"use strict";

const $ = (sel) => document.querySelector(sel);

// ---- state -----------------------------------------------------------------
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

// ---- deep path access ------------------------------------------------------
function getPath(obj, path) {
  return path.split(".").reduce((cur, k) => cur?.[k], obj);
}
function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys.at(-1)] = value;
}
function coerce(input) {
  if (input.dataset.type === "number") {
    const n = parseFloat(input.value);
    return Number.isFinite(n) ? n : 0;
  }
  if (input.dataset.type === "int") {
    const n = parseInt(input.value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return input.value;
}

// ---- html builders ---------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function field(label, inputHTML, hint = "") {
  return `<label class="field"><span>${esc(label)}</span>${inputHTML}` +
    (hint ? `<small>${esc(hint)}</small>` : "") + `</label>`;
}
function textInput(path, value, opts = {}) {
  return `<input type="text" data-path="${esc(path)}" value="${esc(value ?? "")}"` +
    ` placeholder="${esc(opts.placeholder || "")}">`;
}
function numInput(path, value, opts = {}) {
  return `<input type="number" data-path="${esc(path)}" data-type="${opts.int ? "int" : "number"}"` +
    ` value="${esc(value ?? 0)}" step="${opts.step ?? "any"}"` + (opts.min != null ? ` min="${opts.min}"` : "") + `>`;
}
// If value isn't among options (e.g. it names a data source or layout that
// was since deleted/renamed), inject it as an extra, labelled-missing option
// so the select shows the real state instead of silently falling back to the
// first option — which would corrupt state the moment the user touches it.
// An empty value on a list with no "" option gets one prepended, so "nothing
// chosen yet" renders as empty instead of the first option — the form must
// never claim a choice the user didn't make.
function select(path, value, options, opts = {}) {
  const missing = value !== "" && value != null && !options.includes(value);
  const empty = (value === "" || value == null) && !options.includes("");
  const list = missing ? [...options, value] : (empty ? ["", ...options] : options);
  const body = list.map((o) =>
    `<option value="${esc(o)}"${o === value || (empty && o === "") ? " selected" : ""}>` +
    `${esc(o === "" ? (opts.emptyLabel ?? "(none)") : (missing && o === value ? `${o} (missing)` : o))}</option>`).join("");
  const rerender = opts.rerender ? ` data-rerender="${esc(opts.rerender)}"` : "";
  const extra = opts.attrs ?? "";
  return `<select data-path="${esc(path)}"${rerender} ${extra}>${body}</select>`;
}

// ---- key renames (data sources, layouts, param/var maps) -------------------
// Presence, not truthiness: new keys are seeded with "", so a truthiness test
// would hand out the same key twice and the second add would overwrite the
// first in place.
function uniqueKey(map, base) {
  if (!Object.hasOwn(map, base)) return base;
  let i = 2;
  while (Object.hasOwn(map, `${base}${i}`)) i++;
  return `${base}${i}`;
}
function renameKey(mapPath, oldKey, newKey) {
  const map = getPath(state, mapPath);
  // Dots are the separator in the data-path strings every input is addressed
  // by, so a dotted key would make every later edit miss or land elsewhere.
  const reject = !newKey ? "A name can't be empty"
    : newKey.includes(".") ? "A name can't contain a dot"
    : map[newKey] !== undefined ? `${newKey} is already taken` : "";
  if (reject) {
    renderAll(); // restore the old name in the input
    flash(`${reject} — kept "${oldKey}"`, true);
    return;
  }
  if (newKey === oldKey) return;
  const rebuilt = {};
  for (const [k, v] of Object.entries(map)) rebuilt[k === oldKey ? newKey : k] = v;
  setPath(state, mapPath, rebuilt);
  if (mapPath === "data") retargetSource(oldKey, newKey);
  if (mapPath === "layouts") retargetLayout(oldKey, newKey);
  renderAll();
  scheduleConvert();
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

// ---- server round-trip -----------------------------------------------------
let convertTimer = null;
function scheduleConvert() {
  clearTimeout(convertTimer);
  convertTimer = setTimeout(convert, 300);
}
// convert() is fired by the debounce and directly by New/Open/Delete, so two
// requests can be in flight; only the newest may touch the DOM, or the pane
// ends up showing an older state's YAML.
let convertSeq = 0;
async function convert() {
  const seq = ++convertSeq;
  let out;
  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    out = await res.json();
  } catch (err) {
    out = { yaml: "", errors: [`server unreachable: ${err.message}`] };
  }
  if (seq !== convertSeq) return; // a newer convert() has already answered
  $("#yaml code").textContent = out.yaml || "";
  const list = $("#errors");
  list.innerHTML = "";
  for (const e of out.errors || []) {
    const li = document.createElement("li");
    li.textContent = e;
    list.appendChild(li);
  }
}

// ---- status toast ----------------------------------------------------------
let flashTimer = null;
function flash(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ""; }, 4000);
}

