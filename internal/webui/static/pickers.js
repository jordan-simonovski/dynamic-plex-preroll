"use strict";
// pickers.js — the colour picker: a text field (the value), a native
// <input type="color"> and a swatch, offered alongside each other.
//
// The rule this control follows: the TEXT FIELD is the value. A picker only
// ever writes into it, so nothing the DSL accepts can be lost by opening one.
// render.go resolves a colour string itself (ImageMagick's PixelWand), and
// accepts far more than the 7-character #rrggbb a native colour input can
// hold — named colours, short hex, rgba(), and "none"/"transparent" for no
// fill at all (see render.go's isTransparent, mirrored in geometry.js). A
// value the native picker cannot represent must render with no swatch, never
// a guessed one, and typing it must never get silently rewritten to a hex.

// CSS_NAMED_COLORS is the subset of named colours that actually turn up in
// pre-roll manifests, plus the obvious rest. ImageMagick knows hundreds more;
// anything not here simply has no swatch, which is a missing convenience, not
// a broken value.
const CSS_NAMED_COLORS = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", olive: "#808000", lime: "#00ff00", aqua: "#00ffff",
  teal: "#008080", navy: "#000080", fuchsia: "#ff00ff", purple: "#800080", orange: "#ffa500",
  gold: "#ffd700", pink: "#ffc0cb", brown: "#a52a2a", beige: "#f5f5dc", ivory: "#fffff0",
  khaki: "#f0e68c", crimson: "#dc143c", salmon: "#fa8072", coral: "#ff7f50", tomato: "#ff6347",
  orchid: "#da70d6", plum: "#dda0dd", violet: "#ee82ee", indigo: "#4b0082", turquoise: "#40e0d0",
};

function namedColorHex(name) {
  return CSS_NAMED_COLORS[String(name || "").trim().toLowerCase()] || null;
}

// toHexColor converts a DSL colour into the #rrggbb the native picker needs,
// or null when it cannot be represented. Returning null rather than a guess is
// the whole point: "none" must not silently become black.
function toHexColor(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "") return null;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  return namedColorHex(v);
}

// colorField renders a text input (the value), a native picker, and a swatch.
// The picker is data-color-for="<path>"; the delegated change handler in
// app.js writes the chosen hex into the text input (and into state) when it
// fires. The text input is data-color-text plus the ordinary data-path every
// other control uses, so typing it goes through the existing setPath/syncPath
// machinery unchanged — colorField only adds the preview.
function colorField(label, path, value, hint) {
  const hex = toHexColor(value);
  const swatch = swatchHTML(path, hex);
  return `<label class="field"><span>${esc(label)}</span>
    <span class="color-row">
      ${swatch}
      <input type="text" data-path="${esc(path)}" data-color-text value="${esc(value ?? "")}" placeholder="white, #101010, none">
      <input type="color" class="color-pick" data-color-for="${esc(path)}" value="${esc(hex || "#ffffff")}"
             aria-label="${esc(label)} colour picker">
    </span>
    ${hint ? `<small>${esc(hint)}</small>` : ""}
    <small class="muted">Any ImageMagick colour works — a name, #rrggbb, rgba(), or <code>none</code> for transparent.</small>
  </label>`;
}

// swatchHTML is also used by syncColorRow() to refresh the swatch in place
// while the text field is being typed into, without touching the field itself
// (a full renderInspector() mid-keystroke would steal the cursor — see
// app.js's onEditorInput comment). aria-hidden: the text field is the
// accessible source of truth for the value: the swatch is a visual bonus,
// never the only indication of state.
function swatchHTML(path, hex) {
  return hex
    ? `<span class="swatch" data-swatch-for="${esc(path)}" style="background:${hex}" aria-hidden="true"></span>`
    : `<span class="swatch swatch-none" data-swatch-for="${esc(path)}" aria-hidden="true"
             title="No swatch: this value is not a plain colour"></span>`;
}

// syncColorRow updates a colour row's swatch (and, when the new value is
// representable, its native picker) to match state — called after typing so
// the preview keeps up without re-rendering the whole panel. It looks the row
// up by path via querySelectorAll, the same delegation syncPath() (app.js)
// already uses for the same reason: a path can contain a quote and would
// break a [data-path="..."] selector built by hand.
function syncColorRow(path, value) {
  const hex = toHexColor(value);
  for (const swatch of document.querySelectorAll("[data-swatch-for]")) {
    if (swatch.dataset.swatchFor !== path) continue;
    swatch.classList.toggle("swatch-none", !hex);
    swatch.style.background = hex || "";
    swatch.title = hex ? "" : "No swatch: this value is not a plain colour";
  }
  if (!hex) return; // leave the native picker showing its last valid colour
  for (const picker of document.querySelectorAll("[data-color-for]")) {
    if (picker.dataset.colorFor === path) picker.value = hex;
  }
}

