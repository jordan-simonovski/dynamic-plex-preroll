package postergenerator

import "gopkg.in/gographics/imagick.v2/imagick"

type ImageClient struct {
	MagickWand  *imagick.MagickWand
	DrawingWand *imagick.DrawingWand
	PixelWand   *imagick.PixelWand
	Period      string
	Output      string
}
