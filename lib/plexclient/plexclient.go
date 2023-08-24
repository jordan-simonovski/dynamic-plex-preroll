package plexclient

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/lib/postergenerator"
)

func (client *PlexClient) GetMostViewedThisWeek() (shows postergenerator.Shows, movies postergenerator.Movies, err error) {
	timeMinusPeriod := time.Now().AddDate(0, 0, -client.PeriodDays)
	topItems := "/library/all/top"
	params := url.Values{
		"X-Plex-Token": []string{client.PlexToken},
		"limit":        []string{fmt.Sprint(client.MaxItems)},
		"viewedAt>":    []string{fmt.Sprint(timeMinusPeriod.Unix())},
	}

	tvShowParams := params
	tvShowParams.Add("type", client.TVShowSectionId)

	tvShowResponse, err := client.GetURL(topItems, tvShowParams)
	if err != nil {
		return nil, nil, err
	}

	shows = postergenerator.Shows{}
	if tvShowResponse.StatusCode == http.StatusOK {
		var tvShowItems TopItems
		err = json.NewDecoder(tvShowResponse.Body).Decode(&tvShowItems)
		if err != nil {
			return nil, nil, err
		}
		for _, item := range tvShowItems.MediaContainer.Metadata {
			shows = append(shows, postergenerator.Show{Name: item.Title, Views: item.GlobalViewCount})
		}
	}

	defer tvShowResponse.Body.Close()

	movieParams := params
	movieParams.Add("type", client.MovieSectionId)

	movieResponse, err := client.GetURL(topItems, movieParams)
	if err != nil {
		return nil, nil, err
	}

	movies = postergenerator.Movies{}
	if movieResponse.StatusCode == http.StatusOK {
		var movieItems TopItems
		err = json.NewDecoder(movieResponse.Body).Decode(&movieItems)
		if err != nil {
			return nil, nil, err
		}
		for _, item := range movieItems.MediaContainer.Metadata {
			movies = append(movies, postergenerator.Movie{Name: item.Title, Views: item.GlobalViewCount})
		}
	}

	return shows, movies, nil
}

func (client *PlexClient) GetLibrarySectionIds() {
	libraryURI := "/library/sections"
	resp, err := client.GetURL(libraryURI, url.Values{})
	if err != nil {
		panic(err)
	}
	if resp.StatusCode == http.StatusOK {
		var libraryResponse LibraryResponse
		err = json.NewDecoder(resp.Body).Decode(&libraryResponse)
		if err != nil {
			panic(err)
		}
		for _, directory := range libraryResponse.MediaContainer.Directory {
			fmt.Println(directory.Key, directory.Title)
		}
	}
	defer resp.Body.Close()
}

func (client *PlexClient) GetURL(urlPath string, params url.Values) (resp *http.Response, err error) {
	params.Add("X-Plex-Token", client.PlexToken)
	url := client.PlexURL + urlPath + "?" + params.Encode()

	// create a new request with headers
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	return resp, nil
}
