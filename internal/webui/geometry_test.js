"use strict";
// Unit tests for the pure layout maths in static/geometry.js. Every assertion
// here is a rule taken from internal/render/render.go; if the renderer's
// behaviour changes, one of these must fail.
//
// Lives outside static/ (like syntax_test.js) so it is never embedded by
// //go:embed all:static and never served to the browser.
// Run: node internal/webui/geometry_test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const GEOMETRY_PATH = path.join(__dirname, "static", "geometry.js");
const Geometry = require(GEOMETRY_PATH);

// A deterministic stand-in for canvas text metrics: half an em per character,
// ascent 0.8em, descent 0.2em. Real metrics come from ctx.measureText in the
// browser; injecting them is what keeps this module testable in Node.
const fakeMeasure = (size) => (text) => ({
  width: text.length * size * 0.5,
  ascent: size * 0.8,
  descent: size * 0.2,
});

// ---- purity ----------------------------------------------------------------

test("geometry.js runs with no DOM in scope at all", () => {
  // A bare vm context has no document, window or canvas, so any reference to
  // one is a ReferenceError. Loading and exercising the module in here proves
  // the purity the whole plan's headless verifiability rests on.
  //
  // A DOM reference hiding in a function this block never calls would be
  // invisible to it, so every exported function is driven here with
  // representative arguments — not just textBaselines/lineBox — so a
  // ReferenceError anywhere in the file surfaces. (Proven by inserting
  // `void document;` into gridCells, a function previously untouched by this
  // test, and confirming the suite failed before this change; see the task
  // report.)
  const ctx = vm.createContext({});
  const src = fs.readFileSync(GEOMETRY_PATH, "utf8");
  assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: "geometry.js" }));
  const G = vm.runInContext("Geometry", ctx);
  const measure = fakeMeasure(100);
  // Objects/arrays returned by G cross a realm boundary, so deepStrictEqual's
  // prototype check fails them even when their contents match; compare
  // structurally via JSON instead. Primitives (numbers, strings, booleans)
  // are unaffected and use plain strictEqual.
  const same = (actual, expected) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));

  assert.strictEqual(G.lineHeight({ size: 100, lineHeight: 0 }), 120);
  same(G.textBaselines({ y: 500, size: 80, lineHeight: 100 }, 3), [400, 500, 600]);
  same(G.listBaselines({ startY: 320, stepY: 96 }, 2), [320, 416]);
  assert.strictEqual(G.align({ align: "CENTRE" }), "center");
  same(G.lineBox({ x: 0, align: "center" }, "abcd", 100, measure), { x: -100, y: 20, w: 200, h: 100 });
  same(
    G.elementBox({ type: "text", x: 0, y: 500, size: 100, lineHeight: 100, align: "left" }, ["ab", "abcdef"], measure),
    { x: 0, y: 370, w: 300, h: 200 },
  );
  const boxA = { x: 0, y: 0, w: 10, h: 10 };
  const boxB = { x: 20, y: -5, w: 10, h: 10 };
  same(G.union(boxA, boxB), { x: 0, y: -5, w: 30, h: 15 });
  assert.ok(G.contains(boxA, 5, 5));
  assert.strictEqual(G.hitTest([boxA, boxB], 25, 0), 1);
  same(G.handlePoint(boxA), { x: 10, y: 10 });
  assert.ok(G.onHandle(boxA, 10, 10, 1));
  same(G.moveTo({ type: "text", x: 10, y: 20 }, 5, -5), { x: 15, y: 15 });
  same(G.nudge({ type: "text", x: 10, y: 20 }, 1, 0), { x: 11, y: 20 });
  assert.strictEqual(G.resizeSize(100, 100, 50), 150);
  same(G.dragPatch({ type: "text", x: 10, y: 20 }, boxA, 5, 5, { xs: [], ys: [] }, 8),
    { patch: { x: 15, y: 25 }, guides: { x: null, y: null } });
  const targets = G.snapTargets(1920, 1080, [boxA]);
  same(G.snap(958, targets.xs, 8), { value: 960, guide: 960 });
  same(G.safeArea(1000, 1000, 0.1), { x: 100, y: 100, w: 800, h: 800 });
  same(G.coverRect(2000, 1000, 1000, 1000), { sx: 500, sy: 0, sw: 1000, sh: 1000 });
  same(G.gridCells(1, 1920, 1080), [{ x: 0, y: 0, w: 1920, h: 1080 }]);
  assert.strictEqual(G.dimAlpha(2), 1);
  assert.ok(G.isTransparent("none"));
  same(G.toManifest(490, 320, { left: 10, top: 20, width: 960 }, 1920), { x: 960, y: 600, scale: 0.5 });
  // Constants are also part of the exported surface.
  assert.strictEqual(G.DEFAULT_TEXT_COLOR, "white");
  assert.strictEqual(G.DEFAULT_BG_COLOR, "black");
  assert.strictEqual(G.DEFAULT_LINE_SPACING, 1.2);
});

