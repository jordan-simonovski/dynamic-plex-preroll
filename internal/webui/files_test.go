package webui

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mediaServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	root := t.TempDir()
	sub := filepath.Join(root, "common")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"Font.ttf":  "fontbytes",
		"bg.png":    "pngbytes",
		"track.mp3": "mp3bytes",
		"notes.txt": "ignored",
	} {
		if err := os.WriteFile(filepath.Join(sub, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{ManifestDir: t.TempDir(), MediaDirs: []string{root}, WorkDir: filepath.Dir(root)}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, root
}

func TestFilesListsOnlyMediaKinds(t *testing.T) {
	ts, _ := mediaServer(t)
	res := do(t, "GET", ts.URL+"/api/files", "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var out struct {
		Files []struct {
			Path, Name, Kind string
			Size             int64
		} `json:"files"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, f := range out.Files {
		kinds[f.Name] = f.Kind
	}
	if kinds["Font.ttf"] != "font" || kinds["bg.png"] != "image" || kinds["track.mp3"] != "audio" {
		t.Fatalf("wrong kinds: %v", kinds)
	}
	if _, ok := kinds["notes.txt"]; ok {
		t.Fatal("a .txt is not media and must not be listed")
	}
}

func TestFilesWithNoMediaDirIsEmptyNotAnError(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "GET", ts.URL+"/api/files", "")
	if res.StatusCode != 200 {
		t.Fatalf("an unconfigured media dir must still answer 200, got %d", res.StatusCode)
	}
	var out struct {
		Files []any `json:"files"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	if len(out.Files) != 0 {
		t.Fatalf("expected no files, got %d", len(out.Files))
	}
}

func TestFilesRawServesAFileUnderTheRoot(t *testing.T) {
	ts, root := mediaServer(t)
	rel := filepath.Base(root) + "/common/Font.ttf"
	res := do(t, "GET", ts.URL+"/api/files/raw?path="+rel, "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != "fontbytes" {
		t.Fatalf("got %q", body)
	}
}

func TestFilesRawRejectsTraversal(t *testing.T) {
	ts, root := mediaServer(t)
	// The sentinel's content, not just the status code, is the real assertion:
	// a working traversal could return non-200 for other reasons while still
	// having read the file (e.g. a handler that reads then 500s).
	secret := filepath.Join(filepath.Dir(root), "secret.txt")
	if err := os.WriteFile(secret, []byte("nope-secret-sentinel"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, attempt := range []string{
		"../secret.txt",
		filepath.Base(root) + "/../secret.txt",
		"/etc/passwd",
		filepath.Base(root) + "/common/../../secret.txt",
	} {
		res := do(t, "GET", ts.URL+"/api/files/raw?path="+attempt, "")
		if res.StatusCode == 200 {
			t.Errorf("traversal %q was served", attempt)
		}
		body, _ := io.ReadAll(res.Body)
		if strings.Contains(string(body), "nope-secret-sentinel") {
			t.Errorf("traversal %q leaked the sentinel file's content", attempt)
		}
	}
}

// TestFilesRawRejectsSiblingWithSharedPrefix pins the prefix-collision case by
// name: a configured root "/media" must not permit "/mediaevil", even though
// "mediaevil" has "media" as a string prefix. resolveMediaPath uses
// filepath.Rel (which respects path segment boundaries) rather than
// strings.HasPrefix; this test fails loudly if a future refactor swaps that
// for a naive prefix check.
func TestFilesRawRejectsSiblingWithSharedPrefix(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "media")
	sibling := filepath.Join(parent, "mediaevil")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	secretPath := filepath.Join(sibling, "secret.png")
	if err := os.WriteFile(secretPath, []byte("sibling-secret-sentinel"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{ManifestDir: t.TempDir(), MediaDirs: []string{root}, WorkDir: parent}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	res := do(t, "GET", ts.URL+"/api/files/raw?path="+url.QueryEscape("mediaevil/secret.png"), "")
	if res.StatusCode == 200 {
		t.Fatal("a sibling directory sharing a name prefix with the root must not be served")
	}
	body, _ := io.ReadAll(res.Body)
	if strings.Contains(string(body), "sibling-secret-sentinel") {
		t.Fatal("leaked the sibling directory's content")
	}
}

func TestFileKind(t *testing.T) {
	for name, want := range map[string]string{
		"a.TTF": "font", "a.otf": "font", "a.woff2": "font",
		"a.png": "image", "a.JPG": "image", "a.webp": "image",
		"a.mp3": "audio", "a.m4a": "audio", "a.wav": "audio",
		"a.mp4": "video", "a.mkv": "video",
		"a.txt": "", "a": "",
	} {
		if got := fileKind(name); got != want {
			t.Errorf("fileKind(%q) = %q, want %q", name, got, want)
		}
	}
}
