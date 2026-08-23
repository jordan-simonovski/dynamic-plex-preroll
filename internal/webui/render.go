package webui

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
)

// renderTimeout is the default hard ceiling on a single render. A trailer
// montage over a slow link is genuinely slow, so this is generous; without it a
// wedged ffmpeg would hold the single job slot forever.
const renderTimeout = 20 * time.Minute

// renderLogLimit caps how much subprocess output is kept. Enough to see what
// went wrong, bounded so a chatty failure cannot grow without limit.
const renderLogLimit = 64 << 10

// DefaultRenderDir is where scratch goes when RenderDir is unset. It is a
// dot-directory under the output tree, never the manifest directory the batch
// renderer globs. Exported so cmd/preroll-ui's flag default cannot drift from
// the server's own.
const DefaultRenderDir = "pre-roll-output/.ui-renders"

// renderEnvDenied lists the variables cmd/plex-pre-rolls reads that a preview
// render must NOT inherit.
//
// THE RULE, for whoever adds the next variable to internal/configmanager: a
// preview may inherit a variable only if its whole effect is reading data and
// writing inside the render scratch directory. Anything that changes WHAT gets
// rendered, or that has an effect outside the scratch dir — the Plex server's
// own configuration, the real output tree, the manifest directory — belongs in
// this list.
//
// Every variable cmd/plex-pre-rolls reads, and why:
//
//	PLEX_URL, PLEX_TOKEN     inherit — the preview resolves against the same server the manifest is written for
//	MOVIE_SECTION_ID         inherit — ditto, source data only
//	TV_SHOW_SECTION_ID       inherit — ditto
//	MAX_ITEMS                inherit — ditto
//	PERIOD_INTERVAL          inherit — ditto
//	PLEX_INSECURE            inherit — connection-level only; without it a preview cannot reach some servers at all
//	DEBUG                    inherit — logging only, and the log is what the preview shows the user
//	PLEX_SET_PREROLL         DENY    — appends the render's path to the LIVE server's pre-roll preference; a preview mp4 is
//	                                   scratch, deleted at the next render, so every preview would leave a dead entry behind
//	PLEX_PREROLL_SERVER_DIR  DENY    — only feeds that write, and with SET_PREROLL on but this unset the renderer exits
//	                                   before rendering anything
//	PLEX_PREROLL_MODE        DENY    — only feeds that write
//	MANIFEST_DIR             DENY    — batch mode: renders the whole real manifest directory and ignores the -manifest we pass
//	MANIFEST_PATH            DENY    — the explicit -manifest flag beats it today; the preview must not rest on flag precedence
//
// Denied variables are REMOVED from the environment, never set to "": envconfig
// treats a set-but-empty value as an explicit value and skips the default, so
// PLEX_SET_PREROLL="" fails to parse as a bool and the renderer dies before it
// renders anything.
var renderEnvDenied = []string{
	"PLEX_SET_PREROLL",
	"PLEX_PREROLL_SERVER_DIR",
	"PLEX_PREROLL_MODE",
	"MANIFEST_DIR",
	"MANIFEST_PATH",
}