// ---- baselines and stacking (render.go drawLines / the list branch) --------

test("lineHeight falls back to 1.2x the font size", () => {
  assert.strictEqual(Geometry.lineHeight({ size: 100, lineHeight: 0 }), 120);
  assert.strictEqual(Geometry.lineHeight({ size: 100, lineHeight: 64 }), 64);
  // render.go tests `lineHeight <= 0`, so a negative one falls back too.
  assert.strictEqual(Geometry.lineHeight({ size: 100, lineHeight: -5 }), 120);
  assert.strictEqual(Geometry.lineHeight({ size: 100 }), 120);
});

test("a single-line text block sits exactly on its y", () => {
  assert.deepStrictEqual(Geometry.textBaselines({ y: 150, size: 96 }, 1), [150]);
});

test("a multi-line text block is centred vertically on y", () => {
  // 3 lines, lineHeight 100, centred on y=500 -> 400, 500, 600.
  assert.deepStrictEqual(
    Geometry.textBaselines({ y: 500, size: 80, lineHeight: 100 }, 3),
    [400, 500, 600],
  );
  // An even count straddles y rather than landing on it.
  assert.deepStrictEqual(
    Geometry.textBaselines({ y: 500, size: 80, lineHeight: 100 }, 2),
    [450, 550],
  );
});

test("list rows start AT startY and step down, never centred", () => {
  assert.deepStrictEqual(
    Geometry.listBaselines({ startY: 320, stepY: 96 }, 3),
    [320, 416, 512],
  );
  assert.deepStrictEqual(Geometry.listBaselines({ startY: 320, stepY: 96 }, 1), [320]);
});

test("align normalises the DSL's spellings", () => {
  assert.strictEqual(Geometry.align({}), "left");
  assert.strictEqual(Geometry.align({ align: "" }), "left");
  assert.strictEqual(Geometry.align({ align: "CENTRE" }), "center");
  assert.strictEqual(Geometry.align({ align: "Center" }), "center");
  assert.strictEqual(Geometry.align({ align: "right" }), "right");
  assert.strictEqual(Geometry.align({ align: "justify" }), "left", "unknown spellings fall back");
});

// ---- boxes -----------------------------------------------------------------

test("lineBox anchors left, centre and right against x", () => {
  const el = { x: 1000, size: 100, y: 500 };
  const m = fakeMeasure(100); // "abcd" -> width 200, ascent 80, descent 20
  assert.deepStrictEqual(Geometry.lineBox({ ...el, align: "left" }, "abcd", 500, m),
    { x: 1000, y: 420, w: 200, h: 100 });
  assert.deepStrictEqual(Geometry.lineBox({ ...el, align: "center" }, "abcd", 500, m),
    { x: 900, y: 420, w: 200, h: 100 });
  assert.deepStrictEqual(Geometry.lineBox({ ...el, align: "right" }, "abcd", 500, m),
    { x: 800, y: 420, w: 200, h: 100 });
});

test("align applies to lists too, as render.go sets it before the type switch", () => {
  const el = { type: "list", x: 1000, startY: 100, stepY: 50, align: "right", size: 100 };
  assert.deepStrictEqual(
    Geometry.lineBox(el, "abcd", 100, fakeMeasure(100)),
    { x: 800, y: 20, w: 200, h: 100 },
  );
});

