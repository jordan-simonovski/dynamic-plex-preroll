// Package manifest defines the YAML pre-roll DSL: global settings, named data
// sources, reusable layouts, a soundtrack, and an ordered scene list. String
// fields that contain Go text/template syntax are kept raw here and rendered
// later by the engine once data sources have been resolved.
package manifest

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Scene kinds.
const (
	SceneImage  = "image"
	SceneRender = "render"
	SceneClips  = "clips"
)

// Element types.
const (
	ElementText = "text"
	ElementList = "list"
)

// Audio modes.
const (
	AudioSoundtrack = "soundtrack"
	AudioOriginal   = "original"
	AudioMix        = "mix"
)

// Scene background modes: art/poster pull still images from a data source's
// items; trailers builds a muted, dimmed video montage from their MediaURLs.
const (
	BackgroundArt      = "art"
	BackgroundPoster   = "poster"
	BackgroundTrailers = "trailers"
)

// Scene background tiling: cover fills the frame with a single item; grid lays
// up to four items out 2x2; sequence (trailers only) plays them back to back.
const (
	TileCover    = "cover"
	TileGrid     = "grid"
	TileSequence = "sequence"
)

// BackgroundContextKey is the reserved render-context key under which the engine
// passes a ResolvedBackground to the renderer for image-mode backgrounds.
const BackgroundContextKey = "__background"

// ResolvedBackground is the engine-resolved, ready-to-composite background for
// an image-mode render scene: local image paths plus the dim amount and tiling.
// It is not part of the YAML; the engine constructs it and the renderer consumes
// it from the render context.
type ResolvedBackground struct {
	Images []string
	Dim    float64
	Tile   string
}

// Preroll is the root of a manifest.
type Preroll struct {
	Name       string                `yaml:"name"`
	Resolution string                `yaml:"resolution"`
	FPS        int                   `yaml:"fps"`
	Output     string                `yaml:"output"`
	Length     float64               `yaml:"length"`
	Audio      Audio                 `yaml:"audio"`
	Data       map[string]DataSource `yaml:"data"`
	Layouts    map[string]Layout     `yaml:"layouts"`
	Scenes     []Scene               `yaml:"scenes"`
}

// Audio describes the soundtrack and how it interacts with clip audio. Start
// seeks into the source track (seconds) so a manifest can drop in on a chosen
// hook rather than the intro.
type Audio struct {
	File    string   `yaml:"file"`
	Mode    string   `yaml:"mode"`
	Start   float64  `yaml:"start"`
	FadeOut *FadeOut `yaml:"fadeOut"`
}

// FadeOut is an audio fade expressed in seconds.
type FadeOut struct {
	Start    float64 `yaml:"start"`
	Duration float64 `yaml:"duration"`
}

// DataSource binds a named provider to its parameters. Param values may contain
// template syntax and are rendered before the provider runs.
type DataSource struct {
	Provider string            `yaml:"provider"`
	Params   map[string]string `yaml:"params"`
}

// Layout is a reusable, declarative description of a rendered frame.
type Layout struct {
	Background Background `yaml:"background"`
	Font       string     `yaml:"font"`
	Elements   []Element  `yaml:"elements"`
}

// Background is a solid colour or an image; image wins when both are set.
type Background struct {
	Color string `yaml:"color"`
	Image string `yaml:"image"`
}

// Element is a single drawable. Type text draws Text once; type list iterates
// the named data Source, rendering Item per entry stepped down the column.
//
// Align sets horizontal text anchoring (left|center|right); with center, X is
// the text's centre. Text may contain newlines: lines are stacked LineHeight
// apart and the whole block is centred vertically on Y.
type Element struct {
	Type       string  `yaml:"type"`
	X          float64 `yaml:"x"`
	Y          float64 `yaml:"y"`
	Size       float64 `yaml:"size"`
	Color      string  `yaml:"color"`
	Align      string  `yaml:"align"`
	Text       string  `yaml:"text"`
	LineHeight float64 `yaml:"lineHeight"`
	Source     string  `yaml:"source"`
	StartY     float64 `yaml:"startY"`
	StepY      float64 `yaml:"stepY"`
	Item       string  `yaml:"item"`
}

// Scene is one entry in the timeline. Fields used depend on Kind. Vars supplies
// extra template variables to a render scene's layout, so one layout can be
// reused across scenes with different text.
type Scene struct {
	Kind       string            `yaml:"kind"`
	File       string            `yaml:"file"`
	Duration   float64           `yaml:"duration"`
	Layout     string            `yaml:"layout"`
	Vars       map[string]string `yaml:"vars"`
	Source     string            `yaml:"source"`
	PerClip    float64           `yaml:"perClip"`
	Transition string            `yaml:"transition"`
	// Label names a layout overlaid on each clip (e.g. the movie title). The
	// layout is rendered per item with that item's fields (Name, Rank, ...) in
	// scope and composited over the clip. Use a transparent background.
	Label string `yaml:"label"`
	// Background, on a render scene, draws content from a data source behind the
	// layout text: still art/posters or a muted trailer montage.
	Background *SceneBackground `yaml:"background"`
}

// SceneBackground configures a dynamic backdrop for a render scene, pulled from
// a data source's items. Mode selects images (art/poster) or a trailer montage;
// Dim darkens it (0 = untouched, 1 = black) so overlaid text stays legible.
type SceneBackground struct {
	Source string  `yaml:"source"`
	Mode   string  `yaml:"mode"`
	Tile   string  `yaml:"tile"`
	Dim    float64 `yaml:"dim"`
	Limit  int     `yaml:"limit"`
}

// IsImage reports whether the background is built from still images.
func (b *SceneBackground) IsImage() bool {
	return b.Mode == BackgroundArt || b.Mode == BackgroundPoster
}

// Dimensions parses a "WIDTHxHEIGHT" resolution string.
func (p *Preroll) Dimensions() (width, height int, err error) {
	parts := strings.SplitN(strings.ToLower(p.Resolution), "x", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("resolution %q is not WIDTHxHEIGHT", p.Resolution)
	}
	width, err = strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil {
		return 0, 0, fmt.Errorf("resolution width: %w", err)
	}
	height, err = strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil {
		return 0, 0, fmt.Errorf("resolution height: %w", err)
	}
	if width <= 0 || height <= 0 {
		return 0, 0, fmt.Errorf("resolution %q must be positive", p.Resolution)
	}
	return width, height, nil
}

// Load reads, parses, and validates a manifest from disk.
func Load(path string) (*Preroll, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	return Parse(raw)
}

// Parse decodes and validates a manifest from bytes. Unknown fields are
// rejected so typos fail loudly rather than being silently ignored.
func Parse(raw []byte) (*Preroll, error) {
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)

	var p Preroll
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return &p, nil
}
