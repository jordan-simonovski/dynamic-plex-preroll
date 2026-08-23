package webui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCapabilitiesAllOff(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "GET", ts.URL+"/api/capabilities", "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var caps capabilities
	if err := json.NewDecoder(res.Body).Decode(&caps); err != nil {
		t.Fatal(err)
	}
	if caps.Plex || caps.Render || caps.Media {
		t.Fatalf("a bare server must advertise nothing: %+v", caps)
	}
}

func TestCapabilitiesReportsRenderAndMedia(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "plex-pre-rolls")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	media := filepath.Join(dir, "media")
	if err := os.MkdirAll(media, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Server{ManifestDir: dir, RenderBin: bin, MediaDirs: []string{media}}
	caps := s.capabilitySet()
	if !caps.Render {
		t.Error("an executable render binary must report render:true")
	}
	if !caps.Media {
		t.Error("an existing media dir must report media:true")
	}
}