// ---- file picker -----------------------------------------------------------
// A path field plus a Browse button. The TEXT FIELD stays the value, exactly
// like colorField above: a path outside the media roots (added since load, or
// simply outside every -media-dir) is still perfectly legal in a manifest, it
// just cannot be browsed to. openFilePicker() only ever writes INTO the field
// (via pick-file, below) — nothing here rewrites what the user typed.
function fileField(label, path, value, kind, hint) {
  return `<label class="field"><span>${esc(label)}</span>
    <span class="file-row">
      <input type="text" data-path="${esc(path)}" value="${esc(value ?? "")}" placeholder="media/common/...">
      <button type="button" class="btn ghost" data-action="browse-files"
        data-target="${esc(path)}" data-kind="${esc(kind)}">Browse</button>
    </span>
    ${hint ? `<small>${esc(hint)}</small>` : ""}
  </label>`;
}

function fileKindLabel(kind) {
  return { font: "font", image: "image", audio: "audio track", video: "video" }[kind] || "file";
}

// matchingFiles is the whole "what gets listed" decision, pulled out of
// openFilePicker so it can be checked without a DOM: /api/files enumerates
// every kind of media at once, and each field only wants its own.
function matchingFiles(files, kind) {
  return (files || []).filter((f) => f.kind === kind);
}

// filePickerEmptyHTML is the other half of the degraded state: no matches,
// either because nothing of that kind exists yet (roots are configured and
// walked) or because no media directory is configured at all (roots is
// empty — see files.go's files(), which always answers 200 with an empty
// list rather than an error). Either way the text field upstream still
// accepts a hand-typed path; this dialog is only ever an assist.
function filePickerEmptyHTML(kind, roots) {
  return roots.length
    ? `<p class="empty">No ${fileKindLabel(kind)} files found under ${esc(roots.join(", "))}.
       Drop one in and reopen this dialog.</p>`
    : `<p class="empty">No media directory is configured. Start the UI with
       <code>-media-dir</code> (or <code>MEDIA_DIR</code>) pointing at your media folder,
       or type the path by hand — the field accepts anything.</p>`;
}

function filePickerRow(f, kind) {
  const url = `/api/files/raw?path=${encodeURIComponent(f.path)}`;
  const preview = kind === "image"
    ? `<img class="file-thumb" src="${esc(url)}" alt="" loading="lazy">`
    : kind === "font"
      ? `<span class="file-sample" data-font-sample="${esc(f.path)}">Top Movies — Month</span>`
      : kind === "audio"
        ? `<audio class="file-audio" controls preload="none" src="${esc(url)}"></audio>`
        : "";
  return `<button type="button" class="file-row-item" data-action="pick-file" data-path-value="${esc(f.path)}">
    <span class="file-name">${esc(f.name)}</span>
    <span class="file-path">${esc(f.path)}</span>
    <span class="file-size">${Math.round(f.size / 1024)} KB</span>
    ${preview}
  </button>`;
}

// filePickerTarget remembers which manifest path the open dialog will write
// to — set when it opens, cleared on close or pick, so a stray keystroke
// after closing can never write into a field the user isn't looking at.
let filePickerTarget = null;

async function openFilePicker(path, kind) {
  filePickerTarget = path;
  const dialog = $("#file-picker");
  const body = $("#file-picker-body");
  $("#file-picker-title").textContent = `Choose a ${fileKindLabel(kind)}`;
  body.innerHTML = `<p class="muted">Loading…</p>`;
  dialog.showModal();

  const { files, roots } = await apiListFiles();
  const matching = matchingFiles(files, kind);
  if (!matching.length) {
    body.innerHTML = filePickerEmptyHTML(kind, roots || []);
    return;
  }
  body.innerHTML = matching.map((f) => filePickerRow(f, kind)).join("");
  // A font can only be previewed in its own face once it is loaded, and each
  // one needs its own @font-face fetch. Unlike the image/audio previews above
  // (loading="lazy", preload="none" — browser-native throttles), a font has
  // no native lazy-load: previewing every match unconditionally would fire
  // one full network fetch per font, all concurrent, the instant the dialog
  // opens. FONT_PREVIEW_CAP bounds that fan-out; see previewFont's comment.
  if (kind === "font") {
    for (const f of matching.slice(0, FONT_PREVIEW_CAP)) previewFont(f.path);
  }
}

