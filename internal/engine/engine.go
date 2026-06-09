// Package engine orchestrates a pre-roll: it resolves data sources, renders
// scenes into normalized clips, concatenates them, and muxes the soundtrack.
// It depends on rendering only through the LayoutRenderer interface so the
// engine itself stays free of CGO/ImageMagick and remains unit-testable.
package engine

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/pipeline"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/templating"
)

// defaultBackgroundLimit caps how many items feed a scene background when the
// manifest does not specify one.
const defaultBackgroundLimit = 4

// LayoutRenderer renders a manifest layout to a PNG. Implemented by the render
// package (CGO/ImageMagick) and injected by the caller.
type LayoutRenderer interface {
	Layout(layout manifest.Layout, ctx map[string]any, width, height int, outputPath string) error
}

// ImageFetcher downloads a remote image (e.g. Plex art) to a local path. It is
// injectable so the engine can be tested without network, and so the caller can
// supply a TLS/token-aware client.
type ImageFetcher func(ctx context.Context, url, dest string) error

// Engine ties together providers, rendering, and the ffmpeg pipeline.
type Engine struct {
	Providers *providers.Registry
	Renderer  LayoutRenderer
	// Runner is optional; nil means shell out to the real ffmpeg.
	Runner pipeline.Runner
	// Fetch is optional; nil uses a plain HTTP download. Set it to a TLS/token
	// aware client (e.g. plexclient.Download) for image backgrounds.
	Fetch ImageFetcher
}

// Run produces the pre-roll described by p. vars seeds the template context
// with caller-supplied globals (e.g. {"Period": "Month"}).
func (e *Engine) Run(ctx context.Context, p *manifest.Preroll, vars map[string]any) error {
	width, height, err := p.Dimensions()
	if err != nil {
		return err
	}

	base := cloneVars(vars)
	dataCtx, err := e.resolveData(ctx, p, base)
	if err != nil {
		return err
	}

	workDir, err := os.MkdirTemp("", "preroll-*")
	if err != nil {
		return fmt.Errorf("engine: create work dir: %w", err)
	}
	defer os.RemoveAll(workDir)

	asm := &pipeline.Assembler{Spec: pipeline.DefaultSpec(width, height, p.FPS), Run: e.Runner}

	clips, err := e.buildClips(ctx, p, dataCtx, width, height, workDir, asm)
	if err != nil {
		return err
	}
	if len(clips) == 0 {
		return fmt.Errorf("engine: no clips were produced (check data sources and scenes)")
	}

	listFile := filepath.Join(workDir, "concat.txt")
	if err := pipeline.WriteConcatList(listFile, clips); err != nil {
		return err
	}
	concatPath := filepath.Join(workDir, "concat.mp4")
	if err := asm.Concat(ctx, listFile, concatPath); err != nil {
		return fmt.Errorf("engine: concat: %w", err)
	}

	if dir := filepath.Dir(p.Output); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("engine: create output dir: %w", err)
		}
	}
	if err := asm.Mux(ctx, concatPath, p.Audio, p.Length, p.Output); err != nil {
		return fmt.Errorf("engine: mux audio: %w", err)
	}
	return nil
}

// resolveData fetches every data source and returns the template context
// (globals plus each source's items keyed by name). Data-source params are
// rendered against the stable base context only, so resolution order does not
// matter.
func (e *Engine) resolveData(ctx context.Context, p *manifest.Preroll, base map[string]any) (map[string]any, error) {
	dataCtx := cloneVars(base)
	for name, ds := range p.Data {
		params, err := templating.RenderParams(ds.Params, base)
		if err != nil {
			return nil, fmt.Errorf("engine: data %q params: %w", name, err)
		}
		items, err := e.Providers.Fetch(ctx, ds.Provider, params)
		if err != nil {
			return nil, fmt.Errorf("engine: data %q: %w", name, err)
		}
		dataCtx[name] = items
	}
	return dataCtx, nil
}

