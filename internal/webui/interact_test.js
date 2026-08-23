// Node check for static/interact.js — the drag/resize state machine.
//
//   node internal/webui/interact_test.js
//
// This is the suite that carries the most weight in the whole editor, because
// there is no browser automation here: nobody in this environment can press a
// mouse button. So the gestures are synthesised — plain {clientX, clientY,
// pointerId} objects pushed through the real pointerdown/pointermove/pointerup
// handlers on top of the same recording-canvas stub stage_test.js uses — and
// every position assertion is compared against Geometry's own output rather
// than a number typed here, so the maths and the sequencing are checked
// separately.
//
// What is NOT covered, and cannot be: that a browser delivers the events in
// this order, that pointer capture behaves as specified, and how any of it
// feels. See the human-check list in the task report.
//
// ponytail: a stub DOM and hand-built events, not a headless browser. The
// point is the state machine, which is where the bugs live.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- stub DOM --------------------------------------------------------------
// measureText reports only a width; stage.js's stageMeasure then falls back to
// the 0.8/0.2 em split, so a one-line box is exactly `size` tall. That makes
// the resize arithmetic (factor = (h + dy) / h) legible: dragging the handle
// down 50 manifest px on a 100pt element is a 1.5x scale.
function recordingCtx() {
  const calls = [];
  const ctx = {
    calls,
    font: "", fillStyle: "", strokeStyle: "", textAlign: "", textBaseline: "", lineWidth: 1,
    setTransform: () => {}, clearRect: () => {},
    fillRect: (x, y, w, h) => calls.push({ op: "fillRect", args: [x, y, w, h], fill: ctx.fillStyle }),
    strokeRect: (x, y, w, h) => calls.push({ op: "strokeRect", args: [x, y, w, h], stroke: ctx.strokeStyle }),
    fillText: (t, x, y) => calls.push({ op: "fillText", text: t, x, y }),
    drawImage: () => {},
    measureText: (t) => ({ width: String(t).length * 10 }),
    beginPath: () => calls.push({ op: "beginPath" }),
    moveTo: (x, y) => calls.push({ op: "moveTo", args: [x, y], stroke: ctx.strokeStyle }),
    lineTo: (x, y) => calls.push({ op: "lineTo", args: [x, y], stroke: ctx.strokeStyle }),
    stroke: () => calls.push({ op: "stroke", stroke: ctx.strokeStyle, width: ctx.lineWidth }),
    setLineDash: () => {}, save: () => {}, restore: () => {},
  };
  return ctx;
}
const stageCtx = recordingCtx();

