package plex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/plexclient"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
)

func listingJSON(metadata ...map[string]any) string {
	b, _ := json.Marshal(map[string]any{"MediaContainer": map[string]any{"Metadata": metadata}})
	return string(b)
}

func newClient(server *httptest.Server) *plexclient.PlexClient {
	return &plexclient.PlexClient{
		PlexToken:  configmanager.Secret("tok"),
		PlexURL:    server.URL,
		HTTPClient: server.Client(),
	}
}

func TestTopProvider(t *testing.T) {
	var gotQuery url.Values
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		w.Write([]byte(listingJSON(map[string]any{"title": "The Wire", "globalViewCount": 3})))
	}))
	defer server.Close()

	reg := providers.NewRegistry()
	Register(reg, newClient(server))

	items, err := reg.Fetch(context.Background(), ProviderTop, map[string]string{
		"type": "2", "period": "MONTH", "limit": "5",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	if gotPath != "/library/all/top" {
		t.Errorf("path = %q", gotPath)
	}
	if gotQuery.Get("type") != "2" || gotQuery.Get("limit") != "5" {
		t.Errorf("query = %v", gotQuery)
	}
	if gotQuery.Get("viewedAt>>") == "" {
		t.Error("expected viewedAt>> filter for MONTH period")
	}
	if len(items) != 1 || items[0].Name != "The Wire" || items[0].Views != 3 {
		t.Errorf("items = %+v", items)
	}
}

func TestTopProviderMapsFriendlyType(t *testing.T) {
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		w.Write([]byte(listingJSON()))
	}))
	defer server.Close()

	reg := providers.NewRegistry()
	Register(reg, newClient(server))

	if _, err := reg.Fetch(context.Background(), ProviderTop, map[string]string{"type": "movie"}); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if gotQuery.Get("type") != "1" {
		t.Errorf("friendly type movie should map to 1, got %q", gotQuery.Get("type"))
	}
}

