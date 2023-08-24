package plexclient

type PlexClient struct {
	PlexToken       string
	PlexURL         string
	PeriodDays      int
	TVShowSectionId string
	MovieSectionId  string
	MaxItems        int
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

type TopItems struct {
	MediaContainer struct {
		Size            int    `json:"size"`
		AllowSync       bool   `json:"allowSync"`
		Identifier      string `json:"identifier"`
		MediaTagPrefix  string `json:"mediaTagPrefix"`
		MediaTagVersion int    `json:"mediaTagVersion"`
		Metadata        []struct {
			RatingKey             string  `json:"ratingKey"`
			Key                   string  `json:"key"`
			GUID                  string  `json:"guid"`
			Studio                string  `json:"studio"`
			Type                  string  `json:"type"`
			Title                 string  `json:"title"`
			LibrarySectionTitle   string  `json:"librarySectionTitle"`
			LibrarySectionID      int     `json:"librarySectionID"`
			LibrarySectionKey     string  `json:"librarySectionKey"`
			ContentRating         string  `json:"contentRating"`
			Summary               string  `json:"summary"`
			Index                 int     `json:"index"`
			AudienceRating        float64 `json:"audienceRating"`
			Year                  int     `json:"year"`
			Thumb                 string  `json:"thumb"`
			Art                   string  `json:"art"`
			Theme                 string  `json:"theme,omitempty"`
			Duration              int     `json:"duration"`
			OriginallyAvailableAt string  `json:"originallyAvailableAt"`
			LeafCount             int     `json:"leafCount"`
			ViewedLeafCount       int     `json:"viewedLeafCount"`
			ChildCount            int     `json:"childCount"`
			AddedAt               int     `json:"addedAt"`
			UpdatedAt             int     `json:"updatedAt"`
			GlobalViewCount       int     `json:"globalViewCount"`
			UserCount             int     `json:"userCount"`
			AudienceRatingImage   string  `json:"audienceRatingImage"`
			Genre                 []struct {
				Tag string `json:"tag"`
			} `json:"Genre"`
			Country []struct {
				Tag string `json:"tag"`
			} `json:"Country"`
			Role []struct {
				Tag string `json:"tag"`
			} `json:"Role"`
			User []struct {
				ID int `json:"id"`
			} `json:"User"`
			TitleSort       string `json:"titleSort,omitempty"`
			Tagline         string `json:"tagline,omitempty"`
			PrimaryExtraKey string `json:"primaryExtraKey,omitempty"`
			Collection      []struct {
				Tag string `json:"tag"`
			} `json:"Collection,omitempty"`
		} `json:"Metadata"`
	} `json:"MediaContainer"`
}