// previewFont loads the file as a real @font-face and applies it to that row's
// sample text, so the list shows what each font actually looks like rather
// than a filename to guess from. Cached by path: reopening the dialog (or
// browsing the same font field twice) must not re-request and re-decode a
// file already sitting in document.fonts.
//
// ponytail: FONT_PREVIEW_CAP is a flat cap, not IntersectionObserver-driven
// lazy loading — this is a local admin tool listing a user's own media
// directory, not a hostile input, and a directory big enough to blow past 24
// fonts is unusual. Rows beyond the cap simply render in the default face,
// the same degradation previewFont's own catch already gives an unreadable
// font. Swap in IntersectionObserver (load on scroll into view) if real
// directories start regularly exceeding the cap.
const FONT_PREVIEW_CAP = 24;
const previewFonts = new Map();
function previewFont(path) {
  const apply = (family) => {
    for (const el of document.querySelectorAll(`[data-font-sample="${CSS.escape(path)}"]`)) {
      el.style.fontFamily = `"${family}", sans-serif`;
    }
  };
  if (previewFonts.has(path)) { apply(previewFonts.get(path)); return; }
  const family = `preview${previewFonts.size}`;
  previewFonts.set(path, family);
  new FontFace(family, `url("/api/files/raw?path=${encodeURIComponent(path)}")`)
    .load()
    .then((loaded) => { document.fonts.add(loaded); apply(family); })
    .catch(() => { /* an unreadable font simply shows in the default face */ });
}

// ---- template picker ---------------------------------------------------
// The template context differs by WHERE the template appears — this is the
// whole reason a bare chip list (the retired templateChips in inspector.js)
// was wrong: it listed every variable everywhere, including ones that fail at
// render in that spot. Three real contexts, verified against the Go source:
//
//   - a list element's ROW template: render.go's itemContext (render.go:294-
//     303) builds a FRESH map — Rank/Name/Views only. No globals: Render()
//     runs with Option("missingkey=error") (templating.go:33), so a global
//     used here is a render-time failure, not a blank.
//   - a text element inside a CLIP LABEL layout (its scene has kind "clips"):
//     engine.go's itemVars (engine.go:229-237) clones the data context
//     (globals) and overlays the item's fields onto it — both are in scope
//     together.
//   - a text element inside a RENDER scene's own layout: engine.go's
//     sceneContext (engine.go:339-348) overlays the scene's own vars onto the
//     data context (globals) — item fields are never in scope here.
//
// fieldScope is what inspector.js knows statically when it renders the
// button ("item" for a list's row template, "text" for everything else);
// sceneKind resolves the rest, exactly like stage.js's own stageVars() does
// for the live preview (stage.js:106-121) — this file deliberately mirrors
// that function's scope split rather than re-deriving it.
function templateScopeKind(fieldScope, sceneKind) {
  if (fieldScope === "item") return "item";
  return sceneKind === "clips" ? "clip-label" : "scene-text";
}

// templateGroups is the picker's whole scope decision: which catalogue
// groups to show, and which variant of each helper (item-bound or
// global-bound — see providers.js's TEMPLATE_CATALOG.funcs). Pure and
// DOM-free so it can be checked hard in Node: get this wrong and the picker
// inserts a variable the render context does not have.
function templateGroups(fieldScope, sceneKind) {
  const kind = templateScopeKind(fieldScope, sceneKind);
  const hasItemFields = kind === "item" || kind === "clip-label";
  const hasGlobals = kind === "clip-label" || kind === "scene-text";
  const funcs = TEMPLATE_CATALOG.funcs.map((f) => ({
    insert: hasItemFields ? f.insert : f.globalInsert,
    label: f.label,
    explain: f.explain,
  }));
  const groups = [];
  if (hasItemFields) groups.push(["Item fields", TEMPLATE_CATALOG.itemFields]);
  if (hasGlobals) groups.push(["Globals", TEMPLATE_CATALOG.globals]);
  groups.push(["Helpers", funcs]);
  return groups;
}

// scope is "item" for a list's row template (where .Rank/.Name/.Views are in
// scope) and "text" for everything else. Which further groups show depends on
// the scene too (templateGroups above) — a text element behaves differently
// inside a clip label than inside a render scene's own layout.
function templateButton(path, scope) {
  return `<button type="button" class="btn ghost small" data-action="insert-template"
    data-target="${esc(path)}" data-scope="${esc(scope)}">Insert variable…</button>`;
}

let templateTarget = null;

