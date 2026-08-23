package webui

import (
	"crypto/tls"
	"net/http"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/plexclient"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
	plexprovider "github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers/plex"
)

// PlexSource is the UI's optional live connection to Plex: the same provider
// registry and template variables the batch renderer builds, so a "Test this
// source" in the editor runs exactly what a render will run. It is a pointer
// on Server and nil whenever Plex is not configured — every caller checks.
//
// This file imports plexclient/providers, all of which are CGO-free. It must
// never reach for render/engine/pipeline: preroll-ui stays CGO_ENABLED=0.
type PlexSource struct {
	Registry *providers.Registry
	// Vars are the globals every template string resolves against, matching
	// cmd/plex-pre-rolls/main.go so previews and renders agree.
	Vars map[string]any
	// BaseURL is the Plex server root. It is the allowlist for the image
	// proxy: nothing outside it (or the two Plex CDN hosts) is ever fetched.
	BaseURL string
	// HTTPClient honours PLEX_INSECURE the same way the renderer does.
	HTTPClient *http.Client
}

// NewPlexSource builds the live connection from the environment, or explains
// why it cannot. A nil source is a supported, ordinary state: the editor falls
// back to placeholder data and says so.
func NewPlexSource() (*PlexSource, error) {
	config, err := configmanager.ReadConfig()
	if err != nil {
		return nil, err
	}
	client := &plexclient.PlexClient{
		PlexToken:       config.PlexToken,
		PlexURL:         config.PlexURL,
		PeriodInterval:  config.PeriodInterval.ToInt(),
		MovieSectionId:  config.MovieSectionId,
		TVShowSectionId: config.TVShowSectionId,
		MaxItems:        config.MaxItems,
		Debug:           config.Debug,
	}
	httpClient := &http.Client{Timeout: 30 * time.Second}
	if config.PlexInsecure {
		httpClient.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // opt-in via PLEX_INSECURE, same as the renderer
		}
	}
	client.HTTPClient = httpClient

	registry := providers.NewRegistry()
	plexprovider.Register(registry, client, plexclient.NewDiscoverClient(config.PlexToken, config.Debug))

	return &PlexSource{
		Registry: registry,
		Vars: map[string]any{
			"Period":          config.PeriodInterval.ToString(),
			"PeriodInterval":  string(config.PeriodInterval),
			"MovieSectionId":  config.MovieSectionId,
			"TVShowSectionId": config.TVShowSectionId,
			"MaxItems":        config.MaxItems,
		},
		BaseURL:    config.PlexURL,
		HTTPClient: httpClient,
	}, nil
}
