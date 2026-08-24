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
	Name       string                `yaml:"name,omitempty" json:"name,omitempty"`
	Resolution string                `yaml:"resolution,omitempty" json:"resolution,omitempty"`
	FPS        int                   `yaml:"fps,omitempty" json:"fps,omitempty"`
	Output     string                `yaml:"output,omitempty" json:"output,omitempty"`
	Length     float64               `yaml:"length,omitempty" json:"length,omitempty"`
	Audio      Audio                 `yaml:"audio,omitempty" json:"audio,omitzero"`
	Data       map[string]DataSource `yaml:"data,omitempty" json:"data,omitempty"`
	Layouts    map[string]Layout     `yaml:"layouts,omitempty" json:"layouts,omitempty"`
	Scenes     []Scene               `yaml:"scenes,omitempty" json:"scenes,omitempty"`
}

// Audio describes the soundtrack and how it interacts with clip audio. Start
// seeks into the source track (seconds) so a manifest can drop in on a chosen
// hook rather than the intro.
type Audio struct {
	File    string   `yaml:"file,omitempty" json:"file,omitempty"`
	Mode    string   `yaml:"mode,omitempty" json:"mode,omitempty"`
	Start   float64  `yaml:"start,omitempty" json:"start,omitempty"`
	FadeOut *FadeOut `yaml:"fadeOut,omitempty" json:"fadeOut,omitempty"`
}

// FadeOut is an audio fade expressed in seconds.
type FadeOut struct {
	Start    float64 `yaml:"start,omitempty" json:"start,omitempty"`
	Duration float64 `yaml:"duration,omitempty" json:"duration,omitempty"`
}

// DataSource binds a named provider to its parameters. Param values may contain
// template syntax and are rendered before the provider runs.
type DataSource struct {
	Provider string            `yaml:"provider,omitempty" json:"provider,omitempty"`
	Params   map[string]string `yaml:"params,omitempty" json:"params,omitempty"`
}

// Layout is a reusable, declarative description of a rendered frame.
type Layout struct {
	Background Background `yaml:"background,omitempty" json:"background,omitzero"`
	Font       string     `yaml:"font,omitempty" json:"font,omitempty"`
	Elements   []Element  `yaml:"elements,omitempty" json:"elements,omitempty"`
}

// Background is a solid colour or an image; image wins when both are set.
type Background struct {
	Color string `yaml:"color,omitempty" json:"color,omitempty"`
	Image string `yaml:"image,omitempty" json:"image,omitempty"`
}

// Element is a single drawable. Type text draws Text once; type list iterates
// the named data Source, rendering Item per entry stepped down the column.
//
// Align sets horizontal text anchoring (left|center|right); with center, X is
// the text's centre. Text may contain newlines: lines are stacked LineHeight
// apart and the whole block is centred vertically on Y.
type Element struct {
	Type       string  `yaml:"type,omitempty" json:"type,omitempty"`
	X          float64 `yaml:"x,omitempty" json:"x,omitempty"`
	Y          float64 `yaml:"y,omitempty" json:"y,omitempty"`
	Size       float64 `yaml:"size,omitempty" json:"size,omitempty"`
	Color      string  `yaml:"color,omitempty" json:"color,omitempty"`
	Align      string  `yaml:"align,omitempty" json:"align,omitempty"`
	Text       string  `yaml:"text,omitempty" json:"text,omitempty"`
	LineHeight float64 `yaml:"lineHeight,omitempty" json:"lineHeight,omitempty"`
	Source     string  `yaml:"source,omitempty" json:"source,omitempty"`
	StartY     float64 `yaml:"startY,omitempty" json:"startY,omitempty"`
	StepY      float64 `yaml:"stepY,omitempty" json:"stepY,omitempty"`
	Item       string  `yaml:"item,omitempty" json:"item,omitempty"`
}

// Scene is one entry in the timeline. Fields used depend on Kind. Vars supplies
// extra template variables to a render scene's layout, so one layout can be
// reused across scenes with different text.
type Scene struct {
	Kind       string            `yaml:"kind,omitempty" json:"kind,omitempty"`
	File       string            `yaml:"file,omitempty" json:"file,omitempty"`
	Duration   float64           `yaml:"duration,omitempty" json:"duration,omitempty"`
	Layout     string            `yaml:"layout,omitempty" json:"layout,omitempty"`
	Vars       map[string]string `yaml:"vars,omitempty" json:"vars,omitempty"`
	Source     string            `yaml:"source,omitempty" json:"source,omitempty"`
	PerClip    float64           `yaml:"perClip,omitempty" json:"perClip,omitempty"`
	Transition string            `yaml:"transition,omitempty" json:"transition,omitempty"`
	// Label names a layout overlaid on each clip (e.g. the movie title). The
	// layout is rendered per item with that item's fields (Name, Rank, ...) in
	// scope and composited over the clip. Use a transparent background.
	Label string `yaml:"label,omitempty" json:"label,omitempty"`
	// Background, on a render scene, draws content from a data source behind the
	// layout text: still art/posters or a muted trailer montage.
	Background *SceneBackground `yaml:"background,omitempty" json:"background,omitempty"`
}

// SceneBackground configures a dynamic backdrop for a render scene, pulled from
// a data source's items. Mode selects images (art/poster) or a trailer montage;
// Dim darkens it (0 = untouched, 1 = black) so overlaid text stays legible.
type SceneBackground struct {
	Source string  `yaml:"source,omitempty" json:"source,omitempty"`
	Mode   string  `yaml:"mode,omitempty" json:"mode,omitempty"`
	Tile   string  `yaml:"tile,omitempty" json:"tile,omitempty"`
	Dim    float64 `yaml:"dim,omitempty" json:"dim,omitempty"`
	Limit  int     `yaml:"limit,omitempty" json:"limit,omitempty"`
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

// Decode parses a manifest from bytes without validating it. Unknown fields
// are rejected so typos fail loudly. JSON bodies are accepted too: JSON is a
// subset of YAML, which is how the web UI posts manifests.
func Decode(raw []byte) (*Preroll, error) {
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)
	var p Preroll
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	return &p, nil
}

// Parse decodes and validates a manifest from bytes.
func Parse(raw []byte) (*Preroll, error) {
	p, err := Decode(raw)
	if err != nil {
		return nil, err
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return p, nil
}

// ToYAML marshals the manifest to its canonical YAML form. Zero-valued fields
// are omitted, so a manifest built up field-by-field in the UI emits only what
// was actually set.
func (p *Preroll) ToYAML() ([]byte, error) {
	return yaml.Marshal(p)
}