test("elementBox spans every line of a multi-line text element", () => {
  const el = { type: "text", x: 0, y: 500, size: 100, lineHeight: 100, align: "left" };
  const box = Geometry.elementBox(el, ["ab", "abcdef"], fakeMeasure(100));
  // baselines 450 and 550; widths 100 and 300; top 450-80=370, bottom 550+20=570
  assert.deepStrictEqual(box, { x: 0, y: 370, w: 300, h: 200 });
});

test("elementBox of a list starts at startY instead of centring on it", () => {
  const el = { type: "list", x: 0, startY: 500, stepY: 100, size: 100, align: "left" };
  const box = Geometry.elementBox(el, ["ab", "abcdef"], fakeMeasure(100));
  // baselines 500 and 600; top 500-80=420, bottom 600+20=620
  assert.deepStrictEqual(box, { x: 0, y: 420, w: 300, h: 200 });
});

test("elementBox of an element with no lines degrades to a point at its anchor", () => {
  assert.deepStrictEqual(
    Geometry.elementBox({ type: "text", x: 12, y: 34 }, [], fakeMeasure(50)),
    { x: 12, y: 34, w: 0, h: 0 });
  assert.deepStrictEqual(
    Geometry.elementBox({ type: "list", x: 12, startY: 34 }, [], fakeMeasure(50)),
    { x: 12, y: 34, w: 0, h: 0 });
});

test("union covers both boxes", () => {
  assert.deepStrictEqual(
    Geometry.union({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 10, h: 10 }),
    { x: 0, y: -5, w: 30, h: 15 });
});

test("contains is inclusive on all four edges", () => {
  const box = { x: 10, y: 20, w: 100, h: 50 };
  assert.ok(Geometry.contains(box, 10, 20), "top-left corner");
  assert.ok(Geometry.contains(box, 110, 70), "bottom-right corner");
  assert.ok(Geometry.contains(box, 10, 45), "left edge, mid-height");
  assert.ok(Geometry.contains(box, 110, 45), "right edge, mid-height");
  assert.ok(Geometry.contains(box, 60, 20), "top edge, mid-width");
  assert.ok(Geometry.contains(box, 60, 70), "bottom edge, mid-width");
  assert.ok(!Geometry.contains(box, 9.999, 45), "just outside the left edge");
  assert.ok(!Geometry.contains(box, 110.001, 45), "just outside the right edge");
  assert.ok(!Geometry.contains(box, 60, 19.999), "just outside the top edge");
  assert.ok(!Geometry.contains(box, 60, 70.001), "just outside the bottom edge");
});

test("hitTest picks the topmost box, matching draw order", () => {
  const boxes = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 50, y: 50, w: 100, h: 100 },
  ];
  assert.strictEqual(Geometry.hitTest(boxes, 10, 10), 0);
  assert.strictEqual(Geometry.hitTest(boxes, 75, 75), 1, "later elements draw over earlier ones");
  assert.strictEqual(Geometry.hitTest(boxes, 500, 500), -1);
});

test("the resize handle sits at the box's bottom-right and has a tolerance", () => {
  const box = { x: 100, y: 200, w: 300, h: 50 };
  assert.deepStrictEqual(Geometry.handlePoint(box), { x: 400, y: 250 });
  assert.ok(Geometry.onHandle(box, 405, 245, 10));
  assert.ok(!Geometry.onHandle(box, 420, 250, 10));
});

// ---- drag and resize patches ----------------------------------------------

test("dragging a text element moves x/y; dragging a list moves x/startY", () => {
  assert.deepStrictEqual(Geometry.moveTo({ type: "text", x: 10, y: 20 }, 5, -5), { x: 15, y: 15 });
  assert.deepStrictEqual(Geometry.moveTo({ type: "list", x: 10, startY: 20 }, 5, -5), { x: 15, startY: 15 });
});

test("moveTo rounds to one decimal so YAML stays readable", () => {
  assert.deepStrictEqual(Geometry.moveTo({ type: "text", x: 0, y: 0 }, 1.23456, 0), { x: 1.2, y: 0 });
});

test("nudge is moveTo with whole-pixel steps", () => {
  assert.deepStrictEqual(Geometry.nudge({ type: "text", x: 100, y: 200 }, 1, 0), { x: 101, y: 200 });
  assert.deepStrictEqual(Geometry.nudge({ type: "list", x: 100, startY: 200 }, 0, -10), { x: 100, startY: 190 });
  assert.deepStrictEqual(Geometry.nudge({ type: "text", x: 100.6, y: 200 }, 1, 0), { x: 102, y: 200 },
    "a nudge lands on whole pixels so repeated presses stay predictable");
});

