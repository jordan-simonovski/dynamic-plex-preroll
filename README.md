# dynamic-plex-preroll
Experimenting with generating dynamic plex pre-rolls 

## Building Binary

```
CGO_CFLAGS_ALLOW='-Xpreprocessor' go build ./cmd/plex-pre-rolls
```

## Manual ffmpeg steps (while I work on getting this working in ffmpeg-go)

Generating Raw Output:

```
ffmpeg -i media/as-preroll-1.ffconcat -i media/default-template/vano-adult-swim.mp3 -t 25 -vcodec libx264 -acodec aac -pix_fmt yuv420p raw.mp4
```


Generating Output with Fade Audio Filter:

```
ffmpeg -i raw.mp4 -af "afade=t=out:st=20:d=5" -vcodec libx264 -acodec aac -pix_fmt yuv420p  out.mp4
```

## Running via Docker 

You'll need a .env file

```
.env
=================
PLEX_TOKEN=""
PLEX_URL="http://localhost:32400"
MAX_ITEMS=5
PERIOD_DAYS=7
MOVIE_SECTION_ID="1"
TV_SHOW_SECTION_ID="2"
```

```
docker compose up
```