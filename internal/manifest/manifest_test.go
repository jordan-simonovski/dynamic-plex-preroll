package manifest

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const validYAML = `
name: test
resolution: 1920x1080
fps: 24
output: output/out.mp4
length: 25
audio:
  file: song.mp3
  mode: soundtrack
  fadeOut: { start: 20, duration: 5 }
data:
  shows: { provider: plex.top, params: { type: "2" } }
layouts:
  main:
    background: { color: black }
    font: font.ttf
    elements:
      - { type: text, x: 10, y: 20, size: 40, text: "Hi {{ .Period }}" }
      - { type: list, x: 10, startY: 100, stepY: 50, size: 30, source: shows, item: "{{ .Name }}" }
scenes:
  - { kind: image, file: a.png, duration: 2 }
  - { kind: render, layout: main, duration: 8 }
`

func TestParseValid(t *testing.T) {
	p, err := Parse([]byte(validYAML))
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}
	if p.Name != "test" {
		t.Errorf("Name = %q", p.Name)
	}
	w, h, err := p.Dimensions()
	if err != nil || w != 1920 || h != 1080 {
		t.Errorf("Dimensions() = %d,%d,%v", w, h, err)
	}
	if len(p.Scenes) != 2 {
		t.Fatalf("got %d scenes", len(p.Scenes))
	}
}

func TestParseCardFields(t *testing.T) {
	yaml := `
name: cards
resolution: 1920x1080
fps: 24
output: out.mp4
layouts:
  card:
    font: f.ttf
    elements:
      - { type: text, x: 960, y: 560, size: 96, align: center, lineHeight: 120, text: "{{ .Line }}" }
scenes:
  - { kind: render, layout: card, duration: 2, vars: { Line: "hey" } }
  - { kind: render, layout: card, duration: 3, vars: { Line: "multi\nline" } }
`
	p, err := Parse([]byte(yaml))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	el := p.Layouts["card"].Elements[0]
	if el.Align != "center" || el.LineHeight != 120 {
		t.Errorf("element align/lineHeight = %q/%g", el.Align, el.LineHeight)
	}
	if p.Scenes[0].Vars["Line"] != "hey" {
		t.Errorf("scene0 vars = %v", p.Scenes[0].Vars)
	}
	if p.Scenes[1].Vars["Line"] != "multi\nline" {
		t.Errorf("scene1 vars = %q", p.Scenes[1].Vars["Line"])
	}
}

func TestParseRejectsUnknownField(t *testing.T) {
	_, err := Parse([]byte(validYAML + "\nbogusField: 1\n"))
	if err == nil {
		t.Fatal("expected error for unknown field, got nil")
	}
}

func TestDimensions(t *testing.T) {
	cases := []struct {
		res  string
		ok   bool
		w, h int
	}{
		{"1920x1080", true, 1920, 1080},
		{"1280X720", true, 1280, 720},
		{"1920", false, 0, 0},
		{"axb", false, 0, 0},
		{"-1x10", false, 0, 0},
	}
	for _, c := range cases {
		p := &Preroll{Resolution: c.res}
		w, h, err := p.Dimensions()
		if c.ok && (err != nil || w != c.w || h != c.h) {
			t.Errorf("%q: got %d,%d,%v want %d,%d,nil", c.res, w, h, err, c.w, c.h)
		}
		if !c.ok && err == nil {
			t.Errorf("%q: expected error", c.res)
		}
	}
}

func TestValidateFailures(t *testing.T) {
	base := func() *Preroll {
		p, err := Parse([]byte(validYAML))
		if err != nil {
			t.Fatalf("base parse: %v", err)
		}
		return p
	}

	cases := []struct {
		name    string
		mutate  func(*Preroll)
		wantSub string
	}{
		{"no name", func(p *Preroll) { p.Name = "" }, "name is required"},
		{"bad fps", func(p *Preroll) { p.FPS = 0 }, "fps must be > 0"},
		{"no output", func(p *Preroll) { p.Output = "" }, "output is required"},
		{"bad resolution", func(p *Preroll) { p.Resolution = "nope" }, "resolution"},
		{"bad audio mode", func(p *Preroll) { p.Audio.Mode = "loud" }, "audio.mode"},
		{"unknown scene kind", func(p *Preroll) { p.Scenes[0].Kind = "weird" }, "is not one of image|render|clips"},
		{"image without file", func(p *Preroll) { p.Scenes[0].File = "" }, "file is required"},
		{"render bad layout ref", func(p *Preroll) { p.Scenes[1].Layout = "ghost" }, `layout "ghost" is not defined`},
		{"list bad source", func(p *Preroll) { p.Layouts["main"] = withListSource(p.Layouts["main"], "ghost") }, `source "ghost" is not a declared data source`},
		{"clips bad source", func(p *Preroll) {
			p.Scenes = append(p.Scenes, Scene{Kind: SceneClips, Source: "ghost", PerClip: 5})
		}, `source "ghost" is not a declared data source`},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := base()
			c.mutate(p)
			err := p.Validate()
			if err == nil {
				t.Fatalf("expected validation error containing %q", c.wantSub)
			}
			if !strings.Contains(err.Error(), c.wantSub) {
				t.Errorf("error %q does not contain %q", err.Error(), c.wantSub)
			}
		})
	}
}