// Pointer capture is recorded rather than simulated: what matters is that the
// canvas is asked for it on press and always gives it back on release.
const captures = [];
let held = null;
function makeEl(sel) {
  return {
    sel,
    innerHTML: "", textContent: "", value: "", checked: false,
    // 960 CSS px wide against a 1920 manifest: every manifest pixel is half a
    // client pixel, which is also why the screen-px tolerances double.
    clientWidth: 960, width: 0, height: 0, style: {},
    dataset: {}, options: [], attrs: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, closest() { return null; },
    querySelector: () => makeEl(),
    getContext: () => stageCtx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    setPointerCapture(id) { held = id; captures.push(["set", id]); },
    hasPointerCapture(id) { return held === id; },
    releasePointerCapture(id) { held = null; captures.push(["release", id]); },
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
  createElement: () => ({ getContext: () => ({ fillStyle: "" }) }),
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

// inspector.js, sections.js and app.js are left out on purpose: the three
// functions interact.js calls into them are stubbed below as counters, which
// is exactly what needs asserting — that a gesture re-renders the inspector
// and schedules ONE convert, at the end, not per frame.
const staticDir = path.join(__dirname, "static");
for (const f of ["providers.js", "util.js", "geometry.js", "interact.js", "state.js", "api.js", "stage.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}
vm.runInContext(`
globalThis.__spy = { selects: [], inspector: 0, converts: 0, renders: 0 };
globalThis.selectElement = (i) => { selection.element = i; __spy.selects.push(i); renderStage(); };
globalThis.renderInspector = () => { __spy.inspector++; };
globalThis.scheduleConvert = () => { __spy.converts++; };
globalThis.__t = {
  Geometry, Interact,
  setState: (s) => { state = normalize(s); selection = { sceneIndex: 0, element: null, dataSource: null }; },
  setSelected: (i) => { selection.element = i; },
  selected: () => selection.element,
  drag: () => stageDrag,
  guides: () => stageDragGuides,
  elements: () => currentLayout().elements,
  boxes: () => stageBoxes(),
};
`, ctx);

const { __t, __spy, renderStage, stagePointerDown, stagePointerMove, stagePointerUp,
  stageCancelDrag, stageKeyDown } = ctx;
const Geometry = __t.Geometry;
const Interact = __t.Interact;

// ---- assertions ------------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const same = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- the synthetic pointer ------------------------------------------------
// The stage is a 1920-wide manifest drawn 960 CSS px wide, so a client pixel
// is two manifest pixels. Tests are written in MANIFEST coordinates — the
// space the DSL and geometry.js speak — and converted on the way in, which is
// also a live check that toManifest is wired up the right way round.
const CLIENT_PER_MANIFEST = 0.5;
let nextPointerId = 1;
let pointerId = 0;
function at(mx, my) {
  return {
    clientX: mx * CLIENT_PER_MANIFEST,
    clientY: my * CLIENT_PER_MANIFEST,
    pointerId,
    preventDefault() {},
  };
}
function press(mx, my) {
  pointerId = nextPointerId++;
  stagePointerDown(at(mx, my));
}
const move = (mx, my) => stagePointerMove(at(mx, my));
const release = (mx, my) => stagePointerUp(at(mx, my));

// The layout every block starts from. One text element and one list, far
// enough apart that a hit test is never ambiguous.
//   text: x 100, y 200, size 100, "Hello World" -> box {100, 120, 110, 100}
//   list: x 1000, startY 600, step 100, size 50, five placeholder rows
function fresh() {
  __t.setState({
    resolution: "1920x1080",
    data: { top: { provider: "plex.top", params: {} } },
    layouts: {
      main: {
        font: "", background: { color: "#101010", image: "" },
        elements: [
          { type: "text", x: 100, y: 200, size: 100, color: "white", text: "Hello World" },
          { type: "list", source: "top", x: 1000, startY: 600, stepY: 100, size: 50, color: "white", item: "{{ .Name }}" },
        ],
      },
    },
    scenes: [{ kind: "render", layout: "main", duration: 6 }],
  });
  renderStage(); // populates the box cache the hit test reads
  __spy.selects.length = 0;
  __spy.inspector = 0;
  __spy.converts = 0;
  captures.length = 0;
  stageCtx.calls.length = 0;
}

// The tolerances the machine converts from screen to manifest pixels. At this
// scale both double.
const SNAP_TOL = Interact.SNAP_PX / CLIENT_PER_MANIFEST;   // 12 manifest px

// ---- the box cache the whole gesture is measured against -------------------
fresh();
{
  const box = __t.boxes()[0];
  same("setup: the text box is where geometry.js says", box, { x: 100, y: 120, w: 110, h: 100 });
  eq("setup: the box height is the font size, so a resize drag is 1:1", box.h, 100);
}

// ---- press, move, release --------------------------------------------------
{
  fresh();
  press(150, 180);
  eq("press: selects the element under the pointer", __t.selected(), 0);
  eq("press: starts a move", __t.drag().mode, "move");
  eq("press: takes pointer capture", captures.length, 1);
  same("press: capture is for this pointer", captures[0], ["set", pointerId]);
  eq("press: nothing is committed yet", __t.elements()[0].x, 100);
  eq("press: no convert scheduled mid-gesture", __spy.converts, 0);

  move(350, 380);
  const el = __t.elements()[0];
  // Compared against geometry.js's own answer, not a number typed here.
  const want = Geometry.dragPatch(
    { type: "text", x: 100, y: 200 }, { x: 100, y: 120, w: 110, h: 100 },
    200, 200,
    Geometry.snapTargets(1920, 1080, [__t.boxes()[1]]),
    SNAP_TOL,
  );
  eq("move: x is geometry.js's patch", el.x, want.patch.x);
  eq("move: y is geometry.js's patch", el.y, want.patch.y);
  eq("move: 200 manifest px right of 100", el.x, 300);
  eq("move: still no convert", __spy.converts, 0);

  // The reason the gesture snapshots the element at press time: the patch is
  // absolute (origin.x + dx). Re-deriving it from the element it has already
  // moved would double every frame — this is the assertion that catches it.
  move(350, 380);
  eq("move: replaying the same position does not compound", __t.elements()[0].x, 300);
  move(450, 380);
  move(350, 380);
  eq("move: nor does moving away and back", __t.elements()[0].x, 300);

  release(350, 380);
  eq("release: the gesture is over", __t.drag(), null);
  same("release: guides cleared", __t.guides(), { x: null, y: null });
  eq("release: capture given back", captures.filter((c) => c[0] === "release").length, 1);
  eq("release: the inspector is re-rendered so the numbers match", __spy.inspector, 1);
  eq("release: exactly one convert, at the end", __spy.converts, 1);
  eq("release: the element kept where it was dropped", __t.elements()[0].x, 300);
}

// ---- a release that happens outside the canvas -----------------------------
// Pointer capture means the browser keeps sending events to the canvas after
// the pointer has left it, which is what happens the moment somebody drags an
// element to the edge of the frame. Coordinates outside 0..1920 are legal in
// the DSL, so they are committed honestly rather than clamped: the element is
// visibly off-frame and the inspector shows why.
{
  fresh();
  press(150, 180);
  move(3000, 2000);                     // well past the bottom-right corner
  const off = __t.elements()[0];
  eq("off-canvas: the element follows past the frame edge", off.x, 100 + (3000 - 150));
  eq("off-canvas: and vertically too", off.y, 200 + (2000 - 180));
  release(9999, 9999);                  // released somewhere else entirely
  eq("off-canvas: the gesture still ends", __t.drag(), null);
  eq("off-canvas: capture still handed back", held, null);
  eq("off-canvas: the position is kept, not reverted", __t.elements()[0].x, 2950);
  eq("off-canvas: one convert", __spy.converts, 1);

  // And the next press still works — the machine is not wedged.
  press(3000, 2000);
  eq("off-canvas: a later press still starts a gesture", __t.drag().mode, "move");
  release(3000, 2000);
}

// ---- a drag that starts on empty canvas ------------------------------------
{
  fresh();
  __t.setSelected(0);
  press(1900, 1050); // inside the frame, outside every box
  eq("empty: selects nothing, which selects the scene", __t.selected(), null);
  eq("empty: starts no gesture", __t.drag(), null);
  eq("empty: takes no pointer capture", captures.length, 0);

  const before = JSON.stringify(__t.elements());
  move(500, 500);
  eq("empty: a move with no gesture changes nothing", JSON.stringify(__t.elements()), before);
  release(500, 500);
  eq("empty: a release with no gesture schedules no convert", __spy.converts, 0);
  eq("empty: and does not re-render the inspector", __spy.inspector, 0);
}

// ---- snapping and the guide lines ------------------------------------------
{
  fresh();
  press(150, 180);
  // Dragging right by 855 puts the box's left edge at 955, five short of the
  // 960 centre guide.
  move(150 + 855, 180);
  eq("snap: x locks onto the centre guide", __t.elements()[0].x, 960);
  eq("snap: the guide is reported", __t.guides().x, 960);
  eq("snap: the untouched axis has no guide", __t.guides().y, null);

  const guideStrokes = stageCtx.calls.filter((c) => c.op === "moveTo" && c.stroke === "rgba(229,160,13,0.9)");
  check("snap: a guide line is drawn", guideStrokes.length >= 1, JSON.stringify(guideStrokes));
  same("snap: the line runs the full height at the guide",
    guideStrokes[guideStrokes.length - 1].args, [960, 0]);

  // Somewhere with no guide near any of the box's three anchors — 500/555/610
  // is clear of the canvas centre at 960 and of the list's box at
  // 1000/1165/1330 — and it lands exactly where it was dropped, no line drawn.
  stageCtx.calls.length = 0;
  move(150 + 400, 180);
  eq("snap: with no guide in range nothing is captured", __t.guides().x, null);
  eq("snap: and the element is exactly where it was dropped", __t.elements()[0].x, 500);
  eq("snap: no guide line drawn",
    stageCtx.calls.filter((c) => c.op === "moveTo" && c.stroke === "rgba(229,160,13,0.9)").length, 0);

  release(0, 0);
  same("snap: guides cleared on release", __t.guides(), { x: null, y: null });
}

// ---- the list drags by startY ----------------------------------------------
{
  fresh();
  press(1100, 620);
  eq("list: the list is what was hit", __t.drag().index, 1);
  // +40/+50: the list's own anchors stay clear of every guide, so this is the
  // raw delta and nothing else.
  move(1140, 670);
  const list = __t.elements()[1];
  eq("list: x moved", list.x, 1040);
  eq("list: startY moved", list.startY, 650);
  eq("list: y was never introduced", list.y, undefined);
  release(1140, 700);
}

// ---- the resize handle -----------------------------------------------------
{
  fresh();
  __t.setSelected(0);
  const box = __t.boxes()[0];
  const h = Geometry.handlePoint(box); // {x: 210, y: 220}
  press(h.x, h.y);
  eq("resize: pressing the selected element's handle resizes", __t.drag().mode, "resize");
  eq("resize: on the element the handle belongs to", __t.drag().index, 0);

  move(h.x, h.y + 50);
  eq("resize: the size is geometry.js's", __t.elements()[0].size, Geometry.resizeSize(100, 100, 50));
  eq("resize: a taller box means a bigger font", __t.elements()[0].size, 150);
  same("resize: a resize snaps to nothing", __t.guides(), { x: null, y: null });
  eq("resize: the anchor is untouched", __t.elements()[0].x, 100);

  move(h.x, h.y);
  eq("resize: back to the start is back to the original size", __t.elements()[0].size, 100);
  release(h.x, h.y);
  eq("resize: one convert at the end", __spy.converts, 1);

  // With nothing selected there is no handle, so the same press is a move.
  fresh();
  press(h.x, h.y);
  eq("resize: no selection means no handle to grab", __t.drag().mode, "move");
  release(h.x, h.y);
}

// ---- the out-of-range font size --------------------------------------------
// The trap: resizeSize used to clamp to 8..512, a range with no basis in
// manifest.go, validate.go or render.go. A manifest carrying `size: 700` was
// silently rewritten the instant the handle was touched. Now the only bound is
// "stay positive", so a large element resizes from where it actually is.
{
  __t.setState({
    resolution: "1920x1080",
    layouts: { main: { font: "", background: {}, elements: [{ type: "text", x: 100, y: 800, size: 700, color: "white", text: "Big" }] } },
    scenes: [{ kind: "render", layout: "main" }],
  });
  renderStage();
  __t.setSelected(0);
  const box = __t.boxes()[0];
  eq("oversize: the box is as tall as the font", box.h, 700);
  const h = Geometry.handlePoint(box);

  press(h.x, h.y);
  move(h.x, h.y + 1);
  const nudged = __t.elements()[0].size;
  check("oversize: a one-pixel nudge does not yank it to 512", nudged !== 512, String(nudged));
  check("oversize: a one-pixel nudge grows it", nudged > 700, String(nudged));
  eq("oversize: and it is geometry.js's number", nudged, Geometry.resizeSize(700, 700, 1));

  move(h.x, h.y + 70);
  eq("oversize: it keeps growing", __t.elements()[0].size, 770);
  move(h.x, h.y - 70);
  eq("oversize: and shrinks", __t.elements()[0].size, 630);
  // The floor is still real: a drag must never produce a size that draws
  // nothing at all.
  move(h.x, h.y - 5000);
  check("oversize: the floor still holds", __t.elements()[0].size > 0, String(__t.elements()[0].size));
  release(h.x, h.y);
}

// ---- interruptions ---------------------------------------------------------
{
  fresh();
  press(150, 180);
  move(600, 600);
  eq("escape: the element moved first", __t.elements()[0].x, 550);
  stageKeyDown({ key: "Escape", preventDefault() {} });
  eq("escape: the element is put back", __t.elements()[0].x, 100);
  eq("escape: and vertically", __t.elements()[0].y, 200);
  eq("escape: the gesture is over", __t.drag(), null);
  eq("escape: capture handed back", held, null);
  eq("escape: still exactly one convert, so the revert is saved too", __spy.converts, 1);

  // Escape with nothing in flight is inert, and a stray release is too.
  const before = JSON.stringify(__t.elements());
  stageKeyDown({ key: "Escape", preventDefault() {} });
  release(0, 0);
  eq("escape: harmless when no gesture is running", JSON.stringify(__t.elements()), before);
  eq("escape: and schedules nothing", __spy.converts, 1);

  // pointercancel (the OS taking the gesture away) reverts the same way.
  fresh();
  press(150, 180);
  move(900, 900);
  stageCancelDrag(at(900, 900));
  eq("cancel: reverted", __t.elements()[0].x, 100);
  eq("cancel: over", __t.drag(), null);

  // A press while a gesture is somehow still open closes the old one first
  // rather than abandoning it holding pointer capture.
  fresh();
  press(150, 180);
  move(400, 400);
  press(1100, 620);            // no pointerup in between
  eq("orphan: the new gesture is the live one", __t.drag().index, 1);
  eq("orphan: the abandoned one was committed, not lost", __t.elements()[0].x, 350);
  eq("orphan: and it released its capture", captures.filter((c) => c[0] === "release").length, 1);
  release(1100, 620);

  // A gesture whose element is replaced underneath it (a manifest loading
  // mid-drag) drops rather than writing into an orphan.
  fresh();
  press(150, 180);
  const orphan = __t.drag().target;
  fresh();                                  // replaces state.layouts wholesale
  move(400, 400);
  eq("stale: the gesture is dropped", __t.drag(), null);
  eq("stale: the orphaned element was not written to", orphan.x, 100);
  eq("stale: the live element was not written to either", __t.elements()[0].x, 100);
}

// ---- the pure machine, driven directly -------------------------------------
// Interact.begin/move/cancel take a snapshot and return a patch; they never
// touch the element. That is what lets Task 11 apply the same patches from the
// keyboard without faking a drag.
{
  const boxes = [{ x: 0, y: 0, w: 100, h: 100 }];
  const elements = [{ type: "text", x: 0, y: 0, size: 100 }];
  const world = { boxes, elements, selected: null, width: 1920, height: 1080 };
  const p = (x, y) => ({ x, y, scale: 0.5 });

  const started = Interact.begin(p(50, 50), world);
  eq("pure: begin selects what it hit", started.select, 0);
  const out = Interact.move(started.drag, p(90, 90));
  same("pure: move returns a patch", out.patch, { x: 40, y: 40 });
  eq("pure: move mutates nothing", elements[0].x, 0);
  same("pure: cancel returns the origin", Interact.cancel(started.drag).patch, { x: 0, y: 0 });

  eq("pure: a press on nothing starts nothing", Interact.begin(p(500, 500), world).drag, null);
  eq("pure: move on no gesture is null", Interact.move(null, p(0, 0)), null);
  eq("pure: cancel on no gesture is null", Interact.cancel(null), null);

  // The element being dragged is never its own snap target: it would lock to
  // the box it is being pulled out of and refuse to move.
  const solo = Interact.begin(p(50, 50), world).drag;
  check("pure: the dragged box is not a snap target",
    !solo.targets.xs.includes(0) || solo.targets.xs.filter((t) => t === 0).length === 1,
    JSON.stringify(solo.targets.xs));
  same("pure: only the canvas guides remain", solo.targets.xs, [0, 960, 1920]);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("interact.js checks passed");
