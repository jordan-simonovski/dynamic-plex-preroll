// Command preroll-ui serves the pre-roll config UI: a browser-based editor
// that builds manifests and saves them into the manifest directory the batch
// renderer reads. Pure Go — no ImageMagick/ffmpeg needed, so it builds and
// runs anywhere with CGO_ENABLED=0.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/webui"
)

func main() {
	addr := flag.String("addr", envOr("UI_ADDR", ":8382"), "listen address")
	dir := flag.String("manifest-dir", envOr("MANIFEST_DIR", "manifests"), "directory manifests are read from and saved to")
	media := flag.String("media-dir", envOr("MEDIA_DIR", "media"), "comma-separated directories the file picker may browse and serve from")
	flag.Parse()

	if err := os.MkdirAll(*dir, 0o755); err != nil {
		log.Fatalf("manifest dir: %v", err)
	}
	srv := &webui.Server{
		ManifestDir: *dir,
		MediaDirs:   splitDirs(*media),
	}
	// Plex is optional: without it the editor shows placeholder data and the
	// UI says so. A missing token must never stop the editor from starting.
	if plex, err := webui.NewPlexSource(); err != nil {
		srv.PlexError = err.Error()
		log.Printf("plex data previews disabled: %v", err)
	} else {
		srv.Plex = plex
		log.Printf("plex data previews enabled (%s)", plex.BaseURL)
	}
	log.Printf("pre-roll config UI listening on %s (manifests in %s)", *addr, *dir)
	log.Fatal(http.ListenAndServe(*addr, srv.Handler()))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// splitDirs turns a comma-separated flag value into a list, dropping blanks so
// an empty or trailing-comma value yields no roots rather than the working
// directory.
func splitDirs(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
