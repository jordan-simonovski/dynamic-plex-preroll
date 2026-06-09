// Package render is the layout interpreter: it turns a declarative manifest
// layout plus a resolved data context into a rendered PNG via ImageMagick.
// This is the only package that depends on CGO/ImageMagick; everything
// upstream (manifest, templating, providers, pipeline) stays CGO-free.
package render

import (
	"fmt"
	"math"
	"path/filepath"
	"strings"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/templating"
	"gopkg.in/gographics/imagick.v2/imagick"
)

// defaultLineSpacing multiplies font size to derive line height when an element
// does not set one explicitly.
const defaultLineSpacing = 1.2

// Renderer is the engine-facing adapter; it satisfies engine.LayoutRenderer.
type Renderer struct{}

// Layout implements engine.LayoutRenderer.
func (Renderer) Layout(layout manifest.Layout, ctx map[string]any, width, height int, outputPath string) error {
	return Layout(layout, ctx, width, height, outputPath)
}

// Layout draws layout into a width x height image, resolving template strings
// against ctx, and writes a PNG to outputPath. The ImageMagick environment
// must already be initialized by the caller (see engine).
func Layout(layout manifest.Layout, ctx map[string]any, width, height int, outputPath string) error {
	mw := imagick.NewMagickWand()
	defer mw.Destroy()
	dw := imagick.NewDrawingWand()
	defer dw.Destroy()
	pw := imagick.NewPixelWand()
	defer pw.Destroy()

	if rb, ok := resolvedBackground(ctx); ok {
		if err := buildImageBackground(mw, pw, rb, width, height); err != nil {
			return err
		}
	} else if err := setupCanvas(mw, pw, layout.Background, width, height); err != nil {
		return err
	}
	dw.SetTextAntialias(true)

	fontPath, err := filepath.Abs(layout.Font)
	if err != nil {
		return fmt.Errorf("render: font path: %w", err)
	}

	for i, el := range layout.Elements {
		if err := drawElement(dw, pw, fontPath, el, ctx); err != nil {
			return fmt.Errorf("render: element %d: %w", i, err)
		}
	}

	if err := mw.DrawImage(dw); err != nil {
		return fmt.Errorf("render: draw image: %w", err)
	}
	if err := mw.WriteImage(outputPath); err != nil {
		return fmt.Errorf("render: write %s: %w", outputPath, err)
	}
	return nil
}

func setupCanvas(mw *imagick.MagickWand, pw *imagick.PixelWand, bg manifest.Background, width, height int) error {
	if bg.Image != "" {
		if err := mw.ReadImage(bg.Image); err != nil {
			return fmt.Errorf("render: read background %s: %w", bg.Image, err)
		}
		return nil
	}
	color := bg.Color
	if color == "" {
		color = "black"
	}
	pw.SetColor(color)
	if err := mw.NewImage(uint(width), uint(height), pw); err != nil {
		return fmt.Errorf("render: new image: %w", err)
	}
	// A transparent canvas (e.g. for clip-label overlays) needs the alpha
	// channel explicitly activated, otherwise IM flattens it to opaque black.
	if isTransparent(color) {
		if err := mw.SetImageAlphaChannel(imagick.ALPHA_CHANNEL_ACTIVATE); err != nil {
			return fmt.Errorf("render: activate alpha: %w", err)
		}
	}
	return nil
}

// isTransparent reports whether a background color denotes a fully transparent
// canvas, in which case the alpha channel must be activated.
func isTransparent(color string) bool {
	switch strings.ToLower(strings.TrimSpace(color)) {
	case "none", "transparent":
		return true
	default:
		return false
	}
}

// resolvedBackground pulls an engine-resolved image background out of the
// render context, if the engine attached one for this scene.
func resolvedBackground(ctx map[string]any) (manifest.ResolvedBackground, bool) {
	v, ok := ctx[manifest.BackgroundContextKey]
	if !ok {
		return manifest.ResolvedBackground{}, false
	}
	rb, ok := v.(manifest.ResolvedBackground)
	return rb, ok
}

// buildImageBackground composes the scene's image backdrop (a single cover image
// or a grid of up to four), then darkens it so overlaid text stays legible.
func buildImageBackground(mw *imagick.MagickWand, pw *imagick.PixelWand, rb manifest.ResolvedBackground, width, height int) error {
	switch {
	case len(rb.Images) == 0:
		pw.SetColor("black")
		if err := mw.NewImage(uint(width), uint(height), pw); err != nil {
			return fmt.Errorf("render: empty background: %w", err)
		}
	case rb.Tile == manifest.TileGrid && len(rb.Images) > 1:
		if err := buildGrid(mw, pw, rb.Images, width, height); err != nil {
			return err
		}
	default:
		if err := mw.ReadImage(rb.Images[0]); err != nil {
			return fmt.Errorf("render: read background %s: %w", rb.Images[0], err)
		}
		if err := coverResize(mw, uint(width), uint(height)); err != nil {
			return err
		}
	}
	return dimImage(mw, rb.Dim)
}

