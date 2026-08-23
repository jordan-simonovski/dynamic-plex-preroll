// Node check for inspector.js: the selection model, the dispatch, and the
// property audit that guards the retired Layouts card. Browser scripts with no
// module system, so they run inside a vm context — one shared lexical scope
// across runInContext calls, exactly like classic <script> tags — on a stub DOM.
//
//   node internal/webui/inspector_test.js
//
// The panels are pure string builders and inspectorTarget() is a pure decision
// over state, which is the whole reason this file can exist without a browser.
// What it CANNOT check: that the markup lays out, that a click on the real
// canvas lands where the stub says it does, or that focus behaves. Those are in
// the human-check list.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- stub DOM --------------------------------------------------------------
// Only enough to let stage.js draw into nothing and the inspector write its
// HTML somewhere readable. Text measures at 10px per character so the element
// boxes are predictable arithmetic.
const drawCtx = new Proxy({ font: "", fillStyle: "", strokeStyle: "", textAlign: "", textBaseline: "", lineWidth: 1 }, {
  get: (t, k) => (k in t ? t[k] : (k === "measureText"
    ? (s) => ({ width: String(s).length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })
    : () => {})),
  set: (t, k, v) => { t[k] = v; return true; },
});
// parent + contains()/focus() are Task 11's addition: renderInspector()'s
// real focus fix (see inspector.js) checks whether document.activeElement is
// a descendant of #inspector BEFORE wiping its innerHTML, and this stub does
// not build a real DOM tree from innerHTML strings — so a child obtained via
// panel.querySelector() is given a `parent` link back to the panel that asked
// for it, which is enough for a synthetic focus/contains check without
// parsing any markup.
function makeEl(sel, parent) {
  const el = {
    sel, parent,
    innerHTML: "", textContent: "", value: "", checked: false,
    clientWidth: 960, width: 0, height: 0, style: {},
    dataset: {}, options: [], attrs: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, closest() { return null; },
    querySelector: () => makeEl(undefined, el),
    getContext: () => drawCtx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {},
    hasAttribute(a) { return el.attrs[a] !== undefined; },
    setAttribute(a, v) { el.attrs[a] = v; },
    toggleAttribute(a, on) { if (on) el.attrs[a] = ""; else delete el.attrs[a]; },
    contains(x) { for (let n = x; n; n = n.parent) if (n === el) return true; return false; },
    focus() { document.activeElement = el; },
  };
  return el;
}
const els = new Map();
const document = {
  activeElement: null,
  querySelector(sel) {
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  },
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  fonts: { add() {} },
};

// A test arms `resolveResponse` before calling actions["test-data"], mirroring
// stage_test.js's own stageFetch — apiResolveData (api.js) is the only fetch
// call inspector.js's new "Test this source" action makes.
let resolveResponse = { configured: false, sources: {} };
// `parkedResolves`, when an array, holds each in-flight reply so a test can
// answer them OUT OF ORDER — the whole point of test-data's sequence guard.
// Same shape stage_test.js uses for refreshStageDataNow.
let parkedResolves = null;
function inspectorFetch() {
  if (parkedResolves) {
    return new Promise((resolve) => parkedResolves.push((body) => resolve({ ok: true, json: async () => body })));
  }
  return Promise.resolve({ ok: true, json: async () => resolveResponse });
}

const ctx = vm.createContext({
  document,
  window: { addEventListener() {}, devicePixelRatio: 1 },
  FontFace: class { load() { return Promise.reject(new Error("no font server in a test")); } },
  Image: class { set src(v) { this._src = v; } },
  fetch: inspectorFetch,
  setTimeout, clearTimeout,
  confirm: () => true,
  navigator: { clipboard: { writeText: async () => {} } },
  console,
  // app.js is not loaded here (see below), so the one thing interact.js calls
  // into it for is stubbed. Whether a gesture schedules exactly one convert is
  // interact_test.js's assertion, not this file's.
  scheduleConvert: () => {},
});

