package webui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/plexclient"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
	plexprovider "github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers/plex"
)

// fakeProvider stands in for a Plex-backed provider so the endpoint can be
// tested without a server: providers.Provider is a one-method interface.
type fakeProvider struct {
	items content.Items
	err   error
	got   map[string]string
}

func (f *fakeProvider) Fetch(_ context.Context, params map[string]string) (content.Items, error) {
	f.got = params
	return f.items, f.err
}

func TestResolveWithNoPlexIsNotAnError(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "POST", ts.URL+"/api/data/resolve", `{"data":{"top":{"provider":"plex.top","params":{}}}}`)
	if res.StatusCode != 200 {
		t.Fatalf("an unconfigured server must answer 200 so the editor falls back to placeholders, got %d", res.StatusCode)
	}
	var out resolveResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Configured {
		t.Fatal("configured must be false with no Plex env")
	}
	if out.Reason == "" {
		t.Fatal("an unconfigured Plex must explain itself so the UI can prompt the user, not fail silently")
	}
}

// TestResolveImposesADeadlineOnTheProvider proves an unreachable Plex cannot
// wedge the editor: resolve() must hand the provider a context bounded by
// resolveTimeout, not the caller's unbounded request context. A provider that
// respects ctx (as the real Discover client does) is cut off in bounded time
// instead of hanging forever against a dead server.
func TestResolveImposesADeadlineOnTheProvider(t *testing.T) {
	fake := &deadlineCapturingProvider{}
	reg := providers.NewRegistry()
	reg.Register("plex.top", fake)
	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{Registry: reg, BaseURL: "http://plex:32400"}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	before := time.Now()
	res := do(t, "POST", ts.URL+"/api/data/resolve", `{"data":{"top":{"provider":"plex.top","params":{}}}}`)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if fake.deadline.IsZero() {
		t.Fatal("provider was not given a context deadline; an unreachable Plex could hang the editor forever")
	}
	if d := fake.deadline.Sub(before); d <= 0 || d > resolveTimeout+time.Second {
		t.Fatalf("deadline %s from request start is not bounded by resolveTimeout (%s)", d, resolveTimeout)
	}
}

type deadlineCapturingProvider struct {
	deadline time.Time
}

func (p *deadlineCapturingProvider) Fetch(ctx context.Context, _ map[string]string) (content.Items, error) {
	if dl, ok := ctx.Deadline(); ok {
		p.deadline = dl
	}
	return content.Items{}, nil
}

// TestImageProxyReturnsQuicklyWhenPlexIsUnreachable proves a dead Plex server
// fails the image proxy fast and cleanly (a 502 the UI can show) rather than
// blocking the request. A refused TCP connection returns immediately from the
// OS, so this test both documents the behaviour and would fail if the request
// somehow started hanging (via t.Deadline/context down the line).
func TestImageProxyReturnsQuicklyWhenPlexIsUnreachable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := upstream.URL
	upstream.Close() // nothing is listening on this address any more

	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{BaseURL: deadURL}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	start := time.Now()
	res := do(t, "GET", ts.URL+"/api/plex/image?u="+url.QueryEscape(deadURL+"/art"), "")
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("proxy took %s to fail on an unreachable host; it must fail fast, not hang", elapsed)
	}
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("want 502 for an unreachable Plex, got %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if strings.Contains(string(body), "X-Plex-Token") {
		t.Fatal("the token-bearing URL must never be echoed back in an error")
	}
}

