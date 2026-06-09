//go:build imagick

// This smoke test exercises the real ImageMagick rendering path. It is gated
// behind the `imagick` build tag because the render package requires CGO and a
// system ImageMagick install. Run with: go test -tags imagick ./internal/render/...
package render

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
	"gopkg.in/gographics/imagick.v2/imagick"
)

func TestLayoutSmoke(t *testing.T) {
	imagick.Initialize()
	defer imagick.Terminate()

	out := filepath.Join(t.TempDir(), "frame.png")
	layout := manifest.Layout{
		Background: manifest.Background{Color: "black"},
		Font:       "../../media/common/Adult-Swim-Font.ttf",
		Elements: []manifest.Element{
			{Type: manifest.ElementText, X: 50, Y: 100, Size: 60, Color: "white", Text: "Top Stuff of the {{ .Period }}"},
			{Type: manifest.ElementList, X: 50, StartY: 200, StepY: 80, Size: 40, Color: "white", Source: "shows",
				Item: `{{ .Rank }}. {{ .Name }} - {{ .Views }} {{ pluralize .Views "view" "views" }}`},
		},
	}
	ctx := map[string]any{
		"Period": "Month",
		"shows":  content.Items{{Name: "The Wire", Views: 3}, {Name: "Heat", Views: 1}},
	}

	if err := Layout(layout, ctx, 1280, 720, out); err != nil {
		t.Fatalf("Layout: %v", err)
	}
	info, err := os.Stat(out)
	if err != nil || info.Size() == 0 {
		t.Fatalf("expected non-empty PNG, stat=%v err=%v", info, err)
	}
}

func TestLayoutCenteredMultilineCard(t *testing.T) {
	imagick.Initialize()
	defer imagick.Terminate()

	out := filepath.Join(t.TempDir(), "card.png")
	layout := manifest.Layout{
		Background: manifest.Background{Color: "black"},
		Font:       "../../media/common/Adult-Swim-Font.ttf",
		Elements: []manifest.Element{
			{Type: manifest.ElementText, X: 640, Y: 360, Size: 90, Color: "white", Align: "center",
				Text: "wanna see what\neveryone's been\nwatching?"},
		},
	}
	if err := Layout(layout, map[string]any{}, 1280, 720, out); err != nil {
		t.Fatalf("Layout: %v", err)
	}
	if info, err := os.Stat(out); err != nil || info.Size() == 0 {
		t.Fatalf("expected non-empty PNG, stat=%v err=%v", info, err)
	}
}
