package postergenerator

import (
	"fmt"
	"path/filepath"

	"gopkg.in/gographics/imagick.v2/imagick"
)

type Show struct {
	Name  string
	Views int
}

type Shows []Show

type Movie struct {
	Name  string
	Views int
}

type Movies []Movie

type ImageClient struct {
	MagickWand  *imagick.MagickWand
	DrawingWand *imagick.DrawingWand
	PixelWand   *imagick.PixelWand
	Output      string
}

func getAbsoluteFontPath() (string, error) {
	fontPath := "media/common/Adult-Swim-Font.ttf"
	absoluteFontPath, err := filepath.Abs(fontPath)
	if err != nil {
		return "", err
	}
	return absoluteFontPath, nil
}

func (img *ImageClient) GenerateImageWithInputs(shows Shows, movies Movies) error {
	var err error
	imagick.Initialize()
	// Schedule cleanup
	defer imagick.Terminate()

	mw := img.MagickWand
	dw := img.DrawingWand
	pw := img.PixelWand

	// Print the absolute path of the file
	absoluteFontPath, err := getAbsoluteFontPath()
	if err != nil {
		return err
	}
	fmt.Println(absoluteFontPath)

	pw.SetColor("black")
	dw.SetTextAntialias(true)
	mw.NewImage(1920, 1080, pw)
	pw.SetColor("white")
	dw.SetFillColor(pw)
	dw.SetFont(absoluteFontPath)
	dw.SetFontSize(80)
	dw.Annotation(80, 150, "Top Stuff of the Week")
	// subheading for TV shows
	setSubheading(dw, "TV Shows", 80, 300)
	resetFont(dw)

	for i, show := range shows {
		height := 400 + (100 * i)
		showName := fmt.Sprintf("%d. %s - %d views", i+1, show.Name, show.Views)
		dw.Annotation(80, float64(height), showName)
	}
	// subheading for Movies
	setSubheading(dw, "Movies", 900, 300)
	resetFont(dw)

	for i, movie := range movies {
		height := 400 + (100 * i)
		movieName := fmt.Sprintf("%d. %s - %d views", i+1, movie.Name, movie.Views)
		dw.Annotation(900, float64(height), movieName)
	}
	mw.DrawImage(dw)

	if err = mw.WriteImage(img.Output); err != nil {
		return err
	}
	return nil
}

func resetFont(dw *imagick.DrawingWand) {
	absoluteFontPath, err := getAbsoluteFontPath()
	if err != nil {
		panic(err)
	}
	dw.SetFont(absoluteFontPath)
	dw.SetFontSize(48)
}

func setSubheading(dw *imagick.DrawingWand, text string, x float64, y float64) {
	absoluteFontPath, err := getAbsoluteFontPath()
	if err != nil {
		panic(err)
	}
	dw.SetFontSize(60)
	dw.SetFont(absoluteFontPath)
	dw.Annotation(x, y, text)
}
