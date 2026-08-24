"use strict";
// geometry.js — the pure layout maths behind the stage. NO DOM, NO fetch, NO
// application state: every function takes its inputs and returns new values.
// That is deliberate — it is the only part of the visual editor that can be
// tested without a browser, and internal/webui/geometry_test.js is the contract
// against internal/render/render.go.
//
// Coordinate space is "manifest pixels": the same space render.go draws in,
// origin top-left, extent = Preroll.resolution. The stage scales that space to
// CSS pixels; nothing in this file knows about CSS, devicePixelRatio, or zoom.
//
// Text metrics arrive through a `measure(text) -> {width, ascent, descent}`
// callback (the browser passes one backed by ctx.measureText). Injecting them
// is what keeps this file pure.
//
// That injected measure() is also the file's largest known divergence from
// the renderer: browser text shaping (ctx.measureText) does not match
// ImageMagick/FreeType's glyph metrics exactly, so lineBox/elementBox widths
// are an approximation, not a guarantee, of what render.go will draw.

const GEO_DEFAULT_LINE_SPACING = 1.2;   // render.go: defaultLineSpacing
const GEO_DEFAULT_TEXT_COLOR = "white"; // render.go: setFillColor's fallback
const GEO_DEFAULT_BG_COLOR = "black";   // render.go: setupCanvas's fallback
const GEO_MIN_SIZE = 8;

function geoRound1(n) { return Math.round(n * 10) / 10; }

