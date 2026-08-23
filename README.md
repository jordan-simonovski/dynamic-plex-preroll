# dynamic-plex-preroll

Personalised, data-driven pre-rolls for your Plex server. Instead of bolting the
same static clip in front of every play, this generates short videos from what is
actually on *your* server right now: the top-watched titles of the month, fresh
arrivals, your collections, spliced trailers of stuff nobody has watched yet.

You describe the pre-roll once in a small YAML manifest. The tool pulls live data
from Plex, renders the frames, splices any trailers, mixes a soundtrack, and
writes a finished `.mp4`. Point Plex at the output and your server greets people
with something made for it.

It is a single Go binary (plus ImageMagick and ffmpeg for rendering), runs from a
`docker compose up`, and ships with a dozen example manifests you can use as-is or
tweak.

## What it looks like

A few rendered examples (sample data — yours are built from your own server):

<!--
  To make these play inline: open this README in GitHub's web editor (pencil icon),
  drag the matching .mp4 from pre-roll-output/ into the editor, wait for GitHub to
  replace it with a https://github.com/user-attachments/assets/... URL, and paste
  that URL into the src="" below. Only those CDN URLs render as a player; a link to
  a file committed in the repo will not.
-->

**`trailers.yaml`** — a title card, then real trailers of unwatched picks spliced back to back:

<video src="https://github.com/user-attachments/assets/59215e3b-621e-42bc-8f46-5d35b7fef988" controls width="600"></video>

**`top-movies-trailer-wall.yaml`** — your most-watched movies over a moving wall of their own trailers:

<video src="https://github.com/user-attachments/assets/f10f1fce-fccd-429e-8202-1b45cfcb73c3
" controls width="600"></video>

**`collections.yaml`** — your movie collections with their title counts:

<video src="https://github.com/user-attachments/assets/c63293a5-34a8-4557-a03d-5dbfdcb9d6c9" controls width="600"></video>

## What you can build

The bundled manifests under [manifests/](manifests/) are working examples, not
just demos. Each is a different pre-roll concept:

- `top-movies-locket.yaml` / `top-shows-show-me-how.yaml` — a countdown of your
  most-watched movies or shows for the period, scored to a track.
- `top-movies-trailer-wall.yaml` / `top-shows-trailer-wall.yaml` — the top list
  over a moving wall of those titles' own trailers.
- `recently-added.yaml` / `fresh-arrivals.yaml` — "new this week" cards driven by
  what you actually added.
- `coming-up-trailers.yaml` / `tv-trailers.yaml` / `trailers-example.yaml` —
  title card, then real trailers of unwatched picks spliced back to back.
- `double-feature.yaml` — two random titles framed as tonight's double bill.
- `decade-night.yaml` — a themed night pulled from a single decade.
- `collections.yaml` — your movie collections with their title counts.
- `watchlist.yaml` — titles from your Plex watchlist that are already on the
  server ("already here, no excuses").

Swap the soundtrack, change the limit, point it at a different library, and it is
a new pre-roll. No re-rendering PNGs, no video editor.

## Quick start

