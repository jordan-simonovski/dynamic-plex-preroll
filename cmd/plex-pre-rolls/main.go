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
	"strings"
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

	// Fail before rendering, not after: a multi-manifest run is expensive.
	prerollSep := ""
	if config.SetPreroll {
		if config.PrerollServerDir == "" {
			log.Fatalf("PLEX_SET_PREROLL=true requires PLEX_PREROLL_SERVER_DIR (the output directory as the Plex server sees it)")
		}
		sep, err := config.PrerollMode.Separator()
		if err != nil {
			log.Fatalf("config: %v", err)
		}
		prerollSep = sep
	}

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
	discoverClient := plexclient.NewDiscoverClient(config.PlexToken, config.Debug)
	plexprovider.Register(registry, plexClient, discoverClient)

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
	var outputs []string
	for _, path := range paths {
		output, err := runManifest(eng, path, vars)
		if err != nil {
			log.Printf("ERROR: %s: %v", describe(path), err)
			failures++
			continue
		}
		outputs = append(outputs, output)
	}
	if failures > 0 {
		// A half-failed batch must not touch the server preference.
		log.Fatalf("%d of %d manifest(s) failed", failures, len(paths))
	}
	if config.SetPreroll {
		if err := updatePreroll(plexClient, outputs, config.PrerollServerDir, prerollSep); err != nil {
			log.Fatalf("preroll pref: %v", err)
		}
	}
}

// runManifest loads and renders a single manifest, returning the output path.
func runManifest(eng *engine.Engine, path string, vars map[string]any) (string, error) {
	preroll, err := loadManifest(path)
	if err != nil {
		return "", err
	}
	if err := eng.Run(context.Background(), preroll, vars); err != nil {
		return "", err
	}
	log.Printf("wrote %s (from %s)", preroll.Output, describe(path))
	return preroll.Output, nil
}

// updatePreroll appends this run's outputs (rebased onto the directory the
// Plex server sees) to the server's pre-roll preference. Existing entries are
// kept; entries already present are not re-added; if nothing is new the
// preference is left untouched.
func updatePreroll(client *plexclient.PlexClient, outputs []string, serverDir, defaultSep string) error {
	additions := make([]string, 0, len(outputs))
	for _, out := range outputs {
		p := serverPath(serverDir, filepath.Base(out))
		// "," and ";" are Plex's list separators; a path containing either
		// would corrupt the preference value.
		if strings.ContainsAny(p, ",;") {
			return fmt.Errorf("output path %q contains a Plex list separator (',' or ';')", p)
		}
		additions = append(additions, p)
	}

	current, err := client.GetPreroll()
	if err != nil {
		return err
	}
	merged, changed := plexclient.MergePrerolls(current, additions, defaultSep)
	if !changed {
		log.Printf("preroll pref already lists all %d output(s); leaving it untouched", len(additions))
		return nil
	}
	if err := client.SetPreroll(merged); err != nil {
		return err
	}
	log.Printf("preroll pref updated: %s", merged)
	return nil
}

// serverPath joins name onto dir using the separator style dir already uses;
// the Plex server may run on Windows while this tool renders on Linux, so
// filepath.Join (host-native) is wrong here.
func serverPath(dir, name string) string {
	if strings.Contains(dir, "\\") {
		return strings.TrimRight(dir, "\\") + "\\" + name
	}
	return strings.TrimRight(dir, "/") + "/" + name
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