func TestResolveRunsTheProviderAndRendersParamTemplates(t *testing.T) {
	fake := &fakeProvider{items: content.Items{
		{Name: "Dune", Views: 7, Art: "http://plex:32400/art?X-Plex-Token=tok", MediaURL: "http://plex:32400/clip"},
		{Name: "Arrival", Views: 2},
	}}
	reg := providers.NewRegistry()
	reg.Register("plex.top", fake)
	s := &Server{
		ManifestDir: t.TempDir(),
		Plex: &PlexSource{
			Registry: reg,
			Vars:     map[string]any{"MovieSectionId": "1", "Period": "Month"},
			BaseURL:  "http://plex:32400",
		},
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	res := do(t, "POST", ts.URL+"/api/data/resolve",
		`{"data":{"top":{"provider":"plex.top","params":{"section":"{{ .MovieSectionId }}"}}}}`)
	var out resolveResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.Configured {
		t.Fatal("configured must be true when a registry is present")
	}
	if fake.got["section"] != "1" {
		t.Fatalf("param templates must be rendered before the provider runs, got %q", fake.got["section"])
	}
	src := out.Sources["top"]
	if len(src.Items) != 2 {
		t.Fatalf("want 2 items, got %d", len(src.Items))
	}
	if src.Items[0].Rank != 1 || src.Items[0].Name != "Dune" || src.Items[0].Views != 7 {
		t.Fatalf("item 0 wrong: %+v", src.Items[0])
	}
	if !src.Items[0].HasMedia || src.Items[1].HasMedia {
		t.Fatal("hasMedia must reflect whether a playable MediaURL was resolved")
	}
	if src.Items[0].Art == "" || src.Items[0].Art[0] != '/' {
		t.Fatalf("art must be rewritten to the local proxy, got %q", src.Items[0].Art)
	}
	if src.Items[1].Art != "" {
		t.Fatal("an item with no art must stay empty, not point at a broken proxy URL")
	}
}

func TestResolveReportsAProviderErrorPerSource(t *testing.T) {
	reg := providers.NewRegistry()
	reg.Register("plex.top", &fakeProvider{err: errors.New("plex: connection refused")})
	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{Registry: reg, BaseURL: "http://plex:32400"}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	res := do(t, "POST", ts.URL+"/api/data/resolve", `{"data":{"top":{"provider":"plex.top","params":{}}}}`)
	if res.StatusCode != 200 {
		t.Fatalf("one broken source must not fail the whole request, got %d", res.StatusCode)
	}
	var out resolveResponse
	json.NewDecoder(res.Body).Decode(&out)
	if out.Sources["top"].Error == "" {
		t.Fatal("the source's error must be reported so the UI can show it")
	}
}

func TestImageProxyRejectsForeignHosts(t *testing.T) {
	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{BaseURL: "http://plex:32400"}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	for _, u := range []string{
		"http://evil.example/steal",
		"http://127.0.0.1:22/",
		"file:///etc/passwd",
		"",
		// A naive substring/suffix check on the host would let these through;
		// only an exact, parsed-host match against the allowlist is safe.
		"http://images.plex.tv.attacker.com/steal",
		"http://plex:32400.attacker.com/steal",
		"http://attacker.com/plex:32400",
	} {
		res := do(t, "GET", ts.URL+"/api/plex/image?u="+url.QueryEscape(u), "")
		if res.StatusCode == 200 {
			t.Errorf("proxy served a foreign URL %q", u)
		}
	}
}

// TestImageProxyDoesNotFollowRedirectsOffTheAllowlist proves the allowlist
// cannot be walked around with a redirect: the vetted host answers 302 to a
// host that would never pass allowImageURL, and its body must never reach the
// browser.
func TestImageProxyDoesNotFollowRedirectsOffTheAllowlist(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("SECRET-FROM-A-DISALLOWED-HOST"))
	}))
	t.Cleanup(elsewhere.Close)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+"/art", http.StatusFound)
	}))
	t.Cleanup(upstream.Close)

	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{BaseURL: upstream.URL, HTTPClient: upstream.Client()}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	res := do(t, "GET", ts.URL+"/api/plex/image?u="+url.QueryEscape(upstream.URL+"/art"), "")
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode == http.StatusOK {
		t.Fatalf("proxy followed a redirect off the allowlist (status %d)", res.StatusCode)
	}
	if strings.Contains(string(body), "SECRET") {
		t.Fatalf("content from a disallowed host was streamed to the browser: %q", body)
	}
}

func TestImageProxyPassesThroughAnAllowlistedURL(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("PNGDATA"))
	}))
	t.Cleanup(upstream.Close)

	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{BaseURL: upstream.URL, HTTPClient: upstream.Client()}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	res := do(t, "GET", ts.URL+"/api/plex/image?u="+url.QueryEscape(upstream.URL+"/art?X-Plex-Token=tok"), "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != "PNGDATA" {
		t.Fatalf("got %q", body)
	}
}

// TestResolveBoundsTheWholeRequestNotEachSource proves two things at once: the
// deadline resolve() sets actually reaches the HTTP request (the providers and
// plexclient thread the context all the way down), and it bounds the request as
// a whole. The Plex stand-in never answers and its client has no Timeout of its
// own, so nothing but the context can end these calls; five sources resolved
// one after another would cost five deadlines.
func TestResolveBoundsTheWholeRequestNotEachSource(t *testing.T) {
	const deadline = 300 * time.Millisecond

	unresponsive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // answers only when the client gives up
	}))
	t.Cleanup(unresponsive.Close)

	client := &plexclient.PlexClient{PlexURL: unresponsive.URL, HTTPClient: unresponsive.Client()}
	reg := providers.NewRegistry()
	plexprovider.Register(reg, client, client)

	s := &Server{
		ManifestDir:    t.TempDir(),
		ResolveTimeout: deadline,
		Plex:           &PlexSource{Registry: reg, BaseURL: unresponsive.URL},
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	sources := make([]string, 0, 5)
	for i := 0; i < 5; i++ {
		sources = append(sources, fmt.Sprintf(`"src%d":{"provider":"plex.top","params":{}}`, i))
	}
	body := `{"data":{` + strings.Join(sources, ",") + `}}`

	start := time.Now()
	res := do(t, "POST", ts.URL+"/api/data/resolve", body)
	elapsed := time.Since(start)

	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if elapsed > 3*deadline {
		t.Fatalf("5 sources took %s against a %s deadline; the endpoint must bound the whole request, not each source", elapsed, deadline)
	}
	var out resolveResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Sources) != 5 {
		t.Fatalf("every source must still be reported, got %d", len(out.Sources))
	}
	for name, src := range out.Sources {
		if src.Error == "" {
			t.Fatalf("source %s must report the timeout so the UI can say so", name)
		}
	}
}
