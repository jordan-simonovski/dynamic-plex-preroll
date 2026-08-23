"use strict";
// stage.js — the live 16:9 preview. It draws the selected scene into a canvas
// using the SAME rules internal/render/render.go uses, so what the user lays
// out is where the renderer puts it.
//
// All maths lives in geometry.js; this file owns only the canvas, the fonts,
// the images and the data. That division is why the hard part is testable in
// Node: everything here needs a browser, and nothing here does arithmetic
// geometry.js could have done. The few decisions that are neither (the scaling
// model, template substitution, what the note says) are pure functions with a
// test in internal/webui/stage_test.js.

// ---- data ------------------------------------------------------------------
// stageData mirrors /api/data/resolve's reply exactly:
//   { vars: {Period: "Month", ...}, sources: { "<name>": { items, error } } }
// It stays empty until Task 7 fills it, and every reader falls back to
// placeholders — which is what keeps the editor usable with no Plex at all.
let stageData = { vars: {}, sources: {} };
function setStageData(resolved) {
  stageData = {
    vars: (resolved && resolved.vars) || {},
    sources: (resolved && resolved.sources) || {},
  };
}

// refreshStageData asks the server to run every data source and redraws with
// what came back. It is debounced hard (2s) because each call hits Plex for
// real: the stage is allowed to lag the form, but it must never hammer the
// server on every keystroke.
//
// Deviation from the Task 7 brief: the brief's snippet wrote into a
// `stageSources` global with a `.__vars` key stitched in, which predates the
// {vars, sources} setStageData() above (a Task 6 review fix). apiResolveData's
// reply is already shaped exactly like setStageData's argument, so it is
// passed straight through.
let stageDataReason = "";
async function refreshStageDataNow() {
  if (!Object.keys(state.data).length) {
    setStageData({});
    renderStage();
    return;
  }
  const out = await apiResolveData(state.data);
  setStageData(out);
  stageDataReason = out.configured ? "" : (out.reason || "Plex is not configured — showing placeholder data.");
  renderStage();
}
const refreshStageData = debounce(refreshStageDataNow, 2000);

// PLACEHOLDER_ITEMS stand in when a source has not been (or cannot be)
// resolved. They are deliberately realistic — varied lengths, plausible view
// counts — because a preview made of "Item 1 / Item 2" hides exactly the
// layout problems the stage exists to reveal. The shape is data.go's
// previewItem, so real and placeholder items are interchangeable.
const PLACEHOLDER_ITEMS = [
  { rank: 1, name: "The Grand Budapest Hotel", views: 42, hasMedia: true },
  { rank: 2, name: "Arrival", views: 31, hasMedia: true },
  { rank: 3, name: "Dune: Part Two", views: 27, hasMedia: true },
  { rank: 4, name: "Everything Everywhere All at Once", views: 19, hasMedia: true },
  { rank: 5, name: "Paddington 2", views: 12, hasMedia: true },
];

function stageResolved(sourceName) {
  const r = stageData.sources[sourceName];
  return r && r.items && r.items.length ? r : null;
}
function stageItems(sourceName) {
  const r = stageResolved(sourceName);
  return r ? r.items : PLACEHOLDER_ITEMS;
}

function stageDimensions() { return manifestDimensions(); }

// ---- template rendering (approximate, on purpose) --------------------------
// The real renderer runs Go text/template. Reimplementing that in the browser
// would be a second, divergent implementation of a thing the server already
// does correctly. Instead the stage substitutes the variables it knows and
// leaves anything else visible as its own source text, so the user can SEE an
// unresolved expression rather than a silent blank.
const STAGE_DEFAULT_VARS = {
  Period: "Month", PeriodInterval: "MONTH",
  MovieSectionId: "1", TVShowSectionId: "2", MaxItems: "5",
};