// ---- delegated events (declared here so section modules below can register
// handlers at top-level script scope, before the listeners are wired up) ----
const actions = {}; // sections register handlers: actions["add-data"] = (dataset) => {...}
// rerenderHooks: selects that change the form's shape declare
// data-rerender="<hook>"; a hook may reset dependent state before re-render.
// Later tasks add entries ("provider", "scene-kind").
const rerenderHooks = {};

// ---- sections --------------------------------------------------------------
function deriveOutput(name) {
  return name ? `output/${name}.mp4` : "";
}

function renderGeneral() {
  $("#section-general").innerHTML = `
    <h2>General</h2>
    <div class="grid2">
      ${field("Name", textInput("name", state.name, { placeholder: "my-preroll" }),
        "Letters, digits, dots, dashes — it becomes the filename")}
      ${field("Output file", textInput("output", state.output, { placeholder: "output/my-preroll.mp4" }))}
      ${field("Resolution", select("resolution", state.resolution,
        ["1920x1080", "3840x2160", "1280x720"]))}
      ${field("FPS", numInput("fps", state.fps, { int: true, min: 1 }))}
      ${field("Length (s)", numInput("length", state.length, { min: 0 }),
        "0 lets the scenes decide the total length")}
    </div>`;
}

function renderAudio() {
  const a = state.audio;
  $("#section-audio").innerHTML = `
    <h2>Audio</h2>
    <div class="grid2">
      ${field("Soundtrack file", textInput("audio.file", a.file, { placeholder: "media/common/track.mp3" }),
        "Leave empty for no soundtrack")}
      ${field("Mode", select("audio.mode", a.mode, ["soundtrack", "original", "mix"]),
        "soundtrack: music only · original: clip audio · mix: both")}
      ${field("Start offset (s)", numInput("audio.start", a.start, { min: 0 }),
        "Seek into the track — drop in on the hook, not the intro")}
    </div>
    <label class="check"><input type="checkbox" id="fade-toggle"${a.fadeOut ? " checked" : ""}> Fade out at the end</label>
    ${a.fadeOut ? `<div class="grid2">
      ${field("Fade starts at (s)", numInput("audio.fadeOut.start", a.fadeOut.start, { min: 0 }))}
      ${field("Fade duration (s)", numInput("audio.fadeOut.duration", a.fadeOut.duration, { min: 0 }))}
    </div>` : ""}`;
  $("#fade-toggle").onchange = (e) => {
    state.audio.fadeOut = e.target.checked ? { start: 0, duration: 2 } : null;
    renderAudio();
    scheduleConvert();
  };
}

function defaultParams(provider) {
  const params = {};
  for (const [key, p] of Object.entries(PROVIDERS[provider].params))
    if (p.default) params[key] = p.default;
  return params;
}

function renderData() {
  const cards = Object.entries(state.data).map(([name, ds]) => dataCard(name, ds)).join("");
  $("#section-data").innerHTML = `
    <h2>Data sources</h2>
    <p class="muted">Named feeds of Plex items. Lists, clip scenes and backgrounds pull from these by name.</p>
    ${cards || `<p class="empty">No data sources yet.</p>`}
    <button class="btn" data-action="add-data">+ Add data source</button>`;
}

