// Package content holds the pure domain types shared between the Plex client
// and the poster generator. It deliberately has no CGO dependencies so the
// rest of the pipeline can be built and tested without ImageMagick installed.
package content

import "fmt"

// Item is a single library entry. Name and Views drive text rendering; the
// remaining fields are populated for sources that need them (e.g. trailers
// carry a RatingKey and a resolved streamable MediaURL).
type Item struct {
	Name      string
	Views     int
	RatingKey string
	MediaURL  string
	// Art and Thumb are fully-qualified, token-authenticated image URLs for the
	// item's background art (landscape) and poster (portrait), when available.
	Art   string
	Thumb string
}

// Items is an ordered, ranked list of library entries.
type Items []Item

// Label returns the human-readable rank line, e.g. "1. The Wire - 3 views".
// Rank is 1-based.
func (item Item) Label(rank int) string {
	unit := "views"
	if item.Views == 1 {
		unit = "view"
	}
	return fmt.Sprintf("%d. %s - %d %s", rank, item.Name, item.Views, unit)
}
