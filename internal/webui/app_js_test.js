// Node check for the pure bits of the static scripts (util.js, state.js and
// app.js's convert loop). They are browser scripts with no module system, so
// they run inside a vm context — which shares one global lexical scope across
// runInContext calls, exactly like classic <script> tags — on top of a stub DOM
// just big enough to boot them; the assertions then call their functions
// directly.
//
//   node internal/webui/app_js_test.js
//
// ponytail: stub DOM, not jsdom — this covers pure functions and one async
// ordering guard. Reach for a real DOM only when rendering itself needs testing.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- stub DOM --------------------------------------------------------------
// The canvas bits are stubs to the point of inertia: stage.js is covered by
// stage_test.js, and here it only has to boot without a browser.
const canvasStub = new Proxy({ fillStyle: "", font: "" }, { get: (t, k) => (k in t ? t[k] : () => ({ width: 0 })) });
function makeEl() {
  const attrs = {};
  const el = {
    attrs,
    innerHTML: "", textContent: "", value: "", checked: false,
    clientWidth: 800, width: 0, height: 0, style: {},
    dataset: {}, options: [],
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, closest() { return null; },
    querySelector: () => makeEl(),
    getContext: () => canvasStub,
    // Task 11 needs the stage's aria-label kept current, and the tabindex/
    // role attributes it sets on boot; a no-op setAttribute stub is enough
    // for this file, which only has to boot without throwing.
    hasAttribute(a) { return attrs[a] !== undefined; },
    setAttribute(a, v) { attrs[a] = v; },
    toggleAttribute(a, on) { if (on) attrs[a] = ""; else delete attrs[a]; },
    focus() {},
    // Task 18's new-picker is a <dialog>, same as file-picker/template-picker
    // — modalOpen is just for this file's own assertions, matching
    // filepicker_test.js's convention.
    modalOpen: false,
    showModal() { el.modalOpen = true; },
    close() { el.modalOpen = false; },
    // The http-only clipboard fallback builds a throwaway <textarea>.
    select() { el.selected = true; },
    remove() { el.removed = true; },
  };
  return el;
}
const els = new Map();
const copied = [];
let execCommandOK = true;
const document = {
  querySelector(sel) {
    if (!els.has(sel)) els.set(sel, makeEl());
    return els.get(sel);
  },
  createElement: () => makeEl(),
  // The clipboard fallback's collaborators: copied records what the browser's
  // own copy command was handed, execCommandOK arms whether it succeeds.
  body: { appendChild(el) { copied.push(el.value); } },
  execCommand: () => execCommandOK,
  // syncPath() sweeps every data-path-bound control. Nothing here renders real
  // markup, so a test registers its own fake controls in `bound`.
  querySelectorAll: () => bound,
  fonts: { add() {} },
};
const bound = [];
function boundInput(path, value) {
  const el = makeEl();
  el.dataset.path = path;
  el.value = value;
  bound.push(el);
  return el;
}

