// Package content holds the pure domain types shared between the Plex client
// and the poster generator. It deliberately has no CGO dependencies so the
// rest of the pipeline can be built and tested without ImageMagick installed.
package content

import "fmt"

// Item is a single ranked library entry (a show or a movie).
type Item struct {
	Name  string
	Views int
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