You need a `.env` (see [Configuration](#configuration)) and Docker.

```
docker compose up
```

That renders the built-in default pre-roll and drops the `.mp4` in
`pre-roll-output/`. To render one of the examples instead, set `MANIFEST_PATH`
(single) or `MANIFEST_DIR` (batch) in your `.env`:

```
MANIFEST_PATH=manifests/top-movies-locket.yaml
# or render every manifest in a folder in one run:
MANIFEST_DIR=manifests
```

### Wiring the output into Plex

Plex Pass servers have a pre-roll setting (Settings → Extras → *Pre-roll video*).
Put the path to a generated `.mp4` there. List several paths separated by a comma
to have Plex pick one at random per play, or a semicolon to play them in
sequence. Render a batch with `MANIFEST_DIR` and you have a rotating set that
stays current as your library changes — re-run on a schedule to refresh it.

## Building the binary

If you would rather run it directly than via Docker:

```
CGO_CFLAGS_ALLOW='-Xpreprocessor' go build ./cmd/plex-pre-rolls
```

```
go run ./cmd/plex-pre-rolls -manifest manifests/trailers-example.yaml
```

Select a manifest with the `-manifest` flag / `MANIFEST_PATH`, or a directory
with `-manifest-dir` / `MANIFEST_DIR` (batch mode wins if both are set). With
neither, the embedded default
([cmd/plex-pre-rolls/default-manifest.yaml](cmd/plex-pre-rolls/default-manifest.yaml))
renders the original "top stuff" pre-roll. In batch mode one bad manifest is
logged and skipped; the run still exits non-zero if anything failed.

## Pre-roll manifests (the DSL)

A pre-roll is described by a YAML manifest: global settings, named data sources,
reusable layouts, a soundtrack, and an ordered scene list. Every text/string
field is a Go `text/template`, so content is driven by the data pulled from Plex.

### Data sources (providers)

Sources are resolved by named providers and exposed to templates under their data
key:

- `plex.top` — most-viewed items (`type`, `section`, `period`, `limit`); set
  `trailers: true` to also resolve each item's trailer URL.
- `plex.unwatched` — unwatched items in a section (`section`, `type`, `sort`,
  `limit`).
- `plex.trailers` — resolves a streamable trailer URL per candidate item
  (`section`, `filter`, `sort`, `limit`).
- `plex.section` — general section listing; supports `random: true` and passes
  any unrecognised param through as a Plex filter (e.g. `decade=1990`,
  `year>>=2000`).
- `plex.collections` — collections in a section, each child count exposed as
  `Views` (`section`, `sort`, `limit`).
- `plex.watchlist` — your account's watchlist from the Plex Discover API
  (`filter`: all/available/released, `type`, `sort`, `limit`).
- `plex.trending` — the trending row from Discover home (`type`, `limit`).
  Plex does not document this feed; if they move it the provider fails with
  the hub names it did find.

The two Discover providers also take `inLibrary` ("true" keeps only titles on
your server, "false" only titles you don't have) and `trailers: true`, which
matches items to your library by GUID and splices the local trailer. They need
`PLEX_TOKEN` to be a plex.tv *account* token — exactly what `cmd/plex-token`
produces — not a server-local one.

Add a provider in `internal/providers` and reference it from a manifest; no
engine changes required.

### Scenes

- `image` — a still shown for `duration` seconds.
- `render` — a `layout` drawn to a frame via ImageMagick, shown for `duration`.
  A render scene may supply `vars` (a string map) that are merged into the
  layout's template context, so one layout can be reused with different text. A
  render scene can also take a `background` sourced from data (e.g. a dimmed grid
  of posters).
- `clips` — splices `perClip` seconds of each item's media (e.g. trailers) from a
  data `source`.

Text elements support `align` (`left`/`center`/`right`) and multi-line strings
(`\n`), with each block centred vertically on its `y`. The built-in manifest's
intro bumpers ("hey", "hey, you", ...) are generated this way: a single `card`
layout fed per-scene `vars.Line`, so similar text sequences are trivial to add to
any manifest without pre-rendering PNGs.

`audio.mode` controls how the soundtrack interacts with clip audio (`soundtrack`
replaces, `original` keeps clip audio, `mix` blends). `audio.start` seeks into the
track (seconds) so a manifest can drop in on a hook instead of the intro;
`audio.fadeOut` is output-relative.

## Config UI

A browser-based editor for building manifests without hand-writing YAML.

```bash
docker compose up -d preroll-ui   # http://localhost:8382
# or locally (pure Go, no ImageMagick needed):
go run ./cmd/preroll-ui -manifest-dir manifests
```

The editor covers the whole DSL — data sources (with per-provider parameter
hints), layouts, the scene timeline, and audio — and shows the generated YAML
live with validation errors as you type. **Save** writes the manifest into the
manifest directory, so the next render run (`docker compose run plex-pre-roll`
with `MANIFEST_DIR` set) picks it up. Saves are strict: an invalid manifest is
refused rather than written.

Saving rewrites the file from the manifest structure, which drops any comments
you hand-wrote in it. The previous contents are kept alongside as
`<name>.yaml.bak` (the renderer ignores `.bak` files), and writes are atomic —
a crash mid-save can never leave a truncated manifest for the renderer to trip
over.

The UI has no auth — it can read, write and delete files in `MANIFEST_DIR`. It
only accepts requests addressed to `localhost` or a bare IP, so a malicious web
page can't reach it via DNS rebinding, but that is the extent of it: keep it on
your LAN and don't expose port 8382 to the internet.

## Configuration

Configuration is read from the environment (Docker reads it from `.env`):

```
.env
=================
PLEX_TOKEN=""                  # see "Getting a Plex token" below
PLEX_URL="http://localhost:32400"
MAX_ITEMS=5
PERIOD_INTERVAL="MONTH"        # DAY, WEEK, MONTH or YEAR
MOVIE_SECTION_ID="1"
TV_SHOW_SECTION_ID="2"
# optional:
# MANIFEST_PATH=manifests/top-movies-locket.yaml
# MANIFEST_DIR=manifests
# DEBUG=true
# PLEX_INSECURE=true           # skip TLS verification; trusted networks only
```

`MAX_ITEMS`, `PERIOD_INTERVAL`, and the section ids are seeded into the template
context (as `MaxItems`, `Period`/`PeriodInterval`, `MovieSectionId`,
`TVShowSectionId`), so manifests can reference your settings instead of
hard-coding them.

## Getting a Plex token

`PLEX_TOKEN` is an authenticated session token for your Plex account. The
`plex-token` helper fetches one by signing in to plex.tv. Run it through Docker
so you don't need a Go toolchain:

```
docker compose run --rm plex-token -login you@example.com
```

You'll be prompted for your password (input is hidden). If your account has
two-factor auth enabled, pass the verification code:

```
docker compose run --rm plex-token -login you@example.com -code 123456
```

Only the token is printed, so copy it into `PLEX_TOKEN` in your `.env`. The
first run builds a small image (no ImageMagick/ffmpeg); later runs are instant.

If you do have Go installed, the same util runs directly:

```
echo "PLEX_TOKEN=\"$(go run ./cmd/plex-token -login you@example.com)\"" >> .env
```

## Running tests

Everything except the ImageMagick layout interpreter (`internal/render`) and the
`cmd` entrypoint is CGO-free. With ImageMagick installed, the whole suite runs:

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
