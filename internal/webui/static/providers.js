"use strict";

// Provider metadata drives the data-source forms: which params exist, what
// they mean, and sensible defaults. Mirrors internal/providers/plex — keep in
// sync when providers change.
const PROVIDERS = {
  "plex.top": {
    hint: "Most-viewed items in a library section over a period.",
    params: {
      type:     { options: ["", "movie", "show"], hint: "Item type" },
      section:  { hint: "Library section ID", default: "{{ .MovieSectionId }}" },
      period:   { options: ["", "{{ .PeriodInterval }}", "DAY", "WEEK", "MONTH", "YEAR"], hint: "Viewed-within window", default: "{{ .PeriodInterval }}" },
      limit:    { hint: "Max items", default: "5" },
      trailers: { options: ["", "true"], hint: "Also resolve each item's trailer URL (feeds trailer backgrounds)" },
    },
  },
  "plex.unwatched": {
    hint: "Unwatched items in a library section.",
    params: {
      section: { hint: "Library section ID (required)", default: "{{ .MovieSectionId }}" },
      type:    { options: ["", "movie", "show", "season", "episode"], hint: "Item type" },
      sort:    { hint: "Plex sort, e.g. addedAt:desc" },
      limit:   { hint: "Max items" },
    },
  },
  "plex.trailers": {
    hint: "A streamable trailer for each item in a section.",
    params: {
      section: { hint: "Library section ID (required)", default: "{{ .MovieSectionId }}" },
      filter:  { options: ["", "unwatched"], hint: "Restrict candidates" },
      type:    { options: ["", "movie", "show"], hint: "Item type (default movie)" },
      sort:    { hint: "Plex sort, e.g. addedAt:desc" },
      limit:   { hint: "Max candidate items" },
    },
  },
  "plex.section": {
    hint: "General listing of a library section; extra filters pass straight through to Plex.",
    extra: true,
    params: {
      section:   { hint: "Library section ID (required)", default: "{{ .MovieSectionId }}" },
      type:      { options: ["", "movie", "show", "season", "episode"], hint: "Item type" },
      sort:      { hint: "Plex sort, e.g. addedAt:desc, random" },
      limit:     { hint: "Max items" },
      unwatched: { options: ["", "true"], hint: "Only unwatched items" },
      random:    { options: ["", "true"], hint: "Shuffle a 200-item pool, then trim to limit" },
      trailers:  { options: ["", "true"], hint: "Also resolve each item's trailer URL" },
    },
  },
  "plex.collections": {
    hint: "The collections in a section (item count exposed as Views).",
    params: {
      section: { hint: "Library section ID (required)", default: "{{ .MovieSectionId }}" },
      sort:    { hint: "Plex sort" },
      limit:   { hint: "Max collections" },
    },
  },
  "plex.watchlist": {
    hint: "Your Plex Discover watchlist, optionally matched against the local library.",
    params: {
      filter:    { options: ["", "all", "available", "released"], hint: "Watchlist filter (default all)" },
      type:      { options: ["", "movie", "show"], hint: "Item type" },
      sort:      { hint: "Discover sort" },
      limit:     { hint: "Max items" },
      inLibrary: { options: ["", "true", "false"], hint: "true: only items in your library · false: only items not in it" },
      trailers:  { options: ["", "true"], hint: "Resolve trailers for library-matched items" },
    },
  },
  "plex.trending": {
    hint: "The trending row from Plex Discover home.",
    params: {
      type:      { options: ["", "movie", "show"], hint: "Item type" },
      limit:     { hint: "Max items" },
      inLibrary: { options: ["", "true", "false"], hint: "true: only items in your library · false: only items not in it" },
      trailers:  { options: ["", "true"], hint: "Resolve trailers for library-matched items" },
    },
  },
};

// Variables the renderer injects into every template string (see
// cmd/plex-pre-rolls/main.go vars map) and the fields each list item exposes.
const TEMPLATE_VARS = ["{{ .Period }}", "{{ .PeriodInterval }}", "{{ .MovieSectionId }}", "{{ .TVShowSectionId }}", "{{ .MaxItems }}"];
const ITEM_FIELDS = ["{{ .Name }}", "{{ .Rank }}", "{{ .Views }}"];
const TEMPLATE_FUNCS = ["upper", "lower", "title", "pluralize", "truncate N"];
