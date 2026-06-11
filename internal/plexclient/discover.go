package plexclient

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
)

// DiscoverBaseURL is the Plex Discover cloud API. Unlike the local server it
// requires a plex.tv account token (what cmd/plex-token produces).
const DiscoverBaseURL = "https://discover.provider.plex.tv"

// NewDiscoverClient returns a client pointed at the Plex Discover API. TLS is
// always verified (PLEX_INSECURE only applies to the local server), so no
// custom HTTP client is taken.
func NewDiscoverClient(token configmanager.Secret, debug bool) *PlexClient {
	return &PlexClient{
		PlexToken: token,
		PlexURL:   DiscoverBaseURL,
		Debug:     debug,
	}
}

// WatchlistItems returns the account's watchlist. filter is all, available or
// released (Discover's /library/sections/watchlist/{filter} endpoint); params
// pass through (libtype, sort, limit). Items carry Discover metadata: GUID and
// absolute image URLs, but no local RatingKey.
func (client *PlexClient) WatchlistItems(filter string, params url.Values) (content.Items, error) {
	if strings.TrimSpace(filter) == "" {
		filter = "all"
	}
	path := "/library/sections/watchlist/" + filter
	decoded := &itemsResponse{}
	if err := client.getJSON(path, params, decoded); err != nil {
		return nil, accountTokenHint(err)
	}
	return discoverItems(decoded.MediaContainer.Metadata), nil
}

// HomeHubs returns the Discover home hub rows (trending, top watchlisted,
// ...). The hub set is not a documented API surface; callers must select hubs
// by identifier and handle absence.
func (client *PlexClient) HomeHubs(params url.Values) ([]content.Hub, error) {
	var decoded hubsResponse
	if err := client.getJSON("/hubs/sections/home", params, &decoded); err != nil {
		return nil, accountTokenHint(err)
	}
	hubs := make([]content.Hub, 0, len(decoded.MediaContainer.Hub))
	for _, h := range decoded.MediaContainer.Hub {
		hubs = append(hubs, content.Hub{
			Identifier: h.HubIdentifier,
			Title:      h.Title,
			Items:      discoverItems(h.Metadata),
		})
	}
	return hubs, nil
}

// discoverItems maps Discover metadata to items. Discover serves absolute,
// unauthenticated image URLs, so unlike listItems nothing is prefixed or
// token-stamped. RatingKey is deliberately dropped: Discover rating keys are
// cloud ids and must not be mistaken for local ones.
func discoverItems(metadata []metadataItem) content.Items {
	items := make(content.Items, 0, len(metadata))
	for _, m := range metadata {
		items = append(items, content.Item{
			Name:  m.Title,
			GUID:  m.GUID,
			Type:  m.Type,
			Art:   m.Art,
			Thumb: m.Thumb,
		})
	}
	return items
}

// accountTokenHint decorates a Discover 401 with the actual cause: the token
// is not a plex.tv account token.
func accountTokenHint(err error) error {
	var status *statusError
	if errors.As(err, &status) && status.code == http.StatusUnauthorized {
		return fmt.Errorf("%w (Discover requires a plex.tv account token; get one with cmd/plex-token)", err)
	}
	return err
}
