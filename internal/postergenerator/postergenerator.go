package postergenerator

import (
	"fmt"
	"path/filepath"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
	"gopkg.in/gographics/imagick.v2/imagick"
)

const fontRelativePath = "media/common/Adult-Swim-Font.ttf"

func getAbsoluteFontPath() (string, error) {
	return filepath.Abs(fontRelativePath)
}

// GenerateImageWithInputs renders the top-shows/top-movies poster to img.Output.
// The ImageMagick environment must already be initialized by the caller.
func (img *ImageClient) GenerateImageWithInputs(shows, movies content.Items) error {
	fontPath, err := getAbsoluteFontPath()
	if err != nil {
		return err
	}

	mw := img.MagickWand
	dw := img.DrawingWand
	pw := img.PixelWand

	pw.SetColor("black")
	dw.SetTextAntialias(true)
	mw.NewImage(1920, 1080, pw)

	pw.SetColor("white")
	dw.SetFillColor(pw)
	dw.SetFont(fontPath)
	dw.SetFontSize(80)
	dw.Annotation(80, 150, fmt.Sprintf("Top Stuff of the %s", img.Period))

	renderColumn(dw, fontPath, "TV Shows", 80, shows)
	renderColumn(dw, fontPath, "Movies", 900, movies)

	mw.DrawImage(dw)

	return mw.WriteImage(img.Output)
}

// renderColumn draws a heading and its ranked entries at the given x offset.
func renderColumn(dw *imagick.DrawingWand, fontPath, heading string, x float64, items content.Items) {
	dw.SetFont(fontPath)
	dw.SetFontSize(60)
	dw.Annotation(x, 300, heading)

	dw.SetFontSize(48)
	for i, item := range items {
		y := float64(400 + 100*i)
		dw.Annotation(x, y, item.Label(i+1))
	}
}
