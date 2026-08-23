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

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/webui"
)

func main() {
	addr := flag.String("addr", envOr("UI_ADDR", ":8382"), "listen address")
	dir := flag.String("manifest-dir", envOr("MANIFEST_DIR", "manifests"), "directory manifests are read from and saved to")
	flag.Parse()

	if err := os.MkdirAll(*dir, 0o755); err != nil {
		log.Fatalf("manifest dir: %v", err)
	}
	srv := &webui.Server{ManifestDir: *dir}
	log.Printf("pre-roll config UI listening on %s (manifests in %s)", *addr, *dir)
	log.Fatal(http.ListenAndServe(*addr, srv.Handler()))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
