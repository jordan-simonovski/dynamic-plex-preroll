"use strict";
// inspector.js — the right-hand panel. It describes whatever is selected: an
// element on the stage, the scene, or the pre-roll itself. Every control binds
// through data-path exactly like the phase-1 form did, so the existing
// delegated input/change listeners keep working unchanged.
//
// The dispatch is deliberately two pieces: inspectorTarget() DECIDES what is
// selected (pure, no DOM, testable in Node) and inspectorPanels renders it
// (pure string builders, also testable). renderInspector() is the only part
// that touches the document. Tasks 9-15 extend this by adding controls to a
// panel, or a kind to both maps — not by rewriting the dispatch.

// elementPath is the state path prefix of the selected element. Null whenever
// nothing is selected or the selection has gone stale (a deleted element, a
// scene whose layout was renamed away).
function elementPath() {
  if (selection.element == null) return null;
  const layout = currentLayout();
  if (!layout || !layout.elements || !layout.elements[selection.element]) return null;
  return `layouts.${currentLayoutName()}.elements.${selection.element}`;
}

// inspectorTarget is the single answer to "what is the inspector describing?".
// It never throws on a stale selection: a missing scene falls back to the
// pre-roll, a missing element falls back to the scene.
function inspectorTarget() {
  const scene = currentScene();
  if (!scene) return { kind: "preroll" };
  const path = elementPath();
  if (path) return { kind: "element", path, el: currentLayout().elements[selection.element], index: selection.element };
  return { kind: "scene", path: `scenes.${selection.sceneIndex}`, scene, index: selection.sceneIndex };
}

const inspectorPanels = {
  // audioFields() and the "Edit data sources" button are duplicated here from
  // sceneInspector's "Pre-roll settings" details, below: with zero scenes
  // there is no scene panel to hold that details block at all, and the
  // retired Audio and Data cards were reachable with zero scenes too — this
  // is what keeps that true now that both only otherwise live inside a
  // scene's details.
  preroll: () => `<h2>Pre-roll</h2>${prerollFields()}${audioFields()}
    <h3>Data</h3>
    <button class="btn ghost" data-action="select-data-list">Edit data sources</button>
    <p class="empty">No scenes yet — add one with the + buttons in the timeline rail.</p>`,
  element: (t) => elementInspector(t.path, t.el),
  scene: (t) => sceneInspector(t.scene, t.index),
};

function renderInspector() {
  const panel = $("#inspector");
  // Task 11's real focus model, replacing the Task 8 review's one-line
  // stopgap (which refocused into the panel unconditionally, every call).
  // Replacing #inspector's innerHTML destroys whatever was focused inside
  // it, which only matters when that is where focus actually WAS — e.g. an
  // element row or the "Remove element" button just clicked. When the
  // change came from elsewhere (the stage's own Tab/arrow handling, a drag,
  // the timeline rail), focus must be left alone: stealing it into the
  // newly-rendered panel would silently move it off the canvas the instant
  // a keyboard-selected element's inspector panel repainted, breaking the
  // very nudge keys that selection was for.
  const hadFocus = document.activeElement && panel.contains(document.activeElement);
  // A non-null selection.dataSource means the inspector is describing a data
  // source rather than the stage's selection: checked first, ahead of the
  // scene/element/preroll dispatch below. "" is the data list; null is "not
  // in data mode at all".
  if (selection.dataSource !== null) {
    panel.innerHTML = dataInspector();
  } else {
    const target = inspectorTarget();
    panel.innerHTML = inspectorPanels[target.kind](target);
  }
  if (hadFocus) panel.querySelector("input, select, textarea, button")?.focus?.();
}

// selectElement is how selection.element changes when the selection is the
// POINT of the gesture — a click on the stage (stage.js's selectAt), a drag
// (interact.js), the keyboard's Tab/Escape (stage.js's stageKeyNav), the
// element rows below. It exists so the outline on the stage and the panel on
// the right are repainted together and can never disagree.
// It is not the only writer: code that clears the selection as a side effect
// of a bigger change (switching scene in timeline.js, changing a scene's
// layout, deleting the selected element) sets it to null directly and relies
// on the renderAll()/onStateChange() that change already does.
function selectElement(index) {
  selection.element = index;
  renderStage();
  renderInspector();
}

