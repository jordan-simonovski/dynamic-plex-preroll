package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
)

type fakeProvider struct {
	items     content.Items
	gotParams map[string]string
}

func (f *fakeProvider) Fetch(_ context.Context, params map[string]string) (content.Items, error) {
	f.gotParams = params
	return f.items, nil
}

type fakeRenderer struct {
	calls   int
	gotCtx  map[string]any
	ctxs    []map[string]any
	outputs []string
}

func (r *fakeRenderer) Layout(_ manifest.Layout, ctx map[string]any, _, _ int, outputPath string) error {
	r.calls++
	r.gotCtx = ctx
	r.ctxs = append(r.ctxs, ctx)
	r.outputs = append(r.outputs, outputPath)
	return nil
}

func argsContain(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func TestEngineRunProducesExpectedPipeline(t *testing.T) {
	prov := &fakeProvider{items: content.Items{
		{Name: "Dune", MediaURL: "http://plex/dune"},
		{Name: "Heat", MediaURL: "http://plex/heat"},
	}}
	reg := providers.NewRegistry()
	reg.Register("fake", prov)

	renderer := &fakeRenderer{}

	var calls [][]string
	eng := &Engine{
		Providers: reg,
		Renderer:  renderer,
		Runner: func(_ context.Context, _ string, args []string) error {
			calls = append(calls, args)
			return nil
		},
	}

	out := filepath.Join(t.TempDir(), "out.mp4")
	p := &manifest.Preroll{
		Name:       "t",
		Resolution: "1920x1080",
		FPS:        24,
		Output:     out,
		Length:     0,
		Data: map[string]manifest.DataSource{
			"movies": {Provider: "fake", Params: map[string]string{"section": "{{ .Section }}"}},
		},
		Layouts: map[string]manifest.Layout{
			"L": {Elements: []manifest.Element{{Type: manifest.ElementText, Text: "hi"}}},
		},
		Scenes: []manifest.Scene{
			{Kind: manifest.SceneRender, Layout: "L", Duration: 3},
			{Kind: manifest.SceneClips, Source: "movies", PerClip: 4},
			{Kind: manifest.SceneImage, File: "logo.png", Duration: 2},
		},
	}

	err := eng.Run(context.Background(), p, map[string]any{"Section": "1"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Data-source param template was rendered against vars.
	if prov.gotParams["section"] != "1" {
		t.Errorf("provider params section = %q, want 1", prov.gotParams["section"])
	}

	// Renderer was invoked once and saw the resolved data in its context.
	if renderer.calls != 1 {
		t.Errorf("renderer calls = %d, want 1", renderer.calls)
	}
	if items, ok := renderer.gotCtx["movies"].(content.Items); !ok || len(items) != 2 {
		t.Errorf("renderer ctx movies = %#v", renderer.gotCtx["movies"])
	}

	// Expect: render->1 image clip, clips->2 trailer clips, image->1 clip, then concat, then mux = 6 calls.
	if len(calls) != 6 {
		t.Fatalf("ffmpeg calls = %d, want 6", len(calls))
	}

	loopClips, trailerClips, concats := 0, 0, 0
	for _, args := range calls {
		switch {
		case argsContain(args, "-loop"):
			loopClips++
		case argsContain(args, "concat"):
			concats++
		case argsContain(args, "http://plex/dune") || argsContain(args, "http://plex/heat"):
			trailerClips++
		}
	}
	if loopClips != 2 {
		t.Errorf("image/render clips = %d, want 2", loopClips)
	}
	if trailerClips != 2 {
		t.Errorf("trailer clips = %d, want 2", trailerClips)
	}
	if concats != 1 {
		t.Errorf("concat calls = %d, want 1", concats)
	}

	// Last call is the mux, writing to the manifest output.
	last := calls[len(calls)-1]
	if last[len(last)-1] != out {
		t.Errorf("final output = %q, want %q", last[len(last)-1], out)
	}
}

func TestEngineClipsWithLabelOverlay(t *testing.T) {
	prov := &fakeProvider{items: content.Items{
		{Name: "Dune", MediaURL: "http://plex/dune"},
		{Name: "Heat", MediaURL: "http://plex/heat"},
	}}
	reg := providers.NewRegistry()
	reg.Register("fake", prov)
	renderer := &fakeRenderer{}

	var calls [][]string
	eng := &Engine{
		Providers: reg,
		Renderer:  renderer,
		Runner: func(_ context.Context, _ string, args []string) error {
			calls = append(calls, args)
			return nil
		},
	}

	p := &manifest.Preroll{
		Name: "t", Resolution: "1920x1080", FPS: 24, Output: filepath.Join(t.TempDir(), "o.mp4"),
		Data: map[string]manifest.DataSource{"movies": {Provider: "fake"}},
		Layouts: map[string]manifest.Layout{
			"label": {Elements: []manifest.Element{{Type: manifest.ElementText, Text: "{{ .Name }}"}}},
		},
		Scenes: []manifest.Scene{
			{Kind: manifest.SceneClips, Source: "movies", PerClip: 8, Label: "label"},
		},
	}

	if err := eng.Run(context.Background(), p, nil); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// One label render per item, each seeing that item's Name and 1-based Rank.
	if renderer.calls != 2 {
		t.Fatalf("renderer calls = %d, want 2", renderer.calls)
	}
	if renderer.ctxs[0]["Name"] != "Dune" || renderer.ctxs[0]["Rank"] != 1 {
		t.Errorf("item 0 ctx = %v", renderer.ctxs[0])
	}
	if renderer.ctxs[1]["Name"] != "Heat" || renderer.ctxs[1]["Rank"] != 2 {
		t.Errorf("item 1 ctx = %v", renderer.ctxs[1])
	}

	// Each trailer clip is built with an overlay (filter_complex + the rendered
	// label png) rather than a plain -vf trailer clip.
	overlayClips := 0
	for _, args := range calls {
		if argsContain(args, "-filter_complex") &&
			(argsContain(args, "http://plex/dune") || argsContain(args, "http://plex/heat")) {
			overlayClips++
			if !argsContain(args, renderer.outputs[overlayClips-1]) {
				// overlay png path should be an input
				t.Errorf("overlay clip missing label png input: %v", args)
			}
		}
	}
	if overlayClips != 2 {
		t.Errorf("overlay trailer clips = %d, want 2", overlayClips)
	}
}

func TestEngineRenderImageBackground(t *testing.T) {
	prov := &fakeProvider{items: content.Items{
		{Name: "A", Thumb: "http://plex/a/thumb", Art: "http://plex/a/art"},
		{Name: "B", Thumb: "http://plex/b/thumb"},
		{Name: "C", Thumb: ""}, // no image, skipped
	}}
	reg := providers.NewRegistry()
	reg.Register("fake", prov)
	renderer := &fakeRenderer{}

	var fetched []string
	eng := &Engine{
		Providers: reg,
		Renderer:  renderer,
		Runner:    func(context.Context, string, []string) error { return nil },
		Fetch: func(_ context.Context, url, dest string) error {
			fetched = append(fetched, url)
			return os.WriteFile(dest, []byte("img"), 0o644)
		},
	}

	p := &manifest.Preroll{
		Name: "t", Resolution: "1920x1080", FPS: 24, Output: filepath.Join(t.TempDir(), "o.mp4"),
		Data:    map[string]manifest.DataSource{"movies": {Provider: "fake"}},
		Layouts: map[string]manifest.Layout{"L": {Elements: []manifest.Element{{Type: manifest.ElementText, Text: "hi"}}}},
		Scenes: []manifest.Scene{{
			Kind: manifest.SceneRender, Layout: "L", Duration: 5,
			Background: &manifest.SceneBackground{Source: "movies", Mode: manifest.BackgroundPoster, Tile: manifest.TileGrid, Dim: 0.5},
		}},
	}

	if err := eng.Run(context.Background(), p, nil); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Only the two items with thumbs were fetched, in order.
	if len(fetched) != 2 || fetched[0] != "http://plex/a/thumb" || fetched[1] != "http://plex/b/thumb" {
		t.Fatalf("fetched = %v", fetched)
	}
	// The renderer received a ResolvedBackground with the downloaded paths.
	rb, ok := renderer.gotCtx[manifest.BackgroundContextKey].(manifest.ResolvedBackground)
	if !ok {
		t.Fatalf("no ResolvedBackground in ctx: %#v", renderer.gotCtx[manifest.BackgroundContextKey])
	}
	if len(rb.Images) != 2 || rb.Dim != 0.5 || rb.Tile != manifest.TileGrid {
		t.Errorf("resolved background = %+v", rb)
	}
}

func TestEngineRenderTrailerBackground(t *testing.T) {
	prov := &fakeProvider{items: content.Items{
		{Name: "Dune", MediaURL: "http://plex/dune"},
		{Name: "Heat", MediaURL: "http://plex/heat"},
	}}
	reg := providers.NewRegistry()
	reg.Register("fake", prov)
	renderer := &fakeRenderer{}

	var calls [][]string
	eng := &Engine{
		Providers: reg,
		Renderer:  renderer,
		Runner: func(_ context.Context, _ string, args []string) error {
			calls = append(calls, args)
			return nil
		},
	}

	p := &manifest.Preroll{
		Name: "t", Resolution: "1920x1080", FPS: 24, Output: filepath.Join(t.TempDir(), "o.mp4"),
		Data:    map[string]manifest.DataSource{"trailers": {Provider: "fake"}},
		Layouts: map[string]manifest.Layout{"L": {Elements: []manifest.Element{{Type: manifest.ElementText, Text: "hi"}}}},
		Scenes: []manifest.Scene{{
			Kind: manifest.SceneRender, Layout: "L", Duration: 8,
			Background: &manifest.SceneBackground{Source: "trailers", Mode: manifest.BackgroundTrailers, Tile: manifest.TileGrid, Dim: 0.4},
		}},
	}

	if err := eng.Run(context.Background(), p, nil); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// A montage ffmpeg call referencing both trailers, no separate ImageClip.
	montage := 0
	for _, args := range calls {
		if argsContain(args, "-filter_complex") && argsContain(args, "http://plex/dune") && argsContain(args, "http://plex/heat") {
			montage++
		}
	}
	if montage != 1 {
		t.Fatalf("montage background calls = %d, want 1", montage)
	}
	// The text layout was rendered transparent (text-only) for the overlay.
	if renderer.calls != 1 {
		t.Errorf("renderer calls = %d, want 1", renderer.calls)
	}
}

func TestEngineRenderSceneVars(t *testing.T) {
	renderer := &fakeRenderer{}
	eng := &Engine{
		Providers: providers.NewRegistry(),
		Renderer:  renderer,
		Runner:    func(context.Context, string, []string) error { return nil },
	}

	p := &manifest.Preroll{
		Name: "t", Resolution: "100x100", FPS: 24, Output: filepath.Join(t.TempDir(), "o.mp4"),
		Layouts: map[string]manifest.Layout{
			"card": {Elements: []manifest.Element{{Type: manifest.ElementText, Text: "{{ .Line }}"}}},
		},
		Scenes: []manifest.Scene{
			{Kind: manifest.SceneRender, Layout: "card", Duration: 2, Vars: map[string]string{"Line": "hey"}},
			{Kind: manifest.SceneRender, Layout: "card", Duration: 2, Vars: map[string]string{"Line": "hey, you"}},
		},
	}

	if err := eng.Run(context.Background(), p, map[string]any{"Global": "g"}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if len(renderer.ctxs) != 2 {
		t.Fatalf("renderer ctxs = %d, want 2", len(renderer.ctxs))
	}
	if renderer.ctxs[0]["Line"] != "hey" || renderer.ctxs[1]["Line"] != "hey, you" {
		t.Errorf("per-scene Line not applied: %q, %q", renderer.ctxs[0]["Line"], renderer.ctxs[1]["Line"])
	}
	// Globals survive; scene vars don't leak backwards into earlier scenes.
	if renderer.ctxs[0]["Global"] != "g" {
		t.Errorf("global missing from scene ctx: %v", renderer.ctxs[0]["Global"])
	}
}

func TestEngineRenderSceneWithoutRendererFails(t *testing.T) {
	reg := providers.NewRegistry()
	eng := &Engine{Providers: reg, Runner: func(context.Context, string, []string) error { return nil }}
	p := &manifest.Preroll{
		Name: "t", Resolution: "10x10", FPS: 24, Output: filepath.Join(t.TempDir(), "o.mp4"),
		Layouts: map[string]manifest.Layout{"L": {Elements: []manifest.Element{{Type: manifest.ElementText, Text: "x"}}}},
		Scenes:  []manifest.Scene{{Kind: manifest.SceneRender, Layout: "L", Duration: 1}},
	}
	if err := eng.Run(context.Background(), p, nil); err == nil || !strings.Contains(err.Error(), "no renderer") {
		t.Fatalf("expected no-renderer error, got %v", err)
	}
}

func TestEngineNoClipsFails(t *testing.T) {
	prov := &fakeProvider{items: content.Items{}}
	reg := providers.NewRegistry()
	reg.Register("fake", prov)
	eng := &Engine{Providers: reg, Runner: func(context.Context, string, []string) error { return nil }}
	p := &manifest.Preroll{
		Name: "t", Resolution: "10x10", FPS: 24, Output: filepath.Join(t.TempDir(), "o.mp4"),
		Data:   map[string]manifest.DataSource{"movies": {Provider: "fake"}},
		Scenes: []manifest.Scene{{Kind: manifest.SceneClips, Source: "movies", PerClip: 4}},
	}
	if err := eng.Run(context.Background(), p, nil); err == nil || !strings.Contains(err.Error(), "no clips") {
		t.Fatalf("expected no-clips error, got %v", err)
	}
}