// stageVars is the context a TEXT element sees: engine.go's sceneContext —
// globals plus the scene's own vars. A clips scene's label layout additionally
// sees the current item (engine.go itemVars), and the stage previews item 1.
function stageVars(scene) {
  const vars = { ...STAGE_DEFAULT_VARS, ...stageData.vars };
  if (scene && scene.kind === "clips") {
    Object.assign(vars, itemVars(stageItems(scene.source)[0]));
  } else {
    // engine.go's sceneContext (engine.go:339-348) overlays Scene.Vars only
    // for a render scene; a clips label's context is itemVars alone
    // (engine.go:210) — Scene.Vars never reaches it. Applying it to a clips
    // scene here would draw text the real render never does (review fix M2).
    for (const [k, v] of Object.entries((scene && scene.vars) || {})) vars[k] = v;
  }
  return vars;
}
// render.go itemContext: a LIST element's item template sees the item and
// nothing else — no globals, no scene vars. Mirrored rather than smoothed over,
// so `{{ .Period }}` inside a list item shows up unresolved here exactly as it
// would fail in the renderer.
//
// render.go:294-303 and engine.go:229-236 also put RatingKey and MediaURL in
// scope. The resolve endpoint deliberately sends neither to the browser:
// RatingKey was never added to data.go's previewItem, and MediaURL would put
// a Plex-token-bearing URL into page JS. So a template using either stays an
// unresolved literal on the stage; stageHasItemFieldGap below decides when to
// say so in the note (review fix M1).
function itemVars(item) {
  const it = item || {};
  return { Rank: it.rank, Name: it.name, Views: it.views };
}

const TRUNCATE_RE = /\{\{\s*truncate\s+(\d+)\s+\.(\w+)\s*\}\}/g;
const PLURALIZE_RE = /\{\{\s*pluralize\s+\.(\w+)\s+"([^"]*)"\s+"([^"]*)"\s*\}\}/g;
const FUNC_RE = /\{\{\s*(upper|lower|title)\s+\.(\w+)\s*\}\}/g;
const VAR_RE = /\{\{\s*\.(\w+)\s*\}\}/g;

function stageTemplate(text, vars) {
  const get = (name) => (vars[name] === undefined ? null : String(vars[name]));
  return String(text ?? "")
    .replace(TRUNCATE_RE, (m, n, name) => {
      const v = get(name);
      if (v === null) return m;
      const max = parseInt(n, 10);
      return v.length <= max ? v : v.slice(0, Math.max(0, max - 1)) + "…";
    })
    .replace(PLURALIZE_RE, (m, name, one, many) => {
      const v = get(name);
      return v === null ? m : (Number(v) === 1 ? one : many);
    })
    .replace(FUNC_RE, (m, fn, name) => {
      const v = get(name);
      if (v === null) return m;
      if (fn === "upper") return v.toUpperCase();
      if (fn === "lower") return v.toLowerCase();
      return v.replace(/\b\w/g, (c) => c.toUpperCase());
    })
    .replace(VAR_RE, (m, name) => {
      const v = get(name);
      return v === null ? m : v;
    });
}

// stageLines returns exactly the strings an element will draw, in order: one
// per newline for a text element, one per data item for a list. Tasks 7-9 hit
// this same function for measuring and hit-testing, so what is drawn and what
// is selectable can never drift apart.
function stageLines(el, scene) {
  if (el.type === "list") {
    return stageItems(el.source).map((item) => stageTemplate(el.item, itemVars(item)));
  }
  return stageTemplate(el.text, stageVars(scene)).split("\n");
}

// ---- fonts -----------------------------------------------------------------
// A layout names a font FILE. The browser can only use it through @font-face,
// so each distinct path gets a generated family loaded from /api/files/raw. If
// it will not load (no media dir, wrong path), the stage falls back to a
// generic sans and SAYS SO in the note under the canvas — silently swapping
// metrics would make the preview quietly wrong.
const loadedFonts = new Map(); // path -> { family, ok }
let fontWarning = "";

