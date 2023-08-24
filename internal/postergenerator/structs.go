package postergenerator

import "gopkg.in/gographics/imagick.v2/imagick"

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
	Period      string
	Output      string
}
