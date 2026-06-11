package plexclient

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
)

func TestMergePrerolls(t *testing.T) {
	tests := []struct {
		name        string
		current     string
		additions   []string
		defaultSep  string
		want        string
		wantChanged bool
	}{
		{
			name:        "empty pref uses default separator",
			current:     "",
			additions:   []string{"/a.mp4", "/b.mp4"},
			defaultSep:  ",",
			want:        "/a.mp4,/b.mp4",
			wantChanged: true,
		},
		{
			name:        "existing comma separator preserved over sequence default",
			current:     "/a.mp4,/b.mp4",
			additions:   []string{"/c.mp4"},
			defaultSep:  ";",
			want:        "/a.mp4,/b.mp4,/c.mp4",
			wantChanged: true,
		},
		{
			name:        "existing semicolon separator preserved over random default",
			current:     "/a.mp4;/b.mp4",
			additions:   []string{"/c.mp4"},
			defaultSep:  ",",
			want:        "/a.mp4;/b.mp4;/c.mp4",
			wantChanged: true,
		},
		{
			name:        "already present means no change",
			current:     "/a.mp4,/b.mp4",
			additions:   []string{"/b.mp4"},
			defaultSep:  ",",
			want:        "/a.mp4,/b.mp4",
			wantChanged: false,
		},
		{
			name:        "whitespace around existing entries is normalized for matching",
			current:     "/a.mp4, /b.mp4",
			additions:   []string{"/b.mp4"},
			defaultSep:  ",",
			want:        "/a.mp4,/b.mp4",
			wantChanged: false,
		},
		{
			name:        "duplicate additions added once",
			current:     "",
			additions:   []string{"/a.mp4", "/a.mp4"},
			defaultSep:  ";",
			want:        "/a.mp4",
			wantChanged: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, changed := MergePrerolls(tt.current, tt.additions, tt.defaultSep)
			if got != tt.want {
				t.Errorf("merged = %q, want %q", got, tt.want)
			}
			if changed != tt.wantChanged {
				t.Errorf("changed = %v, want %v", changed, tt.wantChanged)
			}
		})
	}
}

func TestGetPreroll(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/:/prefs" || r.Method != http.MethodGet {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Write([]byte(`{"MediaContainer":{"Setting":[
			{"id":"FriendlyName","value":"plex"},
			{"id":"CinemaTrailersPrerollID","value":"/data/prerolls/a.mp4,/data/prerolls/b.mp4"}
		]}}`))
	}))
	defer server.Close()

	client := &PlexClient{
		PlexToken:  configmanager.Secret("tok"),
		PlexURL:    server.URL,
		HTTPClient: server.Client(),
	}

	got, err := client.GetPreroll()
	if err != nil {
		t.Fatalf("GetPreroll error: %v", err)
	}
	if want := "/data/prerolls/a.mp4,/data/prerolls/b.mp4"; got != want {
		t.Errorf("GetPreroll = %q, want %q", got, want)
	}
}

func TestGetPrerollUnsetIsEmpty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"Setting":[{"id":"FriendlyName","value":"plex"}]}}`))
	}))
	defer server.Close()

	client := &PlexClient{
		PlexToken:  configmanager.Secret("tok"),
		PlexURL:    server.URL,
		HTTPClient: server.Client(),
	}

	got, err := client.GetPreroll()
	if err != nil {
		t.Fatalf("GetPreroll error: %v", err)
	}
	if got != "" {
		t.Errorf("GetPreroll = %q, want empty for unset pref", got)
	}
}

func TestSetPreroll(t *testing.T) {
	var gotMethod, gotPath, gotValue, gotToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotValue = r.URL.Query().Get("CinemaTrailersPrerollID")
		gotToken = r.URL.Query().Get("X-Plex-Token")
	}))
	defer server.Close()

	client := &PlexClient{
		PlexToken:  configmanager.Secret("tok"),
		PlexURL:    server.URL,
		HTTPClient: server.Client(),
	}

	if err := client.SetPreroll("/data/a.mp4;/data/b.mp4"); err != nil {
		t.Fatalf("SetPreroll error: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/:/prefs" {
		t.Errorf("request = %s %s, want PUT /:/prefs", gotMethod, gotPath)
	}
	if gotValue != "/data/a.mp4;/data/b.mp4" {
		t.Errorf("CinemaTrailersPrerollID = %q", gotValue)
	}
	if gotToken != "tok" {
		t.Errorf("X-Plex-Token = %q, want %q", gotToken, "tok")
	}
}

func TestSetPrerollNon200IsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	client := &PlexClient{
		PlexToken:  configmanager.Secret("not-the-owner"),
		PlexURL:    server.URL,
		HTTPClient: server.Client(),
	}

	if err := client.SetPreroll("/data/a.mp4"); err == nil {
		t.Fatal("expected error on 403, got nil")
	}
}
