package plexclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
)

const topItemsPath = "/library/all/top"

var defaultHTTPClient = &http.Client{Timeout: 30 * time.Second}

// GetMostViewedContent returns the most-viewed shows and movies within the
// configured period. Retained as a convenience wrapper over TopItems.
func (client *PlexClient) GetMostViewedContent() (shows, movies content.Items, err error) {
	since := time.Now().AddDate(0, 0, -client.PeriodInterval).Unix()
	base := func(sectionType string) url.Values {
		return url.Values{
			"limit":     {fmt.Sprint(client.MaxItems)},
			"viewedAt>": {fmt.Sprint(since)},
			"type":      {sectionType},
		}
	}

	shows, err = client.TopItems(base(client.TVShowSectionId))
	if err != nil {
		return nil, nil, err
	}
	movies, err = client.TopItems(base(client.MovieSectionId))
	if err != nil {
		return nil, nil, err
	}
	return shows, movies, nil
}

// TopItems queries /library/all/top with the supplied filters.
func (client *PlexClient) TopItems(params url.Values) (content.Items, error) {
	return client.listItems(topItemsPath, params)
}

// SectionItems queries /library/sections/{id}/all with the supplied filters
// (e.g. type, unwatched, sort, limit).
func (client *PlexClient) SectionItems(sectionID string, params url.Values) (content.Items, error) {
	if strings.TrimSpace(sectionID) == "" {
		return nil, fmt.Errorf("plex: section id is required")
	}
	return client.listItems("/library/sections/"+sectionID+"/all", params)
}

// CollectionItems lists the collections in a section. The collection's child
// count is surfaced as Views so a manifest can render "(N titles)".
func (client *PlexClient) CollectionItems(sectionID string, params url.Values) (content.Items, error) {
	if strings.TrimSpace(sectionID) == "" {
		return nil, fmt.Errorf("plex: section id is required")
	}
	decoded, err := client.fetch("/library/sections/"+sectionID+"/collections", params)
	if err != nil {
		return nil, err
	}
	items := make(content.Items, 0, len(decoded.MediaContainer.Metadata))
	for _, m := range decoded.MediaContainer.Metadata {
		items = append(items, content.Item{
			Name:      m.Title,
			Views:     m.ChildCount,
			RatingKey: m.RatingKey,
			Art:       client.imageURL(m.Art),
			Thumb:     client.imageURL(m.Thumb),
		})
	}
	return items, nil
}

// Extras returns the extras (trailers, behind-the-scenes, etc.) attached to an
// item. Each returned content.Item carries a RatingKey and a fully-qualified,
// token-authenticated MediaURL suitable as an ffmpeg input.
func (client *PlexClient) Extras(ratingKey string) (content.Items, error) {
	if strings.TrimSpace(ratingKey) == "" {
		return nil, fmt.Errorf("plex: rating key is required")
	}
	decoded, err := client.fetch("/library/metadata/"+ratingKey+"/extras", url.Values{})
	if err != nil {
		return nil, err
	}

	items := make(content.Items, 0, len(decoded.MediaContainer.Metadata))
	for _, m := range decoded.MediaContainer.Metadata {
		partKey := firstPartKey(m)
		if partKey == "" {
			continue
		}
		items = append(items, content.Item{
			Name:      m.Title,
			RatingKey: m.RatingKey,
			MediaURL:  client.mediaURL(partKey),
		})
	}
	return items, nil
}

// FindByGUID looks an agent GUID (e.g. plex://movie/...) up in the local
// library, returning the first match. Used to tie items from cloud sources
// (watchlist, trending) back to local media for trailer resolution.
func (client *PlexClient) FindByGUID(guid string) (content.Item, bool, error) {
	if strings.TrimSpace(guid) == "" {
		return content.Item{}, false, fmt.Errorf("plex: guid is required")
	}
	items, err := client.listItems("/library/all", url.Values{"guid": {guid}})
	if err != nil {
		return content.Item{}, false, err
	}
	if len(items) == 0 {
		return content.Item{}, false, nil
	}
	return items[0], true, nil
}

// listItems issues a GET and maps the metadata into content.Items.
func (client *PlexClient) listItems(path string, params url.Values) (content.Items, error) {
	decoded, err := client.fetch(path, params)
	if err != nil {
		return nil, err
	}
	items := make(content.Items, 0, len(decoded.MediaContainer.Metadata))
	for _, m := range decoded.MediaContainer.Metadata {
		items = append(items, content.Item{
			Name:      m.Title,
			Views:     viewCount(m),
			RatingKey: m.RatingKey,
			GUID:      m.GUID,
			Type:      m.Type,
			Art:       client.imageURL(m.Art),
			Thumb:     client.imageURL(m.Thumb),
		})
	}
	return items, nil
}

// statusError is a non-200 response, kept typed so callers can react to
// specific codes (e.g. 401 from Discover means wrong kind of token).
type statusError struct {
	code int
	path string
}

func (e *statusError) Error() string {
	return fmt.Sprintf("plex: unexpected status %d for %s", e.code, e.path)
}

// fetch performs the request and decodes the lean listing shape.
func (client *PlexClient) fetch(path string, params url.Values) (*itemsResponse, error) {
	var decoded itemsResponse
	if err := client.getJSON(path, params, &decoded); err != nil {
		return nil, err
	}
	if client.Debug {
		log.Printf("plex: %s decoded %d items", path, len(decoded.MediaContainer.Metadata))
	}
	return &decoded, nil
}

