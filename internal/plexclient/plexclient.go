package plexclient

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
)

const topItemsPath = "/library/all/top"

var defaultHTTPClient = &http.Client{Timeout: 30 * time.Second}

// GetMostViewedContent returns the most-viewed shows and movies within the
// configured period.
func (client *PlexClient) GetMostViewedContent() (shows, movies content.Items, err error) {
	since := time.Now().AddDate(0, 0, -client.PeriodInterval).Unix()

	shows, err = client.topItems(client.TVShowSectionId, since)
	if err != nil {
		return nil, nil, err
	}

	movies, err = client.topItems(client.MovieSectionId, since)
	if err != nil {
		return nil, nil, err
	}

	return shows, movies, nil
}

// topItems fetches the top-viewed entries of a single section type. Each call
// builds its own query so requests never share (and corrupt) parameter state.
func (client *PlexClient) topItems(sectionType string, since int64) (content.Items, error) {
	params := url.Values{
		"limit":     {fmt.Sprint(client.MaxItems)},
		"viewedAt>": {fmt.Sprint(since)},
		"type":      {sectionType},
	}

	resp, err := client.GetURL(topItemsPath, params)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("plex: unexpected status %d for type %q", resp.StatusCode, sectionType)
	}

	var top TopItems
	if err := json.NewDecoder(resp.Body).Decode(&top); err != nil {
		return nil, err
	}

	items := make(content.Items, 0, len(top.MediaContainer.Metadata))
	for _, m := range top.MediaContainer.Metadata {
		items = append(items, content.Item{Name: m.Title, Views: m.GlobalViewCount})
	}
	return items, nil
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
// params are not mutated; the auth token is added to a local copy.
func (client *PlexClient) GetURL(urlPath string, params url.Values) (*http.Response, error) {
	query := make(url.Values, len(params)+1)
	for key, values := range params {
		query[key] = values
	}
	query.Set("X-Plex-Token", string(client.PlexToken))

	req, err := http.NewRequest(http.MethodGet, client.PlexURL+urlPath+"?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	return client.httpClient().Do(req)
}

func (client *PlexClient) httpClient() *http.Client {
	if client.HTTPClient != nil {
		return client.HTTPClient
	}
	return defaultHTTPClient
}