test("resizeSize scales the font by the handle's vertical travel", () => {
  assert.strictEqual(Geometry.resizeSize(100, 100, 50), 150);
  assert.strictEqual(Geometry.resizeSize(100, 100, -50), 50);
  assert.strictEqual(Geometry.resizeSize(100, 100, -99), 8, "floored so it stays drawable");
  assert.strictEqual(Geometry.resizeSize(100, 100, -1000), 8, "a negative pointsize is not a size");
  assert.strictEqual(Geometry.resizeSize(100, 0, 50), 100, "a zero-height box cannot scale");
  assert.strictEqual(Geometry.resizeSize(0, 100, 50), 0, "an element with no size has nothing to scale");
});

// The trap this replaced: the old clamp topped out at 512, a number with no
// basis anywhere in manifest.go, validate.go or render.go. Touching the handle
// of a legitimately large element rewrote a value the user never dragged.
test("resizeSize never drags a size back inside bounds the renderer does not have", () => {
  const box = 700 * 1.2;
  assert.strictEqual(Geometry.resizeSize(700, box, 0), 700, "a nudge that goes nowhere changes nothing");
  assert.ok(Geometry.resizeSize(700, box, 1) > 700, "an out-of-range size can still grow");
  assert.ok(Geometry.resizeSize(700, box, -100) < 700, "and can still shrink");
  // The floor drops with the element for the same reason: a 4pt element must
  // not jump to 8 the instant the handle is touched.
  assert.strictEqual(Geometry.resizeSize(4, 5, -100), 4);
  assert.ok(Geometry.resizeSize(4, 5, 5) > 4);
});

// ---- snapping --------------------------------------------------------------

test("snapping locks onto the nearest target inside the tolerance", () => {
  assert.deepStrictEqual(Geometry.snap(958, [0, 960, 1920], 8), { value: 960, guide: 960 });
  assert.deepStrictEqual(Geometry.snap(900, [0, 960, 1920], 8), { value: 900, guide: null });
  assert.deepStrictEqual(Geometry.snap(4, [0, 6], 8), { value: 6, guide: 6 }, "nearest, not first");
});

test("snap ties resolve to the last equidistant target, deliberately", () => {
  // 5 is exactly 5 away from both 0 and 10; the loop's `<=` means the later
  // target in the array wins.
  assert.deepStrictEqual(Geometry.snap(5, [0, 10], 8), { value: 10, guide: 10 });
  assert.deepStrictEqual(Geometry.snap(5, [10, 0], 8), { value: 0, guide: 0 });
});

test("snapTargets offers the canvas edges, its centre, and every other box", () => {
  const t = Geometry.snapTargets(1920, 1080, [{ x: 100, y: 200, w: 100, h: 100 }]);
  assert.deepStrictEqual(t.xs, [0, 960, 1920, 100, 150, 200]);
  assert.deepStrictEqual(t.ys, [0, 540, 1080, 200, 250, 300]);
});

// ---- dragPatch: the whole move calculation ---------------------------------

test("dragPatch snaps the element's own edges to the guides", () => {
  const el = { type: "text", x: 100, y: 500, size: 100, align: "left" };
  const box = { x: 100, y: 460, w: 200, h: 100 };
  const targets = { xs: [0, 960, 1920], ys: [0, 540, 1080] };
  // Dragging right by 855 puts the box's left edge at 955, five short of the
  // 960 centre guide: it should snap, and x moves by the SNAPPED delta.
  const out = Geometry.dragPatch(el, box, 855, 0, targets, 8);
  assert.strictEqual(out.patch.x, 960);
  assert.strictEqual(out.guides.x, 960);
  assert.strictEqual(out.patch.y, 500, "an unsnapped axis keeps its raw delta");
  assert.strictEqual(out.guides.y, null);
});

