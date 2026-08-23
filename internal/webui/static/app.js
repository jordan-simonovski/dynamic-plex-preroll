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
    ` value="${value ?? 0}" step="${opts.step ?? "any"}"` + (opts.min != null ? ` min="${opts.min}"` : "") + `>`;
}
function select(path, value, options, opts = {}) {
  const body = options.map((o) =>
    `<option value="${esc(o)}"${o === value ? " selected" : ""}>` +
    `${esc(o === "" ? (opts.emptyLabel ?? "(none)") : o)}</option>`).join("");
  const rerender = opts.rerender ? ` data-rerender="${esc(opts.rerender)}"` : "";
  const extra = opts.attrs ?? "";
  return `<select data-path="${esc(path)}"${rerender} ${extra}>${body}</select>`;
}

// ---- key renames (data sources, layouts, param/var maps) -------------------
function uniqueKey(map, base) {
  if (!map[base]) return base;
  let i = 2;
  while (map[`${base}${i}`]) i++;
  return `${base}${i}`;
}
function renameKey(mapPath, oldKey, newKey) {
  const map = getPath(state, mapPath);
  if (!newKey || newKey === oldKey || map[newKey] !== undefined) {
    renderAll(); // reject: restore the old name in the input
    return;
  }
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
async function convert() {
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

function renderLayouts() {}
function renderScenes() {}
function renderToolbar() {}

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
