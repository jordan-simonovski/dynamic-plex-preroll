package webui

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeRenderer writes a stub mp4 to the -manifest's output path and exits 0,
// so the whole subprocess round-trip is exercised without ImageMagick.
const fakeRendererOK = `#!/bin/sh
# args: -manifest <path>
manifest="$2"
out=$(grep '^output:' "$manifest" | sed 's/^output: *//')
mkdir -p "$(dirname "$out")"
printf 'FAKEMP4' > "$out"
echo "wrote $out"
`

const fakeRendererFail = `#!/bin/sh
echo "plex: connection refused" >&2
exit 1
`

// writeStub drops a shell script somewhere executable and returns its path.
func writeStub(t *testing.T, script string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "fake-renderer")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func renderServer(t *testing.T, script string) (*httptest.Server, *Server) {
	t.Helper()
	root := t.TempDir()
	bin := writeStub(t, script)
	s := &Server{
		ManifestDir: filepath.Join(root, "manifests"),
		RenderDir:   filepath.Join(root, "renders"),
		WorkDir:     root,
		RenderBin:   bin,
	}
	if err := os.MkdirAll(s.ManifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	// Kill any still-running render so a slow stub cannot outlive its test.
	t.Cleanup(func() {
		s.renderMu.Lock()
		defer s.renderMu.Unlock()
		if s.currentJob != nil {
			s.currentJob.cancel()
		}
	})
	return ts, s
}

// waitForJob polls until the job leaves the running state, which is exactly
// what the browser does.
func waitForJob(t *testing.T, ts *httptest.Server, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		res := do(t, "GET", ts.URL+"/api/render/"+id, "")
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		if out["state"] != "running" {
			return out
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job %s never finished", id)
	return nil
}

func TestRenderWithoutABinaryIsUnavailable(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	if res.StatusCode != 503 {
		t.Fatalf("want 503 with no render binary, got %d", res.StatusCode)
	}
}

func TestRenderRejectsAnInvalidManifest(t *testing.T) {
	ts, _ := renderServer(t, fakeRendererOK)
	res := do(t, "POST", ts.URL+"/api/render", `{"name":"draft"}`)
	if res.StatusCode != 422 {
		t.Fatalf("an invalid manifest must never reach the renderer; got %d", res.StatusCode)
	}
}

func TestRenderRunsAndServesTheVideo(t *testing.T) {
	ts, s := renderServer(t, fakeRendererOK)
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	if res.StatusCode != 202 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)
	if started.ID == "" {
		t.Fatal("no job id returned")
	}

	out := waitForJob(t, ts, started.ID)
	if out["state"] != "done" {
		t.Fatalf("job failed: %+v", out)
	}

	video := do(t, "GET", ts.URL+"/api/render/"+started.ID+"/video", "")
	if video.StatusCode != 200 {
		t.Fatalf("video status %d", video.StatusCode)
	}
	if ct := video.Header.Get("Content-Type"); !strings.HasPrefix(ct, "video/") {
		t.Fatalf("content type %q", ct)
	}

	// Render scratch must never land in the directory the batch renderer globs.
	entries, _ := os.ReadDir(s.ManifestDir)
	if len(entries) != 0 {
		t.Fatalf("render wrote into the manifest directory: %v", entries)
	}
}

func TestRenderSurfacesTheSubprocessError(t *testing.T) {
	ts, _ := renderServer(t, fakeRendererFail)
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)

	out := waitForJob(t, ts, started.ID)
	if out["state"] != "failed" {
		t.Fatalf("want failed, got %+v", out)
	}
	if !strings.Contains(out["log"].(string), "connection refused") {
		t.Fatalf("the renderer's own output must be surfaced, got %q", out["log"])
	}
}

func TestRenderRefusesASecondConcurrentJob(t *testing.T) {
	// A renderer that blocks long enough for the second request to arrive.
	ts, _ := renderServer(t, "#!/bin/sh\nsleep 2\nexit 0\n")
	first := do(t, "POST", ts.URL+"/api/render", validJSON)
	if first.StatusCode != 202 {
		t.Fatalf("first render status %d", first.StatusCode)
	}
	second := do(t, "POST", ts.URL+"/api/render", validJSON)
	if second.StatusCode != 409 {
		t.Fatalf("want 409 while a render is running, got %d", second.StatusCode)
	}
}