function dataCard(name, ds) {
  const meta = PROVIDERS[ds.provider] || { params: {} };
  const rows = Object.entries(meta.params).map(([key, p]) => {
    const path = `data.${name}.params.${key}`;
    const val = ds.params?.[key] ?? "";
    const input = p.options ? select(path, val, p.options) : textInput(path, val, { placeholder: p.default || "" });
    return field(key, input, p.hint);
  }).join("");
  return `<div class="subcard">
    <div class="subcard-head">
      <input type="text" class="name-input" data-rename="data" data-old="${esc(name)}" value="${esc(name)}">
      <button class="btn ghost danger" data-action="remove-data" data-name="${esc(name)}">Remove</button>
    </div>
    ${field("Provider",
      select(`data.${name}.provider`, ds.provider, Object.keys(PROVIDERS),
        { rerender: "provider", attrs: `data-ds="${esc(name)}"` }),
      meta.hint)}
    <div class="grid2">${rows}</div>
    ${meta.extra ? extraParamRows(name, ds, meta) : ""}
  </div>`;
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
    <p class="muted">Passed straight through as query filters, e.g. decade=1990, year>>=2000.</p>
    ${rows}
    <button class="btn ghost" data-action="add-param" data-ds="${esc(name)}">+ Add filter</button>`;
}

actions["add-data"] = () => {
  const name = uniqueKey(state.data, "source");
  state.data[name] = { provider: "plex.top", params: defaultParams("plex.top") };
  renderAll();
};
actions["remove-data"] = (d) => { delete state.data[d.name]; renderAll(); };
actions["add-param"] = (d) => {
  const ds = state.data[d.ds];
  ds.params[uniqueKey(ds.params, "filter")] = "";
  renderData();
};
actions["remove-param"] = (d) => { delete state.data[d.ds].params[d.key]; renderData(); };

// Switching provider resets params to that provider's defaults — stale keys
// would otherwise leak through plex.section's passthrough as bogus filters.
rerenderHooks["provider"] = (dataset) => {
  const ds = state.data[dataset.ds];
  ds.params = defaultParams(ds.provider);
};

function renderLayouts() {
  const cards = Object.entries(state.layouts).map(([name, l]) => layoutCard(name, l)).join("");
  $("#section-layouts").innerHTML = `
    <h2>Layouts</h2>
    <p class="muted">Reusable rendered frames: a background plus text and list elements. Render scenes draw one; clip scenes can overlay one as a per-item label.</p>
    ${cards || `<p class="empty">No layouts yet.</p>`}
    <button class="btn" data-action="add-layout">+ Add layout</button>`;
}

function layoutCard(name, l) {
  const base = `layouts.${name}`;
  const els = (l.elements || []).map((el, i) => elementCard(name, el, i)).join("");
  return `<div class="subcard">
    <div class="subcard-head">
      <input type="text" class="name-input" data-rename="layouts" data-old="${esc(name)}" value="${esc(name)}">
      <button class="btn ghost danger" data-action="remove-layout" data-name="${esc(name)}">Remove</button>
    </div>
    <div class="grid2">
      ${field("Font file", textInput(`${base}.font`, l.font, { placeholder: "media/common/MyFont.ttf" }))}
      ${field("Background color", textInput(`${base}.background.color`, l.background?.color, { placeholder: "black, #101010, none" }),
        `Use "none" for transparent — required for clip labels and scenes with a dynamic background`)}
      ${field("Background image", textInput(`${base}.background.image`, l.background?.image, { placeholder: "media/common/bg.png" }),
        "Wins over color when set")}
    </div>
    <h3>Elements</h3>
    ${els || `<p class="empty">No elements — a layout needs at least one.</p>`}
    <button class="btn ghost" data-action="add-element" data-layout="${esc(name)}" data-kind="text">+ Text</button>
    <button class="btn ghost" data-action="add-element" data-layout="${esc(name)}" data-kind="list">+ List</button>
  </div>`;
}

function templateChips(items) {
  return `<div class="chips">${items.map((c) => `<code>${esc(c)}</code>`).join("")}</div>`;
}

function elementCard(layoutName, el, i) {
  const base = `layouts.${layoutName}.elements.${i}`;
  const head = `<div class="subcard-head">
    <strong>${esc(el.type)}</strong><span class="spacer"></span>
    <button class="btn ghost danger" data-action="remove-element" data-layout="${esc(layoutName)}" data-index="${i}">×</button>
  </div>`;
  if (el.type === "list") {
    return `<div class="subcard">${head}
      <div class="grid2">
        ${field("Data source", select(`${base}.source`, el.source, Object.keys(state.data)), "Which feed this list iterates")}
        ${field("Item template", textInput(`${base}.item`, el.item, { placeholder: "{{ .Rank }}. {{ .Name }}" }))}
        ${field("X", numInput(`${base}.x`, el.x))}
        ${field("First row Y", numInput(`${base}.startY`, el.startY))}
        ${field("Row spacing", numInput(`${base}.stepY`, el.stepY))}
        ${field("Font size", numInput(`${base}.size`, el.size))}
        ${field("Color", textInput(`${base}.color`, el.color, { placeholder: "white" }))}
        ${field("Align", select(`${base}.align`, el.align ?? "", ["", "left", "center", "right"], { emptyLabel: "left (default)" }))}
      </div>
      ${templateChips([...ITEM_FIELDS, ...TEMPLATE_FUNCS.map((f) => `{{ ${f} ... }}`)])}
    </div>`;
  }
  return `<div class="subcard">${head}
    <div class="grid2">
      ${field("Text", `<textarea data-path="${esc(base)}.text">${esc(el.text)}</textarea>`,
        "Newlines stack; templates like {{ upper .Period }} work here")}
      ${field("Color", textInput(`${base}.color`, el.color, { placeholder: "white" }))}
      ${field("X", numInput(`${base}.x`, el.x))}
      ${field("Y", numInput(`${base}.y`, el.y))}
      ${field("Font size", numInput(`${base}.size`, el.size))}
      ${field("Align", select(`${base}.align`, el.align ?? "", ["", "left", "center", "right"], { emptyLabel: "left (default)" }))}
      ${field("Line height", numInput(`${base}.lineHeight`, el.lineHeight ?? 0), "0 = single line")}
    </div>
    ${templateChips(TEMPLATE_VARS)}
  </div>`;
}

actions["add-layout"] = () => {
  const name = uniqueKey(state.layouts, "layout");
  state.layouts[name] = {
    background: { color: "black", image: "" },
    font: "",
    elements: [{ type: "text", text: "Title", x: 96, y: 150, size: 96, color: "white" }],
  };
  renderAll();
};
actions["remove-layout"] = (d) => { delete state.layouts[d.name]; renderAll(); };
actions["add-element"] = (d) => {
  const els = state.layouts[d.layout].elements;
  els.push(d.kind === "list"
    ? { type: "list", source: Object.keys(state.data)[0] || "", item: "{{ .Rank }}. {{ .Name }}",
        x: 96, startY: 320, stepY: 96, size: 56, color: "white" }
    : { type: "text", text: "Text", x: 96, y: 150, size: 64, color: "white" });
  renderLayouts();
};
actions["remove-element"] = (d) => {
  state.layouts[d.layout].elements.splice(+d.index, 1);
  renderLayouts();
};

function sceneDefaults(kind) {
  const first = (map) => Object.keys(map)[0] || "";
  return {
    image:  { kind: "image", file: "", duration: 4 },
    render: { kind: "render", layout: first(state.layouts), duration: 6, vars: {}, background: null },
    clips:  { kind: "clips", source: first(state.data), perClip: 4, label: "" },
  }[kind];
}

function renderScenes() {
  const cards = state.scenes.map((sc, i) => sceneCard(sc, i)).join("");
  $("#section-scenes").innerHTML = `
    <h2>Scenes</h2>
    <p class="muted">The timeline — played top to bottom.</p>
    ${cards || `<p class="empty">No scenes yet — a pre-roll needs at least one.</p>`}
    <button class="btn" data-action="add-scene" data-kind="render">+ Rendered frame</button>
    <button class="btn ghost" data-action="add-scene" data-kind="clips">+ Clip montage</button>
    <button class="btn ghost" data-action="add-scene" data-kind="image">+ Still image</button>`;
}

function sceneCard(sc, i) {
  const base = `scenes.${i}`;
  const head = `<div class="subcard-head">
    <strong>#${i + 1}</strong>
    ${select(`${base}.kind`, sc.kind, ["image", "render", "clips"],
      { rerender: "scene-kind", attrs: `data-index="${i}" data-prev="${esc(sc.kind)}"` })}
    <span class="spacer"></span>
    <button class="btn ghost" data-action="move-scene" data-index="${i}" data-dir="-1">↑</button>
    <button class="btn ghost" data-action="move-scene" data-index="${i}" data-dir="1">↓</button>
    <button class="btn ghost danger" data-action="remove-scene" data-index="${i}">×</button>
  </div>`;
  return `<div class="subcard">${head}${sceneFields(sc, i, base)}</div>`;
}

function sceneFields(sc, i, base) {
  if (sc.kind === "image") {
    return `<div class="grid2">
      ${field("Image file", textInput(`${base}.file`, sc.file, { placeholder: "media/common/intro.png" }))}
      ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}
    </div>`;
  }
  if (sc.kind === "clips") {
    return `<div class="grid2">
      ${field("Data source", select(`${base}.source`, sc.source, Object.keys(state.data)),
        "Items need trailer/media URLs — e.g. plex.trailers, or trailers: true")}
      ${field("Seconds per clip", numInput(`${base}.perClip`, sc.perClip, { min: 0 }))}
      ${field("Label layout", select(`${base}.label`, sc.label ?? "", ["", ...Object.keys(state.layouts)], { emptyLabel: "(no label)" }),
        "Overlaid per clip with that item's Name/Rank in scope — use a transparent background")}
    </div>`;
  }
  // render
  const bg = sc.background;
  return `<div class="grid2">
      ${field("Layout", select(`${base}.layout`, sc.layout, Object.keys(state.layouts)))}
      ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}
    </div>
    ${varRows(sc, i, base)}
    <label class="check"><input type="checkbox" data-action-toggle="scene-bg" data-index="${i}"${bg ? " checked" : ""}> Dynamic background</label>
    ${bg ? `<div class="grid2">
      ${field("Source", select(`${base}.background.source`, bg.source, Object.keys(state.data)))}
      ${field("Mode", select(`${base}.background.mode`, bg.mode, ["art", "poster", "trailers"]),
        "art/poster: still images · trailers: muted video montage")}
      ${field("Tile", select(`${base}.background.tile`, bg.tile ?? "", ["", "cover", "grid", "sequence"], { emptyLabel: "cover (default)" }),
        "grid: up to 4 items 2×2 · sequence: trailers back to back")}
      ${field("Dim", `<input type="range" data-path="${esc(base)}.background.dim" data-type="number" min="0" max="1" step="0.05" value="${esc(bg.dim ?? 0)}">`,
        "0 = untouched, 1 = black — keeps overlaid text legible")}
      ${field("Item limit", numInput(`${base}.background.limit`, bg.limit ?? 0, { int: true, min: 0 }), "0 = all")}
    </div>` : ""}`;
}

// Vars feed extra template variables into the scene's layout, so one layout
// serves many scenes with different text.
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

actions["add-scene"] = (d) => { state.scenes.push(sceneDefaults(d.kind)); renderScenes(); };
actions["remove-scene"] = (d) => { state.scenes.splice(+d.index, 1); renderScenes(); };
actions["move-scene"] = (d) => {
  const i = +d.index, j = i + +d.dir;
  if (j < 0 || j >= state.scenes.length) return;
  [state.scenes[i], state.scenes[j]] = [state.scenes[j], state.scenes[i]];
  renderScenes();
};
actions["add-var"] = (d) => {
  const sc = state.scenes[+d.index];
  sc.vars = sc.vars || {};
  sc.vars[uniqueKey(sc.vars, "Var")] = "";
  renderScenes();
};
actions["remove-var"] = (d) => { delete state.scenes[+d.index].vars[d.key]; renderScenes(); };

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

// The file the editor is currently backed by, "" when it was never opened or
// saved. Save targets this rather than a filename derived from state.name:
// the two are allowed to differ (manifests/trailers-example.yaml declares
// name: unwatched-trailers), and deriving would fork the file or clobber an
// unrelated one.
let openedFile = "";

// No dirty tracking, so anything that replaces the editor's contents asks.
function confirmDiscard() {
  return confirm("Discard the current editor contents?");
}

async function renderToolbar() {
  let names = [];
  try {
    names = await (await fetch("/api/manifests")).json();
  } catch { /* server list is a convenience; the editor still works */ }
  $("#manifest-actions").innerHTML = `
    <select id="manifest-picker">
      <option value="">— open manifest —</option>
      ${names.map((n) => `<option>${esc(n)}</option>`).join("")}
    </select>
    <button class="btn ghost" id="btn-new">New</button>
    <button class="btn" id="btn-save">Save</button>
    <button class="btn ghost danger" id="btn-delete">Delete</button>`;
  $("#manifest-picker").value = openedFile;
  $("#manifest-picker").onchange = (e) => {
    if (!e.target.value) return;
    if (!confirmDiscard()) {
      e.target.value = openedFile; // back out: the picker keeps showing the open file
      return;
    }
    loadManifest(e.target.value);
  };
  $("#btn-new").onclick = () => {
    if (!confirmDiscard()) return;
    state = emptyManifest();
    openedFile = "";
    $("#manifest-picker").value = "";
    renderAll();
    convert();
  };
  $("#btn-save").onclick = saveManifest;
  $("#btn-delete").onclick = deleteManifest;
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

async function loadManifest(name) {
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`);
    if (!res.ok) {
      flash(`Could not load ${name}: ${await res.text()}`, true);
      return;
    }
    state = normalize(await res.json());
  } catch (err) {
    flash(`Could not load ${name}: ${err.message}`, true);
    return;
  }
  openedFile = name;
  renderAll();
  convert();
  flash(`Loaded ${name}`);
}

