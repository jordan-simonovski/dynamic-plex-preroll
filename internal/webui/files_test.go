package webui

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	secret := filepath.Join(filepath.Dir(root), "secret.txt")
	if err := os.WriteFile(secret, []byte("nope"), 0o644); err != nil {
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