func TestRenderStatusOfAnUnknownJobIs404(t *testing.T) {
	ts, _ := renderServer(t, fakeRendererOK)
	res := do(t, "GET", ts.URL+"/api/render/deadbeefdeadbeef", "")
	if res.StatusCode != 404 {
		t.Fatalf("want 404, got %d", res.StatusCode)
	}
}

// A finished render's scratch is replaced, not accumulated: one slot, one set
// of files. This is what keeps pre-roll-output/.ui-renders from growing.
func TestRenderKeepsOnlyTheMostRecentScratch(t *testing.T) {
	ts, s := renderServer(t, fakeRendererOK)
	var ids []string
	for range 2 {
		res := do(t, "POST", ts.URL+"/api/render", validJSON)
		if res.StatusCode != 202 {
			t.Fatalf("status %d", res.StatusCode)
		}
		var started struct {
			ID string `json:"id"`
		}
		json.NewDecoder(res.Body).Decode(&started)
		ids = append(ids, started.ID)
		if out := waitForJob(t, ts, started.ID); out["state"] != "done" {
			t.Fatalf("job failed: %+v", out)
		}
	}
	entries, err := os.ReadDir(s.RenderDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 { // the current render's manifest and its mp4
		t.Fatalf("stale scratch left behind: %v", entries)
	}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ids[1]) {
			t.Fatalf("%s is not from the most recent render %s", e.Name(), ids[1])
		}
	}
	// The superseded job is gone, so its video 404s rather than serving a
	// deleted file.
	if res := do(t, "GET", ts.URL+"/api/render/"+ids[0]+"/video", ""); res.StatusCode != 404 {
		t.Fatalf("want 404 for a superseded render, got %d", res.StatusCode)
	}
}

// The UI is normally started with MANIFEST_DIR pointing at the real manifest
// directory; inherited unchanged it would put the renderer into batch mode and
// render everything except the manifest we asked for.
func TestRenderDoesNotInheritBatchMode(t *testing.T) {
	t.Setenv("MANIFEST_DIR", "/some/batch/dir")
	ts, _ := renderServer(t, "#!/bin/sh\necho \"MANIFEST_DIR=[$MANIFEST_DIR]\"\nexit 1\n")
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)
	out := waitForJob(t, ts, started.ID)
	if log, _ := out["log"].(string); !strings.Contains(log, "MANIFEST_DIR=[]") {
		t.Fatalf("renderer must not inherit MANIFEST_DIR, got %q", log)
	}
}

// The UI process runs with the user's whole .env loaded, and the renderer
// inherits that environment. Anything with an effect outside the scratch
// directory must not survive the trip — above all PLEX_SET_PREROLL, which would
// append every throwaway preview to the live Plex server's pre-roll preference.
// The data variables the manifest resolves against must survive.
func TestRenderNeutralisesSideEffectingEnv(t *testing.T) {
	denied := []string{"PLEX_SET_PREROLL", "PLEX_PREROLL_SERVER_DIR", "PLEX_PREROLL_MODE", "MANIFEST_DIR", "MANIFEST_PATH"}
	inherited := map[string]string{
		"PLEX_URL":           "http://plex.local:32400",
		"PLEX_TOKEN":         "tok",
		"MAX_ITEMS":          "5",
		"PERIOD_INTERVAL":    "WEEK",
		"MOVIE_SECTION_ID":   "1",
		"TV_SHOW_SECTION_ID": "2",
		"DEBUG":              "true",
		"PLEX_INSECURE":      "true",
	}
	for _, k := range denied {
		t.Setenv(k, "set-in-the-ui-process")
	}
	for k, v := range inherited {
		t.Setenv(k, v)
	}

	// The stub reports the child's ACTUAL environment: ${VAR-UNSET} tells a
	// removed variable apart from one set to the empty string, and only removal
	// is correct — envconfig fails to parse PLEX_SET_PREROLL="" as a bool.
	var script strings.Builder
	script.WriteString("#!/bin/sh\n")
	for _, k := range denied {
		fmt.Fprintf(&script, "echo \"%s=[${%s-UNSET}]\"\n", k, k)
	}
	for k := range inherited {
		fmt.Fprintf(&script, "echo \"%s=[${%s-UNSET}]\"\n", k, k)
	}
	script.WriteString("exit 1\n")

	ts, _ := renderServer(t, script.String())
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)
	log, _ := waitForJob(t, ts, started.ID)["log"].(string)

	for _, k := range denied {
		if !strings.Contains(log, k+"=[UNSET]") {
			t.Errorf("%s must be removed from the render environment, not inherited or blanked; child saw:\n%s", k, log)
		}
	}
	for k, v := range inherited {
		if !strings.Contains(log, fmt.Sprintf("%s=[%s]", k, v)) {
			t.Errorf("%s must reach the renderer (the preview resolves against it); child saw:\n%s", k, log)
		}
	}
}

