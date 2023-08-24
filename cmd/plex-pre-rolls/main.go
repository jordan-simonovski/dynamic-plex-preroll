// Port of http://members.shaw.ca/el.supremo/MagickWand/resize.htm to Go
package main

import (
	"fmt"
	"log"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/ffmpegclient"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/plexclient"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/postergenerator"
	"gopkg.in/gographics/imagick.v2/imagick"
)

func main() {
	config := configmanager.MustReadConfig()
	imagick.Initialize()
	defer imagick.Terminate()
	outputFile := "media/out.png"

	imgClient := postergenerator.ImageClient{
		MagickWand:  imagick.NewMagickWand(),
		DrawingWand: imagick.NewDrawingWand(),
		PixelWand:   imagick.NewPixelWand(),
		Output:      outputFile,
		Period:      config.PeriodInterval.ToString(),
	}

	plexClient := plexclient.PlexClient{
		PlexToken:       config.PlexToken,
		PlexURL:         config.PlexURL,
		PeriodInterval:  config.PeriodInterval.ToInt(),
		MovieSectionId:  config.MovieSectionId,
		TVShowSectionId: config.TVShowSectionId,
		MaxItems:        config.MaxItems,
	}

	shows, movies, viewedErr := plexClient.GetMostViewedContent()
	if viewedErr != nil {
		panic(viewedErr)
	}

	err := imgClient.GenerateImageWithInputs(shows, movies)
	if err != nil {
		panic(err)
	}

	commandOutput, errorOutput, err := ffmpegclient.ConcatenateImagesToVideo()
	if err != nil {
		log.Printf("error: %v\n", err)
	}
	fmt.Println("--- stdout ---")
	fmt.Println(commandOutput)
	fmt.Println("--- stderr ---")
	fmt.Println(errorOutput)

	videoFiltersOutput, videoFiltersErrorOutput, videoOutputErr := ffmpegclient.AddVideoFilters()
	if videoOutputErr != nil {
		log.Printf("error: %v\n", videoOutputErr)
	}
	fmt.Println("--- stdout ---")
	fmt.Println(videoFiltersOutput)
	fmt.Println("--- stderr ---")
	fmt.Println(videoFiltersErrorOutput)

	fmt.Println("Wrote output/out.mp4 to disk.")
}