function stageFontFamily(path) {
  if (!path) {
    fontWarning = "This layout has no font set — the preview uses a system sans-serif.";
    return "sans-serif";
  }
  const entry = loadedFonts.get(path);
  if (entry) {
    if (!entry.ok) fontWarning = `Could not load ${path} — the preview uses a system sans-serif, so text width is approximate.`;
    return entry.ok ? entry.family : "sans-serif";
  }
  const family = `prerollfont${loadedFonts.size}`;
  loadedFonts.set(path, { family, ok: false });
  const face = new FontFace(family, `url("/api/files/raw?path=${encodeURIComponent(path)}")`);
  face.load().then((loaded) => {
    document.fonts.add(loaded);
    loadedFonts.set(path, { family, ok: true });
    renderStage();
  }).catch(() => {
    loadedFonts.set(path, { family, ok: false });
    renderStage();
  });
  return "sans-serif";
}

// A quoted "sans-serif" would name a family nothing has, so the generic case
// is spelled without quotes. No clamping: a layout that asks for size 700 is
// drawn at 700, because the renderer has no size limit either.
function stageFontSpec(size, family) {
  return family === "sans-serif" ? `${size}px sans-serif` : `${size}px "${family}", sans-serif`;
}

// ---- measurement -----------------------------------------------------------
// The measure callback geometry.js consumes. Ascent/descent come from the real
// font metrics when the browser reports them, falling back to the 0.8/0.2 em
// split that matches most Latin faces closely enough for a selection box.
function stageMeasure(ctx, size) {
  return (text) => {
    const m = ctx.measureText(text);
    return {
      width: m.width,
      ascent: m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || size * 0.8,
      descent: m.actualBoundingBoxDescent || m.fontBoundingBoxDescent || size * 0.2,
    };
  };
}

// ---- the scaling model -----------------------------------------------------
// The canvas is sized from its container, but every draw call below is issued
// in MANIFEST pixels — the same numbers the DSL holds and geometry.js returns —
// by scaling the context once. The backing store is kept at device resolution
// so text is not blurry, and its height is derived from the same scale as its
// width so the drawn frame fills it exactly rather than missing by a rounding.
function stageCanvasSize(frameWidth, dims, dpr) {
  const width = dims.width > 0 ? dims.width : 1920;
  const height = dims.height > 0 ? dims.height : 1080;
  const ratio = dpr > 0 ? dpr : 1;
  const cssWidth = Math.max(1, Math.round(frameWidth > 0 ? frameWidth : 0));
  const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
  const scale = pixelWidth / width;
  const pixelHeight = Math.max(1, Math.round(height * scale));
  return { cssWidth, cssHeight: pixelHeight / ratio, pixelWidth, pixelHeight, scale };
}

// ---- draw ------------------------------------------------------------------
function renderStage() {
  const canvas = $("#stage");
  const frame = $("#stage-frame");
  if (!canvas || !frame) return;
  const dims = stageDimensions();
  const size = stageCanvasSize(frame.clientWidth, dims, window.devicePixelRatio);
  canvas.width = size.pixelWidth;
  canvas.height = size.pixelHeight;
  canvas.style.width = size.cssWidth + "px";
  canvas.style.height = size.cssHeight + "px";

  const ctx = canvas.getContext("2d");
  ctx.setTransform(size.scale, 0, 0, size.scale, 0, 0);
  ctx.clearRect(0, 0, dims.width, dims.height);

  fontWarning = "";
  backgroundImageNote = "";
  const scene = currentScene();
  const layout = currentLayout();
  drawScene(ctx, scene, layout, dims.width, dims.height);
  if ($("#toggle-safe")?.checked) drawSafeArea(ctx, dims.width, dims.height);

  updateStageChrome(scene, layout);
}

// Draw order is render.go's: the background is built first and the elements are
// drawn over it in array order, so the last element in the list is on top.
function drawScene(ctx, scene, layout, width, height) {
  drawBackground(ctx, scene, layout, width, height);
  if (!layout) return;
  const family = stageFontFamily(layout.font);
  for (const el of layout.elements || []) drawElement(ctx, el, scene, family);
}

