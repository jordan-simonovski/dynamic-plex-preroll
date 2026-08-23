// Node check for stage.js and the state.js accessors it draws from. The stage
// is a browser file, so it runs inside a vm context — one shared lexical scope
// across runInContext calls, exactly like classic <script> tags — on top of a
// stub DOM whose 2d context RECORDS every draw call. That is what makes the
// interesting half testable without a browser: draw order, the numbers each
// call receives, the scaling model, and the note under the canvas.
//
//   node internal/webui/stage_test.js
//
// ponytail: a recording stub, not a headless browser. It cannot prove pixels
// look right — only that the right calls go out with the right numbers, which
// is the part that regresses.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- stub DOM --------------------------------------------------------------
// A 2d context that remembers what it was told to draw, tagging each call with
// the state (fillStyle/font/align) in force at the time.
function recordingCtx() {
  const calls = [];
  const ctx = {
    calls,
    font: "", fillStyle: "", strokeStyle: "", textAlign: "", textBaseline: "", lineWidth: 1,
    setTransform: (...a) => calls.push({ op: "setTransform", args: a }),
    clearRect: (...a) => calls.push({ op: "clearRect", args: a }),
    fillRect: (x, y, w, h) => calls.push({ op: "fillRect", args: [x, y, w, h], fill: ctx.fillStyle }),
    strokeRect: (x, y, w, h) => calls.push({ op: "strokeRect", args: [x, y, w, h], stroke: ctx.strokeStyle }),
    fillText: (t, x, y) => calls.push({ op: "fillText", text: t, x, y, font: ctx.font, fill: ctx.fillStyle, align: ctx.textAlign }),
    drawImage: (...a) => calls.push({ op: "drawImage", args: a }),
    measureText: (t) => ({ width: t.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    setLineDash: () => {}, save: () => {}, restore: () => {},
  };
  return ctx;
}

// The colour probe mimics canvas's real behaviour: assigning an invalid colour
// is IGNORED, leaving the previous value in place. safeColor's whole trick
// depends on that, so the stub has to reproduce it rather than accept anything.
const NAMED = ["white", "black", "red", "gold", "transparent", "none"];
function probeCtx() {
  let value = "#000000";
  return {
    get fillStyle() { return value; },
    set fillStyle(v) {
      const s = String(v).trim().toLowerCase();
      if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/.test(s) || NAMED.includes(s)) value = s;
    },
  };
}

const stageCtx = recordingCtx();
function makeEl(sel) {
  return {
    sel,
    innerHTML: "", textContent: "", value: "", checked: false,
    clientWidth: 960, width: 0, height: 0, style: {},
    dataset: {}, options: [], attrs: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, closest() { return null; },
    querySelector: () => makeEl(),
    getContext: () => stageCtx,
    hasAttribute(a) { return this.attrs[a] !== undefined; },
    setAttribute(a, v) { this.attrs[a] = v; },
    toggleAttribute(a, on) { if (on) this.attrs[a] = ""; else delete this.attrs[a]; },
  };
}
const els = new Map();
const document = {
  querySelector(sel) {
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  },
  createElement: () => ({ getContext: () => probeCtx() }),
  fonts: { add() {} },
};

let fontLoads = 0;
class FontFace {
  constructor(family, src) { this.family = family; this.src = src; }
  load() { fontLoads++; return Promise.reject(new Error("no font server in a test")); }
}

// I1: naturalWidth/naturalHeight are set synchronously (real Image loading is
// async, but nothing here needs to test the async edge — only what happens
// once dimensions are known) whenever a test has armed `imagePreset`, so
// drawImagePath's size-mismatch check has something to compare against.
let imagePreset = null;
class Image {
  constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
  set src(v) {
    this._src = v;
    if (imagePreset) { this.complete = true; this.naturalWidth = imagePreset.w; this.naturalHeight = imagePreset.h; }
  }
}

// apiResolveData's fetch: a test arms `fetchResponse` and reads `fetchCalls`
// to check whether the network was hit at all (refreshStageDataNow must not
// call it when there are no data sources).
let fetchCalls = 0;
let fetchResponse = { configured: false, sources: {} };
function stageFetch() {
  fetchCalls++;
  return Promise.resolve({ ok: true, json: async () => fetchResponse });
}

const ctx = vm.createContext({
  document,
  window: { addEventListener() {}, devicePixelRatio: 2 },
  FontFace,
  Image,
  fetch: stageFetch,
  setTimeout, clearTimeout,
  confirm: () => true,
  navigator: { clipboard: { writeText: async () => {} } },
  console,
});

const staticDir = path.join(__dirname, "static");
for (const f of ["providers.js", "util.js", "geometry.js", "state.js", "api.js", "stage.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}
// `state` and `selection` are top-level `let`s, so they live in the context's
// shared script scope rather than on the global object; this bridge reaches them.
// Geometry is a top-level `const`, so it lives in that same script scope and
// is not reachable as a property of the context either.
vm.runInContext(`globalThis.__t = {
  setState: (s) => { state = normalize(s); },
  select: (i) => { selection.sceneIndex = i; },
  Geometry,
  stageDataReason: () => stageDataReason,
};`, ctx);

// ---- assertions ------------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const { __t, stageTemplate, stageLines, stageVars, stageCanvasSize, stageFontSpec,
  safeColor, stageNotes, stageLabelText, setStageData, renderStage, stageMeasure,
  manifestDimensions, currentScene, currentLayout, currentLayoutName,
  refreshStageDataNow, stageItems } = ctx;
const Geometry = ctx.__t.Geometry;

// manifestDimensions: a half-typed resolution must not collapse the stage.
{
  const dims = (r) => { __t.setState({ resolution: r }); return manifestDimensions(); };
  eq("dims: default", JSON.stringify(dims("1920x1080")), '{"width":1920,"height":1080}');
  eq("dims: other", JSON.stringify(dims("1280x720")), '{"width":1280,"height":720}');
  eq("dims: spaces", JSON.stringify(dims(" 3840 x 2160 ")), '{"width":3840,"height":2160}');
  eq("dims: half-typed falls back", JSON.stringify(dims("1920x")), '{"width":1920,"height":1080}');
  eq("dims: empty falls back", JSON.stringify(dims("")), '{"width":1920,"height":1080}');
}

// The selection accessors must tolerate a stale selection rather than throw.
{
  __t.setState({
    layouts: { title: { font: "", elements: [] }, label: { font: "", elements: [] } },
    scenes: [
      { kind: "render", layout: "title" },
      { kind: "clips", source: "top", label: "label" },
      { kind: "render", layout: "gone" },
      { kind: "image", file: "x.png" },
    ],
  });
  __t.select(0);
  eq("currentLayoutName: render scene", currentLayoutName(), "title");
  check("currentLayout: render scene", currentLayout() !== null);
  __t.select(1);
  eq("currentLayoutName: clips scene previews its label layout", currentLayoutName(), "label");
  __t.select(2);
  eq("currentLayout: missing layout is null", currentLayout(), null);
  eq("currentLayoutName: missing layout still named", currentLayoutName(), "gone");
  __t.select(3);
  eq("currentLayoutName: image scene has none", currentLayoutName(), "");
  __t.select(99);
  eq("currentScene: stale index is null", currentScene(), null);
  eq("currentLayout: stale index is null", currentLayout(), null);
  __t.select(0);
}

// The scaling model: draw calls are issued in manifest pixels, the backing
// store is at device resolution, and the two agree exactly.
{
  const a = stageCanvasSize(960, { width: 1920, height: 1080 }, 2);
  eq("size: css width", a.cssWidth, 960);
  eq("size: backing store width", a.pixelWidth, 1920);
  eq("size: scale", a.scale, 1);
  eq("size: backing store height", a.pixelHeight, 1080);
  eq("size: css height", a.cssHeight, 540);

  const b = stageCanvasSize(640, { width: 1920, height: 1080 }, 1);
  eq("size: dpr 1 scale", b.scale, 1 / 3);
  eq("size: drawn height fills the store", b.pixelHeight, Math.round(1080 * b.scale));
  check("size: aspect preserved", Math.abs(b.cssHeight / b.cssWidth - 1080 / 1920) < 0.002, b.cssHeight);

  const c = stageCanvasSize(600, { width: 1080, height: 1920 }, 1);
  eq("size: portrait is taller than wide", c.pixelHeight > c.pixelWidth, true);

  const z = stageCanvasSize(0, { width: 0, height: 0 }, 0);
  check("size: a hidden frame still produces a usable canvas",
    z.pixelWidth >= 1 && z.pixelHeight >= 1 && z.scale > 0, JSON.stringify(z));
}

// Template substitution: what the stage can resolve it resolves; what it
// cannot stays visible as its own source text.
{
  const vars = { Period: "Month", N: 3, One: 1, S: "the wire" };
  eq("tmpl: var", stageTemplate("Top of the {{ .Period }}", vars), "Top of the Month");
  eq("tmpl: unknown var kept verbatim", stageTemplate("{{ .Nope }}", vars), "{{ .Nope }}");
  eq("tmpl: upper", stageTemplate("{{ upper .Period }}", vars), "MONTH");
  eq("tmpl: lower", stageTemplate("{{ lower .Period }}", vars), "month");
  eq("tmpl: title", stageTemplate("{{ title .S }}", vars), "The Wire");
  eq("tmpl: truncate long", stageTemplate("{{ truncate 5 .S }}", vars), "the …");
  eq("tmpl: truncate short is untouched", stageTemplate("{{ truncate 50 .S }}", vars), "the wire");
  eq("tmpl: pluralize many", stageTemplate(`{{ pluralize .N "view" "views" }}`, vars), "views");
  eq("tmpl: pluralize one", stageTemplate(`{{ pluralize .One "view" "views" }}`, vars), "view");
  eq("tmpl: null-ish input", stageTemplate(undefined, vars), "");
}

// stageLines is the single source of what gets drawn, measured and hit-tested.
{
  __t.setState({
    data: { top: { provider: "plex.top", params: {} } },
    layouts: {},
    scenes: [{ kind: "render", layout: "t", vars: { Period: "Week" } }],
  });
  __t.select(0);
  const scene = currentScene();

  eq("lines: text splits on newlines",
    JSON.stringify(stageLines({ type: "text", text: "a\nb\nc" }, scene)), '["a","b","c"]');
  eq("lines: scene vars win over globals",
    stageLines({ type: "text", text: "{{ .Period }}" }, scene)[0], "Week");

  const list = { type: "list", source: "top", item: "{{ .Rank }}. {{ .Name }} - {{ .Views }} views" };
  const drawn = stageLines(list, scene);
  eq("lines: list falls back to placeholder items", drawn.length, 5);
  eq("lines: list item context", drawn[0], "1. The Grand Budapest Hotel - 42 views");
  // render.go itemContext gives a list item the ITEM and nothing else, so a
  // global in an item template is unresolved here exactly as it would fail there.
  eq("lines: a list item sees no globals",
    stageLines({ type: "list", source: "top", item: "{{ .Period }}" }, scene)[0], "{{ .Period }}");
  eq("lines: an unknown source still draws placeholders",
    stageLines({ type: "list", source: "nope", item: "{{ .Name }}" }, scene).length, 5);

  setStageData({ vars: { Period: "Year" }, sources: { top: { items: [{ rank: 1, name: "Heat", views: 1 }] } } });
  eq("lines: resolved data replaces placeholders",
    JSON.stringify(stageLines(list, scene)), '["1. Heat - 1 views"]');
  eq("lines: server vars are defaults, scene vars still win",
    stageLines({ type: "text", text: "{{ .Period }}" }, scene)[0], "Week");
  eq("lines: server vars override the built-in defaults",
    stageLines({ type: "text", text: "{{ .Period }}" }, { kind: "render" })[0], "Year");
  setStageData(null);
  eq("lines: cleared data falls back to placeholders again", stageLines(list, scene).length, 5);
}

// A clips label layout is rendered per item, so the stage previews item 1.
{
  __t.setState({ data: { top: {} }, layouts: {}, scenes: [{ kind: "clips", source: "top", label: "l" }] });
  __t.select(0);
  eq("vars: a clips label sees the first item", stageVars(currentScene()).Name, "The Grand Budapest Hotel");
}

// M2: engine.go's sceneContext (engine.go:339-348) overlays Scene.Vars only
// for a render scene; a clips label's context is itemVars alone (engine.go:
// 210) with no Scene.Vars mixed in. A clip scene's own vars must not leak
// onto the stage where the real render never draws them.
{
  __t.setState({
    data: { top: {} }, layouts: {},
    scenes: [{ kind: "clips", source: "top", label: "l", vars: { Extra: "should not appear" } }],
  });
  __t.select(0);
  eq("vars: clips scene vars are not applied (M2)", stageVars(currentScene()).Extra, undefined);
}

// Font spec: the generic family is unquoted, and NOTHING clamps the size —
// geometry.js's 8..512 resize clamp must never reach a display path.
{
  eq("font: generic", stageFontSpec(48, "sans-serif"), "48px sans-serif");
  eq("font: loaded family", stageFontSpec(48, "prerollfont0"), '48px "prerollfont0", sans-serif');
  eq("font: no upper clamp", stageFontSpec(700, "sans-serif"), "700px sans-serif");
  eq("font: no lower clamp", stageFontSpec(2, "sans-serif"), "2px sans-serif");
}

// M5: stageMeasure has no caller yet (Task 9's drag/resize is next), but its
// contract is pinned here so that caller can trust it: real glyph metrics
// when the browser reports them, the 0.8/0.2 em split (matching
// geometry.js's own documented fallback) when it does not.
{
  const full = { measureText: () => ({ width: 42, actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 6 }) };
  const m1 = stageMeasure(full, 40)("hi");
  eq("measure: width from ctx.measureText", m1.width, 42);
  eq("measure: ascent from ctx.measureText", m1.ascent, 30);
  eq("measure: descent from ctx.measureText", m1.descent, 6);

  const sparse = { measureText: () => ({ width: 10 }) };
  const m2 = stageMeasure(sparse, 50)("x");
  eq("measure: ascent falls back to 0.8em", m2.ascent, 40);
  eq("measure: descent falls back to 0.2em", m2.descent, 10);
}

// safeColor: a half-typed colour must not paint the previous element's colour.
{
  eq("color: valid hex kept", safeColor("#ff0000", "white"), "#ff0000");
  eq("color: valid name kept", safeColor("gold", "white"), "gold");
  eq("color: half-typed falls back", safeColor("#ff", "white"), "white");
  eq("color: nonsense falls back", safeColor("reddd", "white"), "white");
  eq("color: empty falls back", safeColor("", "white"), "white");
  eq("color: undefined falls back", safeColor(undefined, "black"), "black");
  eq("color: none is the fallback's job", safeColor("none", "black"), "black");
}

// The note under the canvas is the stage's honesty channel.
{
  eq("note: no scene", stageNotes(null, null, "", ""), "Add a scene to start.");
  check("note: image scene", stageNotes({ kind: "image" }, null, "", "").includes("played as-is"));
  check("note: clips without a label", stageNotes({ kind: "clips" }, null, "", "").includes("draws no text"));
  check("note: missing layout is named",
    stageNotes({ kind: "render" }, null, "gone", "").includes('"gone"'));
  check("note: no layout chosen",
    stageNotes({ kind: "render" }, null, "", "").includes("no layout selected"));
  const withList = stageNotes({ kind: "render" }, { elements: [{ type: "list", source: "top" }] }, "t", "");
  check("note: placeholder data is disclosed", withList.includes("Placeholder data for top."), withList);
  check("note: font warning is appended",
    stageNotes({ kind: "render" }, { elements: [] }, "t", "no font").endsWith("no font"));

  // M1: RatingKey/MediaURL are in render.go's item context (render.go:294-303)
  // but the resolve endpoint never sends either to the browser — say so only
  // when a template this scene actually draws would use them.
  const ratingKeyList = stageNotes({ kind: "render" },
    { elements: [{ type: "list", source: "top", item: "{{ .RatingKey }}" }] }, "t", "");
  check("note: a list item using RatingKey is disclosed (M1)",
    ratingKeyList.includes("RatingKey") && ratingKeyList.includes("MediaURL"), ratingKeyList);
  const mediaURLLabel = stageNotes({ kind: "clips" },
    { elements: [{ type: "text", text: "{{ .MediaURL }}" }] }, "l", "");
  check("note: a clips label using MediaURL is disclosed (M1)", mediaURLLabel.includes("MediaURL"), mediaURLLabel);
  const untouched = stageNotes({ kind: "render" },
    { elements: [{ type: "list", source: "top", item: "{{ .Name }}" }] }, "t", "");
  check("note: a template that avoids them stays quiet", !untouched.includes("RatingKey"), untouched);
  // A render scene's own TEXT elements never see itemVars at all (only its
  // list elements do), so MediaURL there is just an unknown var, not this gap.
  const renderTextIgnored = stageNotes({ kind: "render" },
    { elements: [{ type: "text", text: "{{ .MediaURL }}" }] }, "t", "");
  check("note: a render scene's text elements are not item context",
    !renderTextIgnored.includes("MediaURL"), renderTextIgnored);

  eq("label: no scene", stageLabelText(null, 0, ""), "No scenes yet");
  eq("label: scene", stageLabelText({ kind: "render" }, 2, "title"), "Scene 3 · render · title");
  eq("label: no layout", stageLabelText({ kind: "image" }, 0, ""), "Scene 1 · image");
}

// ---- the draw itself -------------------------------------------------------
// Everything below drives renderStage() end to end against the recording ctx.
const stageEl = document.querySelector("#stage");
function draw() { stageCtx.calls.length = 0; renderStage(); return stageCtx.calls; }
const texts = (calls) => calls.filter((c) => c.op === "fillText");

{
  __t.setState({
    resolution: "1920x1080",
    data: { top: {} },
    layouts: {
      main: {
        font: "",
        background: { color: "#101010", image: "" },
        elements: [
          { type: "text", x: 100, y: 200, size: 60, color: "white", text: "Hello\nWorld" },
          { type: "list", source: "top", x: 100, startY: 400, stepY: 70, size: 40, color: "#ff0000", align: "center", item: "{{ .Name }}" },
        ],
      },
    },
    scenes: [{ kind: "render", layout: "main", duration: 6 }],
  });
  __t.select(0);
  const calls = draw();

  eq("draw: backing store sized from the frame", stageEl.width, 1920);
  eq("draw: css width follows the frame", stageEl.style.width, "960px");
  const t = calls.find((c) => c.op === "setTransform");
  eq("draw: context scaled once, so draws are in manifest pixels", JSON.stringify(t.args), "[1,0,0,1,0,0]");
  eq("draw: cleared in manifest pixels", JSON.stringify(calls.find((c) => c.op === "clearRect").args), "[0,0,1920,1080]");

  // Background first, then elements in array order (render.go's order, which is
  // also what makes the last element the topmost hit in geometry.js).
  const bg = calls.filter((c) => c.op === "fillRect" && c.args[2] === 1920 && c.args[3] === 1080);
  eq("draw: layout background colour painted full-frame", bg.length, 1);
  eq("draw: layout background colour", bg[0].fill, "#101010");
  check("draw: background precedes every element",
    calls.indexOf(bg[0]) < calls.indexOf(texts(calls)[0]));

  const drawn = texts(calls);
  eq("draw: two text lines plus five list rows", drawn.length, 7);
  eq("draw: text lines in order", drawn.map((c) => c.text).slice(0, 2).join("|"), "Hello|World");

  // The baselines must be geometry.js's, not something re-derived here.
  const el = ctx.currentLayout().elements[0];
  const want = Geometry.textBaselines(el, 2);
  eq("draw: text baselines come from geometry.js",
    JSON.stringify(drawn.slice(0, 2).map((c) => c.y)), JSON.stringify(want));
  eq("draw: text anchored at el.x", drawn[0].x, 100);
  eq("draw: text font", drawn[0].font, "60px sans-serif");

  const rows = drawn.slice(2);
  const wantRows = Geometry.listBaselines(ctx.currentLayout().elements[1], 5);
  eq("draw: list baselines come from geometry.js",
    JSON.stringify(rows.map((c) => c.y)), JSON.stringify(wantRows));
  eq("draw: list alignment", rows[0].align, "center");
  eq("draw: list colour", rows[0].fill, "#ff0000");
  eq("draw: list rows are the placeholder items", rows[0].text, "The Grand Budapest Hotel");

  eq("draw: label", document.querySelector("#stage-label").textContent, "Scene 1 · render · main");
  check("draw: note discloses the missing font and the placeholder data",
    document.querySelector("#stage-note").textContent.includes("no font set"),
    document.querySelector("#stage-note").textContent);
}

// A transparent layout background leaves the checkerboard showing, which is
// how a clip-label overlay is meant to read.
{
  __t.setState({
    layouts: { l: { font: "", background: { color: "none" }, elements: [] } },
    scenes: [{ kind: "render", layout: "l" }],
  });
  __t.select(0);
  const calls = draw();
  eq("draw: transparent background paints no full-frame fill",
    calls.filter((c) => c.op === "fillRect" && c.args[2] === 1920).length, 0);
  check("draw: the checkerboard is still there",
    calls.filter((c) => c.op === "fillRect").length > 100);
}

// A scene background REPLACES the layout's own, exactly as render.go's
// Layout() takes one branch or the other. With resolved artwork, the CELL
// COUNT follows the usable image count, not the configured limit (M6).
{
  __t.setState({
    data: { top: {} },
    layouts: { l: { font: "", background: { color: "#101010" }, elements: [] } },
    scenes: [{ kind: "render", layout: "l", background: { source: "top", mode: "art", tile: "grid", dim: 0.5, limit: 4 } }],
  });
  __t.select(0);
  // 4 items resolve but only 3 carry Art — engine.go's imageURLs (engine.go:
  // 256-271) skips the 4th outright rather than falling back to Thumb, and
  // the grid must follow what it actually kept, not the configured limit.
  setStageData({ vars: {}, sources: { top: { items: [
    { rank: 1, name: "A", art: "/api/plex/image?u=a" },
    { rank: 2, name: "B", art: "/api/plex/image?u=b" },
    { rank: 3, name: "C", art: "" },
    { rank: 4, name: "D", art: "/api/plex/image?u=d" },
  ] } } });
  const calls = draw();
  eq("draw: the layout colour is not painted under a scene background",
    calls.filter((c) => c.op === "fillRect" && c.fill === "#101010").length, 0);

  const cells = Geometry.gridCells(3, 1920, 1080);
  const tiles = calls.filter((c) => c.op === "fillRect" && c.args[2] === cells[0].w && c.args[3] === cells[0].h);
  eq("draw: cell count follows the usable image count, not the limit (M6)", tiles.length, 3);
  eq("draw: cells come from geometry.js",
    JSON.stringify(tiles.map((c) => c.args.slice(0, 2))),
    JSON.stringify(cells.map((c) => [c.x, c.y])));
  const dim = calls.filter((c) => c.op === "fillRect" && c.fill === "rgba(0,0,0,0.5)");
  eq("draw: the dim is composited over the whole frame", dim.length, 1);
  check("draw: the dim lands after the cells", calls.indexOf(dim[0]) > calls.indexOf(tiles[2]));
  setStageData(null);
}

// No usable art at all (offline placeholders, or a source whose items simply
// have none) falls back to one labelled box for the whole frame rather than
// guessing a cell count nothing backs. An unset mode is a trailer montage,
// not art (manifest.go's IsImage(), review fix M4), so the label — and the
// montage note — must say so too, not just an explicit mode: trailers.
{
  __t.setState({
    data: { top: {} },
    layouts: { l: { font: "", background: {}, elements: [] } },
    scenes: [{ kind: "render", layout: "l", background: { source: "top", tile: "grid", limit: 4 } }],
  });
  __t.select(0);
  const calls = draw();
  const wholeFrame = calls.filter((c) => c.op === "fillRect" && c.args[2] === 1920 && c.args[3] === 1080);
  check("draw: no usable art falls back to a single frame-sized box", wholeFrame.length >= 1);
  const labels = texts(calls);
  eq("draw: exactly one label drawn", labels.length, 1);
  eq("draw: unset mode labels itself trailers, not art (M4)", labels[0].text, "trailers from top");
  check("draw: the montage note fires for an unset mode too (M4)",
    document.querySelector("#stage-note").textContent.includes("muted trailer montage"),
    document.querySelector("#stage-note").textContent);
}

// The safe-area guide, and a resolution the manifest actually asked for.
{
  __t.setState({ resolution: "1280x720", layouts: {}, scenes: [{ kind: "image", file: "a.png" }] });
  __t.select(0);
  document.querySelector("#toggle-safe").checked = false;
  let calls = draw();
  eq("draw: no safe area until it is asked for", calls.filter((c) => c.op === "strokeRect").length, 0);
  eq("draw: backing store follows the manifest resolution", stageEl.width, 1920);
  eq("draw: aspect follows the manifest resolution", stageEl.height, 1080);

  document.querySelector("#toggle-safe").checked = true;
  calls = draw();
  const s = Geometry.safeArea(1280, 720);
  eq("draw: safe area from geometry.js",
    JSON.stringify(calls.find((c) => c.op === "strokeRect").args),
    JSON.stringify([s.x, s.y, s.w, s.h]));
  document.querySelector("#toggle-safe").checked = false;
}

// A size no clamp may touch: geometry.js's resize clamp stops at 512.
{
  __t.setState({
    layouts: { l: { font: "", background: {}, elements: [{ type: "text", x: 0, y: 0, size: 700, text: "Big" }] } },
    scenes: [{ kind: "render", layout: "l" }],
  });
  __t.select(0);
  eq("draw: an oversized font is drawn at its real size", texts(draw())[0].font, "700px sans-serif");
}

// An empty manifest must draw something sensible rather than throw.
{
  __t.setState({});
  __t.select(0);
  const calls = draw();
  check("draw: no scenes still paints the frame", calls.some((c) => c.op === "fillRect"));
  eq("draw: no scenes label", document.querySelector("#stage-label").textContent, "No scenes yet");
  eq("draw: no scenes note", document.querySelector("#stage-note").textContent, "Add a scene to start.");
}

// A layout font is requested once per path and falls back until it loads.
{
  __t.setState({
    layouts: { l: { font: "media/fonts/AdultSwim.ttf", background: {}, elements: [{ type: "text", x: 0, y: 0, size: 40, text: "x" }] } },
    scenes: [{ kind: "render", layout: "l" }],
  });
  __t.select(0);
  const first = texts(draw())[0];
  eq("font: falls back until the file loads", first.font, "40px sans-serif");
  eq("font: one load attempt per path", fontLoads, 1);
  draw();
  eq("font: a redraw does not re-request it", fontLoads, 1);
  check("font: the fallback is disclosed",
    document.querySelector("#stage-note").textContent.includes("Could not load"),
    document.querySelector("#stage-note").textContent);
}

// I1: render.go reads a layout background image at its NATIVE size and draws
// element text directly onto it (render.go:71-77); only pipeline.go's ffmpeg
// scale=W:H stretches the whole frame to the manifest resolution afterwards
// (pipeline.go:44). The stage instead stretches the image up front, so text
// lands identically UNLESS the image's native size differs from the manifest
// resolution — that residual must be disclosed, not silently wrong.
{
  const layoutWith = (image) => ({
    resolution: "1920x1080",
    layouts: { l: { font: "", background: { image }, elements: [] } },
    scenes: [{ kind: "render", layout: "l" }],
  });

  imagePreset = null;
  __t.setState(layoutWith("media/bg-loading.png"));
  __t.select(0);
  draw();
  check("draw: no size note until the image has loaded",
    !document.querySelector("#stage-note").textContent.includes("background image is"),
    document.querySelector("#stage-note").textContent);

  // loadImage() (stage.js) never treats a just-constructed Image as ready —
  // real image loading is async — so the first draw() only primes the cache;
  // the second is what actually sees the (stubbed) loaded image.
  imagePreset = { w: 3840, h: 2160 }; // a 4K background on a 1080p manifest
  __t.setState(layoutWith("media/bg-mismatch.png"));
  __t.select(0);
  draw();
  const calls = draw();
  eq("draw: the mismatched image is still stretched to the frame",
    calls.filter((c) => c.op === "drawImage" &&
      JSON.stringify(c.args.slice(1)) === JSON.stringify([0, 0, 1920, 1080])).length, 1);
  const note = document.querySelector("#stage-note").textContent;
  check("draw: a background image size mismatch is disclosed (I1)",
    note.includes("3840×2160") && note.includes("1920×1080"), note);

  imagePreset = { w: 1920, h: 1080 }; // matching size: no residual, no note
  __t.setState(layoutWith("media/bg-match.png"));
  __t.select(0);
  draw();
  draw();
  check("draw: a matching image size stays quiet",
    !document.querySelector("#stage-note").textContent.includes("background image is"),
    document.querySelector("#stage-note").textContent);
  imagePreset = null;
}

// refreshStageDataNow is the actual Task 7 data wiring: no data sources means
// no network call at all, and apiResolveData's reply flows into setStageData
// and stageDataReason unmodified (see the deviation note on refreshStageData
// in stage.js — the brief's snippet predates the {vars, sources} shape).
(async () => {
  __t.setState({ data: {}, layouts: {}, scenes: [] });
  fetchCalls = 0;
  fetchResponse = { configured: true, sources: { top: { items: [{ rank: 1, name: "should not be fetched" }] } } };
  await refreshStageDataNow();
  eq("resolve: no data sources means no network call", fetchCalls, 0);
  eq("resolve: stageDataReason clear with nothing to resolve", __t.stageDataReason(), "");

  __t.setState({ data: { top: { provider: "plex.top", params: {} } }, layouts: {}, scenes: [] });
  fetchResponse = { configured: false, reason: "Plex is not configured (set PLEX_URL and PLEX_TOKEN); showing placeholder data" };
  await refreshStageDataNow();
  eq("resolve: an unconfigured reason is surfaced", __t.stageDataReason(), fetchResponse.reason);
  eq("resolve: an unconfigured reply still falls back to placeholders", stageItems("top").length, 5);

  fetchResponse = {
    configured: true,
    vars: { Period: "Year" },
    sources: { top: { items: [{ rank: 1, name: "Heat", views: 1, art: "/api/plex/image?u=a" }] } },
  };
  await refreshStageDataNow();
  eq("resolve: a configured reply clears the reason", __t.stageDataReason(), "");
  eq("resolve: a configured reply's items replace the placeholders", stageItems("top").length, 1);
  eq("resolve: a configured reply's item is passed through", stageItems("top")[0].name, "Heat");
  eq("resolve: a configured reply's vars are exposed", stageVars({ kind: "render" }).Period, "Year");

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("stage.js checks passed");
})();
