// Package webui serves the pre-roll config UI: an embedded single-page editor
// plus a small JSON API over the manifest package. The browser posts manifests
// as JSON; JSON is a subset of YAML, so the strict manifest decoder consumes
// the body directly and all validation stays in one place.
package webui

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
)

//go:embed all:static
var staticFS embed.FS

// maxBody caps request bodies; manifests are a few KB, so 1MB is generous.
const maxBody = 1 << 20

// nameRE is the only shape a client-supplied manifest filename may take. It
// forbids path separators and leading dots, confining every file operation to
// ManifestDir.
var nameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(yaml|yml)$`)

// Server is the config UI's HTTP server. ManifestDir is where manifests are
// listed, loaded, saved, and deleted.
type Server struct {
	ManifestDir string
}

// Handler returns the full route table: the JSON API under /api and the
// embedded static UI everywhere else.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/convert", s.convert)
	mux.HandleFunc("GET /api/manifests", s.list)
	mux.HandleFunc("GET /api/manifests/{name}", s.get)
	mux.HandleFunc("PUT /api/manifests/{name}", s.save)
	mux.HandleFunc("DELETE /api/manifests/{name}", s.remove)
	staticRoot, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err) // embedded tree is fixed at compile time
	}
	mux.Handle("GET /", http.FileServerFS(staticRoot))
	return allowHost(mux)
}

// allowHost rejects requests whose Host is a DNS name rather than an IP
// literal or localhost. The tool is LAN-only with no auth, but without this a
// page the user happens to visit can point a name it controls at their box
// (DNS rebinding) and rewrite or delete manifests as same-origin; rebinding
// always arrives with a name in Host, never a bare IP.
// ponytail: IP-or-localhost only. Fronting this with a reverse proxy under a
// hostname needs an allowed-host flag, not this check dropped.
func allowHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]") // bare IPv6 literal, e.g. "[::1]"
		if host != "localhost" && net.ParseIP(host) == nil {
			http.Error(w, "forbidden host: reach this UI by IP or localhost", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type convertResponse struct {
	YAML   string   `json:"yaml"`
	Errors []string `json:"errors"`
}

func (s *Server) convert(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		// Convert always answers 200 with an errors list (an oversized body is
		// just another thing to report); the UI parses JSON unconditionally.
		writeJSON(w, http.StatusOK, convertResponse{Errors: []string{err.Error()}})
		return
	}
	p, err := manifest.Decode(body)
	if err != nil {
		writeJSON(w, http.StatusOK, convertResponse{Errors: []string{err.Error()}})
		return
	}
	out, err := p.ToYAML()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	problems := p.Problems()
	if problems == nil {
		problems = []string{}
	}
	writeJSON(w, http.StatusOK, convertResponse{YAML: string(out), Errors: problems})
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	names := []string{}
	for _, pattern := range []string{"*.yaml", "*.yml"} {
		matches, err := filepath.Glob(filepath.Join(s.ManifestDir, pattern))
		if err != nil {
			httpError(w, http.StatusInternalServerError, err)
			return
		}
		for _, m := range matches {
			names = append(names, filepath.Base(m))
		}
	}
	sort.Strings(names)
	writeJSON(w, http.StatusOK, names)
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	path, err := s.manifestPath(r.PathValue("name"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusNotFound, err)
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	p, err := manifest.Decode(raw)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) save(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	path, err := s.manifestPath(name)
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	// Parse (decode + validate): an invalid manifest must never land in the
	// directory the batch renderer reads.
	p, err := manifest.Parse(body)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, err)
		return
	}
	out, err := p.ToYAML()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if err := writeManifest(path, out); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}

// writeManifest replaces path atomically and keeps the previous contents.
// The manifests directory is the one the batch renderer globs, and a single
// unparseable file fails the whole run: writing a temp file in the same
// directory and renaming it over the target means readers see the old file or
// the new one, never a half-written one. Re-serializing also drops the
// comments a hand-written manifest carries, so the old bytes are kept as
// <name>.yaml.bak — a suffix outside the *.yaml/*.yml globs, so the backup is
// never itself read as a manifest.
func writeManifest(path string, out []byte) error {
	existing, err := os.ReadFile(path)
	hadFile := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Dot-prefixed: the *.yaml glob skips it even in the window before rename.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".manifest-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once the rename below succeeds
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil { // CreateTemp makes 0600
		return err
	}
	if hadFile {
		if err := os.WriteFile(path+".bak", existing, 0o644); err != nil {
			return err
		}
	}
	return os.Rename(tmp.Name(), path)
}

func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	path, err := s.manifestPath(r.PathValue("name"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	if err := os.Remove(path); errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusNotFound, err)
		return
	} else if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"deleted": r.PathValue("name")})
}

// manifestPath validates a client-supplied filename and joins it onto
// ManifestDir. Anything not matching nameRE is rejected, so no client input
// can name a path outside the directory.
func (s *Server) manifestPath(name string) (string, error) {
	if !nameRE.MatchString(name) {
		return "", fmt.Errorf("invalid manifest name %q", name)
	}
	return filepath.Join(s.ManifestDir, name), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, err error) {
	http.Error(w, err.Error(), status)
}