// buildClips encodes each scene into one or more normalized clips, in order.
func (e *Engine) buildClips(ctx context.Context, p *manifest.Preroll, dataCtx map[string]any, width, height int, workDir string, asm *pipeline.Assembler) ([]string, error) {
	withAudio := p.Audio.Mode == manifest.AudioOriginal || p.Audio.Mode == manifest.AudioMix

	var clips []string
	index := 0
	nextClip := func() string {
		path := filepath.Join(workDir, fmt.Sprintf("clip-%03d.mp4", index))
		index++
		return path
	}

	for i, scene := range p.Scenes {
		switch scene.Kind {
		case manifest.SceneImage:
			clip := nextClip()
			if err := asm.ImageClip(ctx, scene.File, clip, scene.Duration); err != nil {
				return nil, fmt.Errorf("engine: scene %d (image): %w", i, err)
			}
			clips = append(clips, clip)

		case manifest.SceneRender:
			if e.Renderer == nil {
				return nil, fmt.Errorf("engine: scene %d (render): no renderer configured", i)
			}
			layout := p.Layouts[scene.Layout]
			sceneCtx := sceneContext(dataCtx, scene.Vars)
			frame := filepath.Join(workDir, fmt.Sprintf("frame-%03d.png", i))

			// Trailer-montage background: render text-only over transparency,
			// then composite it over a muted, dimmed montage of the trailers.
			if bg := scene.Background; bg != nil && !bg.IsImage() {
				items, _ := dataCtx[bg.Source].(content.Items)
				srcs := mediaURLs(items, backgroundLimit(bg))
				if len(srcs) == 0 {
					return nil, fmt.Errorf("engine: scene %d (render): background source %q has no playable trailers", i, bg.Source)
				}
				textLayout := layout
				textLayout.Background = manifest.Background{Color: "none"}
				if err := e.Renderer.Layout(textLayout, sceneCtx, width, height, frame); err != nil {
					return nil, fmt.Errorf("engine: scene %d (render): %w", i, err)
				}
				clip := nextClip()
				if err := asm.MontageBackground(ctx, srcs, frame, clip, scene.Duration, backgroundTile(bg), bg.Dim); err != nil {
					return nil, fmt.Errorf("engine: scene %d (render): %w", i, err)
				}
				clips = append(clips, clip)
				continue
			}

			// Image background: download item art/posters and hand them to the
			// renderer to composite behind the text.
			if bg := scene.Background; bg != nil && bg.IsImage() {
				items, _ := dataCtx[bg.Source].(content.Items)
				paths, err := e.downloadImages(ctx, imageURLs(items, bg.Mode, backgroundLimit(bg)), workDir, i)
				if err != nil {
					return nil, fmt.Errorf("engine: scene %d (render): background images: %w", i, err)
				}
				sceneCtx = cloneVars(sceneCtx)
				sceneCtx[manifest.BackgroundContextKey] = manifest.ResolvedBackground{
					Images: paths, Dim: bg.Dim, Tile: backgroundTile(bg),
				}
			}

			if err := e.Renderer.Layout(layout, sceneCtx, width, height, frame); err != nil {
				return nil, fmt.Errorf("engine: scene %d (render): %w", i, err)
			}
			clip := nextClip()
			if err := asm.ImageClip(ctx, frame, clip, scene.Duration); err != nil {
				return nil, fmt.Errorf("engine: scene %d (render): %w", i, err)
			}
			clips = append(clips, clip)

		case manifest.SceneClips:
			if scene.Label != "" && e.Renderer == nil {
				return nil, fmt.Errorf("engine: scene %d (clips): label %q set but no renderer configured", i, scene.Label)
			}
			items, _ := dataCtx[scene.Source].(content.Items)
			for idx, item := range items {
				if item.MediaURL == "" {
					continue
				}
				clip := nextClip()
				if scene.Label == "" {
					if err := asm.TrailerClip(ctx, item.MediaURL, clip, scene.PerClip, withAudio); err != nil {
						return nil, fmt.Errorf("engine: scene %d (clips): %w", i, err)
					}
					clips = append(clips, clip)
					continue
				}

				overlay := filepath.Join(workDir, fmt.Sprintf("label-%03d-%03d.png", i, idx))
				if err := e.Renderer.Layout(p.Layouts[scene.Label], itemVars(dataCtx, idx, item), width, height, overlay); err != nil {
					return nil, fmt.Errorf("engine: scene %d (clips): render label: %w", i, err)
				}
				if err := asm.OverlayTrailerClip(ctx, item.MediaURL, overlay, clip, scene.PerClip, withAudio); err != nil {
					return nil, fmt.Errorf("engine: scene %d (clips): %w", i, err)
				}
				clips = append(clips, clip)
			}

		default:
			return nil, fmt.Errorf("engine: scene %d: unknown kind %q", i, scene.Kind)
		}
	}
	return clips, nil
}