// ---- pre-roll --------------------------------------------------------------
function prerollFields() {
  return `<div class="stack">
    ${field("Name", textInput("name", state.name, { placeholder: "my-preroll" }),
      "Letters, digits, dots, dashes — it becomes the filename")}
    ${field("Output file", textInput("output", state.output, { placeholder: "output/my-preroll.mp4" }))}
    ${field("Resolution", select("resolution", state.resolution, ["1920x1080", "3840x2160", "1280x720"]))}
    ${field("FPS", numInput("fps", state.fps, { int: true, min: 1 }))}
    ${field("Length (s)", numInput("length", state.length, { min: 0 }), "0 lets the scenes decide the total length")}
  </div>`;
}

// audioFields is the retired Audio card, moved here: the soundtrack belongs
// to the pre-roll, so it lives with the pre-roll's other settings (a scene's
// "Pre-roll settings" details, and the no-scenes preroll panel above).
function audioFields() {
  const a = state.audio;
  return `<h3>Soundtrack</h3>
    <div class="stack">
      ${fileField("Audio file", "audio.file", a.file, "audio", "Leave empty for no soundtrack")}
      ${field("Mode", select("audio.mode", a.mode, ["soundtrack", "original", "mix"]),
        "soundtrack: music only · original: clip audio · mix: both")}
      ${field("Start offset (s)", numInput("audio.start", a.start, { min: 0 }),
        "Seek into the track — drop in on the hook, not the intro")}
      <label class="check"><input type="checkbox" data-action-toggle="audio-fade"${a.fadeOut ? " checked" : ""}> Fade out at the end</label>
      ${a.fadeOut ? `
        ${field("Fade starts at (s)", numInput("audio.fadeOut.start", a.fadeOut.start, { min: 0 }))}
        ${field("Fade duration (s)", numInput("audio.fadeOut.duration", a.fadeOut.duration, { min: 0 }))}` : ""}
    </div>`;
}

// ---- element ---------------------------------------------------------------
function elementInspector(base, el) {
  const back = `<button class="btn ghost" data-action="select-scene">← Scene</button>`;
  const common = `
    ${field("Font size", numInput(`${base}.size`, el.size))}
    ${colorField("Colour", `${base}.color`, el.color, "Blank means white")}
    ${field("Align", select(`${base}.align`, el.align ?? "", ["", "left", "center", "right"], { emptyLabel: "left (default)" }),
      "Where x anchors the text: its left edge, its centre, or its right edge")}`;
  if (el.type === "list") {
    return `<h2>List element</h2>${back}
      <div class="stack">
        ${field("Data source", select(`${base}.source`, el.source, Object.keys(state.data)), "Which feed this list iterates")}
        ${field("Row template", textInput(`${base}.item`, el.item, { placeholder: "{{ .Rank }}. {{ .Name }}" }) +
          templateButton(`${base}.item`, "item"),
          "One line per item from the data source")}
        ${field("X", numInput(`${base}.x`, el.x))}
        ${field("First row Y", numInput(`${base}.startY`, el.startY), "The first row's baseline sits exactly here")}
        ${field("Row spacing", numInput(`${base}.stepY`, el.stepY))}
        ${common}
      </div>
      <button class="btn ghost danger" data-action="remove-selected-element">Remove element</button>`;
  }
  return `<h2>Text element</h2>${back}
    <div class="stack">
      ${field("Text", `<textarea data-path="${esc(base)}.text">${esc(el.text)}</textarea>` +
        templateButton(`${base}.text`, "text"),
        "Newlines stack; the block is centred vertically on Y")}
      ${field("X", numInput(`${base}.x`, el.x))}
      ${field("Y", numInput(`${base}.y`, el.y))}
      ${field("Line height", numInput(`${base}.lineHeight`, el.lineHeight ?? 0), "0 = 1.2 × the font size")}
      ${common}
    </div>
    <button class="btn ghost danger" data-action="remove-selected-element">Remove element</button>`;
}

