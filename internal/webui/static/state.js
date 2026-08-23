"use strict";
// state.js — the manifest as a mutable plain object shaped exactly like the
// DSL's JSON form, plus the operations that keep it internally consistent
// (renames retarget every reference). This file knows the DSL; it knows
// nothing about how any of it is drawn.

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

// replaceState swaps the whole manifest and resets the selection, which would
// otherwise point at a scene or element the new manifest does not have.
function replaceState(m) {
  state = normalize(m);
  selection = { sceneIndex: 0, element: null, dataSource: null };
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
