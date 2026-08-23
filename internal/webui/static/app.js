"use strict";
// app.js — boot, the manifest toolbar, the YAML/validation pane, and the
// delegated event wiring. Everything that draws a specific part of the
// manifest lives in its own file; this one only starts them and connects them.

// ---- server round-trip -----------------------------------------------------
// convert() is fired by the debounce and directly by New/Open/Delete, so two
// requests can be in flight; only the newest may touch the DOM, or the pane
// ends up showing an older state's YAML.
let convertSeq = 0;
async function convert() {
  const seq = ++convertSeq;
  const out = await apiConvert(state);
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
const scheduleConvert = debounce(convert, 300);

// ---- toolbar ---------------------------------------------------------------
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
  const names = await apiListManifests();
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
    replaceState(emptyManifest());
    openedFile = "";
    $("#manifest-picker").value = "";
    renderAll();
    renderStage();
    // replaceState() bypasses onStateChange, so nothing else refetches: a
    // stale resolve from the manifest just left would otherwise linger keyed
    // under whatever source names this one reuses.
    refreshStageDataNow();
    convert();
  };
  $("#btn-save").onclick = saveManifest;
  $("#btn-delete").onclick = deleteManifest;
}

async function loadManifest(name) {
  try {
    replaceState(await apiGetManifest(name));
  } catch (err) {
    flash(`Could not load ${name}: ${err.message}`, true);
    return;
  }
  openedFile = name;
  renderAll();
  renderStage();
  refreshStageDataNow(); // replaceState() bypasses onStateChange
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
  const res = await apiSaveManifest(filename, state);
  if (!res.ok) {
    flash(`Not saved: ${res.error}`, true);
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
  const res = await apiDeleteManifest(name);
  if (!res.ok) {
    flash(`Not deleted: ${res.error}`, true);
    return;
  }
  flash(`Deleted ${name}`);
  replaceState(emptyManifest());
  openedFile = "";
  renderAll();
  renderStage();
  refreshStageDataNow(); // replaceState() bypasses onStateChange
  convert();
  renderToolbar();
}

// ---- delegated events ------------------------------------------------------
// One data-path can now be bound by more than one control at once — the
// inspector's "Pre-roll settings" and the General card show the same fields,
// and Task 12's colour swatch will sit beside its own hex box. Typing does not
// re-render the form (that would steal focus mid-word), so push the new value
// to the other controls by hand or they keep showing the old one. Matching in
// JS rather than through a [data-path="..."] selector: a path can contain a
// quote (layout and data-source names are free text) and would break it.
function syncPath(path, source) {
  for (const other of document.querySelectorAll("[data-path]")) {
    if (other !== source && other.dataset.path === path) other.value = String(getPath(state, path) ?? "");
  }
}

function onEditorInput(e) {
  const path = e.target.dataset.path;
  if (!path) return;
  if (path === "name") {
    // Keep output auto-derived while the user hasn't customised it.
    const wasAuto = state.output === deriveOutput(state.name);
    setPath(state, path, coerce(e.target));
    if (wasAuto) {
      state.output = deriveOutput(state.name);
      syncPath("output");
    }
  } else {
    setPath(state, path, coerce(e.target));
  }
  syncPath(path, e.target);
  // Only a data-source edit can change what the providers return; anything
  // else just redraws.
  if (path.startsWith("data.")) refreshStageData();
  renderStage();
  scheduleConvert();
}

function onEditorChange(e) {
  const t = e.target;
  if (t.dataset.actionToggle === "scene-bg") {
    const sc = state.scenes[+t.dataset.index];
    sc.background = t.checked
      ? { source: Object.keys(state.data)[0] || "", mode: "art", tile: "", dim: 0.35, limit: 0 }
      : null;
    renderAll();
    renderStage();
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
    renderStage();
    scheduleConvert();
  }
}

function onEditorClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  actions[btn.dataset.action]?.(btn.dataset);
  renderStage();
  scheduleConvert();
}

// The inspector uses the same data-path/data-action conventions as the phase-1
// form, so it gets the same three delegated listeners rather than its own.
for (const root of ["#editor", "#inspector"]) {
  const el = $(root);
  el.addEventListener("input", onEditorInput);
  el.addEventListener("change", onEditorChange);
  el.addEventListener("click", onEditorClick);
}

// Clicking the stage selects the topmost element under the pointer, or the
// scene when the click lands on empty canvas. Task 11 adds the keyboard
// equivalents; the inspector's element rows are already keyboard-reachable, so
// no property is behind this click alone.
$("#stage").addEventListener("click", (e) => selectAt(e.clientX, e.clientY));

$("#copy-yaml").onclick = async () => {
  await navigator.clipboard.writeText($("#yaml code").textContent);
  flash("YAML copied");
};

// ---- stage chrome ----------------------------------------------------------
// The YAML pane is a drawer now. `hidden` is the whole state — no class, no
// stored flag — so the button's aria-expanded is derived from it and the two
// can never disagree.
$("#toggle-yaml").onclick = () => {
  const drawer = $("#yaml-drawer");
  const open = drawer.hasAttribute("hidden");
  drawer.toggleAttribute("hidden", !open);
  $("#toggle-yaml").setAttribute("aria-expanded", String(open));
};
$("#toggle-safe").onchange = renderStage;

// ---- boot ------------------------------------------------------------------
// State mutations that change the form's shape re-render everything and
// re-validate; a rejected rename only needs the form put back. state.js calls
// these without knowing what "everything" is.
setStateChangeHandler(
  () => { renderAll(); renderStage(); refreshStageData(); scheduleConvert(); },
  () => renderAll(),
);
renderAll();
renderStage();
refreshStageDataNow();
renderToolbar();
convert();