// ---- scene -----------------------------------------------------------------
function sceneInspector(sc, i) {
  const base = `scenes.${i}`;
  return `<h2>Scene ${i + 1}</h2>
    <div class="stack">
      ${field("Kind", select(`${base}.kind`, sc.kind, ["image", "render", "clips"],
        { rerender: "scene-kind", attrs: `data-index="${i}" data-prev="${esc(sc.kind)}"` }))}
      ${sceneKindFields(sc, i, base)}
    </div>
    ${layoutSection(sc)}
    <details><summary>Pre-roll settings</summary>${prerollFields()}${audioFields()}
      <h3>Data</h3>
      <button class="btn ghost" data-action="select-data-list">Edit data sources</button>
    </details>`;
}

function sceneKindFields(sc, i, base) {
  if (sc.kind === "image") {
    return `${fileField("Image file", `${base}.file`, sc.file, "image")}
      ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}`;
  }
  if (sc.kind === "clips") {
    return `${field("Data source", select(`${base}.source`, sc.source, Object.keys(state.data)),
        "Items need trailer/media URLs — e.g. plex.trailers, or trailers: true")}
      ${field("Seconds per clip", numInput(`${base}.perClip`, sc.perClip, { min: 0 }))}
      ${field("Label layout", select(`${base}.label`, sc.label ?? "", ["", ...Object.keys(state.layouts)],
        { emptyLabel: "(no label)", rerender: "scene-layout" }),
        "Drawn over every clip with that item's Name/Rank in scope — needs a transparent background")}`;
  }
  const bg = sc.background;
  return `${field("Layout", select(`${base}.layout`, sc.layout, Object.keys(state.layouts), { rerender: "scene-layout" }))}
    ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}
    ${varRows(sc, i, base)}
    <label class="check"><input type="checkbox" data-action-toggle="scene-bg" data-index="${i}"${bg ? " checked" : ""}> Dynamic background</label>
    ${bg ? `
      ${field("Source", select(`${base}.background.source`, bg.source, Object.keys(state.data)))}
      ${field("Mode", select(`${base}.background.mode`, bg.mode, ["art", "poster", "trailers"]),
        "art/poster: still images · trailers: muted video montage")}
      ${field("Tile", select(`${base}.background.tile`, bg.tile ?? "", ["", "cover", "grid", "sequence"], { emptyLabel: "grid (default)" }),
        "grid: up to 4 items 2×2 · sequence: trailers back to back")}
      ${field("Dim", `<input type="range" data-path="${esc(base)}.background.dim" data-type="number" min="0" max="1" step="0.05" value="${esc(bg.dim ?? 0)}">`,
        "0 = untouched, 1 = black — keeps overlaid text legible")}
      ${field("Item limit", numInput(`${base}.background.limit`, bg.limit ?? 0, { int: true, min: 0 }), "0 = all")}` : ""}`;
}

