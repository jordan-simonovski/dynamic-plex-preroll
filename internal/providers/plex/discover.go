package plex

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
)

// Provider names for the Plex Discover (cloud) backed sources.
const (
	ProviderWatchlist = "plex.watchlist"
	ProviderTrending  = "plex.trending"
)

// discoverPool is how many items are fetched from Discover when an inLibrary
// filter must be applied locally: filtering happens after the fetch, so the
// pool has to be larger than the requested limit or the result starves.
const discoverPool = 40

// DiscoverClient is the slice of plexclient that talks to the Plex Discover
// cloud API. Kept as an interface so providers can be unit-tested with a fake.
type DiscoverClient interface {
	WatchlistItems(filter string, params url.Values) (content.Items, error)
	HomeHubs(params url.Values) ([]content.Hub, error)
}

// watchlistProvider serves plex.watchlist: the account's Discover watchlist,
// optionally matched against the local library.
type watchlistProvider struct {
	discover DiscoverClient
	local    Client
}

func (p watchlistProvider) Fetch(_ context.Context, params map[string]string) (content.Items, error) {
	filter := strings.ToLower(strings.TrimSpace(params["filter"]))
	if filter == "" {
		filter = "all"
	}
	switch filter {
	case "all", "available", "released":
	default:
		return nil, fmt.Errorf("plex.watchlist: invalid filter %q (want all, available or released)", params["filter"])
	}

	q := url.Values{}
	if t := params["type"]; t != "" {
		q.Set("libtype", strings.ToLower(t))
	}
	setIfPresent(q, "sort", params["sort"])
	if params["inLibrary"] != "" {
		// Local filtering discards items, so fetch a pool and trim after.
		q.Set("limit", strconv.Itoa(discoverPool))
	} else {
		setIfPresent(q, "limit", params["limit"])
	}

	items, err := p.discover.WatchlistItems(filter, q)
	if err != nil {
		return nil, err
	}
	return finishDiscover(p.local, items, params)
}

// trendingProvider serves plex.trending: the trending row on the Discover
// home screen. The hub set is undocumented, so the hub is selected by
// identifier rather than a hardcoded path, and absence is a hard error.
type trendingProvider struct {
	discover DiscoverClient
	local    Client
}

func (p trendingProvider) Fetch(_ context.Context, params map[string]string) (content.Items, error) {
	hubs, err := p.discover.HomeHubs(url.Values{})
	if err != nil {
		return nil, err
	}

	hub, ok := trendingHub(hubs)
	if !ok {
		return nil, fmt.Errorf(
			"plex.trending: no trending hub on Discover home (hubs found: %s); the feed is undocumented and may have moved",
			hubIdentifiers(hubs))
	}

	items := hub.Items
	if t := strings.ToLower(strings.TrimSpace(params["type"])); t != "" {
		kept := make(content.Items, 0, len(items))
		for _, item := range items {
			if item.Type == t {
				kept = append(kept, item)
			}
		}
		items = kept
	}
	if params["inLibrary"] == "" {
		// No local filtering ahead: trim now so GUID matching stays bounded.
		items = trim(items, params["limit"])
	}
	return finishDiscover(p.local, items, params)
}

// trendingHub picks the first hub whose identifier mentions trending.
func trendingHub(hubs []content.Hub) (content.Hub, bool) {
	for _, hub := range hubs {
		if strings.Contains(strings.ToLower(hub.Identifier), "trending") {
			return hub, true
		}
	}
	return content.Hub{}, false
}

func hubIdentifiers(hubs []content.Hub) string {
	if len(hubs) == 0 {
		return "none"
	}
	ids := make([]string, 0, len(hubs))
	for _, hub := range hubs {
		ids = append(ids, hub.Identifier)
	}
	return strings.Join(ids, ", ")
}

// finishDiscover applies the shared post-processing for Discover sources:
// GUID-match items against the local library (when needed), apply the
// inLibrary filter, trim to limit, and resolve trailers for matched items.
func finishDiscover(local Client, items content.Items, params map[string]string) (content.Items, error) {
	libFilter := strings.TrimSpace(params["inLibrary"])
	wantTrailers := isTrue(params["trailers"])

	if libFilter != "" || wantTrailers {
		if err := matchLocal(local, items); err != nil {
			return nil, err
		}
	}
	if libFilter != "" {
		wantMatched := isTrue(libFilter)
		kept := make(content.Items, 0, len(items))
		for _, item := range items {
			if (item.RatingKey != "") == wantMatched {
				kept = append(kept, item)
			}
		}
		items = kept
	}
	items = trim(items, params["limit"])
	if wantTrailers {
		return attachTrailers(local, items)
	}
	return items, nil
}

// matchLocal resolves each item's GUID in the local library, attaching the
// local RatingKey on a hit. Discover metadata is otherwise kept as-is.
func matchLocal(local Client, items content.Items) error {
	for i := range items {
		if items[i].GUID == "" {
			continue
		}
		match, ok, err := local.FindByGUID(items[i].GUID)
		if err != nil {
			return err
		}
		if ok {
			items[i].RatingKey = match.RatingKey
		}
	}
	return nil
}

// trim cuts items to a positive numeric limit; anything else is a no-op.
func trim(items content.Items, limit string) content.Items {
	if n, err := strconv.Atoi(limit); err == nil && n > 0 && n < len(items) {
		return items[:n]
	}
	return items
}