const Geometry = {
  DEFAULT_LINE_SPACING: GEO_DEFAULT_LINE_SPACING,
  DEFAULT_TEXT_COLOR: GEO_DEFAULT_TEXT_COLOR,
  DEFAULT_BG_COLOR: GEO_DEFAULT_BG_COLOR,

  // render.go drawLines: an unset lineHeight is 1.2x the font size.
  lineHeight(el) {
    return el.lineHeight > 0 ? el.lineHeight : (el.size || 0) * GEO_DEFAULT_LINE_SPACING;
  },

  // render.go drawLines: the block of N lines is centred vertically on el.y,
  // and each returned number is a BASELINE, not a top edge. dw.Annotation and
  // canvas's default textBaseline "alphabetic" both anchor at the baseline, so
  // this translates 1:1 with no offset.
  textBaselines(el, lineCount) {
    const lh = Geometry.lineHeight(el);
    const start = (el.y || 0) - ((lineCount - 1) / 2) * lh;
    const out = [];
    for (let i = 0; i < lineCount; i++) out.push(start + i * lh);
    return out;
  },

  // render.go's list branch: y = el.StartY + i*el.StepY. There is no vertical
  // centring here — the first row's baseline IS startY. Getting this wrong is
  // the classic "my list is half a row too high" bug.
  listBaselines(el, rowCount) {
    const out = [];
    for (let i = 0; i < rowCount; i++) out.push((el.startY || 0) + i * (el.stepY || 0));
    return out;
  },

  // render.go alignType: centre is accepted as a spelling of center. render.go
  // calls SetTextAlignment before the type switch, so this applies to lists too.
  align(el) {
    const a = String(el.align || "").toLowerCase();
    if (a === "center" || a === "centre") return "center";
    if (a === "right") return "right";
    return "left";
  },

  // The box for ONE line whose baseline sits at `baseline`, anchored
  // horizontally at el.x according to the alignment.
  lineBox(el, text, baseline, measure) {
    const m = measure(text);
    const align = Geometry.align(el);
    let left = el.x || 0;
    if (align === "center") left = (el.x || 0) - m.width / 2;
    else if (align === "right") left = (el.x || 0) - m.width;
    return { x: left, y: baseline - m.ascent, w: m.width, h: m.ascent + m.descent };
  },

  // The union of every line's box: the element's selection rectangle and its
  // hit area. An element with nothing to draw collapses to a point at its
  // anchor so it stays selectable.
  elementBox(el, lines, measure) {
    const baselines = el.type === "list"
      ? Geometry.listBaselines(el, lines.length)
      : Geometry.textBaselines(el, lines.length);
    let box = null;
    for (let i = 0; i < lines.length; i++) {
      const b = Geometry.lineBox(el, lines[i], baselines[i], measure);
      box = box === null ? b : Geometry.union(box, b);
    }
    return box || { x: el.x || 0, y: (el.type === "list" ? el.startY : el.y) || 0, w: 0, h: 0 };
  },

  union(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  },

  contains(box, px, py) {
    return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
  },

  // Topmost hit wins: render.go draws elements in array order, so the last one
  // drawn is the one on top, and the search runs backwards.
  hitTest(boxes, px, py) {
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (Geometry.contains(boxes[i], px, py)) return i;
    }
    return -1;
  },

  // One handle, bottom-right. More handles would imply the DSL can express a
  // width or a non-uniform scale; it cannot — an element has a font size and
  // an anchor, so one handle is the whole vocabulary.
  handlePoint(box) { return { x: box.x + box.w, y: box.y + box.h }; },

  // tol is supplied by the caller in MANIFEST pixels (screen tolerance / scale),
  // so the handle stays the same physical size however the stage is scaled.
  onHandle(box, px, py, tol) {
    const h = Geometry.handlePoint(box);
    return Math.abs(px - h.x) <= tol && Math.abs(py - h.y) <= tol;
  },

  // The patch a completed drag applies. A list has no y — its vertical anchor
  // is startY — so dragging one moves x/startY instead of x/y.
  moveTo(el, dx, dy) {
    if (el.type === "list") {
      return { x: geoRound1((el.x || 0) + dx), startY: geoRound1((el.startY || 0) + dy) };
    }
    return { x: geoRound1((el.x || 0) + dx), y: geoRound1((el.y || 0) + dy) };
  },

  // dragPatch is the whole move calculation: apply the raw delta, then look at
  // the box's three anchors on each axis (left/centre/right, top/middle/
  // bottom) and take the nearest snap within tolerance, adjusting the delta by
  // however far that anchor had to move. Returning the guides it locked onto
  // lets the stage draw them; keeping the arithmetic here keeps the pointer
  // handler free of maths and this behaviour testable in Node.
  //
  // `el` must be the element as it was when the gesture STARTED, and `box` its
  // box then: the patch is absolute (el.x + dx), so feeding back an element a
  // previous frame of the same drag already moved compounds the delta.
  // Narrowing `best` as the loop goes is what makes the nearest anchor win
  // rather than the last one that happened to be in range.
  dragPatch(el, box, dx, dy, targets, tol) {
    const anchorsX = [box.x + dx, box.x + box.w / 2 + dx, box.x + box.w + dx];
    const anchorsY = [box.y + dy, box.y + box.h / 2 + dy, box.y + box.h + dy];
    let adjustX = 0;
    let guideX = null;
    let bestX = tol;
    for (const a of anchorsX) {
      const s = Geometry.snap(a, targets.xs || [], bestX);
      if (s.guide !== null) { bestX = Math.abs(a - s.guide); adjustX = s.guide - a; guideX = s.guide; }
    }
    let adjustY = 0;
    let guideY = null;
    let bestY = tol;
    for (const a of anchorsY) {
      const s = Geometry.snap(a, targets.ys || [], bestY);
      if (s.guide !== null) { bestY = Math.abs(a - s.guide); adjustY = s.guide - a; guideY = s.guide; }
    }
    return {
      patch: Geometry.moveTo(el, dx + adjustX, dy + adjustY),
      guides: { x: guideX, y: guideY },
    };
  },

  // nudge is an arrow-key move: the same patch shape as a drag, but rounded to
  // whole pixels so ten presses of "right" move exactly ten pixels rather than
  // accumulating a fractional offset the way moveTo's one-decimal rounding
  // would across many small steps.
  nudge(el, dx, dy) {
    if (el.type === "list") {
      return { x: Math.round((el.x || 0) + dx), startY: Math.round((el.startY || 0) + dy) };
    }
    return { x: Math.round((el.x || 0) + dx), y: Math.round((el.y || 0) + dy) };
  },

  // Resizing changes the font size, the only size the DSL has. The scale
  // factor is how much taller the box got, so the drag feels proportional.
  //
  // The bounds are deliberately one-sided, and that is a change from the
  // clamp this function shipped with. manifest.go declares Size as a bare
  // float64 and neither validate.go nor render.go puts a ceiling on it, so a
  // 512 clamp here was an editor-only rule: a manifest carrying `size: 700`
  // got silently rewritten down the instant the handle was touched, moving a
  // value the user never dragged. The one bound that IS the renderer's is
  // "stay positive" — a zero or negative pointsize draws nothing — and even
  // that floor drops to the element's own size when it already starts below
  // it, for the same reason. Nothing needs defending at the top end: a text
  // box is about as tall as its font, so the factor works out at roughly one
  // manifest pixel of size per pixel dragged, and a pointer cannot travel far
  // past the frame. An element with no size has nothing to scale.
  resizeSize(startSize, startBoxHeight, dy) {
    if (startBoxHeight <= 0 || startSize <= 0) return startSize;
    const factor = (startBoxHeight + dy) / startBoxHeight;
    return Math.max(Math.min(GEO_MIN_SIZE, startSize), geoRound1(startSize * factor));
  },

  // Guides a drag can lock onto: the canvas edges and centre, plus the edges
  // and centre of every other element's box.
  snapTargets(width, height, boxes) {
    const xs = [0, width / 2, width];
    const ys = [0, height / 2, height];
    for (const b of boxes) {
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    return { xs, ys };
  },

  // Returns the snapped value and the guide it locked onto (null when nothing
  // was near enough), so the caller can draw the guide line it snapped to.
  // Ties (two targets exactly equidistant) resolve to the LAST one in
  // `targets`, deliberately: the loop uses `<=` rather than `<` so a later
  // target overwrites an equally-close earlier one. Harmless in practice
  // (snapTargets rarely produces exact ties), but pinned by a test.
  snap(value, targets, tol) {
    let best = null;
    let bestDistance = tol;
    for (const t of targets) {
      const d = Math.abs(value - t);
      if (d <= bestDistance) { bestDistance = d; best = t; }
    }
    return best === null ? { value, guide: null } : { value: best, guide: best };
  },

  // Title-safe rectangle. 5% is the broadcast convention and is only a guide —
  // nothing in the renderer enforces it.
  safeArea(width, height, inset) {
    const i = inset == null ? 0.05 : inset;
    return { x: width * i, y: height * i, w: width * (1 - 2 * i), h: height * (1 - 2 * i) };
  },

  // render.go coverResize expressed as a SOURCE rectangle, which is what
  // canvas drawImage's 9-argument form wants: scale to fill, crop the overflow
  // centred, never letterbox. render.go resizes to ceil(i*scale) then crops
  // with integer offsets; doing it as a source rect is the same geometry
  // carried out in continuous coordinates, so the two can differ by under a
  // pixel on the crop offset.
  coverRect(iw, ih, tw, th) {
    if (iw <= 0 || ih <= 0) return { sx: 0, sy: 0, sw: 0, sh: 0 };
    const scale = Math.max(tw / iw, th / ih);
    const sw = Math.min(iw, tw / scale);
    const sh = Math.min(ih, th / scale);
    return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh };
  },

  // render.go buildGrid: 2 columns, 2 rows, except exactly two images which
  // share one row; anything past the fourth is dropped. The integer division
  // is render.go's uint(width/cols) — with an odd resolution the last column
  // or row leaves a black strip, and the stage should show that honestly.
  // render.go (buildImageBackground) only takes the grid path when there is
  // MORE than one image; count<=1 falls through to the cover path, so this
  // returns a single full-rect cell to match — not a half-height 2x2 cell
  // the renderer would never draw.
  gridCells(count, width, height) {
    if (count <= 1) return [{ x: 0, y: 0, w: width, h: height }];
    const n = Math.min(count, 4);
    const cols = 2;
    const rows = n === 2 ? 1 : 2;
    const tw = Math.floor(width / cols);
    const th = Math.floor(height / rows);
    const cells = [];
    for (let i = 0; i < n; i++) {
      cells.push({ x: (i % cols) * tw, y: Math.floor(i / cols) * th, w: tw, h: th });
    }
    return cells;
  },

  // render.go dimImage: <=0 is a no-op, >1 clamps to 1. The renderer dims with
  // ModulateImage(brightness), which scales HSL lightness; the stage can only
  // composite black at this alpha, which scales RGB. They agree on greys and
  // diverge slightly on saturated colours — an approximation the UI discloses.
  dimAlpha(amount) {
    const a = Number(amount) || 0;
    return a <= 0 ? 0 : Math.min(a, 1);
  },

  // render.go isTransparent.
  isTransparent(color) {
    const c = String(color || "").trim().toLowerCase();
    return c === "none" || c === "transparent";
  },

  // Pointer position -> manifest pixels. rect is a DOMRect-shaped
  // {left, top, width}; passing it in rather than reading it keeps this pure.
  toManifest(clientX, clientY, rect, width) {
    const scale = rect.width / width;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale, scale };
  },
};

// Browser: a classic script's top-level const is visible to later scripts.
// Node: exported so geometry_test.js can require it. The repo has no
// package.json, so .js here is CommonJS and this guard is all that is needed.
if (typeof module !== "undefined" && module.exports) module.exports = Geometry;