// layoutSection is the layout the selected scene draws: its name, its font, its
// background, and the buttons that add elements to it. This is the half of the
// old Layouts card that had to survive; the per-element half moved to
// elementInspector. The element rows are also the KEYBOARD path to a selection
// — clicking the canvas must never be the only way to reach an element.
function layoutSection(sc) {
  if (sc.kind === "image") return ""; // a still image has nothing to lay out
  const name = currentLayoutName();
  const layout = currentLayout();
  // CRITICAL FIX (Task 8 regression): "+ Add layout" must be reachable
  // whether or not the current scene already has one — matching the retired
  // Layouts card, whose "+ Add layout" button was unconditional. Before this
  // fix it only rendered in the `!layout` branch below, and sceneDefaults()
  // always hands a fresh render scene the first existing layout, so once any
  // layout existed a second one could never be created at all.
  const addBtn = `<button class="btn ghost" data-action="add-layout">+ Add layout</button>`;
  if (!layout) {
    const missing = name
      ? `This scene names the layout "${esc(name)}", which does not exist.`
      : sc.kind === "clips" ? "This clip montage has no label layout." : "This scene has no layout yet.";
    return `<h3>Layout</h3><p class="empty">${missing}</p>${addBtn}`;
  }
  const base = `layouts.${name}`;
  const els = (layout.elements || []).map((el, i) =>
    `<button type="button" class="element-row${i === selection.element ? " selected" : ""}" data-action="select-element" data-index="${i}"${i === selection.element ? ' aria-current="true"' : ""}>
       <span class="kind">${esc(el.type)}</span>
       <span class="label">${esc(el.type === "list" ? (el.item || "(row template)") : (el.text || "(empty)").split("\n")[0])}</span>
     </button>`).join("");
  return `<h3>Layout</h3>
    <div class="subcard-head">
      <input type="text" class="name-input" data-rename="layouts" data-old="${esc(name)}" value="${esc(name)}" aria-label="Layout name">
      ${addBtn}
      <button class="btn ghost danger" data-action="remove-layout" data-name="${esc(name)}">Remove</button>
    </div>
    <div class="stack">
      ${fileField("Font file", `${base}.font`, layout.font, "font", "The .ttf/.otf the renderer draws with")}
      ${colorField("Background colour", `${base}.background.color`, layout.background?.color,
        "Use none for transparent — required for clip labels and dynamic backgrounds")}
      ${fileField("Background image", `${base}.background.image`, layout.background?.image, "image", "Wins over the colour when set")}
    </div>
    <h3>Elements</h3>
    <div class="element-list">${els || `<p class="empty">No elements — a layout needs at least one.</p>`}</div>
    <button class="btn ghost" data-action="add-element-here" data-kind="text">+ Text</button>
    <button class="btn ghost" data-action="add-element-here" data-kind="list">+ List</button>`;
}

// ---- actions ---------------------------------------------------------------
actions["select-scene"] = () => selectElement(null);
actions["select-element"] = (d) => selectElement(+d.index);
actions["remove-selected-element"] = () => {
  const layout = currentLayout();
  if (!layout || selection.element == null) return;
  layout.elements.splice(selection.element, 1);
  selectElement(null);
};
actions["add-element-here"] = (d) => {
  const layout = currentLayout();
  if (!layout) return;
  const { width, height } = stageDimensions();
  // New elements land in the middle of the frame rather than at 0,0 — an
  // element off the top-left corner looks broken and cannot be grabbed.
  layout.elements.push(d.kind === "list"
    ? { type: "list", source: Object.keys(state.data)[0] || "", item: "{{ .Rank }}. {{ .Name }}",
        x: Math.round(width * 0.05), startY: Math.round(height * 0.35),
        stepY: Math.round(height * 0.09), size: Math.round(height * 0.05), color: "white" }
    : { type: "text", text: "Text", x: Math.round(width / 2), y: Math.round(height / 2),
        size: Math.round(height * 0.09), color: "white", align: "center" });
  selectElement(layout.elements.length - 1);
};
// A new layout is pointed at by the scene that asked for it, replacing
// whatever it named before — a layout nothing references is unreachable from
// the inspector, which is the only surface left to browse layouts from. The
// scene's previous layout (if any) stays in state.layouts and is still
// reachable through that scene's own "Layout" dropdown, exactly like a layout
// the retired Layouts card created before any scene picked it.
actions["add-layout"] = () => {
  const name = uniqueKey(state.layouts, "layout");
  const { width, height } = stageDimensions();
  state.layouts[name] = {
    background: { color: "black", image: "" },
    font: "",
    elements: [{ type: "text", text: "Title", x: Math.round(width / 2), y: Math.round(height / 2),
                 size: Math.round(height * 0.09), color: "white", align: "center" }],
  };
  const sc = currentScene();
  if (sc && sc.kind === "render") sc.layout = name;
  if (sc && sc.kind === "clips") sc.label = name;
  selection.element = 0;
  renderAll(); // the timeline rail and inspector both need repainting
};
actions["remove-layout"] = (d) => {
  delete state.layouts[d.name];
  selection.element = null;
  renderAll();
};

// Changing a render scene's layout (or a clips scene's label layout)
// invalidates the element selection, which indexes into the OLD layout's array.
rerenderHooks["scene-layout"] = () => { selection.element = null; };