// renderEnv strips the denied variables from env.
// ponytail: deny-list, not allow-list. The renderer also needs whatever
// ImageMagick and ffmpeg need — PATH, HOME, TMPDIR, MAGICK_*, LD_LIBRARY_PATH,
// locale — and that set is not ours to enumerate. The list above is the part we
// own, and it is short enough to audit at a glance.
func renderEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		key, _, _ := strings.Cut(kv, "=")
		if slices.Contains(renderEnvDenied, key) {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// jobIDRE is the shape of a server-generated job id. Ids are only ever
// generated here, so validating the shape on the way back in is a cheap way to
// keep a client-supplied string out of a filesystem path.
var jobIDRE = regexp.MustCompile(`^[0-9a-f]{16}$`)

// renderJob is one render. There is exactly one slot: this is a local,
// single-user admin tool, and a queue would be machinery with no user.
// ponytail: one job at a time. If somebody genuinely needs a queue, that is a
// different tool, not a bigger version of this one.
type renderJob struct {
	ID      string  `json:"id"`
	State   string  `json:"state"` // running | done | failed
	Log     string  `json:"log"`
	Error   string  `json:"error,omitempty"`
	Seconds float64 `json:"seconds"`
	started time.Time
	cancel  context.CancelFunc
	output  string // absolute path to the mp4
}

// renderState is the mutable half of Server, embedded rather than declared
// inline so the struct in webui.go stays a plain list of configuration.
type renderState struct {
	renderMu   sync.Mutex
	currentJob *renderJob
}

// startRender validates the posted manifest, writes it to the render scratch
// directory, and runs the renderer as a subprocess.
//
// Why a subprocess at all: rendering needs ImageMagick via CGO and ffmpeg on
// PATH. Linking that into this binary would make the config UI unbuildable
// anywhere the toolchain is missing — which is most places somebody wants to
// edit a manifest. The renderer already exists as a binary; running it is one
// exec.Command instead of a build-system problem.
func (s *Server) startRender(w http.ResponseWriter, r *http.Request) {
	if !s.capabilitySet().Render {
		httpError(w, http.StatusServiceUnavailable,
			fmt.Errorf("no renderer available: set -render-bin (or RENDER_BIN) to the plex-pre-rolls binary"))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	// Parse, not Decode: rendering an invalid manifest wastes minutes to
	// produce the error the validator already knows.
	preroll, err := manifest.Parse(body)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, err)
		return
	}

	// Scratch lives beside the working directory the subprocess runs in, so a
	// relative -render-dir means the same thing to both processes.
	renderDir, err := s.renderDirAbs()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.MkdirAll(renderDir, 0o755); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	id, err := newJobID()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	// The preview writes into the render directory, never to the manifest's
	// own output path: a preview must not clobber the file the Plex server is
	// pointed at, and the scratch directory is the one thing we clean up.
	outputPath := filepath.Join(renderDir, id+".mp4")
	preroll.Output = outputPath

	yamlBytes, err := preroll.ToYAML()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	manifestPath := filepath.Join(renderDir, id+".yaml")
	if err := os.WriteFile(manifestPath, yamlBytes, 0o644); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), s.renderDeadline())
	job := &renderJob{ID: id, State: "running", started: time.Now(), cancel: cancel, output: outputPath}

	// Claiming the slot and rejecting a competing render happen under one lock
	// acquisition: check-then-set across two would let two subprocesses start,
	// and the second would be untracked and unkillable.
	s.renderMu.Lock()
	if s.currentJob != nil && s.currentJob.State == "running" {
		s.renderMu.Unlock()
		cancel()
		os.Remove(manifestPath)
		httpError(w, http.StatusConflict, fmt.Errorf("a render is already running"))
		return
	}
	s.cleanupPreviousJobLocked(renderDir)
	s.currentJob = job
	s.renderMu.Unlock()

	go s.runRender(ctx, job, manifestPath)
	writeJSON(w, http.StatusAccepted, map[string]string{"id": id})
}

// runRender executes the renderer and records the outcome. The working
// directory is the same one a batch run uses, so relative manifest paths
// (media/common/Font.ttf, output/...) resolve identically.
func (s *Server) runRender(ctx context.Context, job *renderJob, manifestPath string) {
	defer job.cancel()

	cmd := exec.CommandContext(ctx, s.RenderBin, "-manifest", manifestPath)
	cmd.Dir = s.WorkDir
	cmd.Env = renderEnv(os.Environ())
	// Killing the renderer at the deadline is not enough on its own: a
	// grandchild (ffmpeg) inherits the output pipe, and cmd.Run would block on
	// it long after the process it launched is dead — which is exactly the
	// wedged slot the deadline exists to prevent.
	cmd.WaitDelay = 10 * time.Second

	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()

	logText := out.String()
	if len(logText) > renderLogLimit {
		// Keep the TAIL: the error is at the end, the ffmpeg banner is not.
		logText = "… (earlier output trimmed) …\n" + logText[len(logText)-renderLogLimit:]
	}

	s.renderMu.Lock()
	defer s.renderMu.Unlock()
	job.Log = logText
	job.Seconds = time.Since(job.started).Seconds()
	switch {
	case err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded):
		job.State = "failed"
		job.Error = fmt.Sprintf("render timed out after %s", s.renderDeadline())
	case err != nil:
		job.State = "failed"
		job.Error = err.Error()
	default:
		if _, statErr := os.Stat(job.output); statErr != nil {
			job.State = "failed"
			job.Error = "the renderer exited cleanly but wrote no video"
			return
		}
		job.State = "done"
	}
}

