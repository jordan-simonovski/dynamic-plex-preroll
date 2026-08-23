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
function makeEl(sel) {
  return {
    sel,
    innerHTML: "", textContent: "", value: "", checked: false,
    clientWidth: 960, width: 0, height: 0, style: {},
    dataset: {}, options: [], attrs: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, closest() { return null; },
    querySelector: () => makeEl(),
    getContext: () => drawCtx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
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
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  fonts: { add() {} },
};

const ctx = vm.createContext({
  document,
  window: { addEventListener() {}, devicePixelRatio: 1 },
  FontFace: class { load() { return Promise.reject(new Error("no font server in a test")); } },
  Image: class { set src(v) { this._src = v; } },
  fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  setTimeout, clearTimeout,
  confirm: () => true,
  navigator: { clipboard: { writeText: async () => {} } },
  console,
});

const staticDir = path.join(__dirname, "static");
// app.js is left out on purpose: it boots the toolbar and the network. The
// listeners it registers are thin — every decision they reach lives here.
for (const f of ["providers.js", "util.js", "geometry.js", "state.js", "api.js", "stage.js", "inspector.js", "sections.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}
vm.runInContext(`globalThis.__t = {
  setState: (s) => { state = normalize(s); },
  getState: () => state,
  select: (scene, element) => { selection.sceneIndex = scene; selection.element = element ?? null; },
  selected: () => selection.element,
  // \`actions\`/\`rerenderHooks\` are top-level consts, so they live in the shared
  // script scope rather than on the context's global object.
  actions, rerenderHooks,
};`, ctx);

const { __t, inspectorTarget, elementPath, renderInspector, selectElement, selectAt,
  currentLayout } = ctx;
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
    scene.includes(`<button class="element-row`), scene);

  // Text element: text, x, y, size, colour, align, line height, remove, chips.
  __t.select(0, 0);
  renderInspector();
  const text = panel();
  for (const [name, p] of [["text", "text"], ["x", "x"], ["y", "y"], ["size", "size"],
                           ["colour", "color"], ["align", "align"], ["line height", "lineHeight"]]) {
    has(`audit: text element ${name}`, text, `data-path="layouts.main.elements.0.${p}"`);
  }
  has("audit: text element remove", text, `data-action="remove-selected-element"`);
  has("audit: text element template chips", text, "{{ .Period }}");
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
  has("audit: list element item chips", list, "{{ .Rank }}");
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

// ---- click to select -------------------------------------------------------
// selectAt maps a client point through geometry.js onto the boxes the draw
// left behind. The stub frame is 960 CSS px wide against a 1920px manifest, so
// client coordinates are half of manifest ones.
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

  selectAt(60, 98); // manifest (120, 196): inside "Hello" (y 192..202)
  eq("click: a hit selects that element", __t.selected(), 0);

  selectAt(60, 398); // manifest (120, 796): inside "Bye"
  eq("click: a second hit selects the other element", __t.selected(), 1);

  selectAt(5, 5); // manifest (10, 10): empty canvas
  eq("click: empty canvas selects the scene", __t.selected(), null);
  eq("click: and the panel goes back to the scene", inspectorTarget().kind, "scene");
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("inspector.js checks passed");