async function saveManifest() {
  const derived = state.name ? `${state.name}.yaml` : "";
  const filename = openedFile || derived;
  if (!filename) {
    flash("Give the pre-roll a name before saving", true);
    return;
  }
  const known = [...$("#manifest-picker").options].map((o) => o.value);
  // Two ways a save can surprise: it writes a file whose name no longer
  // matches the manifest's, or it lands on someone else's manifest.
  if (openedFile && derived && derived !== openedFile) {
    if (!confirm(`This manifest is named "${state.name}" (${derived}) but was opened as ${openedFile}. Save over ${openedFile}?`)) return;
  } else if (!openedFile && known.includes(filename)) {
    if (!confirm(`${filename} already exists in the manifest directory. Overwrite it?`)) return;
  }
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(filename)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    if (!res.ok) {
      flash(`Not saved: ${await res.text()}`, true);
      return;
    }
  } catch (err) {
    flash(`Not saved: ${err.message}`, true);
    return;
  }
  openedFile = filename;
  flash(`Saved ${filename}`);
  await renderToolbar();
}

async function deleteManifest() {
  const name = $("#manifest-picker").value;
  if (!name) {
    flash("Open a manifest first", true);
    return;
  }
  if (!confirm(`Delete ${name}? The file is removed from the manifest directory.`)) return;
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) {
      flash(`Not deleted: ${await res.text()}`, true);
      return;
    }
  } catch (err) {
    flash(`Not deleted: ${err.message}`, true);
    return;
  }
  flash(`Deleted ${name}`);
  state = emptyManifest();
  openedFile = "";
  renderAll();
  convert();
  renderToolbar();
}