// Requests to /api/convert are parked in `pending` so a test can resolve them
// out of order; everything else answers immediately.
const pending = [];
// manifestList/manifestFixtures drive /api/manifests and /api/manifests/<name>
// for Task 18's tests below; both default to "nothing on disk", matching the
// generic []-returning fallback every other stub URL got before this file
// existed. fetchLog records every call (url + method) so a test can prove a
// PUT never reached the network — the mutation-check for the clobber fix.
let manifestList = [];
const manifestFixtures = {};
const fetchLog = [];
function fetchStub(url, opts) {
  fetchLog.push({ url, method: (opts && opts.method) || "GET" });
  if (url === "/api/convert") {
    return new Promise((resolve) => pending.push(resolve));
  }
  if (url === "/api/manifests") {
    return Promise.resolve(reply(manifestList));
  }
  const gm = /^\/api\/manifests\/([^/]+)$/.exec(url);
  if (gm) {
    const name = decodeURIComponent(gm[1]);
    if ((opts && opts.method) === "PUT") {
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
    if (!Object.hasOwn(manifestFixtures, name)) {
      return Promise.resolve({ ok: false, text: async () => `${name}: not found` });
    }
    return Promise.resolve(reply(manifestFixtures[name]));
  }
  return Promise.resolve({ ok: true, json: async () => [] });
}
function reply(body) {
  return { ok: true, json: async () => body };
}

let confirmAnswer = true;
const flashes = [];

const ctx = vm.createContext({
  document,
  window: { addEventListener() {}, devicePixelRatio: 1 },
  fetch: fetchStub,
  setTimeout, clearTimeout,
  confirm: () => confirmAnswer,
  navigator: { clipboard: { writeText: async () => {} } },
  console,
});

const staticDir = path.join(__dirname, "static");
for (const f of ["providers.js", "util.js", "geometry.js", "interact.js", "state.js", "api.js", "stage.js", "pickers.js", "inspector.js", "timeline.js", "renderjob.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}
// `state` is a top-level `let` in state.js, so it lives in the context's
// shared script scope rather than on the global object; this bridge reaches it.
// openedFile is a top-level `let` in app.js (same shared-scope reasoning) and
// actions a top-level `const` in state.js — Task 18's clobber-protection
// proof needs to read/set the former and drive the latter's "new-empty" /
// "new-from" entries directly, the same way timeline_test.js's own bridge
// already exposes `actions`.
vm.runInContext(`globalThis.__t = {
  getState: () => state,
  setState: (s) => { state = s; },
  getOpenedFile: () => openedFile,
  setOpenedFile: (v) => { openedFile = v; },
  actions,
};`, ctx);

// The renderers are exercised at boot above; from here they only add noise.
// (renderInspector's real body needs panel.contains(), which this stub DOM
// does not implement — its own DOM behaviour is inspector_test.js's job.)
ctx.renderAll = () => {};
ctx.renderStage = () => {};
ctx.renderInspector = () => {};
ctx.flash = (msg, isError) => flashes.push({ msg, isError });
pending.length = 0; // drop the boot convert; later converts get higher seqs

// ---- assertions ------------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// uniqueKey: presence, not truthiness — new keys are seeded with "".
{
  const { uniqueKey } = ctx;
  check("uniqueKey: free base", uniqueKey({}, "Var") === "Var");
  check("uniqueKey: empty-string value still counts as taken",
    uniqueKey({ Var: "" }, "Var") === "Var2", uniqueKey({ Var: "" }, "Var"));
  check("uniqueKey: skips both empty keys",
    uniqueKey({ Var: "", Var2: "" }, "Var") === "Var3");
  // The reported symptom: two clicks of "+ Add variable" must make two rows.
  const vars = {};
  vars[uniqueKey(vars, "Var")] = "";
  vars[uniqueKey(vars, "Var")] = "";
  check("uniqueKey: two adds make two keys", Object.keys(vars).length === 2,
    JSON.stringify(vars));
}

// select: an empty bound value must not display the first option as chosen.
{
  const { select } = ctx;
  const html = select("scenes.0.layout", "", ["title", "outro"]);
  check("select: empty value prepends an empty option",
    html.indexOf('<option value="" selected>') === html.indexOf("<option"), html);
  check("select: empty value leaves real options unselected",
    !html.includes('<option value="title" selected'), html);

  const known = select("p", "outro", ["title", "outro"]);
  check("select: known value selected", known.includes('<option value="outro" selected'), known);
  check("select: known value adds no empty option", !known.includes('value=""'), known);

  const missing = select("p", "gone", ["title"]);
  check("select: unknown value kept and labelled",
    missing.includes('<option value="gone" selected>gone (missing)'), missing);

  const withEmpty = select("p", "", ["", "left", "right"], { emptyLabel: "left (default)" });
  check("select: list that already has an empty option gets only one",
    withEmpty.split('value=""').length === 2, withEmpty);
}

// renameKey: dotted names would break every data-path, and every rejection
// must say so rather than silently restoring the old name.
{
  const { renameKey, getPath, setPath } = ctx;
  const fresh = () => ctx.__t.setState({ data: { good: { provider: "plex.top", params: {} } }, scenes: [], layouts: {} });

  fresh(); flashes.length = 0;
  renameKey("data", "good", "top.movies");
  check("renameKey: dotted name rejected",
    Object.keys(ctx.__t.getState().data).join() === "good", Object.keys(ctx.__t.getState().data).join());
  check("renameKey: dotted name flashes an error",
    flashes.length === 1 && flashes[0].isError === true, JSON.stringify(flashes));

  fresh(); flashes.length = 0;
  renameKey("data", "good", "");
  check("renameKey: empty name flashes an error",
    flashes.length === 1 && flashes[0].isError === true, JSON.stringify(flashes));

  ctx.__t.setState({ data: { a: {}, b: {} }, scenes: [], layouts: {} }); flashes.length = 0;
  renameKey("data", "a", "b");
  check("renameKey: duplicate name flashes an error",
    flashes.length === 1 && flashes[0].isError === true, JSON.stringify(flashes));
  check("renameKey: duplicate name keeps both keys",
    Object.keys(ctx.__t.getState().data).join() === "a,b");

  fresh(); flashes.length = 0;
  renameKey("data", "good", "renamed");
  check("renameKey: valid rename applied",
    Object.keys(ctx.__t.getState().data).join() === "renamed");

  // retargetSource/retargetLayout are the whole point of renameKey: without
  // them a rename dangles every reference to the old name. The cases above all
  // seed `scenes: []` and `layouts: {}`, so neither function ever ran.
  {
    ctx.__t.setState({
      data: { top: { provider: "plex.top", params: {} } },
      layouts: {
        title: { font: "", background: {}, elements: [
          { type: "list", source: "top", item: "{{ .Name }}" },
          { type: "text", text: "no source here" },
        ] },
      },
      scenes: [
        { kind: "clips", source: "top", label: "title" },
        { kind: "render", layout: "title", background: { source: "top", mode: "art" } },
      ],
    });
    flashes.length = 0;
    renameKey("data", "top", "topMovies");
    const st = ctx.__t.getState();
    check("retargetSource: a clips scene's source follows the rename",
      st.scenes[0].source === "topMovies", st.scenes[0].source);
    check("retargetSource: a scene background's source follows the rename",
      st.scenes[1].background.source === "topMovies", st.scenes[1].background.source);
    check("retargetSource: a list element's source follows the rename",
      st.layouts.title.elements[0].source === "topMovies", st.layouts.title.elements[0].source);
    check("retargetSource: an element with no source is left alone, not given one",
      st.layouts.title.elements[1].source === undefined, JSON.stringify(st.layouts.title.elements[1]));
    check("retargetSource: nothing still points at the old name",
      !JSON.stringify(st).includes('"top"'), JSON.stringify(st));

    renameKey("layouts", "title", "titleCard");
    const st2 = ctx.__t.getState();
    check("retargetLayout: a render scene's layout follows the rename",
      st2.scenes[1].layout === "titleCard", st2.scenes[1].layout);
    check("retargetLayout: a clips scene's LABEL layout follows the rename too",
      st2.scenes[0].label === "titleCard", st2.scenes[0].label);
    check("retargetLayout: the layout map itself was rekeyed",
      Object.keys(st2.layouts).join() === "titleCard", Object.keys(st2.layouts).join());
    check("retargetLayout: a rejected rename retargets nothing",
      (renameKey("layouts", "titleCard", "bad.name"),
       ctx.__t.getState().scenes[1].layout === "titleCard"),
      ctx.__t.getState().scenes[1].layout);
  }

  // Why the dot rejection exists: paths are split on ".".
  const obj = { data: { "top.movies": { params: {} } } };
  check("getPath: a dotted key is unreachable",
    getPath(obj, "data.top.movies.params") === undefined);
  // setPath used to walk into undefined and throw a TypeError from inside the
  // input handler — the edit vanished with nothing shown. It must report and
  // leave the state alone instead.
  flashes.length = 0;
  let threw = false;
  let wrote = null;
  try { wrote = setPath(obj, "data.top.movies.params.x", 1); } catch { threw = true; }
  check("setPath: an unaddressable path does not throw into the event handler", !threw);
  check("setPath: an unaddressable path reports it did not write", wrote === false);
  check("setPath: an unaddressable path flashes an error",
    flashes.length === 1 && flashes[0].isError === true, JSON.stringify(flashes));
  check("setPath: an unaddressable path leaves the object untouched",
    JSON.stringify(obj) === '{"data":{"top.movies":{"params":{}}}}', JSON.stringify(obj));
  // The ordinary case still writes, and says so.
  flashes.length = 0;
  const ok = { a: { b: {} } };
  check("setPath: a reachable path still writes", setPath(ok, "a.b.c", 7) === true && ok.a.b.c === 7);
  check("setPath: a reachable path flashes nothing", flashes.length === 0);
}

// replaceState: a manifest that already carries a dotted key cannot be edited
// safely, so it is refused at the door rather than opened and silently losing
// the first edit to that key. Finding #9.
{
  const { replaceState } = ctx;
  const good = { name: "keep-me", data: {}, layouts: {}, scenes: [] };
  const cases = [
    ["a dotted data-source name", { data: { "top.movies": { provider: "plex.top", params: {} } } }, /top\.movies/],
    ["a dotted provider param", { data: { top: { provider: "plex.top", params: { "max.items": 5 } } } }, /max\.items/],
    ["a dotted layout name", { layouts: { "title.card": { elements: [] } } }, /title\.card/],
    ["a dotted scene var", { scenes: [{ kind: "render", layout: "t", vars: { "my.var": "x" } }] }, /my\.var/],
  ];
  for (const [what, bad, mentions] of cases) {
    ctx.__t.setState(ctx.normalize(good));
    flashes.length = 0;
    const accepted = replaceState({ name: "dotted", data: {}, layouts: {}, scenes: [], ...bad });
    check(`replaceState: ${what} is refused`, accepted === false, String(accepted));
    check(`replaceState: ${what} leaves the open manifest alone`,
      ctx.__t.getState().name === "keep-me", ctx.__t.getState().name);
    check(`replaceState: ${what} flashes an error naming the key`,
      flashes.length === 1 && flashes[0].isError === true && mentions.test(flashes[0].msg),
      JSON.stringify(flashes));
  }
  // The mutation check: an ordinary manifest must still open, and every
  // shipped manifest is ordinary.
  flashes.length = 0;
  const accepted = replaceState({ name: "plain", data: { top: { provider: "plex.top", params: { limit: 5 } } },
    layouts: { title: { elements: [] } }, scenes: [{ kind: "render", layout: "title", vars: { Var: "x" } }] });
  check("replaceState: a manifest with no dotted key still opens", accepted === true);
  check("replaceState: opening a clean manifest flashes nothing", flashes.length === 0, JSON.stringify(flashes));
  check("replaceState: opening a clean manifest actually swaps the state",
    ctx.__t.getState().name === "plain", ctx.__t.getState().name);
}

// syncPath: the inspector and the General card bind the same paths, and typing
// does not re-render the form — so the OTHER control has to be pushed the new
// value or it keeps showing the old one (and writes it back on the next edit).
{
  ctx.__t.setState({ ...ctx.emptyManifest(), name: "", output: "" });
  const typed = boundInput("name", "");
  const mirror = boundInput("name", "");
  const output = boundInput("output", "");

  typed.value = "my-preroll";
  ctx.onEditorInput({ target: typed });
  check("syncPath: the state took the edit", ctx.__t.getState().name === "my-preroll");
  check("syncPath: the other control bound to the same path follows",
    mirror.value === "my-preroll", mirror.value);
  check("syncPath: a derived field is pushed out too — everywhere, not just the General card",
    output.value === "output/my-preroll.mp4", output.value);

  // Once output is customised, it stops being derived from the name.
  output.value = "custom.mp4";
  ctx.onEditorInput({ target: output });
  typed.value = "renamed";
  ctx.onEditorInput({ target: typed });
  check("syncPath: a customised output is left alone",
    ctx.__t.getState().output === "custom.mp4", ctx.__t.getState().output);
  bound.length = 0;
}

// colour picker: the text field stays authoritative. Typing "none" — a value
// the native <input type="color"> cannot hold — must land in state verbatim
// and must not be "corrected" to a hex; the swatch (a separate DOM node) has
// to keep up without a full renderInspector() destroying the cursor
// mid-keystroke (see onEditorInput's comment). The native picker's own change
// event is the reverse case: it only ever writes a hex it produced itself.
{
  ctx.__t.setState({ ...ctx.emptyManifest(),
    layouts: { main: { font: "", background: { color: "white" }, elements: [] } } });
  const path = "layouts.main.background.color";

  const text = boundInput(path, "white");
  text.dataset.colorText = "";

  const swatchClasses = new Set();
  const swatch = makeEl();
  swatch.dataset.swatchFor = path;
  swatch.classList = {
    toggle(cls, on) { on ? swatchClasses.add(cls) : swatchClasses.delete(cls); },
    add(cls) { swatchClasses.add(cls); }, remove(cls) { swatchClasses.delete(cls); },
    contains(cls) { return swatchClasses.has(cls); },
  };
  bound.push(swatch);

  const picker = makeEl();
  picker.dataset.colorFor = path;
  picker.value = "#ffffff";
  bound.push(picker);

  text.value = "none";
  ctx.onEditorInput({ target: text });
  check("colour: typing 'none' writes it to state verbatim, never a hex",
    ctx.__t.getState().layouts.main.background.color === "none",
    ctx.__t.getState().layouts.main.background.color);
  check("colour: the swatch flips to swatch-none for an unrepresentable value",
    swatchClasses.has("swatch-none"), [...swatchClasses].join(","));
  check("colour: a value the picker cannot hold leaves the native picker untouched",
    picker.value === "#ffffff", picker.value);

  text.value = "#ff0000";
  ctx.onEditorInput({ target: text });
  check("colour: a hex value clears swatch-none", !swatchClasses.has("swatch-none"));
  check("colour: the swatch background follows the typed hex",
    swatch.style.background === "#ff0000", swatch.style.background);
  check("colour: the native picker follows a representable typed value",
    picker.value === "#ff0000", picker.value);

  // The native picker firing its own change event writes its hex back into
  // the text value's path — nothing derived, nothing guessed.
  picker.value = "#00ff00";
  ctx.onEditorChange({ target: picker });
  check("colour: the native picker's change writes its own hex into state",
    ctx.__t.getState().layouts.main.background.color === "#00ff00",
    ctx.__t.getState().layouts.main.background.color);
  bound.length = 0;
}

// ---- Task 18: start from an existing manifest instead of an empty form ----
(async () => {

// summariseManifest: what a starting point is made of, so the chooser reads
// as a menu of approaches rather than a list of filenames.
{
  const { summariseManifest } = ctx;
  const s1 = summariseManifest({ scenes: [{ kind: "render" }, { kind: "render" }, { kind: "clips" }] });
  check("summariseManifest: counts scene kinds", s1 === "2 render, 1 clips", s1);

  const s2 = summariseManifest({
    scenes: [{ kind: "clips" }],
    data: { a: { provider: "plex.top" }, b: { provider: "plex.top" }, c: { provider: "plex.trailers" } },
  });
  check("summariseManifest: names the unique data providers, order preserved, no repeats",
    s2 === "1 clips · from plex.top, plex.trailers", s2);

  check("summariseManifest: no scenes says so",
    summariseManifest({ scenes: [] }) === "no scenes");
  check("summariseManifest: no data sources omits the 'from' clause",
    summariseManifest({ scenes: [{ kind: "image" }] }) === "1 image");
}

// openNewManifestDialog: Empty first, then every manifest with its summary;
// an unreadable one says so instead of throwing; nothing to offer degrades to
// a message rather than an empty heading.
{
  manifestList = ["a.yaml", "b.yaml"];
  manifestFixtures["a.yaml"] = { scenes: [{ kind: "render" }], data: { x: { provider: "plex.top" } } };
  // b.yaml is deliberately left out of manifestFixtures: apiGetManifest's GET
  // then 404s, exactly like a manifest that fails to parse on the server.
  confirmAnswer = true;
  document.querySelector("#new-picker").modalOpen = false;
  await ctx.openNewManifestDialog();
  const body = document.querySelector("#new-picker-body").innerHTML;
  check("chooser: offers Empty manifest first",
    body.indexOf("Empty manifest") < body.indexOf("a.yaml"), body);
  check("chooser: shows a.yaml's summary",
    body.includes("1 render · from plex.top"), body);
  check("chooser: an unreadable manifest says so instead of throwing",
    body.includes("could not be read"), body);
  check("chooser: the dialog was actually opened",
    document.querySelector("#new-picker").modalOpen === true);

  // Degrade gracefully: no other manifests on disk.
  manifestList = [];
  await ctx.openNewManifestDialog();
  const emptyBody = document.querySelector("#new-picker-body").innerHTML;
  check("chooser: still offers Empty manifest with nothing else on disk",
    emptyBody.includes("Empty manifest"), emptyBody);
  check("chooser: says so instead of an empty 'Start from an existing manifest' list",
    emptyBody.includes("No other manifests"), emptyBody);
  check("chooser: does not render the section heading over an empty list",
    !emptyBody.includes("Start from an existing manifest"), emptyBody);

  delete manifestFixtures["a.yaml"];
}

// The discard confirm: New must still ask before it discards. It now gates
// the dialog itself, covering both of the dialog's outcomes (empty or
// template) — a deviation from the brief, which never confirmed at all.
{
  document.querySelector("#new-picker").modalOpen = false;
  confirmAnswer = false;
  await ctx.openNewManifestDialog();
  check("chooser: declining the discard confirm never opens the dialog",
    document.querySelector("#new-picker").modalOpen === false);
  confirmAnswer = true;
}

// ---- the clobber-protection proof ------------------------------------------
// The dangerous path named in the task: pick a shipped manifest as a starting
// point, and Save must not be able to land on the file it came from.
// Reproduced exactly as it happens in the app — the user had this very
// manifest open (openedFile points at it) before clicking New, which is
// precisely the case saveManifest()'s `openedFile || derived` would clobber
// through if startFromTemplate left openedFile untouched.
{
  const SOURCE = {
    name: "Top Movies Trailer Wall", output: "output/top-movies-trailer-wall.mp4",
    data: { top: { provider: "plex.top", params: {} } },
    layouts: {}, scenes: [{ kind: "clips", source: "top", perClip: 4, label: "" }],
  };
  manifestFixtures["top-movies-trailer-wall.yaml"] = SOURCE;
  manifestList = ["top-movies-trailer-wall.yaml"];

  ctx.__t.setState(JSON.parse(JSON.stringify(SOURCE)));
  ctx.__t.setOpenedFile("top-movies-trailer-wall.yaml");

  await ctx.startFromTemplate("top-movies-trailer-wall.yaml");

  const copy = ctx.__t.getState();
  check("clobber: the copy's name is cleared", copy.name === "", copy.name);
  check("clobber: the copy's output is cleared", copy.output === "", copy.output);
  check("clobber: openedFile no longer names the source — the ACTUAL clobber vector, since saveManifest() targets openedFile before it ever looks at state.name",
    ctx.__t.getOpenedFile() === "", ctx.__t.getOpenedFile());
  check("clobber: the design itself came across, not just cleared to nothing",
    copy.scenes.length === 1 && copy.data.top.provider === "plex.top", JSON.stringify(copy));

  // Mutation check: exercise the REAL saveManifest(), not just the two fields
  // above, and prove no PUT reaches the source's filename. This is exactly
  // what would fail if `openedFile = "";` were ever deleted from
  // startFromTemplate again: derived would still be "" (no name typed yet),
  // so the "give it a name" refusal would not fire either, and the save
  // would go straight through to /api/manifests/top-movies-trailer-wall.yaml.
  fetchLog.length = 0;
  flashes.length = 0;
  await ctx.saveManifest();
  const putToSource = fetchLog.some((c) => c.method === "PUT" && c.url === "/api/manifests/top-movies-trailer-wall.yaml");
  check("clobber: Save never PUTs to the source manifest", !putToSource, JSON.stringify(fetchLog));
  check("clobber: no PUT went out at all — the refusal short-circuits before the network",
    !fetchLog.some((c) => c.method === "PUT"), JSON.stringify(fetchLog));
  check("clobber: Save is refused for lacking a name, not silently applied",
    flashes.length === 1 && flashes[0].isError === true && /name/i.test(flashes[0].msg),
    JSON.stringify(flashes));
}

// ---- the two confirm()-gated save branches, and delete's ------------------
// saveManifest() is exercised by the clobber test above, but that path clears
// openedFile and hits neither confirm. Both are the last thing standing between
// Save and someone else's manifest, so both are checked here: what they ASK,
// and that declining leaves the network untouched.
{
  // Branch 1: the manifest's name no longer matches the file it was opened as.
  ctx.__t.setState({ ...ctx.emptyManifest(), name: "renamed" });
  ctx.__t.setOpenedFile("original.yaml");
  document.querySelector("#manifest-picker").options = [{ value: "original.yaml" }];

  const asked = [];
  const realConfirm = ctx.confirm;
  ctx.confirm = (msg) => { asked.push(msg); return confirmAnswer; };

  confirmAnswer = false;
  fetchLog.length = 0;
  await ctx.saveManifest();
  check("save (rename): asks before writing over the file it was opened as",
    asked.length === 1 && asked[0].includes("original.yaml") && asked[0].includes("renamed.yaml"),
    JSON.stringify(asked));
  check("save (rename): declining sends nothing at all",
    !fetchLog.some((c) => c.method === "PUT"), JSON.stringify(fetchLog));
  check("save (rename): declining leaves the open file alone",
    ctx.__t.getOpenedFile() === "original.yaml", ctx.__t.getOpenedFile());

  asked.length = 0;
  confirmAnswer = true;
  fetchLog.length = 0;
  await ctx.saveManifest();
  check("save (rename): accepting writes to the file it was OPENED as, not the derived name",
    fetchLog.some((c) => c.method === "PUT" && c.url === "/api/manifests/original.yaml"),
    JSON.stringify(fetchLog));

  // Branch 2: a never-opened manifest whose derived filename already exists.
  ctx.__t.setState({ ...ctx.emptyManifest(), name: "existing" });
  ctx.__t.setOpenedFile("");
  document.querySelector("#manifest-picker").options = [{ value: "existing.yaml" }];

  asked.length = 0;
  confirmAnswer = false;
  fetchLog.length = 0;
  await ctx.saveManifest();
  check("save (overwrite): asks before landing on an existing manifest",
    asked.length === 1 && asked[0].includes("existing.yaml") && /overwrite/i.test(asked[0]),
    JSON.stringify(asked));
  check("save (overwrite): declining sends nothing at all",
    !fetchLog.some((c) => c.method === "PUT"), JSON.stringify(fetchLog));
  check("save (overwrite): declining does not adopt the file either",
    ctx.__t.getOpenedFile() === "", ctx.__t.getOpenedFile());

  asked.length = 0;
  confirmAnswer = true;
  fetchLog.length = 0;
  await ctx.saveManifest();
  check("save (overwrite): accepting writes to the derived filename",
    fetchLog.some((c) => c.method === "PUT" && c.url === "/api/manifests/existing.yaml"),
    JSON.stringify(fetchLog));

  // A name that matches the open file asks nothing at all — the confirms are
  // for surprises, not for every save.
  ctx.__t.setState({ ...ctx.emptyManifest(), name: "same" });
  ctx.__t.setOpenedFile("same.yaml");
  asked.length = 0;
  fetchLog.length = 0;
  await ctx.saveManifest();
  check("save: the ordinary case asks nothing", asked.length === 0, JSON.stringify(asked));
  check("save: ...and still saves", fetchLog.some((c) => c.method === "PUT"), JSON.stringify(fetchLog));

  // Delete's confirm: it removes a file from the manifest directory, so the
  // same rule applies — declining must not reach the network.
  document.querySelector("#manifest-picker").value = "doomed.yaml";
  asked.length = 0;
  confirmAnswer = false;
  fetchLog.length = 0;
  await ctx.deleteManifest();
  check("delete: asks first, naming the file",
    asked.length === 1 && asked[0].includes("doomed.yaml"), JSON.stringify(asked));
  check("delete: declining sends no DELETE",
    !fetchLog.some((c) => c.method === "DELETE"), JSON.stringify(fetchLog));

  confirmAnswer = true;
  fetchLog.length = 0;
  await ctx.deleteManifest();
  check("delete: accepting sends the DELETE",
    fetchLog.some((c) => c.method === "DELETE" && c.url === "/api/manifests/doomed.yaml"),
    JSON.stringify(fetchLog));

  // Nothing open: refused before the confirm, never mind the network.
  document.querySelector("#manifest-picker").value = "";
  asked.length = 0;
  fetchLog.length = 0;
  flashes.length = 0;
  await ctx.deleteManifest();
  check("delete: with nothing open it refuses without asking",
    asked.length === 0 && !fetchLog.length && flashes.length === 1 && flashes[0].isError === true,
    JSON.stringify({ asked, fetchLog, flashes }));

  ctx.confirm = realConfirm;
  confirmAnswer = true;
  document.querySelector("#manifest-picker").options = [];
  document.querySelector("#manifest-picker").value = "";
}

// new-empty and new-from also reset openedFile — the same clobber vector as
// startFromTemplate above, checked directly through their action handlers
// (the click path a real dialog button drives) rather than the function.
{
  ctx.__t.setOpenedFile("some-open-file.yaml");
  ctx.__t.actions["new-empty"]();
  check("new-empty: clears openedFile too", ctx.__t.getOpenedFile() === "", ctx.__t.getOpenedFile());
  check("new-empty: state is a blank manifest", ctx.__t.getState().scenes.length === 0);

  manifestFixtures["c.yaml"] = { name: "c", scenes: [], data: {} };
  ctx.__t.setOpenedFile("some-open-file.yaml");
  await ctx.__t.actions["new-from"]({ name: "c.yaml" });
  check("new-from: clears openedFile too", ctx.__t.getOpenedFile() === "", ctx.__t.getOpenedFile());
  check("new-from: the copy's name is cleared even though the source had one",
    ctx.__t.getState().name === "", ctx.__t.getState().name);
  delete manifestFixtures["c.yaml"];
}

pending.length = 0; // drop every convert() this block fired off; see below

})().then(async () => {

// onEditorClick is pure dispatch: it used to renderStage() and
// scheduleConvert() after EVERY delegated action, so an action that had already
// repainted drew the canvas twice and a pure selection click posted a convert
// for a manifest that had not changed.
  {
    const drawn = [];
    const realRenderStage = ctx.renderStage;
    ctx.renderStage = () => drawn.push(1);
    ctx.__t.actions["__probe"] = () => {};
    const click = { target: { closest: () => ({ dataset: { action: "__probe" } }) } };

    // Let any debounce still armed from the blocks above fire first, or its
    // convert would be blamed on this click.
    await new Promise((r) => setTimeout(r, 400));
    fetchLog.length = 0;
    ctx.onEditorClick(click);
    check("click dispatch: an action that repaints nothing repaints nothing",
      drawn.length === 0, `${drawn.length} draw(s)`);

    // scheduleConvert is debounced (300ms), so the network check has to wait it
    // out rather than assert on the same tick.
    await new Promise((r) => setTimeout(r, 400));
    check("click dispatch: ...and posts no convert for a manifest that did not change",
      !fetchLog.some((c) => c.url === "/api/convert"), JSON.stringify(fetchLog));

    // An unknown action is still a no-op rather than a throw.
    ctx.onEditorClick({ target: { closest: () => ({ dataset: { action: "__nope" } }) } });
    ctx.onEditorClick({ target: { closest: () => null } });

    delete ctx.__t.actions["__probe"];
    ctx.renderStage = realRenderStage;
    pending.length = 0;
  }

// convert(): responses that land out of order must not overwrite newer state.
  const pane = document.querySelector("#yaml code");
  const first = ctx.convert();
  const second = ctx.convert();
  check("convert: two requests in flight", pending.length === 2, String(pending.length));
  pending[1](reply({ yaml: "NEW", errors: [] }));
  await second;
  pending[0](reply({ yaml: "OLD", errors: [] }));
  await first;
  check("convert: stale response ignored", pane.textContent === "NEW", pane.textContent);

  // Copy YAML on the documented LAN deployment: http://192.168.x.x:8382 is not
  // a secure context, so navigator.clipboard is undefined there and the old
  // handler threw a TypeError into nothing. It must fall back, and it must say
  // something when even the fallback is refused.
  {
    const clipboard = ctx.navigator.clipboard;
    pane.textContent = "name: copied-preroll";
    ctx.navigator = { clipboard: undefined };
    flashes.length = 0; copied.length = 0; execCommandOK = true;
    await document.querySelector("#copy-yaml").onclick();
    check("copy: without navigator.clipboard the text still reaches the clipboard",
      copied.length === 1 && copied[0] === "name: copied-preroll", JSON.stringify(copied));
    check("copy: and the user is told it worked",
      flashes.length === 1 && !flashes[0].isError, JSON.stringify(flashes));

    flashes.length = 0; execCommandOK = false;
    await document.querySelector("#copy-yaml").onclick();
    check("copy: a refused fallback reports instead of failing silently",
      flashes.length === 1 && flashes[0].isError === true, JSON.stringify(flashes));
    ctx.navigator = { clipboard };
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("app.js checks passed");
});