func TestUnwatchedProvider(t *testing.T) {
	var gotPath string
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		w.Write([]byte(listingJSON(map[string]any{"title": "Dune", "ratingKey": "42"})))
	}))
	defer server.Close()

	reg := providers.NewRegistry()
	Register(reg, newClient(server))

	items, err := reg.Fetch(context.Background(), ProviderUnwatched, map[string]string{
		"section": "1", "type": "movie", "sort": "addedAt:desc", "limit": "4",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if gotPath != "/library/sections/1/all" {
		t.Errorf("path = %q", gotPath)
	}
	if gotQuery.Get("unwatched") != "1" || gotQuery.Get("sort") != "addedAt:desc" || gotQuery.Get("type") != "1" {
		t.Errorf("query = %v", gotQuery)
	}
	if len(items) != 1 || items[0].RatingKey != "42" {
		t.Errorf("items = %+v", items)
	}
}

func TestUnwatchedProviderRequiresSection(t *testing.T) {
	reg := providers.NewRegistry()
	Register(reg, &plexclient.PlexClient{})
	if _, err := reg.Fetch(context.Background(), ProviderUnwatched, map[string]string{}); err == nil {
		t.Fatal("expected error when section missing")
	}
}

func TestTrailersProvider(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/library/sections/1/all":
			w.Write([]byte(listingJSON(
				map[string]any{"title": "Dune", "ratingKey": "42"},
				map[string]any{"title": "NoTrailer", "ratingKey": "99"},
			)))
		case r.URL.Path == "/library/metadata/42/extras":
			w.Write([]byte(listingJSON(map[string]any{
				"title": "Dune Trailer",
				"Media": []any{map[string]any{"Part": []any{map[string]any{"key": "/parts/dune.mp4"}}}},
			})))
		case r.URL.Path == "/library/metadata/99/extras":
			w.Write([]byte(listingJSON())) // no extras
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	reg := providers.NewRegistry()
	Register(reg, newClient(server))

	items, err := reg.Fetch(context.Background(), ProviderTrailers, map[string]string{
		"section": "1", "filter": "unwatched", "limit": "4",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 trailer (only Dune has one), got %d: %+v", len(items), items)
	}
	if items[0].Name != "Dune" {
		t.Errorf("trailer name = %q", items[0].Name)
	}
	if !strings.Contains(items[0].MediaURL, "/parts/dune.mp4") || !strings.Contains(items[0].MediaURL, "X-Plex-Token=tok") {
		t.Errorf("MediaURL = %q, want part key + token", items[0].MediaURL)
	}
}

func TestTopProviderResolvesTrailers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/library/all/top":
			w.Write([]byte(listingJSON(
				map[string]any{"title": "Dune", "ratingKey": "42", "globalViewCount": 9},
				map[string]any{"title": "Heat", "ratingKey": "43", "globalViewCount": 7},
			)))
		case "/library/metadata/42/extras":
			w.Write([]byte(listingJSON(map[string]any{
				"title": "Dune Trailer",
				"Media": []any{map[string]any{"Part": []any{map[string]any{"key": "/parts/dune.mp4"}}}},
			})))
		case "/library/metadata/43/extras":
			w.Write([]byte(listingJSON())) // no trailer
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()

	reg := providers.NewRegistry()
	Register(reg, newClient(server))

	items, err := reg.Fetch(context.Background(), ProviderTop, map[string]string{
		"type": "movie", "section": "1", "limit": "5", "trailers": "true",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2", len(items))
	}
	// Top item with a trailer gets its MediaURL; the list text is preserved.
	if items[0].Name != "Dune" || !strings.Contains(items[0].MediaURL, "/parts/dune.mp4") {
		t.Errorf("item 0 = %+v, want Dune with trailer URL", items[0])
	}
	// Item without a trailer stays in the list but carries no MediaURL.
	if items[1].Name != "Heat" || items[1].MediaURL != "" {
		t.Errorf("item 1 = %+v, want Heat with no trailer", items[1])
	}
}

func TestSectionProviderPassthroughAndKnobs(t *testing.T) {
	var gotPath string
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		w.Write([]byte(listingJSON(map[string]any{
			"title": "Heat", "ratingKey": "7",
			"art": "/library/metadata/7/art/1", "thumb": "/library/metadata/7/thumb/1",
		})))
	}))
	defer server.Close()

	reg := providers.NewRegistry()
	Register(reg, newClient(server))

	items, err := reg.Fetch(context.Background(), ProviderSection, map[string]string{
		"section": "1", "type": "movie", "sort": "addedAt:desc", "limit": "8",
		"unwatched": "true", "decade": "1990",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if gotPath != "/library/sections/1/all" {
		t.Errorf("path = %q", gotPath)
	}
	if gotQuery.Get("type") != "1" || gotQuery.Get("sort") != "addedAt:desc" || gotQuery.Get("limit") != "8" {
		t.Errorf("query = %v", gotQuery)
	}
	if gotQuery.Get("unwatched") != "1" {
		t.Errorf("unwatched not set: %v", gotQuery)
	}
	if gotQuery.Get("decade") != "1990" {
		t.Errorf("passthrough filter decade missing: %v", gotQuery)
	}
	if len(items) != 1 || items[0].Name != "Heat" {
		t.Errorf("items = %+v", items)
	}
	if !strings.Contains(items[0].Art, "/library/metadata/7/art/1") || !strings.Contains(items[0].Art, "X-Plex-Token=tok") {
		t.Errorf("Art not mapped with token: %q", items[0].Art)
	}
	if !strings.Contains(items[0].Thumb, "/library/metadata/7/thumb/1") {
		t.Errorf("Thumb not mapped: %q", items[0].Thumb)
	}
}

func TestSectionProviderRandomSamplesPoolAndTrims(t *testing.T) {
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		w.Write([]byte(listingJSON(
			map[string]any{"title": "A"}, map[string]any{"title": "B"},
			map[string]any{"title": "C"}, map[string]any{"title": "D"},
		)))
	}))
	defer server.Close()

	reg := providers.NewRegistry()
	Register(reg, newClient(server))

	items, err := reg.Fetch(context.Background(), ProviderSection, map[string]string{
		"section": "1", "random": "true", "limit": "2",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	// Random samples a larger pool from Plex, not the final count.
	if gotQuery.Get("limit") != strconv.Itoa(sectionPool) {
		t.Errorf("random pool limit = %q, want %d", gotQuery.Get("limit"), sectionPool)
	}
	// ...then trims to the requested limit locally.
	if len(items) != 2 {
		t.Errorf("trimmed items = %d, want 2", len(items))
	}
}

func TestSectionProviderRequiresSection(t *testing.T) {
	reg := providers.NewRegistry()
	Register(reg, &plexclient.PlexClient{})
	if _, err := reg.Fetch(context.Background(), ProviderSection, map[string]string{}); err == nil {
		t.Fatal("expected error when section missing")
	}
}

func TestCollectionsProvider(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Write([]byte(listingJSON(map[string]any{"title": "Marvel", "childCount": 23, "ratingKey": "5"})))
	}))
	defer server.Close()

	reg := providers.NewRegistry()
	Register(reg, newClient(server))

	items, err := reg.Fetch(context.Background(), ProviderCollections, map[string]string{
		"section": "1", "limit": "8",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if gotPath != "/library/sections/1/collections" {
		t.Errorf("path = %q", gotPath)
	}
	if len(items) != 1 || items[0].Name != "Marvel" || items[0].Views != 23 {
		t.Errorf("items = %+v (want Marvel with 23 child count as Views)", items)
	}
}

func TestUnknownProvider(t *testing.T) {
	reg := providers.NewRegistry()
	if _, err := reg.Fetch(context.Background(), "plex.nope", nil); err == nil {
		t.Fatal("expected error for unknown provider")
	}
}