// Vars feed extra template variables into the scene's layout, so one layout
// serves many scenes with different text. Moved here from the retired
// sections.js: the var rows render wherever the scene they belong to is
// shown, which is now only the inspector.
function varRows(sc, i, base) {
  const vars = sc.vars || {};
  const rows = Object.entries(vars).map(([k, v]) => `<div class="kv">
    <input type="text" data-rename="${esc(base)}.vars" data-old="${esc(k)}" value="${esc(k)}">
    <input type="text" data-path="${esc(base)}.vars.${esc(k)}" value="${esc(v)}">
    <button class="btn ghost danger" data-action="remove-var" data-index="${i}" data-key="${esc(k)}">×</button>
  </div>`).join("");
  return `<h3>Template variables</h3>${rows}
    <button class="btn ghost" data-action="add-var" data-index="${i}">+ Add variable</button>`;
}
actions["add-var"] = (d) => {
  const sc = state.scenes[+d.index];
  sc.vars = sc.vars || {};
  sc.vars[uniqueKey(sc.vars, "Var")] = "";
  renderAll();
};
actions["remove-var"] = (d) => { delete state.scenes[+d.index].vars[d.key]; renderAll(); };

// Changing kind swaps the scene for that kind's defaults — stale fields from
// the old kind (file on a render scene, layout on clips) must not linger. That
// throws away vars, background, label and layout, so ask first when the scene
// holds anything beyond a fresh one's defaults; on "no", put the kind back
// (the input handler wrote it before this hook ran) and let the re-render
// restore the select.
rerenderHooks["scene-kind"] = (dataset) => {
  const i = +dataset.index;
  const sc = state.scenes[i];
  const fresh = JSON.stringify({ ...sceneDefaults(dataset.prev), kind: sc.kind });
  if (JSON.stringify(sc) !== fresh &&
      !confirm(`Switch scene #${i + 1} from ${dataset.prev} to ${sc.kind}? Its current settings are cleared.`)) {
    sc.kind = dataset.prev;
    return;
  }
  state.scenes[i] = sceneDefaults(sc.kind);
};

// ---- data sources ------------------------------------------------------------
// Data sources are not part of any one scene, so they get their own inspector
// mode rather than a card: selection.dataSource names the one being edited,
// and "" means the list. null (checked by renderInspector() above) means
// "not in data mode at all".
function dataInspector() {
  const name = selection.dataSource;
  if (!name || !state.data[name]) return dataListPanel();
  return dataSourcePanel(name, state.data[name]);
}

function dataListPanel() {
  const rows = Object.entries(state.data).map(([name, ds]) => {
    const meta = PROVIDERS[ds.provider] || {};
    return `<button class="element-row" data-action="select-data" data-name="${esc(name)}">
      <span class="kind">${esc(meta.title || ds.provider || "?")}</span>
      <span class="label">${esc(name)}</span>
    </button>`;
  }).join("");
  return `<h2>Data sources</h2>
    <p class="muted">Named feeds of Plex items. List elements, clip scenes and dynamic backgrounds all pull from these by name.</p>
    <div class="element-list">${rows || `<p class="empty">No data sources yet.</p>`}</div>
    <button class="btn" data-action="add-data">+ Add data source</button>`;
}

function dataSourcePanel(name, ds) {
  const meta = PROVIDERS[ds.provider] || { params: {} };
  const rows = Object.entries(meta.params || {}).map(([key, p]) => {
    const path = `data.${name}.params.${key}`;
    const val = ds.params?.[key] ?? "";
    const input = p.options
      ? select(path, val, p.options)
      : textInput(path, val, { placeholder: p.default || "" }) + templateButton(path, "text");
    return field(key, input, p.hint);
  }).join("");
  const result = renderTestResult(name);
  return `<h2>Data source</h2>
    <button class="btn ghost" data-action="select-data-list">← All sources</button>
    <div class="stack">
      <label class="field"><span>Name</span>
        <input type="text" data-rename="data" data-old="${esc(name)}" value="${esc(name)}"></label>
      ${field("Provider", select(`data.${name}.provider`, ds.provider, Object.keys(PROVIDERS),
        { rerender: "provider", attrs: `data-ds="${esc(name)}"` }))}
    </div>
    <div class="provider-doc">
      <p><strong>${esc(meta.title || ds.provider)}</strong> — ${esc(meta.describe || "")}</p>
      <p class="muted">${esc(meta.when || "")}</p>
    </div>
    <h3>Parameters</h3>
    <div class="stack">${rows}</div>
    ${meta.extra ? extraParamRows(name, ds, meta) : ""}
    <h3>Test</h3>
    <p class="muted">Runs this source against your real Plex server and shows what it returns.</p>
    <button class="btn" data-action="test-data" data-name="${esc(name)}">Test this source</button>
    <div id="test-result">${result}</div>
    <button class="btn ghost danger" data-action="remove-data" data-name="${esc(name)}">Remove source</button>`;
}

