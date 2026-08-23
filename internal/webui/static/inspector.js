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
  preroll: () => `<h2>Pre-roll</h2>${prerollFields()}
    <p class="empty">No scenes yet — add one with the + buttons in the timeline rail.</p>`,
  element: (t) => elementInspector(t.path, t.el),
  scene: (t) => sceneInspector(t.scene, t.index),
};

function renderInspector() {
  const target = inspectorTarget();
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
  panel.innerHTML = inspectorPanels[target.kind](target);
  if (hadFocus) panel.querySelector("input, select, textarea, button")?.focus?.();
}

// selectElement is the ONE place selection.element changes, so the outline on
// the stage and the panel on the right can never disagree about what is
// selected. stage.js's selectAt() and the element rows below both go through
// it; Task 9's drag and Task 11's keyboard selection should too.
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
    <details><summary>Pre-roll settings</summary>${prerollFields()}</details>`;
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