// itemVars returns the template context for a per-clip label: the resolved data
// context plus the current item's fields (1-based Rank) in scope, so a label
// layout can reference {{ .Name }}, {{ .Rank }}, etc.
func itemVars(dataCtx map[string]any, index int, item content.Item) map[string]any {
	ctx := cloneVars(dataCtx)
	ctx["Rank"] = index + 1
	ctx["Name"] = item.Name
	ctx["Views"] = item.Views
	ctx["RatingKey"] = item.RatingKey
	ctx["MediaURL"] = item.MediaURL
	return ctx
}

// backgroundLimit returns how many items to use, defaulting when unset.
func backgroundLimit(bg *manifest.SceneBackground) int {
	if bg.Limit > 0 {
		return bg.Limit
	}
	return defaultBackgroundLimit
}

// backgroundTile returns the tiling, defaulting to a grid.
func backgroundTile(bg *manifest.SceneBackground) string {
	if bg.Tile != "" {
		return bg.Tile
	}
	return manifest.TileGrid
}

// imageURLs collects up to limit non-empty art/poster URLs for the given mode.
func imageURLs(items content.Items, mode string, limit int) []string {
	var urls []string
	for _, it := range items {
		url := it.Thumb
		if mode == manifest.BackgroundArt {
			url = it.Art
		}
		if url == "" {
			continue
		}
		urls = append(urls, url)
		if len(urls) >= limit {
			break
		}
	}
	return urls
}

// mediaURLs collects up to limit non-empty playable URLs (trailers).
func mediaURLs(items content.Items, limit int) []string {
	var urls []string
	for _, it := range items {
		if it.MediaURL == "" {
			continue
		}
		urls = append(urls, it.MediaURL)
		if len(urls) >= limit {
			break
		}
	}
	return urls
}

// downloadImages fetches each URL to the work dir, returning the local paths.
func (e *Engine) downloadImages(ctx context.Context, urls []string, workDir string, sceneIdx int) ([]string, error) {
	fetch := e.Fetch
	if fetch == nil {
		fetch = defaultImageFetch
	}
	paths := make([]string, 0, len(urls))
	for j, url := range urls {
		dest := filepath.Join(workDir, fmt.Sprintf("bg-%03d-%03d.img", sceneIdx, j))
		if err := fetch(ctx, url, dest); err != nil {
			return nil, err
		}
		paths = append(paths, dest)
	}
	return paths, nil
}

// defaultImageFetch is a plain HTTP download used when no fetcher is injected.
func defaultImageFetch(ctx context.Context, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("engine: image fetch: status %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

func cloneVars(vars map[string]any) map[string]any {
	out := make(map[string]any, len(vars))
	for k, v := range vars {
		out[k] = v
	}
	return out
}

// sceneContext returns the data context with a render scene's vars overlaid.
// The base is left untouched so scene vars never leak between scenes.
func sceneContext(dataCtx map[string]any, vars map[string]string) map[string]any {
	if len(vars) == 0 {
		return dataCtx
	}
	ctx := cloneVars(dataCtx)
	for k, v := range vars {
		ctx[k] = v
	}
	return ctx
}