// plex.section passes unknown params through to Plex as filters; these rows
// edit the params not covered by the provider's declared knobs.
function extraParamRows(name, ds, meta) {
  const extras = Object.entries(ds.params || {}).filter(([k]) => !(k in meta.params));
  const rows = extras.map(([k, v]) => `<div class="kv">
    <input type="text" data-rename="data.${esc(name)}.params" data-old="${esc(k)}" value="${esc(k)}">
    <input type="text" data-path="data.${esc(name)}.params.${esc(k)}" value="${esc(v)}">
    <button class="btn ghost danger" data-action="remove-param" data-ds="${esc(name)}" data-key="${esc(k)}">×</button>
  </div>`).join("");
  return `<h3>Extra Plex filters</h3>
    <p class="muted">Anything here is handed to Plex verbatim as a query filter, e.g. decade=1990 or year&gt;&gt;=2000.</p>
    ${rows}
    <button class="btn ghost" data-action="add-param" data-ds="${esc(name)}">+ Add filter</button>`;
}

// testResults holds the last "Test this source" answer per source name, so the
// table survives a re-render of the panel.
const testResults = {};

function renderTestResult(name) {
  const r = testResults[name];
  if (!r) return "";
  if (r.pending) return `<p class="muted">Running…</p>`;
  if (r.error) return `<ul class="errors"><li>${esc(r.error)}</li></ul>`;
  if (!r.items.length) return `<p class="empty">The source ran and returned no items. Check the section id and any filters.</p>`;
  return `<table class="test-table">
    <thead><tr><th>#</th><th>Name</th><th>Views</th><th>Trailer</th></tr></thead>
    <tbody>${r.items.map((it) => `<tr>
      <td>${it.rank}</td><td>${esc(it.name)}</td><td>${it.views || ""}</td>
      <td>${it.hasMedia ? "yes" : "—"}</td></tr>`).join("")}</tbody>
  </table>
  <p class="muted">${r.items.length} item${r.items.length === 1 ? "" : "s"} returned.</p>`;
}

actions["select-data"] = (d) => { selection.dataSource = d.name; renderInspector(); };
actions["select-data-list"] = () => { selection.dataSource = ""; renderInspector(); };
actions["add-data"] = () => {
  const name = uniqueKey(state.data, "source");
  state.data[name] = { provider: "plex.top", params: defaultParams("plex.top") };
  selection.dataSource = name;
  onStateChange();
};
actions["remove-data"] = (d) => {
  delete state.data[d.name];
  selection.dataSource = "";
  onStateChange();
};
actions["add-param"] = (d) => {
  const ds = state.data[d.ds];
  ds.params[uniqueKey(ds.params, "filter")] = "";
  renderInspector();
};
actions["remove-param"] = (d) => { delete state.data[d.ds].params[d.key]; renderInspector(); };
actions["test-data"] = async (d) => {
  testResults[d.name] = { pending: true };
  renderInspector();
  const out = await apiResolveData({ [d.name]: state.data[d.name] });
  const src = (out.sources || {})[d.name] || { items: [] };
  testResults[d.name] = out.configured
    ? { items: src.items || [], error: src.error || "" }
    : { items: [], error: out.reason || "Plex is not configured." };
  renderInspector();
};

// Switching provider resets params to that provider's defaults — stale keys
// would otherwise leak through plex.section's passthrough as bogus filters.
rerenderHooks["provider"] = (dataset) => {
  const ds = state.data[dataset.ds];
  ds.params = defaultParams(ds.provider);
};
