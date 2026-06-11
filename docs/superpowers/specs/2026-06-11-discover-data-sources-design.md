# Plex Discover data sources: `plex.watchlist` and `plex.trending`

Date: 2026-06-11
Status: approved

## Goal

Two new manifest data providers backed by the Plex Discover cloud API
(`https://discover.provider.plex.tv`), so pre-rolls can render the account's
watchlist and Plex's trending feed — including matching those items back to the
local server for trailer splicing.

Out of scope (deferred): recommended-on-services, available-on-services.

## Components

### 1. Discover client (`internal/plexclient`)

`DiscoverClient` lives next to `PlexClient` and reuses its request plumbing
(token auth, redaction, debug logging, 30s timeout, optional `HTTPClient`).
Base URL is the constant `https://discover.provider.plex.tv`; no new env vars.

Constraints:

- `PLEX_TOKEN` must be a plex.tv account token (what `cmd/plex-token` emits).
  A server-only token returns 401; the error message states this explicitly.
- Discover responses use the same `MediaContainer/Metadata` JSON shape as the
  local server. The decode struct gains `guid`. Art/thumb URLs from Discover
  are absolute; they are used as-is, never prefixed with `PLEX_URL` and never
  given a token.

Methods:

- `WatchlistItems(filter string, params url.Values)` →
  `GET /library/sections/watchlist/{filter}` (documented endpoint; the one
  python-plexapi and Overseerr use).
- `HomeHubs(params url.Values)` → `GET /hubs/sections/home`, returning the hub
  list (identifier + items) for trending selection.

### 2. `plex.watchlist` provider

```yaml
provider: plex.watchlist
params:
  filter: all        # all | available | released (default: all)
  type: movie        # movie | show (maps to libtype)
  sort: watchlistedAt:desc
  limit: "5"
  inLibrary: "true"  # optional: true = only items on the server, false = only items not on it
  trailers: "true"   # optional: attach local trailers to library-matched items
```

### 3. `plex.trending` provider

The Discover trending feed has no documented endpoint, so the provider does not
hardcode a path. It fetches the Discover home hubs and selects the first hub
whose identifier contains `trending` (case-insensitive). If none exists it
fails with an error listing the hub identifiers that were found. Params:
`type`, `limit`, `inLibrary`, `trailers` — same semantics as watchlist.

Accepted risk: Plex can rearrange the hubs without notice. Watchlist is
unaffected.

### 4. GUID matching (Discover → local library)

Discover items carry `plex://movie/...` / `plex://show/...` GUIDs. Matching:

- `PlexClient.FindByGUID(guid)` → `GET {PLEX_URL}/library/all?guid=<guid>`,
  returns the first local item (RatingKey, token-authenticated art/thumb) or
  none.
- Without an `inLibrary` filter, matching runs after `limit` is applied:
  ≤ limit requests per source. With `inLibrary` set, filtering discards items,
  so the provider fetches a pool of 40 from Discover, matches, filters, then
  trims to `limit` — otherwise a mostly-offline watchlist starves the result.
- Matched items get the local `RatingKey` (enabling `attachTrailers`) and keep
  Discover metadata otherwise.
- `inLibrary: true` keeps only matched items; `false` only unmatched; unset
  keeps all.
- `content.Item` gains a `GUID` field, populated by both clients where the API
  provides it.

### 5. Wiring

`plex.Register` gains the Discover client. Providers depend on small
interfaces (existing pattern) so tests use fakes/httptest:

```go
type DiscoverClient interface {
    WatchlistItems(filter string, params url.Values) (content.Items, error)
    HomeHubs(params url.Values) (Hubs, error)
}
```

`cmd/plex-pre-rolls/main.go` constructs the Discover client from the same
config (token, debug, insecure HTTP client) and passes it to `Register`.

## Error handling

Fail closed: any Discover non-200, decode failure, or missing trending hub is
an error from the provider — never a silently empty pre-roll. 401 errors name
the account-token requirement. Token redaction applies to all Discover URLs in
logs and errors.

## Testing

- Provider tests: httptest servers standing in for Discover and the local
  server (existing pattern in `internal/providers/plex/plex_test.go`),
  covering: watchlist param mapping, trending hub selection + missing-hub
  error, GUID match attach/filter behaviour, trailers on matched items.
- Client tests: `httptest` for `WatchlistItems`, `HomeHubs`, `FindByGUID`,
  including absolute-URL art handling and 401 messaging.

## Deliverables

- `internal/plexclient`: `DiscoverClient`, `FindByGUID`, struct additions.
- `internal/providers/plex`: `watchlistProvider`, `trendingProvider`, GUID
  match helper.
- `manifests/watchlist.yaml`: "On your watchlist — now on the server"
  (`filter: all`, `inLibrary: "true"`).
- README: document both providers and the account-token requirement.
