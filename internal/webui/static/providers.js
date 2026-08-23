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

// TEMPLATE_CATALOG is what the template picker (pickers.js) shows. Every
// entry carries a plain-English explanation, because "{{ .PeriodInterval }}"
// tells you nothing on its own. Globals mirror the vars map in
// cmd/plex-pre-rolls/main.go; item fields mirror render.go's itemContext
// (render.go:294-303) — Rank/Name/Views only. RatingKey and MediaURL are real
// item-scope fields too (render.go:294-303, engine.go:229-236) but are left
// out of the picker for the same reason stage.js's own itemVars() leaves them
// out of the live preview: RatingKey was never added to data.go's previewItem
// and MediaURL carries a Plex token the server won't ship to the browser, so
// neither can ever show a live example here (see stage.js:122-136). Funcs
// mirror templating.FuncMap (templating.go).
const TEMPLATE_CATALOG = {
  globals: [
    { insert: "{{ .Period }}", label: ".Period",
      explain: 'The reporting window as a word — "Day", "Week", "Month", "Year", or "All Time". This is the one to put in a headline.' },
    { insert: "{{ .PeriodInterval }}", label: ".PeriodInterval",
      explain: 'The same window as the raw setting — "DAY", "WEEK", "MONTH", "YEAR". Use it in data-source params, not in text.' },
    { insert: "{{ .MovieSectionId }}", label: ".MovieSectionId",
      explain: "Your Plex movie library's section id, from MOVIE_SECTION_ID. Almost always what a movie source's `section` param should be." },
    { insert: "{{ .TVShowSectionId }}", label: ".TVShowSectionId",
      explain: "Your Plex TV library's section id, from TV_SHOW_SECTION_ID." },
    { insert: "{{ .MaxItems }}", label: ".MaxItems",
      explain: "The configured item cap, from MAX_ITEMS. Handy as a source's `limit` so one setting drives every manifest." },
  ],
  itemFields: [
    { insert: "{{ .Rank }}", label: ".Rank",
      explain: "The row's position in the list, starting at 1. Only meaningful inside a list element's row template." },
    { insert: "{{ .Name }}", label: ".Name",
      explain: "The item's title." },
    { insert: "{{ .Views }}", label: ".Views",
      explain: "How many times it was watched. Collections expose their item count here instead." },
  ],
  // Each helper carries TWO example snippets: `insert`, bound to an item field
  // (.Name/.Views) for wherever item fields are in scope, and `globalInsert`,
  // bound to a global (.Period/.MaxItems) for wherever they are not. A plain
  // render-scene text element never has .Name in scope (engine.go's
  // sceneContext, engine.go:339, overlays scene vars onto the globals — never
  // item fields), so handing out a `.Name`-bound snippet there would insert a
  // template that fails at render (Option("missingkey=error"), templating.go:33).
  // pickers.js's templateGroups() picks whichever variant fits the insertion
  // point, so only ever the safe one is offered.
  funcs: [
    { insert: "{{ upper .Name }}", globalInsert: "{{ upper .Period }}", label: "upper",
      explain: "Upper-cases the text. Common in a headline: {{ upper .Period }} gives MONTH." },
    { insert: "{{ lower .Name }}", globalInsert: "{{ lower .Period }}", label: "lower",
      explain: "Lower-cases the text." },
    { insert: "{{ title .Name }}", globalInsert: "{{ title .Period }}", label: "title",
      explain: "Capitalises the first letter of every word." },
    { insert: "{{ truncate 36 .Name }}", globalInsert: "{{ truncate 36 .Period }}", label: "truncate N",
      explain: "Cuts the text to at most N characters, adding an ellipsis when it had to cut. The fix for a long film title running off the frame." },
    { insert: '{{ pluralize .Views "view" "views" }}', globalInsert: '{{ pluralize .MaxItems "item" "items" }}', label: "pluralize",
      explain: 'Picks the singular word when the number is 1 and the plural otherwise: "1 view" / "3 views".' },
  ],
};
