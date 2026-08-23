// Node check for timeline.js: the rail's pure duration/height maths, its
// markup, the reorder state machine, and — the whole point of this file —
// proof that selecting a scene here is what makes the OTHER Task 8 regression
// (every layout but scene 0's had no editing UI) actually go away. Browser
// scripts with no module system, so they run inside a vm context — one shared
// lexical scope across runInContext calls, exactly like classic <script>
// tags — on a stub DOM.
//
//   node internal/webui/timeline_test.js
//
// What this file CANNOT check: that a real drag paints a drag image, that the
// cards actually lay out taller for longer scenes on a real screen, or focus
// behaviour. Those are in the human-check list in the task report.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- stub DOM (same shape as inspector_test.js's) --------------------------
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
    setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {},
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
  querySelectorAll: () => [], // no real cards to iterate; wireSceneDrag() just no-ops
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
  scheduleConvert: () => {},
});

const staticDir = path.join(__dirname, "static");
for (const f of ["providers.js", "util.js", "geometry.js", "interact.js", "state.js", "api.js", "stage.js", "inspector.js", "timeline.js", "sections.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}
vm.runInContext(`globalThis.__t = {
  setState: (s) => { state = normalize(s); },
  getState: () => state,
  select: (scene, element) => { selection.sceneIndex = scene; selection.element = element ?? null; },
  getSelection: () => selection,
  actions,
};`, ctx);

const { __t, renderTimeline, sceneDuration, timelineHeight, moveScene,
  renderInspector, renderStage, currentLayout, railReorderTarget } = ctx;
const { actions } = ctx.__t;
const rail = () => document.querySelector("#rail").innerHTML;
const panel = () => document.querySelector("#inspector").innerHTML;

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const has = (name, html, needle) => check(name, html.includes(needle), `missing ${needle}`);
const not = (name, html, needle) => check(name, !html.includes(needle), `should not contain ${needle}`);

// A fixture shaped exactly like manifests/double-feature.yaml — the case the
// task brief names as the one failing today: three layouts, only one of them
// (the first render scene's) reachable before this file's fix existed.
const DOUBLE_FEATURE = () => ({
  resolution: "1920x1080",
  data: {
    movieTrailers: { provider: "plex.trailers", params: {} },
    showTrailers: { provider: "plex.trailers", params: {} },
  },
  layouts: {
    title: { font: "a.ttf", background: { color: "black" }, elements: [{ type: "text", x: 960, y: 520, size: 120, color: "white", text: "Double Feature" }] },
    intermission: { font: "a.ttf", background: { color: "black" }, elements: [{ type: "text", x: 960, y: 560, size: 96, color: "white", text: "...and on TV" }] },
    "trailer-label": { font: "a.ttf", background: { color: "none" }, elements: [{ type: "text", x: 96, y: 960, size: 72, color: "white", text: "{{ .Name }}" }] },
  },
  scenes: [
    { kind: "render", layout: "title", duration: 4 },
    { kind: "clips", source: "movieTrailers", perClip: 8, label: "trailer-label" },
    { kind: "render", layout: "intermission", duration: 3 },
    { kind: "clips", source: "showTrailers", perClip: 8, label: "trailer-label" },
  ],
});

// ---- sceneDuration -----------------------------------------------------------
{
  eq("duration: no scene is 0", sceneDuration(null), 0);
  eq("duration: a render scene is its own duration", sceneDuration({ kind: "render", duration: 6 }), 6);
  eq("duration: an image scene is its own duration", sceneDuration({ kind: "image", duration: 4 }), 4);
  eq("duration: an unset duration is 0", sceneDuration({ kind: "render" }), 0);

  __t.setState(DOUBLE_FEATURE());
  // No Plex configured: stageItems() falls back to the 5 PLACEHOLDER_ITEMS,
  // all with hasMedia !== false, so a clips scene's estimate is perClip × 5.
  eq("duration: a clips scene estimates from placeholder items",
    sceneDuration({ kind: "clips", source: "movieTrailers", perClip: 8 }), 40);

  ctx.setStageData({ sources: { movieTrailers: { items: [
    { name: "A", hasMedia: true }, { name: "B", hasMedia: true }, { name: "C", hasMedia: false },
  ] } } });
  eq("duration: a clips scene only counts items that actually have media",
    sceneDuration({ kind: "clips", source: "movieTrailers", perClip: 4 }), 8);
  ctx.setStageData({});
}

// ---- timelineHeight ------------------------------------------------------
{
  eq("height: clamps to the minimum", timelineHeight(0), 40);
  eq("height: clamps to the maximum", timelineHeight(1000), 220);
  eq("height: scales linearly in between", timelineHeight(10), 90); // 10 * 9
}

// ---- renderTimeline markup -------------------------------------------------
{
  __t.setState(DOUBLE_FEATURE());
  __t.select(0, null);
  renderTimeline();
  const html = rail();
  has("markup: every scene gets a card", html, `data-index="3"`);
  has("markup: the header counts scenes", html, "4 scenes");
  // 4 + 40 (placeholder clips) + 3 + 40 = 87s
  has("markup: the header sums duration", html, "87s");
  has("markup: the selected scene is marked", html, `class="scene-card selected"`);
  // Cards share no separator, so split on the common class-attribute prefix:
  // fragment[1] is card 0 (selected — starts " selected\""), fragment[2] is
  // card 1 (not — starts "\"" with nothing before the closing quote).
  const cardFragments = html.split('<button type="button" class="scene-card');
  check("markup: scene 0's card IS marked selected", cardFragments[1].startsWith(' selected"'), cardFragments[1].slice(0, 20));
  check("markup: scene 1's card is NOT marked selected", cardFragments[2].startsWith('"'), cardFragments[2].slice(0, 20));
  has("markup: the longer clips scene is taller than the short render scene",
    html, `style="height:220px"`); // 40s clamps to the max
  has("markup: add-scene buttons for all three kinds", html, `data-kind="render"`);
  has("markup: add-scene buttons for all three kinds", html, `data-kind="clips"`);
  has("markup: add-scene buttons for all three kinds", html, `data-kind="image"`);
  has("markup: a remove-scene control", html, `data-action="remove-scene-selected"`);
  for (const btn of html.match(/<button[^>]*>/g)) {
    check(`markup: every button has type="button" (${btn.slice(0, 40)})`, btn.includes('type="button"'));
  }

  __t.setState({ scenes: [] });
  renderTimeline();
  has("markup: an empty manifest says so", rail(), "No scenes yet");
  has("markup: an empty manifest still shows 0 scenes / 0s", rail(), "0 scenes");
}

// ---- moveScene ---------------------------------------------------------------
{
  const three = () => ({ scenes: [{ id: "a" }, { id: "b" }, { id: "c" }] });

  __t.setState(three());
  moveScene(0, 0);
  eq("move: from === to is a no-op", __t.getState().scenes.map((s) => s.id).join(), "a,b,c");

  __t.setState(three());
  moveScene(5, 1);
  eq("move: an out-of-range index is a no-op", __t.getState().scenes.map((s) => s.id).join(), "a,b,c");

  __t.setState(three());
  __t.select(0, null);
  moveScene(0, 2);
  eq("move: the scene order changes", __t.getState().scenes.map((s) => s.id).join(), "b,c,a");
  eq("move: the moved scene's OWN selection follows it, not the index it left",
    __t.getSelection().sceneIndex, 2);

  __t.setState(three());
  __t.select(1, null); // "b" selected
  moveScene(0, 2); // "a" moves past it
  eq("move: a scene crossing the selection from below shifts it back",
    __t.getSelection().sceneIndex, 0);
  eq("move: ...and the selection still names the same scene ('b')",
    __t.getState().scenes[__t.getSelection().sceneIndex].id, "b");

  __t.setState(three());
  __t.select(1, null); // "b" selected
  moveScene(2, 0); // "c" moves in front of it
  eq("move: a scene crossing the selection from above shifts it forward",
    __t.getSelection().sceneIndex, 2);
  eq("move: ...and the selection still names the same scene ('b')",
    __t.getState().scenes[__t.getSelection().sceneIndex].id, "b");
}

// ---- Task 11 fix for a Task 8 regression: keyboard scene reordering -------
// The retired Scenes card had per-row up/down buttons; the rail that replaced
// it only reorders via HTML5 drag-and-drop (dragstart/drop), which needs a
// pointer. railReorderTarget is the pure decision (no DOM) that
// sceneCardKeyDown applies via moveScene() — driven directly here with plain
// {key, altKey} shapes, the same way stage.js's stageKeyAction is tested.
{
  eq("reorder: a bare arrow (no Alt) claims nothing — Tab still reaches every card",
    railReorderTarget(1, "ArrowUp", false, 3), null);
  eq("reorder: Alt+Up moves one earlier", railReorderTarget(1, "ArrowUp", true, 3), 0);
  eq("reorder: Alt+Up on the first card is a no-op", railReorderTarget(0, "ArrowUp", true, 3), null);
  eq("reorder: Alt+Down moves one later", railReorderTarget(0, "ArrowDown", true, 3), 1);
  eq("reorder: Alt+Down on the last card is a no-op", railReorderTarget(2, "ArrowDown", true, 3), null);
  eq("reorder: an unrelated key claims nothing", railReorderTarget(1, "Enter", true, 3), null);
  eq("reorder: a single-scene rail has nowhere to move to either way",
    railReorderTarget(0, "ArrowDown", true, 1), null);
}

// ---- CRITICAL FIX #1: selecting a scene here is what the inspector's ------
// currentLayoutName()/currentLayout() actually key off. Before timeline.js
// existed nothing ever wrote selection.sceneIndex, so it stayed 0 forever and
// "intermission" / "trailer-label" (double-feature.yaml's scenes 2-3) had no
// editing UI at all — this is the end-to-end proof that they do now.
{
  __t.setState(DOUBLE_FEATURE());
  __t.select(0, null);
  renderInspector();
  has("critical-1: scene 0 addresses the title layout", panel(), `data-path="layouts.title.font"`);
  not("critical-1: scene 0 does NOT show intermission's font field", panel(), `layouts.intermission.font`);

  actions["select-scene-index"]({ index: "2" });
  eq("critical-1: selecting scene 2 in the rail writes selection.sceneIndex",
    __t.getSelection().sceneIndex, 2);
  eq("critical-1: it also clears any element selection", __t.getSelection().element, null);
  has("critical-1: the inspector now addresses scene 2's OWN layout (intermission)",
    panel(), `data-path="layouts.intermission.font"`);
  has("critical-1: intermission's element is listed and selectable",
    panel(), `data-action="select-element" data-index="0"`);
  not("critical-1: it no longer shows scene 0's layout", panel(), `layouts.title.font`);

  // Follow the element row in: this is the other half of "editable" — the
  // full field set the retired Layouts card had, now reachable for a layout
  // that was completely inert before this fix.
  actions["select-element"]({ index: "0" });
  has("critical-1: intermission's element is actually editable",
    panel(), `data-path="layouts.intermission.elements.0.text"`);
  actions["select-scene"](); // back out for the rest of this block
  check("critical-1: the stage redraws scene 2 without throwing",
    (() => { try { renderStage(); return true; } catch (e) { console.error(e); return false; } })());

  actions["select-scene-index"]({ index: "1" });
  has("critical-1: a clips scene (index 1) addresses its LABEL layout (trailer-label)",
    panel(), `data-path="layouts.trailer-label.font"`);

  actions["select-scene-index"]({ index: "3" });
  has("critical-1: the second clips scene (index 3) reaches the SAME label layout",
    panel(), `data-path="layouts.trailer-label.font"`);
}

// ---- CRITICAL FIX #2: "+ Add layout" must be reachable whether or not the --
// current scene already has one. Before this fix it only rendered in the
// inspector's `!layout` branch, and sceneDefaults("render") always hands a
// fresh render scene the first existing layout — so once ANY layout existed,
// no scene could ever lack one, and a second layout could never be made.
{
  __t.setState(DOUBLE_FEATURE());
  __t.select(0, null); // scene 0 already has a layout ("title")
  renderInspector();
  has("critical-2: scene 0 already has a layout", panel(), `data-path="layouts.title.font"`);
  has("critical-2: '+ Add layout' is STILL present", panel(), `data-action="add-layout"`);

  actions["add-layout"]();
  const st = __t.getState();
  check("critical-2: a brand new layout was created", Object.keys(st.layouts).length === 4,
    Object.keys(st.layouts).join());
  check("critical-2: scene 0 now points at it", st.scenes[0].layout !== "title", st.scenes[0].layout);
  check("critical-2: the OLD layout ('title') was not deleted",
    st.layouts.title !== undefined && st.layouts.title.elements.length === 1);
  // It stays reachable exactly like a layout the old card made before any
  // scene picked it: through this scene's own Layout <select>. add-layout()
  // also selects the new layout's first element, so back out to the scene
  // panel first — the dropdown lives there, not in the element panel.
  actions["select-scene"]();
  renderInspector();
  has("critical-2: the orphaned layout is still selectable from the Layout dropdown",
    panel(), `<option value="title">title</option>`);
}

// ---- add-scene / remove-scene-selected -------------------------------------
{
  __t.setState(DOUBLE_FEATURE());
  __t.select(1, null);
  actions["add-scene"]({ kind: "render" });
  const st1 = __t.getState();
  eq("add-scene: appended", st1.scenes.length, 5);
  eq("add-scene: selects the new scene", __t.getSelection().sceneIndex, 4);
  eq("add-scene: clears any element selection", __t.getSelection().element, null);
  eq("add-scene: the new scene is the requested kind", st1.scenes[4].kind, "render");

  actions["remove-scene-selected"]();
  const st2 = __t.getState();
  eq("remove-scene: the selected scene is gone", st2.scenes.length, 4);
  eq("remove-scene: selection lands on a neighbour, not out of range",
    __t.getSelection().sceneIndex, 3);

  __t.setState({ scenes: [] });
  __t.select(0, null);
  check("remove-scene: a no-op on an empty manifest does not throw",
    (() => { try { actions["remove-scene-selected"](); return true; } catch { return false; } })());
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("timeline.js checks passed");
