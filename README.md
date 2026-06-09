# dynamic-plex-preroll
Experimenting with generating dynamic plex pre-rolls 

## Building Binary

```
CGO_CFLAGS_ALLOW='-Xpreprocessor' go build ./cmd/plex-pre-rolls
```

## Pre-roll manifests (the DSL)

A pre-roll is described by a YAML manifest: global settings, named data
sources, reusable layouts, a soundtrack, and an ordered scene list. Every
text/string field is a Go `text/template`, so content is driven by the data
pulled from Plex.

Select a manifest with the `-manifest` flag or the `MANIFEST_PATH` env var. If
neither is set, the embedded default
([cmd/plex-pre-rolls/default-manifest.yaml](cmd/plex-pre-rolls/default-manifest.yaml))
reproduces the original "top stuff" pre-roll.

```
go run ./cmd/plex-pre-rolls -manifest manifests/trailers-example.yaml
```

### Data sources (providers)

Sources are resolved by named providers and exposed to templates under their
data key:

- `plex.top` — most-viewed items (`type`, `period`, `limit`).
- `plex.unwatched` — unwatched items in a section (`section`, `type`, `sort`, `limit`).
- `plex.trailers` — resolves a streamable trailer URL per candidate item
  (`section`, `filter`, `sort`, `limit`).

Add a provider in `internal/providers` and reference it from a manifest; no
engine changes required.

### Scenes

- `image` — a still shown for `duration` seconds.
- `render` — a `layout` drawn to a frame via ImageMagick, shown for `duration`.
  A render scene may supply `vars` (a string map) that are merged into the
  layout's template context, so one layout can be reused with different text.
- `clips` — splices `perClip` seconds of each item's media (e.g. trailers) from
  a data `source`.

Text elements support `align` (`left`/`center`/`right`) and multi-line strings
(`\n`), with each block centred vertically on its `y`. The built-in manifest's
intro bumpers ("hey", "hey, you", ...) are generated this way: a single `card`
layout fed per-scene `vars.Line`, so similar text sequences are trivial to add
to any manifest without pre-rendering PNGs.

`audio.mode` controls how the soundtrack interacts with clip audio
(`soundtrack` replaces, `original` keeps clip audio, `mix` blends).
`audio.start` seeks into the track (seconds) so a manifest can drop in on a
hook instead of the intro; `audio.fadeOut` is output-relative.

Example manifests live under [manifests/](manifests/):

- `top-movies-locket.yaml` — movies-only countdown, Crumb "Locket" from 0:25.
- `top-shows-show-me-how.yaml` — TV-only countdown, Men I Trust "Show Me How" from 0:33.
- `coming-up-trailers.yaml` — title card + spliced unwatched trailers with the soundtrack mixed under.
- `trailers-example.yaml` — minimal trailer-splicing example.

## Running Tests

Everything except the ImageMagick layout interpreter (`internal/render`) and
the `cmd` entrypoint is CGO-free. With ImageMagick installed, the whole suite
runs:

```
go test ./...
```

Without ImageMagick, test the CGO-free packages directly (the `render` package
won't build without it):

```
go test ./internal/manifest/... ./internal/templating/... ./internal/content/... \
  ./internal/configmanager/... ./internal/plexclient/... ./internal/providers/... \
  ./internal/pipeline/... ./internal/engine/...
```

The real rendering path has an opt-in smoke test (requires ImageMagick):

```
go test -tags imagick ./internal/render/...
```

## Getting a Plex Token

`PLEX_TOKEN` is an authenticated session token for your Plex account. The
`plex-token` CLI fetches one by signing in to plex.tv:

```
go run ./cmd/plex-token -login you@example.com
```

You'll be prompted for your password (input is hidden). If your account has
two-factor auth enabled, pass the verification code:

```
go run ./cmd/plex-token -login you@example.com -code 123456
```

Only the token is written to stdout, so you can pipe it straight into `.env`:

```
echo "PLEX_TOKEN=\"$(go run ./cmd/plex-token -login you@example.com)\"" >> .env
```

## Running via Docker 

You'll need a .env file

```
.env
=================
PLEX_TOKEN=""
PLEX_URL="http://localhost:32400"
MAX_ITEMS=5
PERIOD_INTERVAL="MONTH" # DAY, WEEK, MONTH or YEAR
MOVIE_SECTION_ID="1"
TV_SHOW_SECTION_ID="2"
```

```
docker compose up
```