// render.go: a scene background REPLACES the layout's own background — Layout()
// takes the resolved-background branch or the layout.Background branch, never
// both. Getting that wrong would show a colour behind art the renderer never
// draws.
function drawBackground(ctx, scene, layout, width, height) {
  drawCheckerboard(ctx, width, height); // shows through anything transparent

  const bg = scene && scene.background;
  if (bg && bg.source) {
    drawSceneBackground(ctx, bg, width, height);
    return;
  }
  if (!layout) return;
  const lbg = layout.background || {};
  if (lbg.image) {
    // The renderer reads this image as the canvas itself and ffmpeg then
    // scales it to the output resolution with `scale=W:H` — a stretch, not a
    // crop — so the stage stretches it too.
    drawImagePath(ctx, lbg.image, 0, 0, width, height);
    return;
  }
  if (Geometry.isTransparent(lbg.color)) return; // stays transparent for an overlay
  ctx.fillStyle = safeColor(lbg.color, Geometry.DEFAULT_BG_COLOR);
  ctx.fillRect(0, 0, width, height);
}

// manifest.go's (*SceneBackground).IsImage() is false for an unset Mode, so
// an unset mode is a TRAILER MONTAGE, not art (review fix M4) — the label text
// and the art/thumb key choice below both need to agree with that, not with
// `mode || "art"`.
function sceneBgEffectiveMode(mode) {
  return mode === "art" || mode === "poster" ? mode : "trailers";
}

