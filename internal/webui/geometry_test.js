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
  const ctx = vm.createContext({});
  const src = fs.readFileSync(GEOMETRY_PATH, "utf8");
  assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: "geometry.js" }));
  const G = vm.runInContext("Geometry", ctx);
  // Values cross a realm boundary, so compare structurally rather than by
  // prototype identity.
  assert.strictEqual(
    JSON.stringify(G.textBaselines({ y: 500, size: 80, lineHeight: 100 }, 3)),
    JSON.stringify([400, 500, 600]),
  );
  assert.strictEqual(
    JSON.stringify(G.lineBox({ x: 0, align: "center" }, "abcd", 100, fakeMeasure(100))),
    JSON.stringify({ x: -100, y: 20, w: 200, h: 100 }),
  );
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

test("resizeSize scales the font by the handle's vertical travel and clamps", () => {
  assert.strictEqual(Geometry.resizeSize(100, 100, 50), 150);
  assert.strictEqual(Geometry.resizeSize(100, 100, -50), 50);
  assert.strictEqual(Geometry.resizeSize(100, 100, -99), 8, "clamped at the small end");
  assert.strictEqual(Geometry.resizeSize(100, 100, 10000), 512, "clamped at the large end");
  assert.strictEqual(Geometry.resizeSize(100, 0, 50), 100, "a zero-height box cannot scale");
});

// ---- snapping --------------------------------------------------------------

test("snapping locks onto the nearest target inside the tolerance", () => {
  assert.deepStrictEqual(Geometry.snap(958, [0, 960, 1920], 8), { value: 960, guide: 960 });
  assert.deepStrictEqual(Geometry.snap(900, [0, 960, 1920], 8), { value: 900, guide: null });
  assert.deepStrictEqual(Geometry.snap(4, [0, 6], 8), { value: 6, guide: 6 }, "nearest, not first");
});

test("snapTargets offers the canvas edges, its centre, and every other box", () => {
  const t = Geometry.snapTargets(1920, 1080, [{ x: 100, y: 200, w: 100, h: 100 }]);
  assert.deepStrictEqual(t.xs, [0, 960, 1920, 100, 150, 200]);
  assert.deepStrictEqual(t.ys, [0, 540, 1080, 200, 250, 300]);
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
