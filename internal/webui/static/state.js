"use strict";
// state.js — the manifest as a mutable plain object shaped exactly like the
// DSL's JSON form, plus the operations that keep it internally consistent
// (renames retarget every reference), plus `selection` and the two EMPTY
// view-wiring registries (`actions`, `rerenderHooks`).
//
// It knows the DSL and it never draws, but it is not innocent of the views:
// the registries below exist for view files to fill in, and they live here
// only because every view file loads after state.js and before app.js, which
// is what dispatches through them. Naming that here rather than claiming this
// file "knows nothing about how any of it is drawn", which it no longer does.

function emptyManifest() {
  return {
    name: "",
    resolution: "1920x1080",
    fps: 24,
    output: "",
    length: 0,
    audio: { file: "", mode: "soundtrack", start: 0, fadeOut: null },
    data: {},
    layouts: {},
    scenes: [],
  };
}
let state = emptyManifest();

// Selection: what the inspector is currently describing. sceneIndex is the
// scene the stage draws; element is an index into that scene's layout's
// elements, or null when the scene itself is selected.
let selection = { sceneIndex: 0, element: null, dataSource: null };

// Set by app.js during boot. Mutators here call these instead of naming a
// renderer, so state.js has no dependency on the views. onStateChange means
// "the manifest changed" (redraw and re-validate); onRerender means "only the
// form drifted from the state" (redraw, nothing to re-validate).
let onStateChange = () => {};
let onRerender = () => {};
function setStateChangeHandler(change, rerender) {
  onStateChange = change;
  onRerender = rerender;
}

// The server omits empty fields (omitempty), so rebuild the containers the
// renderers index into.
function normalize(m) {
  const base = emptyManifest();
  const out = { ...base, ...m };
  out.audio = { ...base.audio, ...(m.audio || {}) };
  out.data = m.data || {};
  out.layouts = m.layouts || {};
  out.scenes = m.scenes || [];
  for (const ds of Object.values(out.data)) ds.params = ds.params || {};
  for (const l of Object.values(out.layouts)) {
    l.background = l.background || { color: "", image: "" };
    l.elements = l.elements || [];
  }
  return out;
}

// dottedKey finds the first key in a manifest that this editor cannot address,
// or "" when there is none. Every input is bound by a dot-separated data-path
// string ("data.top.params.limit"), so a key that itself contains a dot —
// data["top.movies"], a dotted layout name, scene var or provider param — is
// walked as two steps that do not exist: the edit misses, and getPath/setPath
// find nothing there. renameKey already refuses to CREATE such a key; this
// refuses to OPEN one that arrived from disk, which is the only other way in.
//
// ponytail: reject at load rather than escape. The alternative is an escaping
// scheme threaded through every data-path producer (textInput/numInput/select/
// the rename inputs/pickers.js) and through getPath/setPath's splitter — a
// disproportionate change for something none of the shipped manifests does. If
// dotted names ever become a real use case, that is the upgrade path.
function dottedKey(m) {
  for (const [name, ds] of Object.entries(m.data || {})) {
    if (name.includes(".")) return `the data source "${name}"`;
    for (const p of Object.keys(ds?.params || {}))
      if (p.includes(".")) return `the parameter "${p}" of data source "${name}"`;
  }
  for (const name of Object.keys(m.layouts || {}))
    if (name.includes(".")) return `the layout "${name}"`;
  for (const [i, sc] of (m.scenes || []).entries())
    for (const v of Object.keys(sc?.vars || {}))
      if (v.includes(".")) return `the variable "${v}" of scene ${i + 1}`;
  return "";
}

// replaceState swaps the whole manifest and resets the selection, which would
// otherwise point at a scene or element the new manifest does not have.
// Returns false — leaving the editor exactly as it was — when the manifest
// carries a key this editor cannot address; the caller must not proceed as if
// it had loaded. Saying so up front is the honest failure: the alternative is
// opening the file and losing the first edit to one of those keys.
function replaceState(m) {
  const bad = dottedKey(m);
  if (bad) {
    flash(`Can't open this manifest: ${bad} contains a dot, which this editor can't address. Rename it in the YAML first.`, true);
    return false;
  }
  state = normalize(m);
  selection = { sceneIndex: 0, element: null, dataSource: null };
  return true;
}

