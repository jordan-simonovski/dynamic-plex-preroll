package plexclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
)

// topItemsBody builds a minimal /library/all/top JSON response with the given titles.
func topItemsBody(t *testing.T, titles map[string]int) string {
	t.Helper()
	metadata := make([]map[string]any, 0, len(titles))
	for title, views := range titles {
		metadata = append(metadata, map[string]any{"title": title, "globalViewCount": views})
	}
	b, err := json.Marshal(map[string]any{
		"MediaContainer": map[string]any{"Metadata": metadata},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestGetMostViewedContentSeparatesRequests(t *testing.T) {
	var gotQueries []url.Values

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQueries = append(gotQueries, r.URL.Query())

		sectionType := r.URL.Query().Get("type")
		switch sectionType {
		case "2": // TV
			w.Write([]byte(topItemsBody(t, map[string]int{"The Wire": 3})))
		case "1": // Movies
			w.Write([]byte(topItemsBody(t, map[string]int{"Heat": 1})))
		default:
			t.Errorf("unexpected or ambiguous type param: %q (full=%v)", sectionType, r.URL.Query()["type"])
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	client := &PlexClient{
		PlexToken:       configmanager.Secret("test-token"),
		PlexURL:         server.URL,
		PeriodInterval:  30,
		TVShowSectionId: "2",
		MovieSectionId:  "1",
		MaxItems:        5,
		HTTPClient:      server.Client(),
	}

	shows, movies, err := client.GetMostViewedContent(context.Background())
	if err != nil {
		t.Fatalf("GetMostViewedContent() error: %v", err)
	}

	if len(gotQueries) != 2 {
		t.Fatalf("expected 2 requests, got %d", len(gotQueries))
	}

	// Regression guard: each request must carry exactly one `type` value and the auth token.
	for i, q := range gotQueries {
		if types := q["type"]; len(types) != 1 {
			t.Errorf("request %d: got %d type values %v, want exactly 1", i, len(types), types)
		}
		if q.Get("X-Plex-Token") != "test-token" {
			t.Errorf("request %d: missing/incorrect X-Plex-Token: %q", i, q.Get("X-Plex-Token"))
		}
	}

	if len(shows) != 1 || shows[0].Name != "The Wire" || shows[0].Views != 3 {
		t.Errorf("shows = %+v, want [{The Wire 3}]", shows)
	}
	if len(movies) != 1 || movies[0].Name != "Heat" || movies[0].Views != 1 {
		t.Errorf("movies = %+v, want [{Heat 1}]", movies)
	}
}

func TestGetMostViewedContentNon200IsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := &PlexClient{
		PlexToken:  configmanager.Secret("bad"),
		PlexURL:    server.URL,
		HTTPClient: server.Client(),
	}

	if _, _, err := client.GetMostViewedContent(context.Background()); err == nil {
		t.Fatal("expected error on non-200 response, got nil")
	}
}

func TestGetURLDoesNotMutateCallerParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	client := &PlexClient{
		PlexToken:  configmanager.Secret("tok"),
		PlexURL:    server.URL,
		HTTPClient: server.Client(),
	}

	params := url.Values{"limit": {"5"}}
	resp, err := client.GetURL(context.Background(), "/library/all/top", params)
	if err != nil {
		t.Fatalf("GetURL error: %v", err)
	}
	resp.Body.Close()

	if _, leaked := params["X-Plex-Token"]; leaked {
		t.Error("GetURL mutated caller params by injecting X-Plex-Token")
	}
}
