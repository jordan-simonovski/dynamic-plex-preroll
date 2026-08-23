// Package plex implements data providers backed by a Plex Media Server.
package plex

import (
	"context"
	"fmt"
	"math/rand"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
)

// Provider names as referenced from a manifest.
const (
	ProviderTop         = "plex.top"
	ProviderUnwatched   = "plex.unwatched"
	ProviderTrailers    = "plex.trailers"
	ProviderSection     = "plex.section"
	ProviderCollections = "plex.collections"
)

// sectionPool is how many items plex.section samples from when random:true is
// set, before shuffling and trimming to the requested limit.
const sectionPool = 200

// Client is the slice of plexclient the providers depend on. Kept as an
// interface so providers can be unit-tested with a fake.
type Client interface {
	TopItems(ctx context.Context, params url.Values) (content.Items, error)
	SectionItems(ctx context.Context, sectionID string, params url.Values) (content.Items, error)
	CollectionItems(ctx context.Context, sectionID string, params url.Values) (content.Items, error)
	Extras(ctx context.Context, ratingKey string) (content.Items, error)
	FindByGUID(ctx context.Context, guid string) (content.Item, bool, error)
}

// Register wires the Plex-backed providers into reg. client talks to the
// local server; discover talks to the Plex Discover cloud API.
func Register(reg *providers.Registry, client Client, discover DiscoverClient) {
	reg.Register(ProviderTop, topProvider{client})
	reg.Register(ProviderUnwatched, unwatchedProvider{client})
	reg.Register(ProviderTrailers, trailersProvider{client})
	reg.Register(ProviderSection, sectionProvider{client})
	reg.Register(ProviderCollections, collectionsProvider{client})
	reg.Register(ProviderWatchlist, watchlistProvider{discover, client})
	reg.Register(ProviderTrending, trendingProvider{discover, client})
}

// topProvider serves plex.top: most-viewed items in a section/period.
type topProvider struct{ client Client }

func (p topProvider) Fetch(ctx context.Context, params map[string]string) (content.Items, error) {
	q := url.Values{}
	setIfPresent(q, "limit", params["limit"])
	if t := params["type"]; t != "" {
		q.Set("type", plexType(t))
	}
	setIfPresent(q, "librarySectionID", params["section"])
	if days := periodDays(params["period"]); days > 0 {
		// Plex datetime filters use the ">>" ("is greater than") operator;
		// url.Values supplies the trailing "=", yielding "viewedAt>>=<ts>".
		q.Set("viewedAt>>", fmt.Sprint(time.Now().AddDate(0, 0, -days).Unix()))
	}
	items, err := p.client.TopItems(ctx, q)
	if err != nil {
		return nil, err
	}
	if isTrue(params["trailers"]) {
		return attachTrailers(ctx, p.client, items)
	}
	return items, nil
}

// unwatchedProvider serves plex.unwatched: unwatched items in a section.
type unwatchedProvider struct{ client Client }

func (p unwatchedProvider) Fetch(ctx context.Context, params map[string]string) (content.Items, error) {
	section := params["section"]
	if section == "" {
		return nil, fmt.Errorf("plex.unwatched: section is required")
	}
	q := url.Values{"unwatched": {"1"}}
	if t := params["type"]; t != "" {
		q.Set("type", plexType(t))
	}
	setIfPresent(q, "sort", params["sort"])
	setIfPresent(q, "limit", params["limit"])
	return p.client.SectionItems(ctx, section, q)
}

// trailersProvider serves plex.trailers: resolves a streamable trailer URL for
// each candidate item in a section.
type trailersProvider struct{ client Client }

func (p trailersProvider) Fetch(ctx context.Context, params map[string]string) (content.Items, error) {
	section := params["section"]
	if section == "" {
		return nil, fmt.Errorf("plex.trailers: section is required")
	}

	q := url.Values{}
	if strings.EqualFold(params["filter"], "unwatched") {
		q.Set("unwatched", "1")
	}
	if t := params["type"]; t != "" {
		q.Set("type", plexType(t))
	} else {
		q.Set("type", plexType("movie"))
	}
	setIfPresent(q, "sort", params["sort"])
	setIfPresent(q, "limit", params["limit"])

	candidates, err := p.client.SectionItems(ctx, section, q)
	if err != nil {
		return nil, err
	}

	trailers := make(content.Items, 0, len(candidates))
	for _, item := range candidates {
		if item.RatingKey == "" {
			continue
		}
		extras, err := p.client.Extras(ctx, item.RatingKey)
		if err != nil {
			return nil, err
		}
		for _, extra := range extras {
			if extra.MediaURL != "" {
				trailers = append(trailers, content.Item{
					Name:      item.Name,
					RatingKey: item.RatingKey,
					MediaURL:  extra.MediaURL,
				})
				break
			}
		}
	}
	return trailers, nil
}

