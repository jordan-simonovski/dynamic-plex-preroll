package webui

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/templating"
)

// resolveTimeout caps one /api/data/resolve request, however many sources it
// names. A slow Plex must not wedge the editor's stage: the sources report a
// timeout and the stage falls back to placeholders.
const resolveTimeout = 20 * time.Second

// previewItemLimit caps how many items each source returns to the browser. The
// stage draws a handful and the test table shows a page; nobody needs 200 rows
// of JSON on every keystroke.
const previewItemLimit = 25

// plexImageHosts are the Plex CDN hosts (used by Discover-backed sources)
// allowed alongside the configured server. Everything else is refused: the
// proxy takes a URL from the page, so without this it is an SSRF hole.
var plexImageHosts = map[string]bool{
	"images.plex.tv":          true,
	"metadata-static.plex.tv": true,
	"provider.plex.tv":        true,
}

type previewItem struct {
	Rank     int    `json:"rank"`
	Name     string `json:"name"`
	Views    int    `json:"views"`
	Art      string `json:"art,omitempty"`
	Thumb    string `json:"thumb,omitempty"`
	HasMedia bool   `json:"hasMedia"`
	Type     string `json:"type,omitempty"`
}

type resolvedSource struct {
	Items []previewItem `json:"items"`
	Error string        `json:"error,omitempty"`
}

type resolveResponse struct {
	Configured bool                      `json:"configured"`
	Reason     string                    `json:"reason,omitempty"`
	Vars       map[string]any            `json:"vars,omitempty"`
	Sources    map[string]resolvedSource `json:"sources"`
}

type resolveRequest struct {
	Data map[string]manifest.DataSource `json:"data"`
}

// resolve runs each named data source against the real providers and returns
// what they yield. It always answers 200: "Plex is not configured" and "this
// one source is broken" are both ordinary states the editor renders, not
// transport failures. Serving them as errors would make the stage go blank
// every time somebody typed an incomplete section id.
func (s *Server) resolve(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeJSON(w, http.StatusOK, resolveResponse{Reason: err.Error(), Sources: map[string]resolvedSource{}})
		return
	}
	var req resolveRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusOK, resolveResponse{Reason: err.Error(), Sources: map[string]resolvedSource{}})
		return
	}
	out := resolveResponse{Sources: map[string]resolvedSource{}}
	if s.Plex == nil || s.Plex.Registry == nil {
		out.Reason = "Plex is not configured (set PLEX_URL and PLEX_TOKEN); showing placeholder data"
		writeJSON(w, http.StatusOK, out)
		return
	}
	out.Configured = true
	out.Vars = s.Plex.Vars

	// One deadline for the whole request, not one per source: five sources
	// against a wedged Plex must not add up to five timeouts. The providers
	// honour ctx down to the HTTP request, so an expiry aborts them in flight.
	ctx, cancel := context.WithTimeout(r.Context(), s.resolveDeadline())
	defer cancel()

	var wg sync.WaitGroup
	var mu sync.Mutex
	for name, ds := range req.Data {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resolved := s.resolveOne(ctx, ds)
			mu.Lock()
			defer mu.Unlock()
			out.Sources[name] = resolved
		}()
	}
	wg.Wait()
	writeJSON(w, http.StatusOK, out)
}

// resolveDeadline is how long the whole resolve may take. ResolveTimeout is
// only ever set by tests that need a short one.
func (s *Server) resolveDeadline() time.Duration {
	if s.ResolveTimeout > 0 {
		return s.ResolveTimeout
	}
	return resolveTimeout
}

func (s *Server) resolveOne(ctx context.Context, ds manifest.DataSource) resolvedSource {
	params, err := templating.RenderParams(ds.Params, s.Plex.Vars)
	if err != nil {
		return resolvedSource{Items: []previewItem{}, Error: err.Error()}
	}
	items, err := s.Plex.Registry.Fetch(ctx, ds.Provider, params)
	if err != nil {
		return resolvedSource{Items: []previewItem{}, Error: err.Error()}
	}
	out := make([]previewItem, 0, len(items))
	for i, it := range items {
		if i >= previewItemLimit {
			break
		}
		out = append(out, previewItem{
			Rank:     i + 1,
			Name:     it.Name,
			Views:    it.Views,
			Art:      s.proxyImage(it.Art),
			Thumb:    s.proxyImage(it.Thumb),
			HasMedia: it.MediaURL != "",
			Type:     it.Type,
		})
	}
	return resolvedSource{Items: out}
}

// proxyImage rewrites a token-bearing Plex image URL into a same-origin URL
// this server will fetch on the browser's behalf. Two reasons it cannot just
// be handed over: the URL carries the Plex token (which should not be pasted
// into page markup), and a Plex server on https with its *.plex.direct cert
// fails browser verification when reached by IP.
func (s *Server) proxyImage(raw string) string {
	if raw == "" {
		return ""
	}
	return "/api/plex/image?u=" + url.QueryEscape(raw)
}

// image fetches an allowlisted Plex image and streams it back. The URL comes
// from the page, so it is checked against the configured server and the Plex
// CDN hosts before anything is dialled, and the fetch refuses to follow
// redirects: allowImageURL only vets the URL that was asked for, so a 302 from
// an allowlisted host would otherwise walk straight out of the allowlist.
func (s *Server) image(w http.ResponseWriter, r *http.Request) {
	if s.Plex == nil {
		httpError(w, http.StatusServiceUnavailable, fmt.Errorf("plex is not configured"))
		return
	}
	raw := r.URL.Query().Get("u")
	if err := s.allowImageURL(raw); err != nil {
		httpError(w, http.StatusForbidden, err)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, raw, nil)
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	resp, err := s.Plex.imageHTTPClient().Do(req)
	if err != nil {
		// The URL carries the token; never echo the raw error.
		httpError(w, http.StatusBadGateway, fmt.Errorf("could not reach the Plex server for that image"))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		httpError(w, http.StatusBadGateway, fmt.Errorf("plex returned status %d for that image", resp.StatusCode))
		return
	}
	if ct := resp.Header.Get("Content-Type"); strings.HasPrefix(ct, "image/") {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=300")
	io.Copy(w, io.LimitReader(resp.Body, 16<<20))
}

// allowImageURL is the whole security boundary of the proxy: http(s) only, and
// the host+port must be the configured Plex server or a known Plex CDN host.
func (s *Server) allowImageURL(raw string) error {
	if raw == "" {
		return fmt.Errorf("u is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("u is not a URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("only http(s) image URLs are proxied")
	}
	if plexImageHosts[strings.ToLower(u.Hostname())] {
		return nil
	}
	base, err := url.Parse(s.Plex.BaseURL)
	if err != nil || base.Host == "" {
		return fmt.Errorf("no Plex server configured to allow that image")
	}
	if !strings.EqualFold(u.Host, base.Host) {
		return fmt.Errorf("image host %q is not the configured Plex server", u.Host)
	}
	return nil
}