const staticDir = path.join(__dirname, "static");
// app.js is left out on purpose: it boots the toolbar and the network. The
// listeners it registers are thin — every decision they reach lives here.
for (const f of ["providers.js", "util.js", "geometry.js", "interact.js", "state.js", "api.js", "stage.js", "pickers.js", "inspector.js", "timeline.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}
vm.runInContext(`globalThis.__t = {
  setState: (s) => { state = normalize(s); },
  getState: () => state,
  select: (scene, element) => { selection.sceneIndex = scene; selection.element = element ?? null; },
  selected: () => selection.element,
  setDataSource: (n) => { selection.dataSource = n; },
  dataSource: () => selection.dataSource,
  // \`actions\`/\`rerenderHooks\`/\`testResults\`/\`PROVIDERS\` are top-level
  // consts, so they live in the shared script scope rather than on the
  // context's global object.
  actions, rerenderHooks, testResults, PROVIDERS,
};`, ctx);

const { __t, inspectorTarget, elementPath, renderInspector, selectElement,
  stagePointerDown, stagePointerUp,
  currentLayout, layoutSection, dataInspector, dataListPanel, dataSourcePanel,
  renderTestResult } = ctx;
const PROVIDERS = __t.PROVIDERS;
const { actions, rerenderHooks } = ctx.__t;
const panel = () => document.querySelector("#inspector").innerHTML;

// ---- assertions ------------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const has = (name, html, needle) => check(name, html.includes(needle), `missing ${needle}`);
const not = (name, html, needle) => check(name, !html.includes(needle), `should not contain ${needle}`);
const same = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const FIXTURE = () => ({
  resolution: "1920x1080",
  data: { top: { provider: "plex.top", params: {} } },
  layouts: {
    main: {
      font: "media/common/F.ttf",
      background: { color: "#101010", image: "bg.png" },
      elements: [
        { type: "text", x: 100, y: 200, size: 60, color: "white", align: "center", lineHeight: 0, text: "Hello" },
        { type: "list", source: "top", x: 100, startY: 400, stepY: 70, size: 40, color: "red", item: "{{ .Name }}" },
      ],
    },
    label: { font: "", background: { color: "none", image: "" }, elements: [{ type: "text", x: 10, y: 20, size: 30, text: "L" }] },
  },
  scenes: [
    { kind: "render", layout: "main", duration: 6, vars: {} },
    { kind: "clips", source: "top", perClip: 4, label: "label" },
    { kind: "image", file: "x.png", duration: 4 },
    { kind: "render", layout: "gone", duration: 6, vars: {} },
  ],
});

// ---- the dispatch ----------------------------------------------------------
// Three kinds, and a stale selection always degrades to a coarser one rather
// than throwing mid-render.
{
  __t.setState(FIXTURE());

  __t.select(0, null);
  eq("target: a scene with nothing selected is the scene", inspectorTarget().kind, "scene");
  eq("target: elementPath is null with nothing selected", elementPath(), null);

  __t.select(0, 1);
  eq("target: a selected element is the element", inspectorTarget().kind, "element");
  eq("target: elementPath addresses the layout's element",
    elementPath(), "layouts.main.elements.1");
  eq("target: the element carried is the selected one", inspectorTarget().el.type, "list");

  __t.select(0, 9);
  eq("target: an out-of-range element falls back to the scene", inspectorTarget().kind, "scene");
  eq("target: elementPath is null when the index is gone", elementPath(), null);

  __t.select(1, 0);
  eq("target: a clips scene selects into its LABEL layout",
    elementPath(), "layouts.label.elements.0");

  __t.select(2, 0);
  eq("target: an image scene has no layout to select into", elementPath(), null);
  eq("target: an image scene is still a scene", inspectorTarget().kind, "scene");

  __t.select(3, 0);
  eq("target: a scene naming a missing layout selects nothing", elementPath(), null);

  __t.select(99, null);
  eq("target: no scene at all is the pre-roll", inspectorTarget().kind, "preroll");

  __t.setState({ scenes: [] });
  eq("target: an empty manifest is the pre-roll", inspectorTarget().kind, "preroll");
  renderInspector();
  has("panel: the pre-roll panel is the manifest's own fields", panel(), `data-path="name"`);
  has("panel: the pre-roll panel says why it is empty", panel(), "No scenes yet");
}

// ---- the Layouts-card property audit ---------------------------------------
// Every control the retired Layouts card exposed, asserted present in the
// inspector. A property lost in the deletion is exactly what this file is for.
{
  __t.setState(FIXTURE());

  // Layout-level: name (rename), font, background colour/image, remove, add
  // element, add layout.
  __t.select(0, null);
  renderInspector();
  const scene = panel();
  has("audit: layout name is renameable", scene, `data-rename="layouts" data-old="main"`);
  has("audit: layout remove", scene, `data-action="remove-layout" data-name="main"`);
  has("audit: layout font", scene, `data-path="layouts.main.font"`);
  has("audit: layout background colour", scene, `data-path="layouts.main.background.color"`);
  has("audit: layout background image", scene, `data-path="layouts.main.background.image"`);
  has("audit: add a text element", scene, `data-action="add-element-here" data-kind="text"`);
  has("audit: add a list element", scene, `data-action="add-element-here" data-kind="list"`);
  has("audit: every element is listed", scene, `data-action="select-element" data-index="1"`);
  check("audit: the element list is a keyboard path to the selection",
    scene.includes(`<button type="button" class="element-row`), scene);

  // Text element: text, x, y, size, colour, align, line height, remove, the
  // template picker's Insert button (Task 14 — replaces the retired chips).
  __t.select(0, 0);
  renderInspector();
  const text = panel();
  for (const [name, p] of [["text", "text"], ["x", "x"], ["y", "y"], ["size", "size"],
                           ["colour", "color"], ["align", "align"], ["line height", "lineHeight"]]) {
    has(`audit: text element ${name}`, text, `data-path="layouts.main.elements.0.${p}"`);
  }
  has("audit: text element remove", text, `data-action="remove-selected-element"`);
  has("audit: text element has the template picker's Insert button", text, `data-action="insert-template"`);
  has("audit: the Insert button targets the text field", text, `data-target="layouts.main.elements.0.text"`);
  has("audit: the Insert button is scoped to text (globals, no item fields)", text, `data-scope="text"`);
  has("audit: back to the scene", text, `data-action="select-scene"`);

  // List element: source, item, x, startY, stepY, size, colour, align, remove.
  __t.select(0, 1);
  renderInspector();
  const list = panel();
  for (const [name, p] of [["source", "source"], ["row template", "item"], ["x", "x"],
                           ["first row Y", "startY"], ["row spacing", "stepY"], ["size", "size"],
                           ["colour", "color"], ["align", "align"]]) {
    has(`audit: list element ${name}`, list, `data-path="layouts.main.elements.1.${p}"`);
  }
  has("audit: list element remove", list, `data-action="remove-selected-element"`);
  has("audit: list element has the template picker's Insert button", list, `data-action="insert-template"`);
  has("audit: the Insert button targets the row template field", list, `data-target="layouts.main.elements.1.item"`);
  has("audit: the Insert button is scoped to item fields (no globals)", list, `data-scope="item"`);
  check("audit: a list element has no y (its anchor is startY)",
    !list.includes(`data-path="layouts.main.elements.1.y"`), list);
}

// The layout section follows the scene: a clips scene edits its label layout,
// an image scene has none, and a scene with no layout can make one.
{
  __t.setState(FIXTURE());
  __t.select(1, null);
  renderInspector();
  has("layout section: a clips scene edits its label layout", panel(), `data-path="layouts.label.font"`);

  __t.select(2, null);
  renderInspector();
  check("layout section: an image scene has no layout section",
    !panel().includes("data-action=\"add-element-here\"") && !panel().includes("+ New layout"), panel());
  has("layout section: an image scene still edits its file", panel(), `data-path="scenes.2.file"`);

  __t.select(3, null);
  renderInspector();
  has("layout section: a missing layout offers a new one", panel(), `data-action="add-layout"`);
  has("layout section: a missing layout says so", panel(), "does not exist");
}

// The scene panel keeps every scene control the Scenes card had, including the
// dynamic background — and data-prev, without which switching kind throws away
// the wrong defaults.
{
  __t.setState(FIXTURE());
  __t.select(0, null);
  renderInspector();
  has("scene: kind", panel(), `data-path="scenes.0.kind"`);
  has("scene: kind carries data-prev for the rerender hook", panel(), `data-prev="render"`);
  has("scene: layout", panel(), `data-path="scenes.0.layout"`);
  has("scene: duration", panel(), `data-path="scenes.0.duration"`);
  has("scene: template variables", panel(), `data-action="add-var"`);
  // The var rows are the Scenes card's, rendered here: its actions must repaint
  // the inspector too, or a variable added from this panel never shows up in it.
  actions["add-var"]({ index: "0" });
  has("scene: a variable added from the panel appears in it", panel(), `data-path="scenes.0.vars.Var"`);
  actions["remove-var"]({ index: "0", key: "Var" });
  check("scene: and removing it takes the row away",
    !panel().includes(`data-path="scenes.0.vars.Var"`), panel());
  has("scene: dynamic background toggle", panel(), `data-action-toggle="scene-bg"`);

  const st = __t.getState();
  st.scenes[0].background = { source: "top", mode: "art", tile: "", dim: 0.35, limit: 0 };
  renderInspector();
  for (const p of ["source", "mode", "tile", "dim", "limit"]) {
    has(`scene: background ${p}`, panel(), `data-path="scenes.0.background.${p}"`);
  }
  // engine.go's backgroundTile() defaults an unset tile to GRID, not cover.
  has("scene: the tile default is named correctly", panel(), "grid (default)");
}

// ---- selection transitions -------------------------------------------------
{
  __t.setState(FIXTURE());
  __t.select(0, null);

  selectElement(1);
  eq("select: selectElement sets the selection", __t.selected(), 1);
  eq("select: and the panel follows it", inspectorTarget().kind, "element");

  actions["select-scene"]();
  eq("select: back to the scene clears the element", __t.selected(), null);

  actions["select-element"]({ index: "0" });
  eq("select: a row selects by index", __t.selected(), 0);

  // Adding selects what was added, so it can be dragged straight away.
  actions["add-element-here"]({ kind: "text" });
  eq("add: a new element is appended", currentLayout().elements.length, 3);
  eq("add: and selected", __t.selected(), 2);
  eq("add: a new text element lands in the middle of the frame",
    JSON.stringify([currentLayout().elements[2].x, currentLayout().elements[2].y]), "[960,540]");
  actions["add-element-here"]({ kind: "list" });
  eq("add: a new list element takes the first data source", currentLayout().elements[3].source, "top");

  // Removing clears the selection: the index would otherwise point at whatever
  // shuffled into its place.
  actions["remove-selected-element"]();
  eq("remove: the element is gone", currentLayout().elements.length, 3);
  eq("remove: the selection is cleared", __t.selected(), null);
  actions["remove-selected-element"]();
  eq("remove: removing with nothing selected is a no-op", currentLayout().elements.length, 3);

  // Changing the layout a scene draws invalidates an index into the old one.
  selectElement(1);
  rerenderHooks["scene-layout"]();
  eq("hook: switching layout clears the element selection", __t.selected(), null);
}

// A new layout is claimed by the scene that asked for it, per kind — a layout
// nothing references is unreachable now that the Layouts card is gone.
{
  __t.setState(FIXTURE());
  __t.select(3, null); // render scene naming a layout that does not exist
  actions["add-layout"]();
  eq("add-layout: a render scene points at it", __t.getState().scenes[3].layout, "layout");
  eq("add-layout: it starts with one text element", currentLayout().elements.length, 1);
  eq("add-layout: that element is selected", __t.selected(), 0);

  __t.setState({ ...FIXTURE(), layouts: {} });
  __t.select(1, null); // clips scene with a label naming a missing layout
  actions["add-layout"]();
  eq("add-layout: a clips scene points its LABEL at it", __t.getState().scenes[1].label, "layout");

  __t.setState(FIXTURE());
  __t.select(0, 1);
  actions["remove-layout"]({ name: "main" });
  eq("remove-layout: the layout is gone", __t.getState().layouts.main, undefined);
  eq("remove-layout: the element selection is cleared", __t.selected(), null);
  eq("remove-layout: the scene's dangling reference is left visible",
    __t.getState().scenes[0].layout, "main");
}

// ---- press to select -------------------------------------------------------
// Selection is committed by interact.js's pointerdown, which maps a client
// point through geometry.js onto the boxes the draw left behind. The stub
// frame is 960 CSS px wide against a 1920px manifest, so client coordinates
// are half of manifest ones. What is checked HERE is only that the panel
// follows; the gesture itself is interact_test.js's job.
const clickAt = (cx, cy) => {
  const e = { clientX: cx, clientY: cy, pointerId: 1, preventDefault() {} };
  stagePointerDown(e);
  stagePointerUp(e);
};
{
  __t.setState({
    resolution: "1920x1080",
    layouts: { main: { font: "", background: { color: "black" }, elements: [
      { type: "text", x: 100, y: 200, size: 60, color: "white", text: "Hello" }, // 5 chars -> 50 wide
      { type: "text", x: 100, y: 800, size: 60, color: "white", text: "Bye" },
    ] } },
    scenes: [{ kind: "render", layout: "main", duration: 6 }],
  });
  __t.select(0, null);
  ctx.renderStage(); // fills the box cache the hit test reads

  clickAt(60, 98); // manifest (120, 196): inside "Hello" (y 192..202)
  eq("click: a hit selects that element", __t.selected(), 0);

  clickAt(60, 398); // manifest (120, 796): inside "Bye"
  eq("click: a second hit selects the other element", __t.selected(), 1);

  clickAt(5, 5); // manifest (10, 10): empty canvas
  eq("click: empty canvas selects the scene", __t.selected(), null);
  eq("click: and the panel goes back to the scene", inspectorTarget().kind, "scene");
}

// ---- Task 11: renderInspector()'s real focus model -------------------------
// Replacing #inspector's innerHTML destroys whatever was focused inside it —
// a real loss ONLY when that is where focus actually was. Task 8's stopgap
// refocused into the panel on every call, which would have stolen focus off
// the STAGE the instant a keyboard-driven stage selection (Tab/arrows,
// Task 11) repainted the inspector, breaking the very nudge keys that
// selection was for. The fix: only steal focus back in when it was already
// somewhere inside #inspector.
{
  __t.setState(FIXTURE());
  __t.select(0, null);
  const panel1 = document.querySelector("#inspector");

  // Focus was elsewhere (simulating the stage's own Tab/arrow handling) —
  // renderInspector() must leave it alone.
  const stageStub = document.querySelector("#stage");
  document.activeElement = stageStub;
  renderInspector();
  eq("focus: a re-render triggered from OUTSIDE #inspector does not steal focus",
    document.activeElement, stageStub);

  // Focus was inside #inspector (e.g. the element row that was just
  // clicked) — renderInspector() must land it on the freshly-rendered panel
  // rather than dropping it to <body>.
  const wasFocused = panel1.querySelector("button");
  document.activeElement = wasFocused;
  eq("focus: the simulated prior focus really is inside #inspector",
    panel1.contains(document.activeElement), true);
  renderInspector();
  const panel2 = document.querySelector("#inspector");
  eq("focus: a re-render triggered from INSIDE #inspector refocuses within it",
    panel2.contains(document.activeElement), true);
  check("focus: it does not just leave the destroyed element focused",
    document.activeElement !== wasFocused, "focus should move to the NEW panel's control");

  // Nothing focused at all (document.activeElement null, e.g. <body>) is the
  // same as "not inside #inspector" — no theft, no throw.
  document.activeElement = null;
  check("focus: no active element at all does not throw",
    (() => { try { renderInspector(); return true; } catch (e) { console.error(e); return false; } })());
}

// ---- Task 11 review fixes: element rows are real buttons with the right ---
// ARIA for a single-selection list, not a toggle-button's aria-pressed.
//
// layoutSection() is called directly rather than through renderInspector():
// inspectorTarget() only ever renders the SCENE panel (where these rows
// live) when selection.element is null or stale — the moment it names a real
// element, the dispatch switches to the ELEMENT panel instead, so "the
// selected row" can never actually appear in front of a user viewing the
// row list at the same time. That is a pre-existing property of the
// dispatch, not something Task 11 changed, so this checks the row markup
// itself in isolation rather than asserting a panel state the app can't reach.
{
  __t.setState(FIXTURE());
  __t.select(0, 1); // selection.element = 1: the SECOND row, for layoutSection to mark
  const html = layoutSection({ kind: "render", layout: "main" });
  has("rows: every row is a real <button type=\"button\">", html, `<button type="button" class="element-row`);
  has("rows: the selected row is marked aria-current", html, `aria-current="true"`);
  check("rows: aria-pressed is gone (this is a selection list, not a toggle)",
    !html.includes("aria-pressed"), html);
  eq("rows: exactly one row is marked current, not both",
    (html.match(/aria-current="true"/g) || []).length, 1);
}

// ---- Task 15: the retired Data card's property audit -----------------------
// Every property the old dataCard() exposed (sections.js), checked reachable
// through the new data-source inspector mode — for EVERY source, not just the
// first, since the panel shows one source at a time via selection.dataSource.
const DATA_FIXTURE = () => ({
  data: {
    topMovies: { provider: "plex.top", params: { section: "1", limit: "5" } },
    decade: { provider: "plex.section", params: { section: "1", decade: "1990" } },
  },
  layouts: {}, scenes: [],
});

{
  __t.setState(DATA_FIXTURE());

  // The list panel: every source shown, labelled by its provider's title.
  __t.setDataSource("");
  const list = dataInspector();
  has("data-list: topMovies is listed", list, `data-action="select-data" data-name="topMovies"`);
  has("data-list: decade is listed", list, `data-action="select-data" data-name="decade"`);
  has("data-list: labelled by the provider's plain-English title", list, "Most watched");
  has("data-list: add a source", list, `data-action="add-data"`);

  // An empty or dangling dataSource name falls back to the list, never throws.
  __t.setDataSource("");
  has("data-list: empty name is the list", dataInspector(), `data-action="add-data"`);
  __t.setDataSource("gone");
  has("data-list: a name naming nothing falls back to the list", dataInspector(), `data-action="add-data"`);

  // plex.top's source panel: every declared param reachable, each with a
  // FULL-SENTENCE hint (not the old one-line "Library section ID"), plus the
  // provider's own description/when, rename, provider select, test button,
  // remove button.
  __t.setDataSource("topMovies");
  const top = dataSourcePanel("topMovies", __t.getState().data.topMovies);
  for (const key of Object.keys(PROVIDERS["plex.top"].params)) {
    has(`audit: plex.top param ${key}`, top, `data-path="data.topMovies.params.${key}"`);
  }
  has("audit: rename the source", top, `data-rename="data" data-old="topMovies"`);
  has("audit: switch provider", top, `data-path="data.topMovies.provider"`);
  has("audit: the provider's title", top, "Most watched");
  has("audit: the provider's plain-English description", top,
    "The most-viewed items in one library section over a recent window");
  has("audit: the provider's 'when to use' guidance", top, "Use for a countdown");
  check("audit: every plex.top hint is a full sentence (ends in a period)",
    Object.values(PROVIDERS["plex.top"].params).every((p) => /\.$/.test(p.hint)),
    JSON.stringify(PROVIDERS["plex.top"].params));
  has("audit: a test button", top, `data-action="test-data" data-name="topMovies"`);
  has("audit: a remove button", top, `data-action="remove-data" data-name="topMovies"`);
  has("audit: back to the list", top, `data-action="select-data-list"`);
  check("audit: plex.top has no extra-filter passthrough section (not `extra`)",
    !top.includes("Extra Plex filters"), top);

  // A SECOND source, a different provider — the whole point of "for every
  // instance, not just the first": switching selection.dataSource actually
  // shows THAT source's own params, and plex.section's passthrough extras.
  __t.setDataSource("decade");
  const dec = dataSourcePanel("decade", __t.getState().data.decade);
  for (const key of Object.keys(PROVIDERS["plex.section"].params)) {
    has(`audit: plex.section param ${key}`, dec, `data-path="data.decade.params.${key}"`);
  }
  has("audit: plex.section's escape-hatch description", dec, "escape hatch");
  has("audit: the extra filter (decade) not covered by the provider's own params",
    dec, `data-path="data.decade.params.decade"`);
  has("audit: an extra filter is renameable", dec, `data-rename="data.decade.params" data-old="decade"`);
  has("audit: add another extra filter", dec, `data-action="add-param" data-ds="decade"`);
  not("audit: topMovies' fields are not bleeding into decade's panel", dec, `data.topMovies`);
  __t.setDataSource(null);
}

// ---- data source actions ----------------------------------------------------
{
  __t.setState(DATA_FIXTURE());

  actions["select-data"]({ name: "decade" });
  eq("actions: select-data sets the selection", __t.dataSource(), "decade");

  actions["select-data-list"]();
  eq("actions: select-data-list returns to the list (empty string, not null)", __t.dataSource(), "");

  actions["add-data"]();
  const st = __t.getState();
  const added = Object.keys(st.data).find((k) => !["topMovies", "decade"].includes(k));
  check("actions: add-data creates a new source", added !== undefined, Object.keys(st.data));
  eq("actions: add-data selects the new source", __t.dataSource(), added);
  eq("actions: it defaults to plex.top", st.data[added].provider, "plex.top");

  actions["remove-data"]({ name: "decade" });
  eq("actions: remove-data deletes the source", __t.getState().data.decade, undefined);
  eq("actions: remove-data returns to the list", __t.dataSource(), "");

  actions["add-param"]({ ds: "topMovies" });
  const keys1 = Object.keys(__t.getState().data.topMovies.params);
  check("actions: add-param adds an extra filter key", keys1.includes("filter"), keys1);
  actions["remove-param"]({ ds: "topMovies", key: "filter" });
  check("actions: remove-param takes it away",
    !Object.keys(__t.getState().data.topMovies.params).includes("filter"),
    Object.keys(__t.getState().data.topMovies.params));

  // Switching provider resets params to the new provider's defaults — a
  // section id left over from plex.top would otherwise leak into a provider
  // that names its params differently.
  const ds = __t.getState().data.topMovies;
  ds.provider = "plex.collections";
  rerenderHooks["provider"]({ ds: "topMovies" });
  same("actions: switching provider resets params to its defaults",
    __t.getState().data.topMovies.params, { section: "{{ .MovieSectionId }}" });
  __t.setDataSource(null);
}

// ---- "Test this source" results table --------------------------------------
// renderTestResult is pure over the testResults[name] cache, so every one of
// its states is checked directly rather than through a live fetch (the async
// end-to-end path, including the Plex-absent and per-source-error cases, is
// exercised below).
{
  for (const k of Object.keys(__t.testResults)) delete __t.testResults[k];
  eq("test-result: nothing tested yet renders nothing", renderTestResult("x"), "");

  __t.testResults.x = { pending: true };
  has("test-result: pending shows a running state", renderTestResult("x"), "Running");

  __t.testResults.x = { error: "plex.top: section is required" };
  has("test-result: an error is shown, not a table", renderTestResult("x"), "plex.top: section is required");
  not("test-result: an error state has no table", renderTestResult("x"), "<table");

  __t.testResults.x = { items: [] };
  has("test-result: a real empty result says so, distinct from 'not tested yet'",
    renderTestResult("x"), "returned no items");

  __t.testResults.x = { items: [
    { rank: 1, name: "The Grand Budapest Hotel", views: 42, hasMedia: true },
    { rank: 2, name: "Arrival", views: 31, hasMedia: false },
  ] };
  const table = renderTestResult("x");
  has("test-result: item names shown", table, "The Grand Budapest Hotel");
  has("test-result: view counts shown", table, "42");
  has("test-result: a resolved trailer is marked", table, "yes");
  has("test-result: a missing trailer is marked distinctly", table, "—");
  has("test-result: the count is summarised", table, "2 items returned");
  for (const k of Object.keys(__t.testResults)) delete __t.testResults[k];
}

// ---- Task 15: audio settings and "Edit data sources" survive the Audio/Data
// cards' retirement, reachable with EITHER zero scenes (the preroll panel)
// or a scene selected (its "Pre-roll settings" details) — the same
// reachability failure mode the Layouts-card audit above already guards
// against (a control that exists for scene 0 but nowhere else).
{
  __t.setState({ ...FIXTURE(), audio: { file: "", mode: "soundtrack", start: 0, fadeOut: null } });
  __t.setDataSource(null);

  __t.setState({ scenes: [], layouts: {}, data: {}, audio: { file: "a.mp3", mode: "soundtrack", start: 0, fadeOut: null } });
  __t.select(99, null); // no scene at all -> the preroll panel
  renderInspector();
  const empty = panel();
  has("audio: reachable with zero scenes (preroll panel)", empty, `data-path="audio.file"`);
  has("audio: the fade toggle is reachable with zero scenes", empty, `data-action-toggle="audio-fade"`);
  has("data: 'Edit data sources' is reachable with zero scenes", empty, `data-action="select-data-list"`);

  __t.setState(FIXTURE());
  __t.select(0, null); // a normal scene -> the scene panel
  renderInspector();
  const withScene = panel();
  has("audio: also reachable from a scene's Pre-roll settings", withScene, `data-path="audio.file"`);
  has("data: also reachable from a scene's Pre-roll settings", withScene, `data-action="select-data-list"`);

  // The fade sub-fields only appear once fadeOut is set — audited here since
  // audioFields() moved from a directly-wired #fade-toggle listener
  // (sections.js) to the same data-action-toggle delegation scene-bg uses.
  const st = __t.getState();
  st.audio.fadeOut = { start: 1, duration: 2 };
  renderInspector();
  has("audio: fade sub-fields appear once fadeOut is set", panel(), `data-path="audio.fadeOut.start"`);
}

// ---- Task 15: clicking a data-source row leaves the LIST panel showing that
// source, and the panel dispatch correctly prefers data mode over the
// scene/element dispatch whenever dataSource is non-null.
{
  __t.setState(DATA_FIXTURE());
  __t.select(0, null);
  __t.setDataSource("topMovies");
  renderInspector();
  has("dispatch: data mode wins over the scene panel", panel(), `data-action="test-data"`);
  not("dispatch: the scene panel is not shown while in data mode", panel(), `data-path="scenes.0.kind"`);
  __t.setDataSource(null);
}

(async () => {
  // ---- "Test this source" end to end ---------------------------------------
  // The async action itself: apiResolveData's reply flows into testResults
  // through the same {configured, sources} shape data.go actually answers
  // with (data_test.go), across the three states the brief calls out.
  __t.setState(DATA_FIXTURE());

  // Plex absent: data.go answers 200 with configured:false and a reason —
  // never a hang, never a silent failure.
  resolveResponse = { configured: false, reason: "Plex is not configured (set PLEX_URL and PLEX_TOKEN); showing placeholder data" };
  await actions["test-data"]({ name: "topMovies" });
  eq("test-data: Plex absent surfaces the reason as the error", __t.testResults.topMovies.error,
    "Plex is not configured (set PLEX_URL and PLEX_TOKEN); showing placeholder data");
  eq("test-data: Plex absent has no items", __t.testResults.topMovies.items.length, 0);

  // Plex present, this one source erroring (a bad param): configured:true but
  // this source's own .error is set, per-source, exactly like data.go's
  // resolveOne on a provider error.
  resolveResponse = { configured: true, sources: { topMovies: { items: [], error: "plex.top: section is required" } } };
  await actions["test-data"]({ name: "topMovies" });
  eq("test-data: a per-source error surfaces", __t.testResults.topMovies.error, "plex.top: section is required");

  // Plex present and healthy: real items flow straight into the table.
  resolveResponse = { configured: true, sources: { topMovies: { items: [
    { rank: 1, name: "Heat", views: 12, hasMedia: true },
  ] } } };
  await actions["test-data"]({ name: "topMovies" });
  eq("test-data: a healthy reply has no error", __t.testResults.topMovies.error, "");
  eq("test-data: a healthy reply's items are kept", __t.testResults.topMovies.items[0].name, "Heat");
  has("test-data: renders into the panel's own table", renderTestResult("topMovies"), "Heat");

  // A source the resolve reply says nothing about (the request failed to
  // resolve for that name at all) must not throw — falls back to no items.
  resolveResponse = { configured: true, sources: {} };
  await actions["test-data"]({ name: "topMovies" });
  eq("test-data: a missing source in the reply degrades to empty, not a throw",
    __t.testResults.topMovies.items.length, 0);

  // Two tests of the SAME source in flight at once: edit a param, retest, and
  // the first (slow) reply must not overwrite the second with results for
  // parameters no longer configured. The replies land keyed by source name, so
  // nothing in them distinguishes the two.
  {
    parkedResolves = [];
    const stale = actions["test-data"]({ name: "topMovies" });
    const fresh = actions["test-data"]({ name: "topMovies" });
    eq("test-data: both resolves really are in flight", parkedResolves.length, 2);

    parkedResolves[1]({ configured: true, sources: { topMovies: { items: [{ rank: 1, name: "NEW" }] } } });
    await fresh;
    parkedResolves[0]({ configured: true, sources: { topMovies: { items: [{ rank: 1, name: "OLD" }] } } });
    await stale;
    eq("test-data: a stale reply never overwrites the newest",
      __t.testResults.topMovies.items[0].name, "NEW");

    // A different source tested meanwhile is legitimate and must still land —
    // the guard is per name, not one global counter.
    parkedResolves = [];
    const other = actions["test-data"]({ name: "second" });
    parkedResolves[0]({ configured: true, sources: { second: { items: [{ rank: 1, name: "OTHER" }] } } });
    await other;
    eq("test-data: a concurrent test of another source still lands",
      __t.testResults.second.items[0].name, "OTHER");
    eq("test-data: ...and does not disturb the first source's result",
      __t.testResults.topMovies.items[0].name, "NEW");
    parkedResolves = null;
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("inspector.js checks passed");
})();