test("dragPatch leaves an unsnapped drag exactly where it was dropped", () => {
  const el = { type: "text", x: 100, y: 500 };
  const box = { x: 100, y: 460, w: 200, h: 100 };
  const out = Geometry.dragPatch(el, box, 30, 40, { xs: [0], ys: [0] }, 8);
  assert.deepStrictEqual(out.patch, { x: 130, y: 540 });
  assert.deepStrictEqual(out.guides, { x: null, y: null });
});

test("dragPatch moves a list by startY, not y", () => {
  const el = { type: "list", x: 96, startY: 320 };
  const box = { x: 96, y: 280, w: 400, h: 500 };
  const out = Geometry.dragPatch(el, box, 10, 10, { xs: [], ys: [] }, 8);
  assert.deepStrictEqual(out.patch, { x: 106, startY: 330 });
});

test("dragPatch snaps to whichever of the box's three x anchors is closest", () => {
  const el = { type: "text", x: 100, y: 500, align: "left" };
  const box = { x: 100, y: 460, w: 200, h: 100 }; // right edge at 300
  // Dragging right by 655 puts the RIGHT edge at 955 — 5 from the 960 guide.
  const out = Geometry.dragPatch(el, box, 655, 0, { xs: [960], ys: [] }, 8);
  assert.strictEqual(out.patch.x, 760, "x moves so the right edge lands on 960");
  assert.strictEqual(out.guides.x, 960);
});

test("dragPatch prefers the nearest anchor when several are in range", () => {
  const el = { type: "text", x: 0, y: 0 };
  const box = { x: 0, y: 0, w: 10, h: 10 };
  // Dragging by 93 puts the three x anchors at 93, 98 and 103 — all three
  // within 8 of the single 100 guide. The CENTRE is nearest (2 away), so the
  // element moves by 95. Only because the loop narrows its tolerance as it
  // goes: without that the last anchor in range (103) would win and this
  // would be 90.
  const out = Geometry.dragPatch(el, box, 93, 0, { xs: [100], ys: [] }, 8);
  assert.strictEqual(out.patch.x, 95);
  assert.strictEqual(out.guides.x, 100);
});

test("dragPatch snaps both axes independently", () => {
  const el = { type: "text", x: 0, y: 0 };
  const box = { x: 0, y: 0, w: 100, h: 100 };
  // x snaps by the box's LEFT edge (47 -> 50); y by its MIDDLE (1003 -> 1000),
  // which pulls the anchor to 950, not to the guide.
  const out = Geometry.dragPatch(el, box, 47, 953, { xs: [50], ys: [1000] }, 8);
  assert.deepStrictEqual(out.patch, { x: 50, y: 950 });
  assert.deepStrictEqual(out.guides, { x: 50, y: 1000 });
});

test("dragPatch is absolute, so replaying the same delta lands in the same place", () => {
  // The reason the drag state machine snapshots the element at press time: a
  // patch is el.x + dx, not a relative nudge. Applying frame N and then frame
  // N to a moved element would double it.
  const el = { type: "text", x: 100, y: 100 };
  const box = { x: 100, y: 100, w: 10, h: 10 };
  const targets = { xs: [], ys: [] };
  assert.deepStrictEqual(Geometry.dragPatch(el, box, 30, 30, targets, 8).patch, { x: 130, y: 130 });
  assert.deepStrictEqual(Geometry.dragPatch(el, box, 30, 30, targets, 8).patch, { x: 130, y: 130 });
});

test("safeArea insets 5% by default", () => {
  assert.deepStrictEqual(Geometry.safeArea(1920, 1080),
    { x: 96, y: 54, w: 1728, h: 972 });
  assert.deepStrictEqual(Geometry.safeArea(1000, 1000, 0.1),
    { x: 100, y: 100, w: 800, h: 800 });
});

// ---- backgrounds (render.go coverResize / buildGrid / dimImage) ------------

test("coverRect crops the overflow centred, mirroring coverResize", () => {
  // A 2000x1000 image into a 1000x1000 cell: scale 1, crop 1000 off the width.
  assert.deepStrictEqual(Geometry.coverRect(2000, 1000, 1000, 1000),
    { sx: 500, sy: 0, sw: 1000, sh: 1000 });
  // A 1000x2000 image into a 1000x1000 cell: crop 1000 off the height.
  assert.deepStrictEqual(Geometry.coverRect(1000, 2000, 1000, 1000),
    { sx: 0, sy: 500, sw: 1000, sh: 1000 });
  assert.deepStrictEqual(Geometry.coverRect(0, 0, 100, 100), { sx: 0, sy: 0, sw: 0, sh: 0 });
});

