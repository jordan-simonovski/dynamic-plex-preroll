package main

import (
	"context"
	"crypto/tls"
	_ "embed"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/engine"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/plexclient"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
	plexprovider "github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers/plex"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/render"
	"gopkg.in/gographics/imagick.v2/imagick"
)

//go:embed default-manifest.yaml
var defaultManifest []byte

func main() {
	manifestPath := flag.String("manifest", os.Getenv("MANIFEST_PATH"), "path to a single pre-roll manifest (defaults to the built-in manifest)")
	manifestDir := flag.String("manifest-dir", os.Getenv("MANIFEST_DIR"), "directory of manifests to render in a batch; overrides -manifest")
	flag.Parse()

	config := configmanager.MustReadConfig()

	paths, err := manifestPaths(*manifestDir, *manifestPath)
	if err != nil {
		log.Fatalf("manifest: %v", err)
	}

	imagick.Initialize()
	defer imagick.Terminate()

	plexClient := &plexclient.PlexClient{
		PlexToken:       config.PlexToken,
		PlexURL:         config.PlexURL,
		PeriodInterval:  config.PeriodInterval.ToInt(),
		MovieSectionId:  config.MovieSectionId,
		TVShowSectionId: config.TVShowSectionId,
		MaxItems:        config.MaxItems,
		Debug:           config.Debug,
	}

	if config.PlexInsecure {
		plexClient.HTTPClient = &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		}
		log.Printf("WARNING: PLEX_INSECURE=true, skipping TLS certificate verification")
	}

	if config.Debug {
		log.Printf("debug logging enabled (plex url %s, period %s, sections tv=%s movie=%s)",
			config.PlexURL, config.PeriodInterval, config.TVShowSectionId, config.MovieSectionId)
		plexClient.Diagnose()
	}

	registry := providers.NewRegistry()
	plexprovider.Register(registry, plexClient)

	eng := &engine.Engine{
		Providers: registry,
		Renderer:  render.Renderer{},
		Fetch:     plexClient.Download,
	}

	vars := map[string]any{
		"Period":          config.PeriodInterval.ToString(),
		"PeriodInterval":  string(config.PeriodInterval),
		"MovieSectionId":  config.MovieSectionId,
		"TVShowSectionId": config.TVShowSectionId,
		"MaxItems":        config.MaxItems,
	}

	// Batch mode keeps going past a bad manifest so one typo does not sink the
	// whole run; the process still exits non-zero if anything failed.
	failures := 0
	for _, path := range paths {
		if err := runManifest(eng, path, vars); err != nil {
			log.Printf("ERROR: %s: %v", describe(path), err)
			failures++
		}
	}
	if failures > 0 {
		log.Fatalf("%d of %d manifest(s) failed", failures, len(paths))
	}
}

// runManifest loads and renders a single manifest.
func runManifest(eng *engine.Engine, path string, vars map[string]any) error {
	preroll, err := loadManifest(path)
	if err != nil {
		return err
	}
	if err := eng.Run(context.Background(), preroll, vars); err != nil {
		return err
	}
	log.Printf("wrote %s (from %s)", preroll.Output, describe(path))
	return nil
}

// manifestPaths resolves which manifests to render. A directory (batch mode)
// takes precedence over a single path; an empty single path means the embedded
// default. Directory entries are sorted for deterministic ordering.
func manifestPaths(dir, single string) ([]string, error) {
	if dir == "" {
		return []string{single}, nil
	}
	if single != "" {
		log.Printf("MANIFEST_DIR set, ignoring MANIFEST_PATH=%s", single)
	}
	var paths []string
	for _, pattern := range []string{"*.yaml", "*.yml"} {
		matches, err := filepath.Glob(filepath.Join(dir, pattern))
		if err != nil {
			return nil, err
		}
		paths = append(paths, matches...)
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no .yaml/.yml manifests found in %s", dir)
	}
	sort.Strings(paths)
	return paths, nil
}

// describe gives a human label for a manifest path, naming the built-in default
// when the path is empty.
func describe(path string) string {
	if path == "" {
		return "built-in default"
	}
	return path
}

// loadManifest reads the manifest from path, or falls back to the embedded
// default when no path is given.
func loadManifest(path string) (*manifest.Preroll, error) {
	if path != "" {
		return manifest.Load(path)
	}
	return manifest.Parse(defaultManifest)
}
