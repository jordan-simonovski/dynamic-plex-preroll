package plexclient

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
)

func testClient(server *httptest.Server) *PlexClient {
	return &PlexClient{
		PlexToken:  configmanager.Secret("tok"),
		PlexURL:    server.URL,
		HTTPClient: server.Client(),
	}
}

func TestWatchlistItemsDefaultsFilterAndPassesParams(t *testing.T) {
	var gotPath string
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"title":"Dune","guid":"plex://movie/abc","type":"movie",
			 "ratingKey":"cloud-id","thumb":"https://images.plex.tv/dune.jpg"}
		]}}`))
	}))
	defer server.Close()

	items, err := testClient(server).WatchlistItems("", url.Values{"libtype": {"movie"}})
	if err != nil {
		t.Fatalf("WatchlistItems: %v", err)
	}
	if gotPath != "/library/sections/watchlist/all" {
		t.Errorf("path = %q, want default filter all", gotPath)
	}
	if gotQuery.Get("libtype") != "movie" {
		t.Errorf("query = %v", gotQuery)
	}
	if len(items) != 1 {
		t.Fatalf("items = %+v", items)
	}
	item := items[0]
	if item.Name != "Dune" || item.GUID != "plex://movie/abc" || item.Type != "movie" {
		t.Errorf("item = %+v", item)
	}
	if item.RatingKey != "" {
		t.Errorf("cloud rating key must be dropped, got %q", item.RatingKey)
	}
	if item.Thumb != "https://images.plex.tv/dune.jpg" {
		t.Errorf("absolute thumb must pass through untouched, got %q", item.Thumb)
	}
}

func TestWatchlistItemsExplains401(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := testClient(server).WatchlistItems("all", url.Values{})
	if err == nil || !strings.Contains(err.Error(), "account token") {
		t.Fatalf("err = %v, want account-token hint on 401", err)
	}
}

func TestHomeHubs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hubs/sections/home" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Write([]byte(`{"MediaContainer":{"Hub":[
			{"title":"Trending","hubIdentifier":"home.trending","Metadata":[
				{"title":"Dune","guid":"plex://movie/abc","type":"movie"}
			]}
		]}}`))
	}))
	defer server.Close()

	hubs, err := testClient(server).HomeHubs(url.Values{})
	if err != nil {
		t.Fatalf("HomeHubs: %v", err)
	}
	if len(hubs) != 1 || hubs[0].Identifier != "home.trending" || hubs[0].Title != "Trending" {
		t.Fatalf("hubs = %+v", hubs)
	}
	if len(hubs[0].Items) != 1 || hubs[0].Items[0].GUID != "plex://movie/abc" {
		t.Errorf("hub items = %+v", hubs[0].Items)
	}
}

func TestFindByGUID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/library/all" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("guid") == "plex://movie/abc" {
			w.Write([]byte(`{"MediaContainer":{"Metadata":[{"title":"Dune","ratingKey":"42"}]}}`))
			return
		}
		w.Write([]byte(`{"MediaContainer":{"Metadata":[]}}`))
	}))
	defer server.Close()
	client := testClient(server)

	item, ok, err := client.FindByGUID("plex://movie/abc")
	if err != nil || !ok {
		t.Fatalf("FindByGUID: ok=%v err=%v", ok, err)
	}
	if item.RatingKey != "42" {
		t.Errorf("item = %+v", item)
	}

	_, ok, err = client.FindByGUID("plex://movie/missing")
	if err != nil {
		t.Fatalf("FindByGUID miss: %v", err)
	}
	if ok {
		t.Error("expected no match")
	}

	if _, _, err := client.FindByGUID(" "); err == nil {
		t.Error("expected error for blank guid")
	}
}

func TestNewDiscoverClientTargetsDiscover(t *testing.T) {
	client := NewDiscoverClient(configmanager.Secret("tok"), false)
	if client.PlexURL != DiscoverBaseURL {
		t.Errorf("PlexURL = %q", client.PlexURL)
	}
}