// sectionProvider serves plex.section: a general listing of a library section.
// Reserved params map to known query knobs; any other param is passed through
// verbatim as a Plex filter (e.g. decade=1990, year>>=2000, genre=<tagID>), so
// the manifest can express filters the provider doesn't model explicitly.
type sectionProvider struct{ client Client }

var sectionReserved = map[string]bool{
	"section": true, "type": true, "sort": true, "limit": true,
	"unwatched": true, "random": true, "trailers": true,
}

func (p sectionProvider) Fetch(ctx context.Context, params map[string]string) (content.Items, error) {
	section := params["section"]
	if section == "" {
		return nil, fmt.Errorf("plex.section: section is required")
	}
	random := isTrue(params["random"])

	q := url.Values{}
	if t := params["type"]; t != "" {
		q.Set("type", plexType(t))
	}
	setIfPresent(q, "sort", params["sort"])
	if isTrue(params["unwatched"]) {
		q.Set("unwatched", "1")
	}
	if random {
		// Sample a pool, then shuffle/trim locally for an even draw.
		q.Set("limit", strconv.Itoa(sectionPool))
	} else {
		setIfPresent(q, "limit", params["limit"])
	}
	for key, value := range params {
		if value == "" || sectionReserved[key] {
			continue
		}
		q.Set(key, value)
	}

	items, err := p.client.SectionItems(ctx, section, q)
	if err != nil {
		return nil, err
	}
	if random {
		rand.Shuffle(len(items), func(i, j int) { items[i], items[j] = items[j], items[i] })
		if n, err := strconv.Atoi(params["limit"]); err == nil && n > 0 && n < len(items) {
			items = items[:n]
		}
	}
	if isTrue(params["trailers"]) {
		return attachTrailers(ctx, p.client, items)
	}
	return items, nil
}

// attachTrailers resolves each item's first streamable trailer (via the extras
// endpoint) into its MediaURL, leaving items without one untouched. This lets a
// single data source feed both list text and a matching trailer background.
func attachTrailers(ctx context.Context, client Client, items content.Items) (content.Items, error) {
	for i := range items {
		if items[i].RatingKey == "" {
			continue
		}
		extras, err := client.Extras(ctx, items[i].RatingKey)
		if err != nil {
			return nil, err
		}
		for _, extra := range extras {
			if extra.MediaURL != "" {
				items[i].MediaURL = extra.MediaURL
				break
			}
		}
	}
	return items, nil
}

// collectionsProvider serves plex.collections: the collections in a section,
// each item's child count exposed as Views.
type collectionsProvider struct{ client Client }

func (p collectionsProvider) Fetch(ctx context.Context, params map[string]string) (content.Items, error) {
	section := params["section"]
	if section == "" {
		return nil, fmt.Errorf("plex.collections: section is required")
	}
	q := url.Values{}
	setIfPresent(q, "sort", params["sort"])
	setIfPresent(q, "limit", params["limit"])
	return p.client.CollectionItems(ctx, section, q)
}

// isTrue reports whether a manifest string param denotes an enabled flag.
func isTrue(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func setIfPresent(q url.Values, key, value string) {
	if value != "" {
		q.Set(key, value)
	}
}

// plexType maps friendly type names to Plex numeric library types, passing
// through any value that is already numeric.
func plexType(name string) string {
	switch strings.ToLower(name) {
	case "movie":
		return "1"
	case "show":
		return "2"
	case "season":
		return "3"
	case "episode":
		return "4"
	default:
		return name
	}
}

// periodDays converts a period name (DAY/WEEK/MONTH/YEAR) to days; 0 if unset.
func periodDays(period string) int {
	return configmanager.Period(strings.ToUpper(period)).ToInt()
}