function deriveOutput(name) {
  return name ? `output/${name}.mp4` : "";
}

function defaultParams(provider) {
  const params = {};
  for (const [key, p] of Object.entries(PROVIDERS[provider].params))
    if (p.default) params[key] = p.default;
  return params;
}

function sceneDefaults(kind) {
  const first = (map) => Object.keys(map)[0] || "";
  return {
    image:  { kind: "image", file: "", duration: 4 },
    render: { kind: "render", layout: first(state.layouts), duration: 6, vars: {}, background: null },
    clips:  { kind: "clips", source: first(state.data), perClip: 4, label: "" },
  }[kind];
}

// ---- key renames (data sources, layouts, param/var maps) -------------------
function renameKey(mapPath, oldKey, newKey) {
  const map = getPath(state, mapPath);
  // Dots are the separator in the data-path strings every input is addressed
  // by, so a dotted key would make every later edit miss or land elsewhere.
  const reject = !newKey ? "A name can't be empty"
    : newKey.includes(".") ? "A name can't contain a dot"
    : map[newKey] !== undefined ? `${newKey} is already taken` : "";
  if (reject) {
    onRerender(); // restore the old name in the input
    flash(`${reject} — kept "${oldKey}"`, true);
    return;
  }
  if (newKey === oldKey) return;
  const rebuilt = {};
  for (const [k, v] of Object.entries(map)) rebuilt[k === oldKey ? newKey : k] = v;
  setPath(state, mapPath, rebuilt);
  if (mapPath === "data") retargetSource(oldKey, newKey);
  if (mapPath === "layouts") retargetLayout(oldKey, newKey);
  onStateChange();
}
// Renaming a data source or layout fixes every reference to it, so a rename
// never silently dangles.
function retargetSource(oldKey, newKey) {
  for (const sc of state.scenes) {
    if (sc.source === oldKey) sc.source = newKey;
    if (sc.background && sc.background.source === oldKey) sc.background.source = newKey;
  }
  for (const layout of Object.values(state.layouts))
    for (const el of layout.elements || [])
      if (el.source === oldKey) el.source = newKey;
}
function retargetLayout(oldKey, newKey) {
  for (const sc of state.scenes) {
    if (sc.layout === oldKey) sc.layout = newKey;
    if (sc.label === oldKey) sc.label = newKey;
  }
}

// Registries the view files populate: actions["add-data"] = (dataset) => {...}
// for [data-action] clicks, and rerenderHooks for selects that change the
// form's shape (declared with data-rerender="<hook>").
const actions = {};
const rerenderHooks = {};

// ---- what the stage is looking at ------------------------------------------
// currentScene and currentLayout are the two lookups every view needs, and
// both must tolerate a selection that has gone stale (a deleted scene, a
// renamed layout) by returning null rather than throwing mid-render.
function currentScene() {
  return state.scenes[selection.sceneIndex] || null;
}
// A clips scene draws no layout of its own; its label layout is what the stage
// previews, since that is the only thing the user positions.
function currentLayoutName() {
  const sc = currentScene();
  if (!sc) return "";
  return (sc.kind === "clips" ? sc.label : sc.layout) || "";
}
function currentLayout() {
  return state.layouts[currentLayoutName()] || null;
}

// The manifest's pixel space, which is what geometry.js and the stage draw in.
// A half-typed resolution must not collapse the stage; 1920x1080 is the DSL's
// own default and the only sane thing to draw against.
function manifestDimensions() {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(state.resolution || ""));
  if (!m) return { width: 1920, height: 1080 };
  return { width: parseInt(m[1], 10) || 1920, height: parseInt(m[2], 10) || 1080 };
}

// renderAll repaints every view. state.js owns it because state.js is what
// calls onStateChange, and every view file is loaded before app.js boots.
// Moved here from the retired sections.js, whose own renderAll() also
// repainted its three phase-1 cards — those are gone, so only the rail, the
// stage and the inspector remain.
function renderAll() {
  renderTimeline();
  renderStage();
  renderInspector();
}
