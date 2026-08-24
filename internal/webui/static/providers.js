"use strict";

// Provider metadata drives the data-source forms: which params exist, what
// they mean, and sensible defaults. Mirrors internal/providers/plex — keep in
// sync when providers change.
const PROVIDERS = {
  "plex.top": {
    title: "Most watched",
    describe: "The most-viewed items in one library section over a recent window, ordered by view count.",
    when: "Use for a countdown — 'Top 5 movies this month'. It is the only source that gives you meaningful view counts.",
    params: {
      type:     { options: ["", "movie", "show"], hint: "Restrict to films or TV. Leave blank for both." },
      section:  { hint: "Which Plex library to look in, by section id. {{ .MovieSectionId }} uses the one from your config.", default: "{{ .MovieSectionId }}" },
      period:   { options: ["", "{{ .PeriodInterval }}", "DAY", "WEEK", "MONTH", "YEAR"], hint: "How far back 'recently watched' reaches. {{ .PeriodInterval }} follows your PERIOD_INTERVAL setting.", default: "{{ .PeriodInterval }}" },
      limit:    { hint: "How many items to return. Match this to the number of rows your list element can fit.", default: "5" },
      trailers: { options: ["", "true"], hint: "Also resolve each item's trailer URL, so the same source can feed both the list text and a matching trailer background." },
    },
  },
  "plex.unwatched": {
    title: "Not watched yet",
    describe: "Items in a library section that nobody has watched.",
    when: "Use for a 'still on the shelf' reminder, or to build a montage of things the household has been ignoring.",
    params: {
      section: { hint: "Which Plex library to look in, by section id. Required.", default: "{{ .MovieSectionId }}" },
      type:    { options: ["", "movie", "show", "season", "episode"], hint: "Restrict to one kind of item." },
      sort:    { hint: "Plex sort expression, e.g. addedAt:desc for newest first, titleSort for A–Z." },
      limit:   { hint: "How many items to return." },
    },
  },
  "plex.trailers": {
    title: "Trailers",
    describe: "One streamable trailer per item in a section, resolved from each item's extras.",
    when: "Use to feed a clip montage. Items with no trailer are dropped, so ask for more candidates than you need.",
    params: {
      section: { hint: "Which Plex library to look in, by section id. Required.", default: "{{ .MovieSectionId }}" },
      filter:  { options: ["", "unwatched"], hint: "Restrict the candidates before trailers are looked up." },
      type:    { options: ["", "movie", "show"], hint: "Restrict to films or TV. Defaults to films." },
      sort:    { hint: "Plex sort expression, e.g. addedAt:desc for the newest arrivals." },
      limit:   { hint: "How many candidates to consider — not how many trailers you get, since some items have none." },
    },
  },
  "plex.section": {
    title: "Library listing",
    describe: "A general listing of one library section. Any parameter this source does not recognise is passed straight to Plex as a filter.",
    when: "Use when nothing more specific fits: a decade night, a genre selection, a random pick. It is the escape hatch.",
    extra: true,
    params: {
      section:   { hint: "Which Plex library to look in, by section id. Required.", default: "{{ .MovieSectionId }}" },
      type:      { options: ["", "movie", "show", "season", "episode"], hint: "Restrict to one kind of item." },
      sort:      { hint: "Plex sort expression, e.g. addedAt:desc, titleSort, random." },
      limit:     { hint: "How many items to return." },
      unwatched: { options: ["", "true"], hint: "Only items nobody has watched." },
      random:    { options: ["", "true"], hint: "Sample 200 items, shuffle them, then trim to the limit — a fairer random than Plex's own sort." },
      trailers:  { options: ["", "true"], hint: "Also resolve each item's trailer URL." },
    },
  },
  "plex.collections": {
    title: "Collections",
    describe: "The collections in a section, each one's item count exposed as Views.",
    when: "Use to advertise what is grouped in the library — 'The Bond Collection (25 titles)'.",
    params: {
      section: { hint: "Which Plex library to look in, by section id. Required.", default: "{{ .MovieSectionId }}" },
      sort:    { hint: "Plex sort expression." },
      limit:   { hint: "How many collections to return." },
    },
  },
  "plex.watchlist": {
    title: "Your watchlist",
    describe: "The watchlist on your Plex account, from Plex Discover rather than your own server.",
    when: "Use for a 'coming up' card. Set inLibrary to split what you already own from what you do not.",
    params: {
      filter:    { options: ["", "all", "available", "released"], hint: "all: everything · available: streamable somewhere · released: already out. Defaults to all." },
      type:      { options: ["", "movie", "show"], hint: "Restrict to films or TV." },
      sort:      { hint: "Discover sort expression." },
      limit:     { hint: "How many items to return." },
      inLibrary: { options: ["", "true", "false"], hint: "true: only items you already have · false: only items you do not. Leave blank for both." },
      trailers:  { options: ["", "true"], hint: "Resolve trailers for the items that matched your library — cloud-only items have none to resolve." },
    },
  },
  "plex.trending": {
    title: "Trending on Plex",
    describe: "The trending row from the Plex Discover home page — what is popular across Plex, not in your library.",
    when: "Use for a 'what everyone is watching' card, usually with inLibrary:true so you only advertise what you actually have.",
    params: {
      type:      { options: ["", "movie", "show"], hint: "Restrict to films or TV." },
      limit:     { hint: "How many items to return." },
      inLibrary: { options: ["", "true", "false"], hint: "true: only items you already have · false: only items you do not. Leave blank for both." },
      trailers:  { options: ["", "true"], hint: "Resolve trailers for the items that matched your library." },
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