test("coverRect agrees with render.go's resize-then-crop on a non-square fill", () => {
  // render.go: scale = max(1920/800, 1080/800) = 2.4; nw = nh = 1920; crop
  // 1920x1080 at ((1920-1920)/2, (1920-1080)/2) = (0, 420) of the SCALED image,
  // i.e. 420/2.4 = 175 in source pixels, leaving 1080/2.4 = 450 source rows.
  const r = Geometry.coverRect(800, 800, 1920, 1080);
  assert.strictEqual(r.sx, 0);
  assert.strictEqual(r.sw, 800);
  assert.strictEqual(r.sh, 450);
  assert.strictEqual(r.sy, 175);
});

test("gridCells falls back to one full-rect cell for <=1 image, matching render.go's cover fall-through", () => {
  // render.go's buildImageBackground only takes the grid path when
  // len(rb.Images) > 1; a single image (or zero, though that's the
  // caller's empty-background case) renders via coverResize onto the
  // whole canvas, never a half-height 2x2 tile.
  assert.deepStrictEqual(Geometry.gridCells(1, 1920, 1080), [{ x: 0, y: 0, w: 1920, h: 1080 }]);
  assert.deepStrictEqual(Geometry.gridCells(0, 1920, 1080), [{ x: 0, y: 0, w: 1920, h: 1080 }]);
});

test("gridCells is 2x2, 2x1 for exactly two, and never more than four", () => {
  assert.deepStrictEqual(Geometry.gridCells(2, 1920, 1080), [
    { x: 0, y: 0, w: 960, h: 1080 },
    { x: 960, y: 0, w: 960, h: 1080 },
  ]);
  assert.strictEqual(Geometry.gridCells(3, 1920, 1080).length, 3);
  assert.deepStrictEqual(Geometry.gridCells(3, 1920, 1080)[2], { x: 0, y: 540, w: 960, h: 540 });
  assert.strictEqual(Geometry.gridCells(9, 1920, 1080).length, 4, "render.go slices to four");
  // render.go computes the tile size with integer division, so an odd
  // resolution leaves a black strip rather than stretching the last tile.
  assert.deepStrictEqual(Geometry.gridCells(4, 1921, 1081)[3], { x: 960, y: 540, w: 960, h: 540 });
});

test("dimAlpha mirrors dimImage's no-op-below-zero and clamp-at-one", () => {
  assert.strictEqual(Geometry.dimAlpha(0), 0);
  assert.strictEqual(Geometry.dimAlpha(-1), 0);
  assert.strictEqual(Geometry.dimAlpha(0.4), 0.4);
  assert.strictEqual(Geometry.dimAlpha(2), 1);
  assert.strictEqual(Geometry.dimAlpha(undefined), 0);
});

test("isTransparent matches render.go's none/transparent check", () => {
  assert.ok(Geometry.isTransparent("none"));
  assert.ok(Geometry.isTransparent("  TRANSPARENT "));
  assert.ok(!Geometry.isTransparent("black"));
  assert.ok(!Geometry.isTransparent(""));
});

test("the colour defaults are render.go's", () => {
  assert.strictEqual(Geometry.DEFAULT_TEXT_COLOR, "white");
  assert.strictEqual(Geometry.DEFAULT_BG_COLOR, "black");
  assert.strictEqual(Geometry.DEFAULT_LINE_SPACING, 1.2);
});

// ---- pointer mapping -------------------------------------------------------

test("toManifest converts a pointer position back into manifest pixels", () => {
  const rect = { left: 10, top: 20, width: 960 }; // a 1920-wide manifest at 50%
  const p = Geometry.toManifest(490, 320, rect, 1920);
  assert.strictEqual(p.scale, 0.5);
  assert.strictEqual(p.x, 960);
  assert.strictEqual(p.y, 600);
  // The stage's top-left corner is the manifest's origin.
  assert.deepStrictEqual(Geometry.toManifest(10, 20, rect, 1920), { x: 0, y: 0, scale: 0.5 });
});
