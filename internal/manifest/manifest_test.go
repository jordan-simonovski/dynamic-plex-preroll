package manifest

import (
	"path/filepath"
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