// renderStatus is what the browser polls. Polling rather than streaming keeps
// both ends trivial: no SSE reconnection logic, no partial-frame parsing, and
// a status object that is the same shape whether the job is running or long
// finished.
func (s *Server) renderStatus(w http.ResponseWriter, r *http.Request) {
	job, ok := s.renderJobStatus(r.PathValue("id"))
	if !ok {
		httpError(w, http.StatusNotFound, fmt.Errorf("no such render"))
		return
	}
	writeJSON(w, http.StatusOK, job)
}

// renderVideo serves the finished mp4. The id is shape-checked and the path is
// built from the server's own render directory, never taken from the request,
// so there is nothing to traverse with.
func (s *Server) renderVideo(w http.ResponseWriter, r *http.Request) {
	job, ok := s.renderJobStatus(r.PathValue("id"))
	if !ok || job.State != "done" {
		httpError(w, http.StatusNotFound, fmt.Errorf("no finished render with that id"))
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, job.output)
}

// renderJobStatus returns a COPY of the current job, so a caller cannot read a
// half-written field while runRender is finishing.
func (s *Server) renderJobStatus(id string) (*renderJob, bool) {
	if !jobIDRE.MatchString(id) {
		return nil, false
	}
	s.renderMu.Lock()
	defer s.renderMu.Unlock()
	if s.currentJob == nil || s.currentJob.ID != id {
		return nil, false
	}
	snapshot := *s.currentJob
	return &snapshot, true
}

// cleanupPreviousJobLocked deletes the last render's scratch. One slot means
// one set of files; keeping a history would need a retention policy nobody
// asked for. Caller must hold renderMu.
func (s *Server) cleanupPreviousJobLocked(renderDir string) {
	if s.currentJob == nil {
		return
	}
	os.Remove(s.currentJob.output)
	os.Remove(filepath.Join(renderDir, s.currentJob.ID+".yaml"))
	s.currentJob = nil
}

// renderDeadline is how long one render may take. RenderTimeout is the
// override; zero means the package default.
func (s *Server) renderDeadline() time.Duration {
	if s.RenderTimeout > 0 {
		return s.RenderTimeout
	}
	return renderTimeout
}

// renderDirAbs resolves RenderDir against the same working directory the
// renderer runs in, so "pre-roll-output/.ui-renders" names one directory
// whether the UI process and the subprocess share a cwd or not.
func (s *Server) renderDirAbs() (string, error) {
	abs := s.RenderDir
	if !filepath.IsAbs(abs) {
		dir := s.RenderDir
		if dir == "" {
			dir = DefaultRenderDir // never scatter scratch across the working directory
		}
		base, err := s.workDirAbs()
		if err != nil {
			return "", err
		}
		abs = filepath.Join(base, dir)
	}
	// The scratch directory must not be the manifest directory: a render writes
	// <id>.yaml there, and the batch renderer globs *.yaml. Nothing else stops
	// an operator pointing -render-dir and -manifest-dir at the same path, so
	// make the invariant structural rather than a comment.
	// ManifestDir is resolved against this process's own cwd because that is
	// what every other use of it does; RenderDir is resolved against WorkDir
	// because the subprocess reads it.
	manifestAbs, err := filepath.Abs(s.ManifestDir)
	if err != nil {
		return "", err
	}
	if abs == manifestAbs {
		return "", fmt.Errorf("render dir %s is the manifest dir: scratch manifests written there would be picked up by a batch render", abs)
	}
	return abs, nil
}

func newJobID() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
