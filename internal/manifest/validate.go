package manifest

import (
	"fmt"
	"strings"
)

// Validate checks structural and referential integrity. It fails closed: any
// unknown kind, dangling reference, or nonsensical value is an error.
func (p *Preroll) Validate() error {
	var errs []string
	add := func(format string, args ...any) {
		errs = append(errs, fmt.Sprintf(format, args...))
	}

	if strings.TrimSpace(p.Name) == "" {
		add("name is required")
	}
	if _, _, err := p.Dimensions(); err != nil {
		add("%v", err)
	}
	if p.FPS <= 0 {
		add("fps must be > 0, got %d", p.FPS)
	}
	if strings.TrimSpace(p.Output) == "" {
		add("output is required")
	}
	if p.Length < 0 {
		add("length must be >= 0, got %g", p.Length)
	}

	p.validateAudio(add)
	p.validateLayouts(add)
	p.validateScenes(add)

	if len(errs) > 0 {
		return fmt.Errorf("invalid manifest:\n  - %s", strings.Join(errs, "\n  - "))
	}
	return nil
}

func (p *Preroll) validateAudio(add func(string, ...any)) {
	if p.Audio.File == "" {
		return
	}
	switch p.Audio.Mode {
	case "", AudioSoundtrack, AudioOriginal, AudioMix:
	default:
		add("audio.mode %q is not one of soundtrack|original|mix", p.Audio.Mode)
	}
	if p.Audio.Start < 0 {
		add("audio.start must be >= 0, got %g", p.Audio.Start)
	}
	if f := p.Audio.FadeOut; f != nil {
		if f.Start < 0 {
			add("audio.fadeOut.start must be >= 0, got %g", f.Start)
		}
		if f.Duration <= 0 {
			add("audio.fadeOut.duration must be > 0, got %g", f.Duration)
		}
	}
}

func (p *Preroll) validateLayouts(add func(string, ...any)) {
	for name, layout := range p.Layouts {
		if len(layout.Elements) == 0 {
			add("layout %q has no elements", name)
		}
		for i, el := range layout.Elements {
			where := fmt.Sprintf("layout %q element %d", name, i)
			switch el.Type {
			case ElementText:
				if strings.TrimSpace(el.Text) == "" {
					add("%s: text element needs a text value", where)
				}
			case ElementList:
				if el.Source == "" {
					add("%s: list element needs a source", where)
				} else if _, ok := p.Data[el.Source]; !ok {
					add("%s: list source %q is not a declared data source", where, el.Source)
				}
				if strings.TrimSpace(el.Item) == "" {
					add("%s: list element needs an item template", where)
				}
			default:
				add("%s: type %q is not one of text|list", where, el.Type)
			}
		}
	}
}

func (p *Preroll) validateBackground(add func(string, ...any), where string, bg *SceneBackground) {
	if bg == nil {
		return
	}
	if bg.Source == "" {
		add("%s: background needs a source", where)
	} else if _, ok := p.Data[bg.Source]; !ok {
		add("%s: background source %q is not a declared data source", where, bg.Source)
	}
	switch bg.Mode {
	case BackgroundArt, BackgroundPoster, BackgroundTrailers:
	default:
		add("%s: background mode %q is not one of art|poster|trailers", where, bg.Mode)
	}
	switch bg.Tile {
	case "", TileCover, TileGrid, TileSequence:
	default:
		add("%s: background tile %q is not one of cover|grid|sequence", where, bg.Tile)
	}
	if bg.Dim < 0 || bg.Dim > 1 {
		add("%s: background dim must be in [0,1], got %g", where, bg.Dim)
	}
	if bg.Limit < 0 {
		add("%s: background limit must be >= 0, got %d", where, bg.Limit)
	}
}

func (p *Preroll) validateScenes(add func(string, ...any)) {
	if len(p.Scenes) == 0 {
		add("at least one scene is required")
	}
	for i, s := range p.Scenes {
		where := fmt.Sprintf("scene %d", i)
		switch s.Kind {
		case SceneImage:
			if s.File == "" {
				add("%s (image): file is required", where)
			}
			if s.Duration <= 0 {
				add("%s (image): duration must be > 0", where)
			}
		case SceneRender:
			if s.Layout == "" {
				add("%s (render): layout is required", where)
			} else if _, ok := p.Layouts[s.Layout]; !ok {
				add("%s (render): layout %q is not defined", where, s.Layout)
			}
			if s.Duration <= 0 {
				add("%s (render): duration must be > 0", where)
			}
			p.validateBackground(add, where, s.Background)
		case SceneClips:
			if s.Source == "" {
				add("%s (clips): source is required", where)
			} else if _, ok := p.Data[s.Source]; !ok {
				add("%s (clips): source %q is not a declared data source", where, s.Source)
			}
			if s.PerClip <= 0 {
				add("%s (clips): perClip must be > 0", where)
			}
			if s.Label != "" {
				if _, ok := p.Layouts[s.Label]; !ok {
					add("%s (clips): label layout %q is not defined", where, s.Label)
				}
			}
		default:
			add("%s: kind %q is not one of image|render|clips", where, s.Kind)
		}
	}
}