// getJSON performs an authenticated GET and decodes the body into dst.
func (client *PlexClient) getJSON(path string, params url.Values, dst any) error {
	resp, err := client.GetURL(path, params)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &statusError{code: resp.StatusCode, path: path}
	}
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		return fmt.Errorf("plex: decode %s: %w", path, err)
	}
	return nil
}

// Diagnose probes a sequence of endpoints (simplest first) and logs the outcome
// of each. It isolates whether a failure is connectivity-wide or specific to one
// endpoint/param set. Best-effort: it never returns an error and reads from the
// container's network perspective, which is what actually runs the pre-roll.
func (client *PlexClient) Diagnose() {
	type probe struct {
		path   string
		params url.Values
	}
	since := fmt.Sprint(time.Now().AddDate(0, 0, -client.PeriodInterval).Unix())
	probes := []probe{
		{"/identity", url.Values{}},
		{"/library/sections", url.Values{}},
		{topItemsPath, url.Values{"type": {"2"}, "librarySectionID": {client.TVShowSectionId}}},
		{topItemsPath, url.Values{"type": {"2"}, "librarySectionID": {client.TVShowSectionId}, "limit": {fmt.Sprint(client.MaxItems)}, "viewedAt>>": {since}}},
	}
	for _, p := range probes {
		resp, err := client.GetURL(p.path, p.params)
		if err != nil {
			log.Printf("plex: probe %s %v -> ERROR: %v", p.path, p.params, err)
			continue
		}
		log.Printf("plex: probe %s %v -> %s", p.path, p.params, resp.Status)
		resp.Body.Close()
	}
}

// Download fetches rawURL (already token-authenticated) to dest using the
// client's HTTP client, so it honours the same TLS settings as API calls. The
// token is redacted from any returned error.
func (client *PlexClient) Download(ctx context.Context, rawURL, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	resp, err := client.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("plex: download %s: %s", client.redact(rawURL), client.redact(err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("plex: download %s: status %d", client.redact(rawURL), resp.StatusCode)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return fmt.Errorf("plex: download %s: %w", client.redact(rawURL), err)
	}
	return nil
}

// GetLibrarySectionIds prints the available library sections. Diagnostic helper.
func (client *PlexClient) GetLibrarySectionIds() error {
	resp, err := client.GetURL("/library/sections", url.Values{})
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("plex: unexpected status %d", resp.StatusCode)
	}

	var libraryResponse LibraryResponse
	if err := json.NewDecoder(resp.Body).Decode(&libraryResponse); err != nil {
		return err
	}
	for _, directory := range libraryResponse.MediaContainer.Directory {
		fmt.Println(directory.Key, directory.Title)
	}
	return nil
}

// GetURL issues an authenticated GET against the Plex server. The supplied
// params are not mutated; the auth token is added to a local copy. The token is
// always redacted from logs and returned errors.
func (client *PlexClient) GetURL(urlPath string, params url.Values) (*http.Response, error) {
	query := make(url.Values, len(params)+1)
	for key, values := range params {
		query[key] = values
	}
	query.Set("X-Plex-Token", string(client.PlexToken))

	fullURL := client.PlexURL + urlPath + "?" + query.Encode()
	safeURL := client.redact(fullURL)

	req, err := http.NewRequest(http.MethodGet, fullURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	if client.Debug {
		log.Printf("plex: GET %s", safeURL)
	}
	start := time.Now()
	resp, err := client.httpClient().Do(req)
	if err != nil {
		// Redact the underlying error too: net/http's *url.Error embeds the
		// full request URL (with token). Wrapping with %w would leak it.
		return nil, fmt.Errorf("plex: GET %s: %s", safeURL, client.redact(err.Error()))
	}
	if client.Debug {
		log.Printf("plex: GET %s -> %s in %s", safeURL, resp.Status, time.Since(start))
	}
	return resp, nil
}

// redact removes the Plex token from a URL so it never lands in logs or errors.
func (client *PlexClient) redact(s string) string {
	token := string(client.PlexToken)
	if token == "" {
		return s
	}
	s = strings.ReplaceAll(s, url.QueryEscape(token), "****")
	return strings.ReplaceAll(s, token, "****")
}

// imageURL builds a token-authenticated, absolute URL for an art/thumb path,
// returning "" when the path is empty so callers can treat it as "no image".
func (client *PlexClient) imageURL(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	return client.mediaURL(path)
}

// mediaURL builds a token-authenticated, absolute URL for a part key.
func (client *PlexClient) mediaURL(partKey string) string {
	sep := "?"
	if strings.Contains(partKey, "?") {
		sep = "&"
	}
	return client.PlexURL + partKey + sep + "X-Plex-Token=" + url.QueryEscape(string(client.PlexToken))
}

func (client *PlexClient) httpClient() *http.Client {
	if client.HTTPClient != nil {
		return client.HTTPClient
	}
	return defaultHTTPClient
}

// viewCount prefers globalViewCount but falls back to per-user viewCount.
func viewCount(m metadataItem) int {
	if m.GlobalViewCount > 0 {
		return m.GlobalViewCount
	}
	return m.ViewCount
}

// firstPartKey returns the first streamable part key for an extra, if any.
func firstPartKey(m metadataItem) string {
	for _, media := range m.Media {
		for _, p := range media.Part {
			if p.Key != "" {
				return p.Key
			}
		}
	}
	return ""
}