// buildGrid lays the images out 2x2 (2x1 for two) on a black canvas, each tile
// cropped to cover its cell.
func buildGrid(mw *imagick.MagickWand, pw *imagick.PixelWand, images []string, width, height int) error {
	pw.SetColor("black")
	if err := mw.NewImage(uint(width), uint(height), pw); err != nil {
		return fmt.Errorf("render: grid canvas: %w", err)
	}
	if len(images) > 4 {
		images = images[:4]
	}
	cols, rows := 2, 2
	if len(images) == 2 {
		rows = 1
	}
	tw, th := uint(width/cols), uint(height/rows)
	for i, path := range images {
		tile := imagick.NewMagickWand()
		if err := tile.ReadImage(path); err != nil {
			tile.Destroy()
			return fmt.Errorf("render: read tile %s: %w", path, err)
		}
		if err := coverResize(tile, tw, th); err != nil {
			tile.Destroy()
			return err
		}
		x := (i % cols) * int(tw)
		y := (i / cols) * int(th)
		err := mw.CompositeImage(tile, imagick.COMPOSITE_OP_OVER, x, y)
		tile.Destroy()
		if err != nil {
			return fmt.Errorf("render: composite tile: %w", err)
		}
	}
	return nil
}

// coverResize scales the wand's image to fill tw x th, cropping the overflow so
// the cell is fully covered (no letterboxing).
func coverResize(mw *imagick.MagickWand, tw, th uint) error {
	iw, ih := mw.GetImageWidth(), mw.GetImageHeight()
	if iw == 0 || ih == 0 {
		return fmt.Errorf("render: zero-size background image")
	}
	scale := math.Max(float64(tw)/float64(iw), float64(th)/float64(ih))
	nw := uint(math.Ceil(float64(iw) * scale))
	nh := uint(math.Ceil(float64(ih) * scale))
	if err := mw.ResizeImage(nw, nh, imagick.FILTER_LANCZOS, 1); err != nil {
		return fmt.Errorf("render: resize background: %w", err)
	}
	if err := mw.CropImage(tw, th, int(nw-tw)/2, int(nh-th)/2); err != nil {
		return fmt.Errorf("render: crop background: %w", err)
	}
	mw.ResetImagePage("")
	return nil
}

// dimImage darkens the whole image by amount (0 = untouched, 1 = black).
func dimImage(mw *imagick.MagickWand, amount float64) error {
	if amount <= 0 {
		return nil
	}
	if amount > 1 {
		amount = 1
	}
	if err := mw.ModulateImage((1-amount)*100, 100, 100); err != nil {
		return fmt.Errorf("render: dim background: %w", err)
	}
	return nil
}

func drawElement(dw *imagick.DrawingWand, pw *imagick.PixelWand, fontPath string, el manifest.Element, ctx map[string]any) error {
	setFillColor(dw, pw, el.Color)
	dw.SetFont(fontPath)
	dw.SetFontSize(el.Size)
	dw.SetTextAlignment(alignType(el.Align))

	switch el.Type {
	case manifest.ElementText:
		text, err := templating.Render(el.Text, ctx)
		if err != nil {
			return err
		}
		drawLines(dw, el, text)
		return nil

	case manifest.ElementList:
		items, err := itemsFromCtx(ctx, el.Source)
		if err != nil {
			return err
		}
		for i, item := range items {
			line, err := templating.Render(el.Item, itemContext(i, item))
			if err != nil {
				return err
			}
			y := el.StartY + float64(i)*el.StepY
			dw.Annotation(el.X, y, line)
		}
		return nil

	default:
		return fmt.Errorf("unknown element type %q", el.Type)
	}
}

// drawLines renders a text element, splitting on newlines and stacking lines
// LineHeight apart, with the whole block centred vertically on el.Y.
func drawLines(dw *imagick.DrawingWand, el manifest.Element, text string) {
	lines := strings.Split(text, "\n")

	lineHeight := el.LineHeight
	if lineHeight <= 0 {
		lineHeight = el.Size * defaultLineSpacing
	}

	start := el.Y - float64(len(lines)-1)/2*lineHeight
	for i, line := range lines {
		dw.Annotation(el.X, start+float64(i)*lineHeight, line)
	}
}

func alignType(align string) imagick.AlignType {
	switch strings.ToLower(align) {
	case "center", "centre":
		return imagick.ALIGN_CENTER
	case "right":
		return imagick.ALIGN_RIGHT
	default:
		return imagick.ALIGN_LEFT
	}
}

func setFillColor(dw *imagick.DrawingWand, pw *imagick.PixelWand, color string) {
	if color == "" {
		color = "white"
	}
	pw.SetColor(color)
	dw.SetFillColor(pw)
}

func itemsFromCtx(ctx map[string]any, source string) (content.Items, error) {
	value, ok := ctx[source]
	if !ok {
		return nil, fmt.Errorf("list source %q not found in data context", source)
	}
	items, ok := value.(content.Items)
	if !ok {
		return nil, fmt.Errorf("list source %q is %T, want content.Items", source, value)
	}
	return items, nil
}

// itemContext exposes one item to a list-item template, injecting a 1-based Rank.
func itemContext(index int, item content.Item) map[string]any {
	return map[string]any{
		"Rank":      index + 1,
		"Name":      item.Name,
		"Views":     item.Views,
		"RatingKey": item.RatingKey,
		"MediaURL":  item.MediaURL,
	}
}
