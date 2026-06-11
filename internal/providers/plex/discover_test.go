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

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
)

// discoverJSON builds a Discover-shaped listing (absolute image URLs, guid).
func discoverJSON(metadata ...map[string]any) string {
	b, _ := json.Marshal(map[string]any{"MediaContainer": map[string]any{"Metadata": metadata}})
	return string(b)
}

func hubsJSON(hubs ...map[string]any) string {
	b, _ := json.Marshal(map[string]any{"MediaContainer": map[string]any{"Hub": hubs}})
	return string(b)
}

// discoverBackends spins up two servers: one playing Discover, one playing the
// local Plex server, and registers the providers against the pair.
func discoverBackends(t *testing.T, discover, local http.HandlerFunc) *providers.Registry {
	t.Helper()
	discoverServer := httptest.NewServer(discover)
	t.Cleanup(discoverServer.Close)
	localServer := httptest.NewServer(local)
	t.Cleanup(localServer.Close)

	reg := providers.NewRegistry()
	Register(reg, newClient(localServer), newClient(discoverServer))
	return reg
}

func TestWatchlistProviderMapsParams(t *testing.T) {
	var gotPath string
	var gotQuery url.Values
	reg := discoverBackends(t,
		func(w http.ResponseWriter, r *http.Request) {
			gotPath = r.URL.Path
			gotQuery = r.URL.Query()
			w.Write([]byte(discoverJSON(map[string]any{
				"title": "Dune", "guid": "plex://movie/abc", "type": "movie",
				"thumb": "https://images.plex.tv/dune.jpg",
			})))
		},
		func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("local server should not be hit without inLibrary/trailers, got %s", r.URL.Path)
		})

	items, err := reg.Fetch(context.Background(), ProviderWatchlist, map[string]string{
		"filter": "available", "type": "Movie", "sort": "watchlistedAt:desc", "limit": "5",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if gotPath != "/library/sections/watchlist/available" {
		t.Errorf("path = %q", gotPath)
	}
	if gotQuery.Get("libtype") != "movie" || gotQuery.Get("sort") != "watchlistedAt:desc" || gotQuery.Get("limit") != "5" {
		t.Errorf("query = %v", gotQuery)
	}
	if len(items) != 1 || items[0].Name != "Dune" || items[0].GUID != "plex://movie/abc" {
		t.Errorf("items = %+v", items)
	}
	if items[0].Thumb != "https://images.plex.tv/dune.jpg" {
		t.Errorf("Discover thumb must pass through untouched, got %q", items[0].Thumb)
	}
	if items[0].RatingKey != "" {
		t.Errorf("Discover items must not carry a RatingKey, got %q", items[0].RatingKey)
	}
}

func TestWatchlistProviderRejectsInvalidFilter(t *testing.T) {
	reg := providers.NewRegistry()
	registerAll(reg, nil)
	_, err := reg.Fetch(context.Background(), ProviderWatchlist, map[string]string{"filter": "bogus"})
	if err == nil || !strings.Contains(err.Error(), "invalid filter") {
		t.Fatalf("err = %v, want invalid filter error", err)
	}
}

func TestWatchlistProviderInLibraryPoolsMatchesAndTrims(t *testing.T) {
	var gotLimit string
	reg := discoverBackends(t,
		func(w http.ResponseWriter, r *http.Request) {
			gotLimit = r.URL.Query().Get("limit")
			w.Write([]byte(discoverJSON(
				map[string]any{"title": "OnServer1", "guid": "plex://movie/1"},
				map[string]any{"title": "NotOnServer", "guid": "plex://movie/2"},
				map[string]any{"title": "OnServer2", "guid": "plex://movie/3"},
				map[string]any{"title": "OnServer3", "guid": "plex://movie/4"},
			)))
		},
		func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/library/all" {
				t.Errorf("unexpected local path %q", r.URL.Path)
			}
			switch r.URL.Query().Get("guid") {
			case "plex://movie/1":
				w.Write([]byte(listingJSON(map[string]any{"title": "OnServer1", "ratingKey": "11"})))
			case "plex://movie/3":
				w.Write([]byte(listingJSON(map[string]any{"title": "OnServer2", "ratingKey": "33"})))
			case "plex://movie/4":
				w.Write([]byte(listingJSON(map[string]any{"title": "OnServer3", "ratingKey": "44"})))
			default:
				w.Write([]byte(listingJSON())) // no match
			}
		})

	items, err := reg.Fetch(context.Background(), ProviderWatchlist, map[string]string{
		"inLibrary": "true", "limit": "2",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	// Pool is requested from Discover, not the final limit.
	if gotLimit != strconv.Itoa(discoverPool) {
		t.Errorf("Discover limit = %q, want pool %d", gotLimit, discoverPool)
	}
	if len(items) != 2 || items[0].Name != "OnServer1" || items[1].Name != "OnServer2" {
		t.Fatalf("items = %+v, want the first two matched items", items)
	}
	if items[0].RatingKey != "11" {
		t.Errorf("matched item must carry the local RatingKey, got %q", items[0].RatingKey)
	}
}

func TestWatchlistProviderInLibraryFalseKeepsUnmatched(t *testing.T) {
	reg := discoverBackends(t,
		func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(discoverJSON(
				map[string]any{"title": "OnServer", "guid": "plex://movie/1"},
				map[string]any{"title": "Missing", "guid": "plex://movie/2"},
			)))
		},
		func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("guid") == "plex://movie/1" {
				w.Write([]byte(listingJSON(map[string]any{"title": "OnServer", "ratingKey": "11"})))
				return
			}
			w.Write([]byte(listingJSON()))
		})

	items, err := reg.Fetch(context.Background(), ProviderWatchlist, map[string]string{"inLibrary": "false"})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(items) != 1 || items[0].Name != "Missing" {
		t.Errorf("items = %+v, want only the unmatched item", items)
	}
}

