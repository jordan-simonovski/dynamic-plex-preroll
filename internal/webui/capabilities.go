package webui

import (
	"net/http"
	"os"
)

// capabilities tells the browser which optional features this deployment can
// actually perform, so the UI hides what would only fail. Everything here is
// off by default: the editor's core (edit, validate, save) never depends on it.
type capabilities struct {
	Plex   bool `json:"plex"`
	Render bool `json:"render"`
	Media  bool `json:"media"`
	// PlexError explains why Plex is off, so the UI can say "PLEX_TOKEN unset"
	// instead of silently showing placeholders forever.
	PlexError string `json:"plexError,omitempty"`
}

func (s *Server) capabilities(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.capabilitySet())
}

// capabilitySet probes the filesystem each call rather than caching: a user who
// mounts a media volume or drops the render binary in place mid-session should
// see the feature appear on the next reload, not need a restart.
func (s *Server) capabilitySet() capabilities {
	caps := capabilities{}
	if info, err := os.Stat(s.RenderBin); s.RenderBin != "" && err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
		caps.Render = true
	}
	for _, dir := range s.MediaDirs {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			caps.Media = true
			break
		}
	}
	caps.Plex = s.Plex != nil && s.Plex.Registry != nil
	if !caps.Plex {
		caps.PlexError = s.PlexError
	}
	return caps
}