function renderAll() {
  renderGeneral();
  renderAudio();
  renderData();
  renderLayouts();
  renderScenes();
}

$("#editor").addEventListener("input", (e) => {
  const path = e.target.dataset.path;
  if (!path) return;
  if (path === "name") {
    // Keep output auto-derived while the user hasn't customised it.
    const wasAuto = state.output === deriveOutput(state.name);
    setPath(state, path, coerce(e.target));
    if (wasAuto) {
      state.output = deriveOutput(state.name);
      const out = $('#section-general input[data-path="output"]');
      if (out) out.value = state.output;
    }
  } else {
    setPath(state, path, coerce(e.target));
  }
  scheduleConvert();
});

$("#editor").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.actionToggle === "scene-bg") {
    const sc = state.scenes[+t.dataset.index];
    sc.background = t.checked
      ? { source: Object.keys(state.data)[0] || "", mode: "art", tile: "", dim: 0.35, limit: 0 }
      : null;
    renderScenes();
    scheduleConvert();
    return;
  }
  if (t.dataset.rename) {
    renameKey(t.dataset.rename, t.dataset.old, t.value.trim());
    return;
  }
  if (t.dataset.rerender) {
    rerenderHooks[t.dataset.rerender]?.(t.dataset, t);
    renderAll();
    scheduleConvert();
  }
});

$("#editor").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  actions[btn.dataset.action]?.(btn.dataset);
  scheduleConvert();
});

$("#copy-yaml").onclick = async () => {
  await navigator.clipboard.writeText($("#yaml code").textContent);
  flash("YAML copied");
};

// ---- boot ------------------------------------------------------------------
renderAll();
renderToolbar();
convert();