func withListSource(l Layout, source string) Layout {
	for i := range l.Elements {
		if l.Elements[i].Type == ElementList {
			l.Elements[i].Source = source
		}
	}
	return l
}

// TestShippedManifests guards every manifest we ship against drift: the
// embedded default plus everything under manifests/.
func TestShippedManifests(t *testing.T) {
	paths := []string{"../../cmd/plex-pre-rolls/default-manifest.yaml"}

	shipped, err := filepath.Glob("../../manifests/*.yaml")
	if err != nil {
		t.Fatalf("glob manifests: %v", err)
	}
	if len(shipped) == 0 {
		t.Fatal("no manifests found under ../../manifests")
	}
	paths = append(paths, shipped...)

	for _, path := range paths {
		if _, err := Load(path); err != nil {
			t.Errorf("Load(%s): %v", path, err)
		}
	}
}

// A complete manifest exercising every DSL feature, used for round-trip tests.
const roundTripFixture = `
name: fixture
resolution: 1920x1080
fps: 24
output: output/fixture.mp4
length: 16
audio:
  file: media/track.mp3
  mode: soundtrack
  start: 25
  fadeOut: { start: 11, duration: 5 }
data:
  topMovies:
    provider: plex.top
    params: { type: movie, section: "1", limit: "5", trailers: "true" }
layouts:
  main:
    background: { color: none }
    font: media/font.ttf
    elements:
      - { type: text, x: 96, y: 150, size: 96, color: white, align: center, text: "Top Movies", lineHeight: 100 }
      - { type: list, x: 96, startY: 320, stepY: 96, size: 56, color: white, source: topMovies, item: "{{ .Rank }}. {{ .Name }}" }
scenes:
  - { kind: image, file: media/intro.png, duration: 3 }
  - kind: render
    layout: main
    duration: 8
    vars: { Title: "Hello" }
    background: { source: topMovies, mode: trailers, tile: grid, dim: 0.35, limit: 4 }
  - { kind: clips, source: topMovies, perClip: 4, label: main }
`

func TestToYAMLRoundTrip(t *testing.T) {
	p, err := Parse([]byte(roundTripFixture))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	out, err := p.ToYAML()
	if err != nil {
		t.Fatalf("ToYAML: %v", err)
	}
	p2, err := Parse(out)
	if err != nil {
		t.Fatalf("re-parse emitted YAML: %v\n%s", err, out)
	}
	if !reflect.DeepEqual(p, p2) {
		t.Fatalf("round trip changed the manifest:\nfirst:  %+v\nsecond: %+v", p, p2)
	}
}

// JSON is a subset of YAML, so the strict decoder must accept a JSON body
// verbatim — this is what the web UI posts.
func TestDecodeAcceptsJSON(t *testing.T) {
	body := []byte(`{"name":"j","resolution":"1920x1080","fps":24,"output":"o.mp4",` +
		`"scenes":[{"kind":"image","file":"a.png","duration":3}]}`)
	p, err := Decode(body)
	if err != nil {
		t.Fatalf("Decode(json): %v", err)
	}
	if p.Name != "j" || p.FPS != 24 || len(p.Scenes) != 1 {
		t.Fatalf("decoded wrong values: %+v", p)
	}
}

func TestDecodeRejectsUnknownFields(t *testing.T) {
	if _, err := Decode([]byte(`{"name":"x","bogus":1}`)); err == nil {
		t.Fatal("expected unknown-field error, got nil")
	}
}

func TestDecodeSkipsValidation(t *testing.T) {
	// Invalid manifest (no fps, no scenes) must still decode.
	p, err := Decode([]byte(`{"name":"draft"}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(p.Problems()) == 0 {
		t.Fatal("expected problems for a draft manifest, got none")
	}
}

func TestProblemsMatchesValidate(t *testing.T) {
	p := &Preroll{} // everything missing
	problems := p.Problems()
	if len(problems) == 0 {
		t.Fatal("expected problems for empty manifest")
	}
	err := p.Validate()
	if err == nil {
		t.Fatal("expected Validate error for empty manifest")
	}
	for _, prob := range problems {
		if !strings.Contains(err.Error(), prob) {
			t.Fatalf("problem %q missing from Validate error %q", prob, err)
		}
	}
}
