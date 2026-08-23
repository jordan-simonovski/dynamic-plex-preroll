package plexclient

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
)

const (
	prefsPath     = "/:/prefs"
	prerollPrefID = "CinemaTrailersPrerollID"
)

// prefsResponse is the lean shape of GET /:/prefs; only the settings list is
// consumed.
type prefsResponse struct {
	MediaContainer struct {
		Setting []struct {
			ID    string `json:"id"`
			Value string `json:"value"`
		} `json:"Setting"`
	} `json:"MediaContainer"`
}

// GetPreroll returns the current value of the server's pre-roll preference
// (CinemaTrailersPrerollID). An empty string means the preference is unset.
func (client *PlexClient) GetPreroll() (string, error) {
	resp, err := client.GetURL(context.Background(), prefsPath, url.Values{})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("plex: unexpected status %d for %s", resp.StatusCode, prefsPath)
	}
	var decoded prefsResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return "", fmt.Errorf("plex: decode %s: %w", prefsPath, err)
	}
	for _, s := range decoded.MediaContainer.Setting {
		if s.ID == prerollPrefID {
			return s.Value, nil
		}
	}
	return "", nil
}

// SetPreroll writes the pre-roll preference. The token must belong to the
// server owner; Plex answers 401/403 otherwise.
func (client *PlexClient) SetPreroll(value string) error {
	query := url.Values{}
	query.Set(prerollPrefID, value)
	query.Set("X-Plex-Token", string(client.PlexToken))

	fullURL := client.PlexURL + prefsPath + "?" + query.Encode()
	safeURL := client.redact(fullURL)

	req, err := http.NewRequest(http.MethodPut, fullURL, nil)
	if err != nil {
		return err
	}
	if client.Debug {
		log.Printf("plex: PUT %s", safeURL)
	}
	resp, err := client.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("plex: PUT %s: %s", safeURL, client.redact(err.Error()))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("plex: set preroll pref: status %d (token must belong to the server owner)", resp.StatusCode)
	}
	return nil
}

// MergePrerolls appends additions to the current preference value, skipping
// paths that are already present. The existing separator wins (";" =
// sequential, "," = random) so a merge never flips the server's playback mode;
// defaultSep applies only when current has no separator. Returns the merged
// value and whether anything was actually added — callers should skip the
// write when nothing changed.
func MergePrerolls(current string, additions []string, defaultSep string) (string, bool) {
	sep := defaultSep
	if strings.Contains(current, ";") {
		sep = ";"
	} else if strings.Contains(current, ",") {
		sep = ","
	}

	var merged []string
	seen := make(map[string]bool)
	add := func(p string) bool {
		p = strings.TrimSpace(p)
		if p == "" || seen[p] {
			return false
		}
		seen[p] = true
		merged = append(merged, p)
		return true
	}

	for _, p := range strings.FieldsFunc(current, func(r rune) bool { return r == ',' || r == ';' }) {
		add(p)
	}
	changed := false
	for _, p := range additions {
		if add(p) {
			changed = true
		}
	}
	return strings.Join(merged, sep), changed
}