// drawSceneBackground mirrors engine.go + render.go: take up to `limit` items
// whose art/poster is actually set, lay them out cover or grid, then dim.
//
// Two honest approximations, both disclosed in the note under the canvas: a
// trailers-mode (or unset-mode, M4) background is a real montage of trailer
// VIDEO in the render but only the items' posters here; and render.go dims
// with ImageMagick's ModulateImage (a brightness scale) where the stage uses
// a black overlay — close, not equal.
function drawSceneBackground(ctx, bg, width, height) {
  const items = stageItems(bg.source);
  const limit = bg.limit > 0 ? bg.limit : 4; // engine.go: defaultBackgroundLimit
  const mode = sceneBgEffectiveMode(bg.mode);
  const key = mode === "art" ? "art" : "thumb"; // engine.go's imageURLs
  const urls = [];
  for (const item of items) {
    // No art->thumb fallback: engine.go's imageURLs skips an item outright
    // when the chosen field is empty rather than trying the other one, and
    // the cell count below must match what it actually keeps (review fix M6).
    const u = item[key];
    if (u) urls.push(u);
    if (urls.length >= limit) break;
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  if (!urls.length) {
    ctx.fillStyle = "#20242c";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#4a5164";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = stageFontSpec(Math.round(height / 28), "sans-serif");
    ctx.fillText(`${mode} from ${bg.source}`, width / 2, height / 2);
  } else {
    // engine.go's backgroundTile defaults an unset tile to grid; render.go
    // only takes the grid path with MORE than one image, else it covers with
    // the first image alone. The cell count therefore follows the RESOLVED,
    // usable image count (urls.length), never the configured limit (M6).
    const tile = bg.tile || "grid";
    // gridCells(1) is the full frame, which is exactly the cover case — so
    // even the non-grid path goes through geometry.js rather than hand-coding
    // the same rect here.
    const cells = Geometry.gridCells(tile === "grid" && urls.length > 1 ? urls.length : 1, width, height);
    for (let i = 0; i < cells.length; i++) drawImageURL(ctx, urls[i], cells[i]);
  }

  const dim = Geometry.dimAlpha(bg.dim);
  if (dim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${dim})`;
    ctx.fillRect(0, 0, width, height);
  }
}

// Artwork arrives as a same-origin proxy URL from /api/data/resolve (see
// data.go's proxyImage), so it is loaded directly rather than through
// /api/files/raw.
function drawImageURL(ctx, url, cell) {
  const img = loadImage(url);
  if (!img) {
    ctx.fillStyle = "#1b1f26";
    ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
    return;
  }
  const r = Geometry.coverRect(img.naturalWidth, img.naturalHeight, cell.w, cell.h);
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, cell.x, cell.y, cell.w, cell.h);
}

// A faint checkerboard under everything, so "background: none" reads as
// transparent instead of as black — that distinction decides whether a clip
// label works at all.
function drawCheckerboard(ctx, width, height) {
  const cell = Math.max(1, Math.round(width / 48));
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? "#15181d" : "#1b1f26";
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

const imageCache = new Map(); // url -> HTMLImageElement | "failed"
function loadImage(url) {
  const cached = imageCache.get(url);
  if (cached === "failed") return null;
  if (cached) return cached.complete && cached.naturalWidth ? cached : null;
  const img = new Image();
  img.onload = () => renderStage();
  img.onerror = () => { imageCache.set(url, "failed"); renderStage(); };
  img.src = url;
  imageCache.set(url, img);
  return null; // a fresh Image is never ready synchronously; onload redraws
}

// backgroundImageNote discloses I1: render.go:71-77 reads a layout background
// image at its NATIVE size and draws element text at DSL coordinates directly
// onto it; only pipeline.go:44's ffmpeg `scale=W:H` stretches the whole frame
// to the manifest resolution afterwards. The stage instead stretches the
// image to the manifest frame up front and draws text in manifest space —
// the same final pixels UNLESS the image's native size differs from the
// manifest resolution, in which case every element is off by that ratio.
// Reset once per renderStage() call, like fontWarning.
let backgroundImageNote = "";

function drawImagePath(ctx, path, x, y, w, h) {
  const img = loadImage(`/api/files/raw?path=${encodeURIComponent(path)}`);
  if (!img) {
    ctx.fillStyle = "#1b1f26";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (img.naturalWidth > 0 && img.naturalHeight > 0 && (img.naturalWidth !== w || img.naturalHeight !== h)) {
    backgroundImageNote = `The background image is ${img.naturalWidth}×${img.naturalHeight}, not the manifest's ${w}×${h} — the render positions text in the image's pixels, so it will land slightly differently there than shown here.`;
  }
  ctx.drawImage(img, x, y, w, h);
}

function drawElement(ctx, el, scene, family) {
  ctx.font = stageFontSpec(el.size || 0, family);
  ctx.fillStyle = safeColor(el.color, Geometry.DEFAULT_TEXT_COLOR);
  ctx.textAlign = Geometry.align(el);
  ctx.textBaseline = "alphabetic"; // matches dw.Annotation's baseline origin
  const lines = stageLines(el, scene);
  const baselines = el.type === "list"
    ? Geometry.listBaselines(el, lines.length)
    : Geometry.textBaselines(el, lines.length);
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], el.x || 0, baselines[i]);
}

// safeColor keeps an in-progress colour ("#ff", "reddd") from silently
// painting the previous element's colour: canvas ignores an invalid fillStyle
// assignment, so it is validated against a probe context before use.
let colorProbe = null;
function safeColor(value, fallback) {
  const v = String(value ?? "").trim();
  if (v === "" || Geometry.isTransparent(v)) return fallback;
  if (!colorProbe) colorProbe = document.createElement("canvas").getContext("2d");
  colorProbe.fillStyle = "#000000";
  colorProbe.fillStyle = v;
  const first = colorProbe.fillStyle;
  colorProbe.fillStyle = "#ffffff";
  colorProbe.fillStyle = v;
  // An invalid value leaves fillStyle at whatever it was, so two different
  // seeds landing on different results means the value was rejected.
  return first === colorProbe.fillStyle ? v : fallback;
}

function drawSafeArea(ctx, width, height) {
  const s = Geometry.safeArea(width, height);
  ctx.save();
  ctx.strokeStyle = "rgba(229,160,13,0.6)";
  ctx.setLineDash([12, 12]);
  ctx.lineWidth = 2;
  ctx.strokeRect(s.x, s.y, s.w, s.h);
  ctx.restore();
}

// ---- chrome ----------------------------------------------------------------
function stageLabelText(scene, index, layoutName) {
  if (!scene) return "No scenes yet";
  return `Scene ${index + 1} · ${scene.kind}` + (layoutName ? ` · ${layoutName}` : "");
}

// The honest note under the canvas: what is approximate, and why. Pure so the
// wording is pinned by a test rather than by squinting at a screenshot.
function stageNotes(scene, layout, layoutName, warning) {
  if (!scene) return "Add a scene to start.";
  const notes = [];
  if (scene.kind === "image") notes.push("A still-image scene is played as-is; there is nothing to lay out.");
  if (scene.kind === "clips" && !scene.label) notes.push("A clip montage with no label layout draws no text.");
  if (scene.kind === "render" && !layout) {
    notes.push(layoutName ? `This scene names the layout "${layoutName}", which does not exist.`
      : "This scene has no layout selected.");
  }
  if (layout && stagePlaceholderSources(scene, layout).length) {
    notes.push(`Placeholder data for ${stagePlaceholderSources(scene, layout).join(", ")}.`);
  }
  if (layout && stageHasItemFieldGap(scene, layout)) {
    notes.push("RatingKey and MediaURL aren't sent to the browser (MediaURL carries a Plex token) — templates using them are shown unresolved here but resolve in the real render.");
  }
  if (warning) notes.push(warning);
  return notes.join(" ");
}

// Which of the sources this scene actually draws are still placeholders — the
// list the note names, so "that isn't my library" is never a mystery.
function stagePlaceholderSources(scene, layout) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n) && !stageResolved(n)) names.push(n); };
  if (scene && scene.background) add(scene.background.source);
  if (scene && scene.kind === "clips") add(scene.source);
  for (const el of (layout && layout.elements) || []) if (el.type === "list") add(el.source);
  return names;
}

// stageHasItemFieldGap backs the itemVars/M1 disclosure above: true when a
// template this scene actually draws references a field the stage cannot
// honestly fill in. Every list element sees RatingKey/MediaURL in the real
// render (render.go:294-303); a clips scene's label folds the same fields
// into its text elements too (engine.go:229-236, stage.js's stageVars).
const ITEM_FIELD_GAP_RE = /\{\{\s*\.(RatingKey|MediaURL)\b/;
function stageHasItemFieldGap(scene, layout) {
  const uses = (s) => ITEM_FIELD_GAP_RE.test(s || "");
  for (const el of (layout && layout.elements) || []) {
    if (el.type === "list" && uses(el.item)) return true;
    if (el.type === "text" && scene && scene.kind === "clips" && uses(el.text)) return true;
  }
  return false;
}

// updateStageChrome is the impure half of the note: it gathers everything
// that can only be known from mutable page state (the last resolve's
// reason/errors, whether a font or a background image is misbehaving, the
// scene-background approximations) into one string and hands it to the pure
// stageNotes() as its `warning`, so ordering and joining stay pinned by that
// function's own tests.
function updateStageChrome(scene, layout) {
  const label = $("#stage-label");
  const note = $("#stage-note");
  if (label) label.textContent = stageLabelText(scene, selection.sceneIndex, currentLayoutName());
  if (!note) return;

  const extra = [];
  if (stageDataReason) extra.push(stageDataReason);
  for (const [name, src] of Object.entries(stageData.sources)) {
    if (src && src.error) extra.push(`${name}: ${src.error}`);
  }
  const bg = scene && scene.background;
  if (bg && bg.source) {
    if (sceneBgEffectiveMode(bg.mode) === "trailers") {
      extra.push("The render plays a muted trailer montage here; the preview shows the same items' posters.");
    }
    if (bg.dim > 0) {
      extra.push("Dimming is approximated with a black overlay; the render uses a brightness scale.");
    }
  }
  if (fontWarning) extra.push(fontWarning);
  if (backgroundImageNote) extra.push(backgroundImageNote);

  note.textContent = stageNotes(scene, layout, currentLayoutName(), extra.join(" "));
}

// The stage is sized from its container, so a window resize must redraw it.
window.addEventListener("resize", debounce(renderStage, 100));