// The timeout is the only thing that reclaims the single render slot from a
// wedged renderer: without it one hung ffmpeg makes the UI useless until
// restart.
func TestRenderTimeoutKillsTheRendererAndFreesTheSlot(t *testing.T) {
	ts, s := renderServer(t, "#!/bin/sh\nexec sleep 60\n") // exec: the killed process is sleep itself
	s.RenderTimeout = 200 * time.Millisecond

	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)

	out := waitForJob(t, ts, started.ID)
	if out["state"] != "failed" {
		t.Fatalf("a render past its deadline must fail, got %+v", out)
	}
	if msg, _ := out["error"].(string); !strings.Contains(msg, "timed out") {
		t.Fatalf("want a timeout error, got %q", msg)
	}
	// The stub sleeps 60s; finishing far sooner proves it was killed rather
	// than waited out.
	if secs, _ := out["seconds"].(float64); secs > 30 {
		t.Fatalf("renderer ran %.1fs: it was not killed at the deadline", secs)
	}

	// The slot is free again: the next render runs and finishes.
	s.RenderTimeout = 10 * time.Second // the point here is the slot, not the deadline
	s.RenderBin = writeStub(t, fakeRendererOK)
	next := do(t, "POST", ts.URL+"/api/render", validJSON)
	if next.StatusCode != 202 {
		t.Fatalf("the slot was not released: second render got %d", next.StatusCode)
	}
	json.NewDecoder(next.Body).Decode(&started)
	if out := waitForJob(t, ts, started.ID); out["state"] != "done" {
		t.Fatalf("second render failed: %+v", out)
	}
}

// A renderer that exits 0 without writing the file must become a failed job,
// not a <video> pointed at nothing.
func TestRenderFailsWhenNoVideoIsProduced(t *testing.T) {
	ts, _ := renderServer(t, "#!/bin/sh\nexit 0\n")
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)

	out := waitForJob(t, ts, started.ID)
	if out["state"] != "failed" {
		t.Fatalf("want failed when no video was written, got %+v", out)
	}
	if res := do(t, "GET", ts.URL+"/api/render/"+started.ID+"/video", ""); res.StatusCode != 404 {
		t.Fatalf("want 404 for a render that produced no video, got %d", res.StatusCode)
	}
}

// The rule is structural, not documentary: scratch <id>.yaml in the manifest
// directory would be swept up by the next batch render.
func TestRenderRefusesAScratchDirThatIsTheManifestDir(t *testing.T) {
	ts, s := renderServer(t, fakeRendererOK)
	s.RenderDir = s.ManifestDir

	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	if res.StatusCode != 500 {
		t.Fatalf("want a refusal when render dir is the manifest dir, got %d", res.StatusCode)
	}
	if entries, _ := os.ReadDir(s.ManifestDir); len(entries) != 0 {
		t.Fatalf("scratch was written into the manifest directory: %v", entries)
	}
}