// templateExampleDisclosure is templateExample's honesty check, surfaced once
// per open rather than once per row: are these live values, or is Plex simply
// not configured (so every global is a placeholder, exactly like the stage's
// own note — stage.js's stageNotes/stageDataReason), or is the previewed item
// itself a placeholder (stage.js's stagePlaceholderSources)? An example that
// looks live but isn't is worse than no example at all.
function templateExampleDisclosure(fieldScope, scene) {
  const kind = templateScopeKind(fieldScope, scene && scene.kind);
  if (kind === "item" || kind === "clip-label") {
    const source = kind === "item"
      ? (elementPath() && currentLayout().elements[selection.element].source)
      : (scene && scene.source);
    if (source && !stageResolved(source)) {
      return `Showing a placeholder item for "${source}" — connect Plex to preview a real one.`;
    }
  }
  if (kind !== "item" && !Object.keys(stageData.vars).length) {
    return "Plex is not configured — global examples use placeholder values.";
  }
  return "";
}

function openTemplatePicker(path, scope) {
  templateTarget = path;
  const scene = currentScene();
  const groups = templateGroups(scope, scene && scene.kind);
  const note = templateExampleDisclosure(scope, scene);
  $("#template-picker-body").innerHTML =
    (note ? `<p class="muted">${esc(note)}</p>` : "") +
    groups.map(([title, entries]) => `
    <h3>${esc(title)}</h3>
    ${entries.map((e) => `<button type="button" class="template-row" data-action="pick-template" data-insert="${esc(e.insert)}">
      <code>${esc(e.insert)}</code>
      <span class="template-explain">${esc(e.explain)}</span>
      <span class="template-example">→ ${esc(templateExample(e.insert, scope))}</span>
    </button>`).join("")}`).join("");
  $("#template-picker").showModal();
}

// templateExample renders the snippet against the SAME data the stage draws
// with, so the example is what the user will actually get — real film titles
// when Plex is connected, the placeholders when it is not (disclosed above).
// "item" scope mirrors render.go's itemContext exactly (item fields, nothing
// else, reusing stage.js's own itemVars() rather than re-deriving it);
// everything else mirrors stageVars(), which already models the clip-label/
// render-scene split.
function templateExample(snippet, scope) {
  const scene = currentScene();
  if (templateScopeKind(scope, scene && scene.kind) === "item") {
    const el = elementPath() ? currentLayout().elements[selection.element] : null;
    return stageTemplate(snippet, itemVars(stageItems(el && el.source)[0]));
  }
  return stageTemplate(snippet, stageVars(scene));
}

// Registering actions here (rather than app.js) matches every other view
// file's convention — inspector.js and timeline.js do the same. Guarded
// because pickers_test.js requires this file directly under plain Node,
// where `actions` (a state.js global, sharing script scope only inside the
// vm-context tests) does not exist; every other consumer of this file loads
// state.js first, so the guard is always true there.
if (typeof actions !== "undefined") {
  actions["browse-files"] = (d) => openFilePicker(d.target, d.kind);
  actions["pick-file"] = (d) => {
    if (!filePickerTarget) return;
    setPath(state, filePickerTarget, d.pathValue);
    $("#file-picker").close();
    filePickerTarget = null;
    onStateChange();
  };
  actions["close-file-picker"] = () => { $("#file-picker").close(); filePickerTarget = null; };

  actions["insert-template"] = (d) => openTemplatePicker(d.target, d.scope);
  actions["close-template-picker"] = () => { $("#template-picker").close(); templateTarget = null; };
  actions["pick-template"] = (d) => {
    if (!templateTarget) return;
    // Insert AT THE CURSOR of the field the button belongs to, so a snippet
    // can be dropped into the middle of an existing string. Appending would
    // make the picker useless for anything but an empty field.
    const input = document.querySelector(`[data-path="${CSS.escape(templateTarget)}"]`);
    const snippet = d.insert;
    if (input) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + snippet + input.value.slice(end);
      setPath(state, templateTarget, input.value);
      // Focus (and place the caret) BEFORE closing the dialog: the WHATWG
      // "dialog closing steps" only restore focus to the invoking button if
      // focus is still INSIDE the dialog when close() runs. Moving focus out
      // first is what makes the caret land in the field being edited, not
      // back on "Insert variable…".
      input.focus();
      input.setSelectionRange(start + snippet.length, start + snippet.length);
    } else {
      setPath(state, templateTarget, String(getPath(state, templateTarget) ?? "") + snippet);
    }
    $("#template-picker").close();
    templateTarget = null;
    renderStage();
    scheduleConvert();
  };
}

// Node: exported for pickers_test.js. Browser: the functions above are already
// global from the classic script.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { toHexColor, namedColorHex };
}
