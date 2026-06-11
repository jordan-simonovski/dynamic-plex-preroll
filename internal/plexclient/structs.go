package plexclient

import (
	"net/http"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
)

type PlexClient struct {
	PlexToken       configmanager.Secret
	PlexURL         string
	PeriodInterval  int
	TVShowSectionId string
	MovieSectionId  string
	MaxItems        int
	// HTTPClient is optional; when nil a client with a sane timeout is used.
	HTTPClient *http.Client
	// Debug enables verbose request/response logging (token redacted).
	Debug bool
}

type LibraryResponse struct {
	MediaContainer MediaContainer `json:"MediaContainer"`
}

type MediaContainer struct {
	Size                          int         `json:"size"`
	AllowSync                     bool        `json:"allowSync"`
	Identifier                    string      `json:"identifier"`
	LibraryTitle                  string      `json:"libraryTitle"`
	LibrarySectionID              string      `json:"librarySectionID"`
	LibrarySectionTitle           string      `json:"librarySectionTitle"`
	LibrarySectionUUID            string      `json:"librarySectionUUID"`
	LibrarySectionKey             string      `json:"librarySectionKey"`
	LibrarySectionType            string      `json:"librarySectionType"`
	LibrarySectionLocation        string      `json:"librarySectionLocation"`
	LibrarySectionLanguage        string      `json:"librarySectionLanguage"`
	LibrarySectionScanner         string      `json:"librarySectionScanner"`
	LibrarySectionAgent           string      `json:"librarySectionAgent"`
	LibrarySectionScannerVersion  string      `json:"librarySectionScannerVersion"`
	LibrarySectionMediaTagPrefix  string      `json:"librarySectionMediaTagPrefix"`
	LibrarySectionMediaTagVersion string      `json:"librarySectionMediaTagVersion"`
	LibrarySectionContent         string      `json:"librarySectionContent"`
	LibrarySectionUpdatedAt       string      `json:"librarySectionUpdatedAt"`
	LibrarySectionCreatedAt       string      `json:"librarySectionCreatedAt"`
	Directory                     []Directory `json:"Directory"`
}

type Directory struct {
	Key           string      `json:"key"`
	Title         string      `json:"title"`
	Type          string      `json:"type"`
	Agent         string      `json:"agent"`
	Scanner       string      `json:"scanner"`
	Language      string      `json:"language"`
	UUID          string      `json:"uuid"`
	UpdatedAt     int         `json:"updatedAt"`
	CreatedAt     int         `json:"createdAt"`
	ScannedAt     int         `json:"scannedAt"`
	Content       bool        `json:"content"`
	Directory     bool        `json:"directory"`
	Refreshing    bool        `json:"refreshing"`
	Hidden        int         `json:"hidden"`
	Location      []Locations `json:"location"`
	AllowSync     bool        `json:"allowSync"`
	Filter        bool        `json:"filters"`
	RefreshingURL string      `json:"refreshingURL"`
	Composite     string      `json:"composite"`
	Art           string      `json:"art"`
	Thumb         string      `json:"thumb"`
}

type Locations struct {
	Locations []Location `json:"locations"`
}

type Location struct {
	ID   int    `json:"id"`
	Path string `json:"path"`
}

// itemsResponse is the lean shape we actually consume from any Plex listing
// endpoint (/library/all/top, /library/sections/{id}/all, extras). Unused
// fields are intentionally omitted.
type itemsResponse struct {
	MediaContainer struct {
		Metadata []metadataItem `json:"Metadata"`
	} `json:"MediaContainer"`
}

type metadataItem struct {
	RatingKey       string      `json:"ratingKey"`
	Title           string      `json:"title"`
	GUID            string      `json:"guid"`
	Type            string      `json:"type"`
	GlobalViewCount int         `json:"globalViewCount"`
	ViewCount       int         `json:"viewCount"`
	ChildCount      int         `json:"childCount"`
	Art             string      `json:"art"`
	Thumb           string      `json:"thumb"`
	PrimaryExtraKey string      `json:"primaryExtraKey"`
	Media           []mediaPart `json:"Media"`
}

// hubsResponse is the lean shape consumed from hub listing endpoints
// (e.g. Discover's /hubs/sections/home).
type hubsResponse struct {
	MediaContainer struct {
		Hub []struct {
			Title         string         `json:"title"`
			HubIdentifier string         `json:"hubIdentifier"`
			Metadata      []metadataItem `json:"Metadata"`
		} `json:"Hub"`
	} `json:"MediaContainer"`
}

type mediaPart struct {
	Part []part `json:"Part"`
}

type part struct {
	Key string `json:"key"`
}