func TestWatchlistProviderResolvesTrailersForMatched(t *testing.T) {
	reg := discoverBackends(t,
		func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(discoverJSON(map[string]any{"title": "Dune", "guid": "plex://movie/1"})))
		},
		func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/library/all":
				w.Write([]byte(listingJSON(map[string]any{"title": "Dune", "ratingKey": "42"})))
			case "/library/metadata/42/extras":
				w.Write([]byte(listingJSON(map[string]any{
					"title": "Dune Trailer",
					"Media": []any{map[string]any{"Part": []any{map[string]any{"key": "/parts/dune.mp4"}}}},
				})))
			default:
				t.Errorf("unexpected local path %q", r.URL.Path)
			}
		})

	items, err := reg.Fetch(context.Background(), ProviderWatchlist, map[string]string{"trailers": "true"})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(items) != 1 || !strings.Contains(items[0].MediaURL, "/parts/dune.mp4") {
		t.Errorf("items = %+v, want Dune with local trailer URL", items)
	}
}

func TestTrendingProviderSelectsHubFiltersAndTrims(t *testing.T) {
	reg := discoverBackends(t,
		func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/hubs/sections/home" {
				t.Errorf("unexpected Discover path %q", r.URL.Path)
			}
			w.Write([]byte(hubsJSON(
				map[string]any{"hubIdentifier": "home.watchlist", "Metadata": []any{
					map[string]any{"title": "Noise", "type": "movie"},
				}},
				map[string]any{"hubIdentifier": "home.trending", "Metadata": []any{
					map[string]any{"title": "Movie1", "type": "movie", "guid": "plex://movie/1"},
					map[string]any{"title": "Show1", "type": "show", "guid": "plex://show/2"},
					map[string]any{"title": "Movie2", "type": "movie", "guid": "plex://movie/3"},
					map[string]any{"title": "Movie3", "type": "movie", "guid": "plex://movie/4"},
				}},
			)))
		},
		func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("local server should not be hit, got %s", r.URL.Path)
		})

	items, err := reg.Fetch(context.Background(), ProviderTrending, map[string]string{
		"type": "movie", "limit": "2",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(items) != 2 || items[0].Name != "Movie1" || items[1].Name != "Movie2" {
		t.Errorf("items = %+v, want first two movies from the trending hub", items)
	}
}

func TestTrendingProviderErrorsWithoutHub(t *testing.T) {
	reg := discoverBackends(t,
		func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(hubsJSON(map[string]any{"hubIdentifier": "home.watchlist"})))
		},
		func(w http.ResponseWriter, r *http.Request) {})

	_, err := reg.Fetch(context.Background(), ProviderTrending, map[string]string{})
	if err == nil || !strings.Contains(err.Error(), "home.watchlist") {
		t.Fatalf("err = %v, want error listing found hub identifiers", err)
	}
}
