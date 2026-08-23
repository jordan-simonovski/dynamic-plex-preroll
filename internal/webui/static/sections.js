"use strict";
// sections.js — the phase-1 stacked-card form. TEMPORARY: each card is retired
// as the visual editor takes over its job (Layouts in Task 8, Scenes in Task
// 10, Data in Task 15), and this file is deleted with the last of them.

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
      ${field("Label layout", select(`${base}.label`, sc.label ?? "", ["", ...Object.keys(state.layouts)], { emptyLabel: "(no label)", rerender: "scene-layout" }),
        "Overlaid per clip with that item's Name/Rank in scope — use a transparent background")}
    </div>`;
  }
  // render
  const bg = sc.background;
  return `<div class="grid2">
      ${field("Layout", select(`${base}.layout`, sc.layout, Object.keys(state.layouts), { rerender: "scene-layout" }))}
      ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}
    </div>
    ${varRows(sc, i, base)}
    <label class="check"><input type="checkbox" data-action-toggle="scene-bg" data-index="${i}"${bg ? " checked" : ""}> Dynamic background</label>
    ${bg ? `<div class="grid2">
      ${field("Source", select(`${base}.background.source`, bg.source, Object.keys(state.data)))}
      ${field("Mode", select(`${base}.background.mode`, bg.mode, ["art", "poster", "trailers"]),
        "art/poster: still images · trailers: muted video montage")}
      ${field("Tile", select(`${base}.background.tile`, bg.tile ?? "", ["", "cover", "grid", "sequence"], { emptyLabel: "grid (default)" }),
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

// These all renderAll() rather than renderScenes(): the inspector shows the
// same scene, and its template-variable rows are the ones being clicked when
// the button lives there. Re-rendering only this card would leave the panel
// showing a variable that is already gone (or missing one just added).
actions["add-scene"] = (d) => { state.scenes.push(sceneDefaults(d.kind)); renderAll(); };
actions["remove-scene"] = (d) => { state.scenes.splice(+d.index, 1); renderAll(); };
actions["move-scene"] = (d) => {
  const i = +d.index, j = i + +d.dir;
  if (j < 0 || j >= state.scenes.length) return;
  [state.scenes[i], state.scenes[j]] = [state.scenes[j], state.scenes[i]];
  renderAll();
};
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

function renderAll() {
  renderGeneral();
  renderAudio();
  renderData();
  renderScenes();
  renderInspector();
}
