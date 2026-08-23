package webui

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// mediaKinds maps an extension to the kind of media it is. Only these are
// listed: the picker exists to fill font/image/audio manifest fields, and a
// directory of arbitrary files is noise, not choice.
var mediaKinds = map[string]string{
	".ttf": "font", ".otf": "font", ".ttc": "font", ".woff": "font", ".woff2": "font",
	".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".bmp": "image",
	".mp3": "audio", ".m4a": "audio", ".aac": "audio", ".wav": "audio", ".flac": "audio", ".ogg": "audio",
	".mp4": "video", ".mkv": "video", ".mov": "video", ".webm": "video",
}

// fileKind classifies a filename by extension, returning "" for anything that
// is not media.
func fileKind(name string) string {
	return mediaKinds[strings.ToLower(filepath.Ext(name))]
}

type mediaFile struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}

type filesResponse struct {
	Files []mediaFile `json:"files"`
	Roots []string    `json:"roots"`
}

// list enumerates every media file under every configured root. A missing or
// unreadable root is skipped, not fatal: the picker degrades to "nothing to
// show" rather than breaking the editor.
func (s *Server) files(w http.ResponseWriter, r *http.Request) {
	out := filesResponse{Files: []mediaFile{}, Roots: []string{}}
	for _, root := range s.MediaDirs {
		abs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		if info, err := os.Stat(abs); err != nil || !info.IsDir() {
			continue
		}
		out.Roots = append(out.Roots, s.manifestRelative(abs))
		filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil //nolint:nilerr // an unreadable entry is skipped, not fatal
			}
			kind := fileKind(d.Name())
			if kind == "" {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			out.Files = append(out.Files, mediaFile{
				Path: s.manifestRelative(path),
				Name: d.Name(),
				Kind: kind,
				Size: info.Size(),
			})
			return nil
		})
	}
	sort.Slice(out.Files, func(i, j int) bool { return out.Files[i].Path < out.Files[j].Path })
	writeJSON(w, http.StatusOK, out)
}

// workDirAbs returns the absolute working directory manifest-relative paths
// are resolved against: WorkDir, or the process's own directory when unset.
func (s *Server) workDirAbs() (string, error) {
	base := s.WorkDir
	if base == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		base = cwd
	}
	return filepath.Abs(base)
}

// manifestRelative renders an absolute path the way a manifest should spell
// it: relative to the directory renders run in, so "media/common/Font.ttf"
// resolves identically for the UI's preview and for the batch renderer.
// A path outside WorkDir is left absolute — still correct in a manifest, just
// less portable.
func (s *Server) manifestRelative(abs string) string {
	baseAbs, err := s.workDirAbs()
	if err != nil {
		return abs
	}
	rel, err := filepath.Rel(baseAbs, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return abs
	}
	return filepath.ToSlash(rel)
}

// raw serves one media file so the browser can preview it: a font in its own
// face, an image as a thumbnail. The path is untrusted, so it is resolved to
// an absolute path and checked for containment in a configured root — the same
// fail-closed posture as manifestPath, and the reason ".." can never escape.
func (s *Server) filesRaw(w http.ResponseWriter, r *http.Request) {
	requested := r.URL.Query().Get("path")
	if requested == "" {
		httpError(w, http.StatusBadRequest, fmt.Errorf("path is required"))
		return
	}
	resolved, err := s.resolveMediaPath(requested)
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	info, err := os.Stat(resolved)
	if err != nil || info.IsDir() {
		httpError(w, http.StatusNotFound, fmt.Errorf("no such media file"))
		return
	}
	// Previews are read from an editor the user controls; nothing here is
	// rendered as HTML, and nosniff stops the browser deciding otherwise.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, resolved)
}

// resolveMediaPath turns a client-supplied path into an absolute path proven
// to sit inside one of the configured media roots, or an error. Relative paths
// are resolved against WorkDir, which is how manifests spell them.
func (s *Server) resolveMediaPath(requested string) (string, error) {
	candidate := requested
	if !filepath.IsAbs(candidate) {
		base, err := s.workDirAbs()
		if err != nil {
			return "", err
		}
		candidate = filepath.Join(base, candidate)
	}
	// EvalSymlinks after Abs: a symlink inside a root pointing out of it must
	// not become a hole in the containment check.
	abs, err := filepath.Abs(candidate)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	for _, root := range s.MediaDirs {
		rootAbs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		if real, err := filepath.EvalSymlinks(rootAbs); err == nil {
			rootAbs = real
		}
		rel, err := filepath.Rel(rootAbs, abs)
		if err != nil {
			continue
		}
		if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return abs, nil
		}
	}
	return "", fmt.Errorf("path %q is not inside a configured media directory", requested)
}
