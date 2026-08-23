// Node check for the file picker (static/pickers.js's fileField/openFilePicker
// half, added in Task 13). Browser scripts with no module system, so they run
// inside a vm context — one shared lexical scope across runInContext calls,
// exactly like classic <script> tags — on a stub DOM just big enough to boot
// them, matching inspector_test.js's convention.
//
//   node internal/webui/filepicker_test.js
//
// What this file checks: what the endpoint's shape turns into (matchingFiles),
// what the degraded states render (filePickerEmptyHTML), what the row/field
// builders escape and preserve verbatim (fileField/filePickerRow), and that
// picking a file writes exactly what the server offered, into exactly the
// field that was opened, and nothing else. What it CANNOT check: that
// showModal() actually opens a native dialog, that Tab cycles inside it, or
// that a real <img>/<audio>/@font-face loads — those are in the human-check
// list in the task report, not here.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const staticDir = path.join(__dirname, "static");

// ---- stub DOM ---------------------------------------------------------------
// Only enough for pickers.js to boot and for openFilePicker() to write
// somewhere readable: a handful of named elements plus a generic fallback.
function makeEl(sel) {
  const el = {
    sel, innerHTML: "", textContent: "", value: "",
    dataset: {}, style: {},
    modalOpen: false,
    showModal() { el.modalOpen = true; },
    close() { el.modalOpen = false; },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return el;
}
const els = new Map();
const document = {
  querySelector(sel) {
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  },
  querySelectorAll: () => [],
  fonts: { add() {} },
};

// fetchQueue lets each test control exactly what /api/files answers next,
// including "the request fails" (apiListFiles's own catch turns that into
// {files: [], roots: []} — the no-media-configured shape files.go also
// answers with, so the two "nothing to browse" causes render identically).
let fetchQueue = [];
function fetchImpl() {
  const next = fetchQueue.shift();
  if (!next) throw new Error("no fetch queued");
  if (next.throw) return Promise.reject(new Error(next.throw));
  return Promise.resolve({ json: async () => next.json });
}

// fontFaceLoads counts every FontFace(...) construction across the whole run
// — the fan-out the bounded-font-previews fix (Task 13 review finding) exists
// to cap. FontFace.load() itself always rejects (no font server in a test),
// which is exactly why the fan-out was invisible before: nothing observed how
// many loads were INITIATED, only whether they succeeded.
let fontFaceLoads = 0;
const ctx = vm.createContext({
  document,
  fetch: (...a) => fetchImpl(...a),
  FontFace: class { constructor() { fontFaceLoads++; } load() { return Promise.reject(new Error("no font server in a test")); } },
  CSS: { escape: (s) => s },
  console,
  confirm: () => true,
});

for (const f of ["util.js", "state.js", "api.js", "pickers.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}

const {
  fileField, fileKindLabel, matchingFiles, filePickerEmptyHTML, filePickerRow,
  openFilePicker, invalidateFileList, esc, setPath,
} = ctx;
// `state`, `actions` and `selection` are top-level `let`/`const`s, so (like
// inspector_test.js) they live in the shared script scope rather than on the
// context's global object — pull them out through a helper defined in-context.
vm.runInContext(`globalThis.__t = { getState: () => state, actions };`, ctx);
const { getState, actions } = ctx.__t;

// ---- assertions --------------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const has = (name, html, needle) => check(name, html.includes(needle), `missing ${JSON.stringify(needle)} in ${html}`);
const not = (name, html, needle) => check(name, !html.includes(needle), `unexpectedly found ${JSON.stringify(needle)} in ${html}`);

// ---- fileKindLabel ------------------------------------------------------
eq("font label", fileKindLabel("font"), "font");
eq("image label", fileKindLabel("image"), "image");
eq("audio label", fileKindLabel("audio"), "audio track");
eq("video label", fileKindLabel("video"), "video");
eq("unknown kind falls back to 'file'", fileKindLabel("subtitle"), "file");

// ---- matchingFiles: what gets listed, filtered by kind ---------------------
const FILES = [
  { path: "media/common/Adult-Swim-Font.ttf", name: "Adult-Swim-Font.ttf", kind: "font", size: 40000 },
  { path: "media/common/plex-as-logo.png", name: "plex-as-logo.png", kind: "image", size: 12000 },
  { path: "media/common/locket-crumb.mp3", name: "locket-crumb.mp3", kind: "audio", size: 900000 },
  { path: "media/common/vano-adult-swim.mp3", name: "vano-adult-swim.mp3", kind: "audio", size: 500000 },
];
eq("filters to just the fonts", matchingFiles(FILES, "font").length, 1);
eq("filters to just the images", matchingFiles(FILES, "image").length, 1);
eq("filters to just the audio tracks", matchingFiles(FILES, "audio").length, 2);
eq("a kind with nothing shipped comes back empty", matchingFiles(FILES, "video").length, 0);
eq("no files at all is still an empty list, never a throw", matchingFiles([], "image").length, 0);
eq("a missing files array degrades to empty, never a throw", matchingFiles(undefined, "image").length, 0);

// ---- filePickerEmptyHTML: the two degraded states --------------------------
const noDirHTML = filePickerEmptyHTML("font", []);
has("no media dir: names -media-dir", noDirHTML, "-media-dir");
has("no media dir: names MEDIA_DIR", noDirHTML, "MEDIA_DIR");
has("no media dir: says the field still accepts typing", noDirHTML, "type the path by hand");

const emptyDirHTML = filePickerEmptyHTML("image", ["media"]);
has("empty dir: names the kind", emptyDirHTML, "No image files found");
has("empty dir: names the root", emptyDirHTML, "media");
not("empty dir message is distinct from the no-dir message", emptyDirHTML, "-media-dir");

// A root name is server-supplied but still untrusted input as far as the
// browser is concerned (Task 6's escaping thread) — it must not break out of
// the paragraph it is rendered into.
const hostileRootHTML = filePickerEmptyHTML("font", ['<img src=x onerror=alert(1)>']);
not("a hostile root name cannot inject a tag", hostileRootHTML, "<img src=x");
has("a hostile root name is escaped, not dropped", hostileRootHTML, esc('<img src=x onerror=alert(1)>'));

// ---- fileField: the text field is the value, always -------------------------
const ff = fileField("Font file", "layouts.main.font", "media/common/Adult-Swim-Font.ttf", "font", "hint text");
has("fileField renders the typed value verbatim", ff, 'value="media/common/Adult-Swim-Font.ttf"');
has("fileField carries the state path on the text input", ff, 'data-path="layouts.main.font"');
has("fileField's Browse button targets the same path", ff, 'data-target="layouts.main.font"');
has("fileField's Browse button carries the kind", ff, 'data-kind="font"');
has("fileField renders its hint", ff, "hint text");
const ffNoHint = fileField("Image file", "scenes.0.file", "x.png", "image");
not("no hint means no <small> at all", ffNoHint, "<small>");

// A path the picker cannot enumerate — outside every media root, or simply
// hand-typed ahead of the file landing on disk — is still a legal DSL value.
// fileField must render it exactly as typed, not blank it or fall back.
const outside = fileField("Font file", "layouts.main.font", "/etc/fonts/Custom.ttf", "font");
has("a path outside any media root still renders, verbatim", outside, 'value="/etc/fonts/Custom.ttf"');

// A value/label/path containing a quote must not break out of its attribute —
// the same threat model as util.js's esc() and the Task 6 dim-range escaping.
const hostile = fileField('Font <script>', 'layouts."weird".font', '"><script>alert(1)</script>', "font");
not("a hostile value cannot break out of the value attribute", hostile, '"><script>alert(1)</script>');
not("a hostile label cannot inject a tag", hostile, "<script>");

// ---- filePickerRow: what each kind previews, and only that -----------------
const imgRow = filePickerRow({ path: "media/common/plex-as-logo.png", name: "plex-as-logo.png", size: 12345 }, "image");
has("image row has a thumbnail", imgRow, '<img class="file-thumb"');
has("image row's thumbnail URL is the raw endpoint, path encoded", imgRow,
  'src="/api/files/raw?path=media%2Fcommon%2Fplex-as-logo.png"');
has("image row shows the size in KB, rounded", imgRow, "12 KB");
has("image row writes the path it will pick", imgRow, 'data-path-value="media/common/plex-as-logo.png"');
not("image row has no font sample", imgRow, "file-sample");
not("image row has no audio player", imgRow, "file-audio");

const fontRow = filePickerRow({ path: "media/common/F.ttf", name: "F.ttf", size: 2048 }, "font");
has("font row samples its own path", fontRow, 'data-font-sample="media/common/F.ttf"');
not("font row has no thumbnail", fontRow, "file-thumb");

const audioRow = filePickerRow({ path: "media/common/t.mp3", name: "t.mp3", size: 4096 }, "audio");
has("audio row has a player", audioRow, "<audio");
has("audio row's player URL is the raw endpoint", audioRow, 'src="/api/files/raw?path=media%2Fcommon%2Ft.mp3"');
not("audio row is not eagerly loaded (preload=none)", audioRow, 'preload="metadata"');
has("audio row defers loading", audioRow, 'preload="none"');

const videoRow = filePickerRow({ path: "media/common/v.mp4", name: "v.mp4", size: 1 }, "video");
not("a kind with no preview renders none — no crash, no placeholder markup", videoRow, "file-thumb");
not("no font sample either", videoRow, "file-sample");
not("no audio player either", videoRow, "file-audio");

// ---- openFilePicker: the DOM glue, exercised end to end ---------------------
// CommonJS has no top-level await, so the async checks below run inside one
// IIFE; process.exit(1) on failure still works from inside it.
async function withPicker(json, fn) {
  invalidateFileList();
  fetchQueue.push({ json });
  await openFilePicker("layouts.main.font", "font");
  return fn();
}

async function main() {

await withPicker({ files: FILES, roots: ["media"] }, () => {
  const body = document.querySelector("#file-picker-body").innerHTML;
  has("open dialog: lists the matching font", body, "Adult-Swim-Font.ttf");
  not("open dialog: does not list a non-matching kind", body, "plex-as-logo.png");
  eq("open dialog: the dialog is actually shown", document.querySelector("#file-picker").modalOpen, true);
  eq("open dialog: the title names the kind", document.querySelector("#file-picker-title").textContent, "Choose a font");
});

await withPicker({ files: [], roots: [] }, () => {
  const body = document.querySelector("#file-picker-body").innerHTML;
  has("degraded (no media dir): shows the no-dir message", body, "No media directory is configured");
});

await withPicker({ files: [{ path: "media/x.png", name: "x.png", kind: "image", size: 1 }], roots: ["media"] }, () => {
  // Asking for fonts when only an image exists is the "configured but empty
  // for this kind" state, distinct from "nothing configured at all".
  const body = document.querySelector("#file-picker-body").innerHTML;
  has("degraded (empty for this kind): names the kind and the root", body, "No font files found under media");
});

// Font previews have no browser-native throttle to fall back on (unlike the
// image row's loading="lazy" and the audio row's preload="none" checked
// above): opening the dialog on a directory of many fonts must not fire one
// concurrent FontFace fetch per font. This is what slipped through review —
// FontFace.load() rejects in this harness either way, so only counting
// CONSTRUCTIONS (not successes) makes the fan-out visible at all.
{
  const manyFonts = Array.from({ length: 50 }, (_, i) => (
    { path: `media/common/font-${i}.ttf`, name: `font-${i}.ttf`, kind: "font", size: 1000 }
  ));
  invalidateFileList();
  fetchQueue.push({ json: { files: manyFonts, roots: ["media"] } });
  fontFaceLoads = 0;
  await openFilePicker("layouts.main.font", "font");
  check("font previews are bounded: a 50-font directory does not fire 50 concurrent loads",
    fontFaceLoads > 0 && fontFaceLoads < 50, `fired ${fontFaceLoads} loads for 50 fonts`);

  // The bound must not scale with N — reopening on an even bigger directory
  // fires the same (small) number of loads, not more.
  const moreFonts = Array.from({ length: 200 }, (_, i) => (
    { path: `media/common/many-${i}.ttf`, name: `many-${i}.ttf`, kind: "font", size: 1000 }
  ));
  invalidateFileList();
  fetchQueue.push({ json: { files: moreFonts, roots: ["media"] } });
  const capAt50 = fontFaceLoads;
  fontFaceLoads = 0;
  await openFilePicker("layouts.main.font", "font");
  eq("the cap does not grow with the directory size (200 fonts fires the same count as 50)",
    fontFaceLoads, capAt50);

  // ...and the rows that are NOT previews say so. Every row shows the same
  // sample text, so without this a capped row is indistinguishable from a
  // font that really does look like the browser's default sans.
  check("past the cap, the list discloses which rows are not real previews",
    document.querySelector("#file-picker-body").innerHTML.includes("Only the first 24 of 200 fonts"),
    document.querySelector("#file-picker-body").innerHTML.slice(-300));

  // Below the cap, every font is still previewed — this is a bound, not a
  // near-total disabling of the feature.
  const fewFonts = Array.from({ length: 3 }, (_, i) => (
    { path: `media/common/few-${i}.ttf`, name: `few-${i}.ttf`, kind: "font", size: 1000 }
  ));
  invalidateFileList();
  fetchQueue.push({ json: { files: fewFonts, roots: ["media"] } });
  fontFaceLoads = 0;
  await openFilePicker("layouts.main.font", "font");
  eq("below the cap, every font is still previewed", fontFaceLoads, 3);
  not("...and there is nothing to disclose when nothing was capped",
    document.querySelector("#file-picker-body").innerHTML, "Only the first");
}

// A network failure must degrade exactly like an empty response — the picker
// never throws into the caller, and the text field is left untouched either
// way (that assertion is in the pick-file block below).
invalidateFileList();
fetchQueue.push({ throw: "network down" });
await openFilePicker("layouts.main.font", "font");
has("a fetch failure degrades to the no-media-dir message, not a crash",
  document.querySelector("#file-picker-body").innerHTML, "No media directory is configured");

// ---- pick-file: writes exactly what was offered, into exactly that field ---
{
  vm.runInContext(`state = normalize({ layouts: { main: { font: "old.ttf", background: {}, elements: [] } } });`, ctx);
  invalidateFileList();
  fetchQueue.push({ json: { files: FILES, roots: ["media"] } });
  await openFilePicker("layouts.main.font", "font");
  actions["pick-file"]({ pathValue: "media/common/Adult-Swim-Font.ttf" });
  eq("pick-file writes the server-offered path into the target field",
    getState().layouts.main.font, "media/common/Adult-Swim-Font.ttf");
  eq("pick-file closes the dialog", document.querySelector("#file-picker").modalOpen, false);

  // Reopening for a DIFFERENT field and picking must never touch the first
  // one — filePickerTarget is the one thing standing between "browsing
  // clobbers whatever was open last" and correctness.
  vm.runInContext(`state.scenes = [{ kind: "image", file: "old.png" }];`, ctx);
  fetchQueue.push({ json: { files: FILES, roots: ["media"] } });
  await openFilePicker("scenes.0.file", "image");
  actions["pick-file"]({ pathValue: "media/common/plex-as-logo.png" });
  eq("picking into the second field lands in the second field",
    getState().scenes[0].file, "media/common/plex-as-logo.png");
  eq("...and leaves the first field's earlier pick alone",
    getState().layouts.main.font, "media/common/Adult-Swim-Font.ttf");
}

// pick-file with nothing open (stale click, or the guard itself) must not
// throw and must not write anywhere.
{
  const before = JSON.stringify(getState());
  actions["pick-file"]({ pathValue: "media/common/plex-as-logo.png" });
  eq("pick-file with no open target is a no-op", JSON.stringify(getState()), before);
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("filepicker.js checks passed");

}

main().catch((err) => { console.error(err); process.exit(1); });
