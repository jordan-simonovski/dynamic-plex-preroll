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

// summariseManifest is the one-line description shown beside each starting
// point: what it is made of, so the list reads as a menu of approaches rather
// than a list of filenames.
function summariseManifest(m) {
  const scenes = m.scenes || [];
  const kinds = {};
  for (const sc of scenes) kinds[sc.kind] = (kinds[sc.kind] || 0) + 1;
  const parts = Object.entries(kinds).map(([k, n]) => `${n} ${k}`);
  const sources = Object.values(m.data || {}).map((ds) => ds.provider);
  const unique = [...new Set(sources)];
  return [
    parts.length ? parts.join(", ") : "no scenes",
    unique.length ? `from ${unique.join(", ")}` : "",
  ].filter(Boolean).join(" · ");
}

// openNewManifestDialog offers the existing manifests as starting points. They
// are fetched one by one because the summary needs their contents; on a local
// server with a dozen manifests that is instant, and the alternative is a new
// endpoint for something the browser can already ask for.
//
// The discard confirm fires HERE, once, before the dialog even opens — the
// same gate the old single-purpose New button had, now covering both of the
// dialog's outcomes (empty or template) rather than just the empty one.
// Deviation from the brief: it never confirmed at all, which would silently
// drop unsaved work the moment either "new-empty" or "new-from" ran.
async function openNewManifestDialog() {
  if (!confirmDiscard()) return;
  const dialog = $("#new-picker");
  const body = $("#new-picker-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  dialog.showModal();

  const names = await apiListManifests();
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      return { name, manifest: await apiGetManifest(name) };
    } catch {
      return { name, manifest: null };
    }
  }));

  // Degrade gracefully with nothing to offer: the empty option is still
  // useful on its own, so it is never hidden — only the "existing manifest"
  // section (and its explanatory copy) disappears when there is nothing to
  // list, rather than showing a heading over an empty list.
  body.innerHTML = `
    <button type="button" class="template-row" data-action="new-empty">
      <code>Empty manifest</code>
      <span class="template-explain">Start from nothing: one blank pre-roll, no scenes.</span>
    </button>
    ${loaded.length ? `
    <h3>Start from an existing manifest</h3>
    <p class="muted">A copy is loaded with the name cleared, so saving creates a new file and never overwrites the original.</p>
    ${loaded.map(({ name, manifest }) => `
      <button type="button" class="template-row" data-action="new-from" data-name="${esc(name)}">
        <code>${esc(name)}</code>
        <span class="template-explain">${esc(manifest ? summariseManifest(manifest) : "could not be read")}</span>
      </button>`).join("")}`
      : `<p class="muted">No other manifests are in the manifest directory yet.</p>`}`;
}

// startFromTemplate loads an existing manifest as a COPY, never an open: the
// name is cleared so the very next Save can't silently overwrite the file it
// came from, and — the deviation from the brief, which omits this — openedFile
// is cleared too. saveManifest() targets openedFile before it ever looks at
// state.name, so leaving openedFile pointing at the source (e.g. because the
// editor had that very file open via the manifest picker before New was
// clicked) would clobber it on Save even with the name blanked out. Both
// have to be cleared for "start from a template" to mean "a copy", not "open".
async function startFromTemplate(name) {
  let m;
  try {
    m = await apiGetManifest(name);
  } catch (err) {
    flash(`Could not read ${name}: ${err.message}`, true);
    return;
  }
  m.name = "";
  m.output = "";
  openedFile = "";
  replaceState(m);
  $("#new-picker").close();
  $("#manifest-picker").value = "";
  renderAll();
  refreshStageDataNow(); // replaceState() bypasses onStateChange
  convert();
  flash(`Started from ${name} — give it a name before saving`);
}

actions["new-empty"] = () => {
  replaceState(emptyManifest());
  openedFile = ""; // deviation from the brief: also missing there
  $("#new-picker").close();
  $("#manifest-picker").value = "";
  renderAll();
  refreshStageDataNow(); // replaceState() bypasses onStateChange
  convert();
};
actions["new-from"] = (d) => startFromTemplate(d.name);
actions["close-new-picker"] = () => $("#new-picker").close();

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
  $("#btn-new").onclick = openNewManifestDialog;
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
  // A colour field's swatch is drawn from the same value the text input just
  // took — refreshed in place (pickers.js), never via a full renderInspector()
  // here, which would steal the cursor mid-keystroke (see the panel-focus
  // comment in inspector.js).
  if (e.target.dataset.colorText !== undefined) syncColorRow(path, e.target.value);
  // Only a data-source edit can change what the providers return; anything
  // else just redraws.
  if (path.startsWith("data.")) refreshStageData();
  renderStage();
  scheduleConvert();
}

function onEditorChange(e) {
  const t = e.target;
  // The native picker writes into the text field, never around it: the text
  // is the value and may hold things the picker cannot express (Pickers.
  // toHexColor returns null for those, and colorField() never offers the
  // picker on such a value in the first place beyond its last-known hex).
  if (t.dataset.colorFor) {
    const path = t.dataset.colorFor;
    setPath(state, path, t.value);
    syncPath(path, t);
    renderInspector();
    renderStage();
    scheduleConvert();
    return;
  }
  if (t.dataset.actionToggle === "audio-fade") {
    state.audio.fadeOut = t.checked ? { start: 0, duration: 2 } : null;
    renderInspector();
    scheduleConvert();
    return;
  }
  if (t.dataset.actionToggle === "scene-bg") {
    const sc = state.scenes[+t.dataset.index];
    sc.background = t.checked
      ? { source: Object.keys(state.data)[0] || "", mode: "art", tile: "", dim: 0.35, limit: 0 }
      : null;
    renderAll();
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
}

function onEditorClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  actions[btn.dataset.action]?.(btn.dataset);
  renderStage();
  scheduleConvert();
}

// The inspector and the timeline rail use the same data-path/data-action
// conventions as the phase-1 form, so they get the same three delegated
// listeners rather than their own.
for (const root of ["#inspector", "#rail", "#file-picker", "#template-picker", "#new-picker"]) {
  const el = $(root);
  el.addEventListener("input", onEditorInput);
  el.addEventListener("change", onEditorChange);
  el.addEventListener("click", onEditorClick);
}

// Pointer events, not click: pointerdown does the selecting too (a click is
// just a drag that went nowhere), and two handlers would fight over which one
// owns the selection. The handlers themselves live in interact.js.
$("#stage").addEventListener("pointerdown", stagePointerDown);
$("#stage").addEventListener("pointermove", stagePointerMove);
$("#stage").addEventListener("pointerup", stagePointerUp);
$("#stage").addEventListener("pointercancel", stageCancelDrag);
// Escape has to be heard wherever the focus went when the drag started, so it
// is bound on the window rather than the canvas.
window.addEventListener("keydown", stageKeyDown);
// Task 11: selection, nudging, delete and deselect by keyboard, once the
// stage itself has focus (stagePointerDown focuses it explicitly on a click,
// same as Tabbing to it does natively). See stage.js's stageKeyNav for why
// this is a differently-named function from the window listener just above.
$("#stage").addEventListener("keydown", stageKeyNav);
// Task 11 fix for a Task 8 regression: the retired Scenes card's ↑/↓ buttons
// let a keyboard user reorder scenes; the rail that replaced them only
// reorders via HTML5 drag-and-drop, which is pointer-only. timeline.js's
// wireSceneDrag() binds the fix (sceneCardKeyDown) directly on each card, the
// same place it binds dragstart/dragover/drop, so nothing extra is needed here.

// navigator.clipboard exists only in a SECURE CONTEXT, and the deployment the
// README describes is not one: compose publishes on every interface and the
// documented way in is http://192.168.x.x:8382. So on the normal LAN install
// navigator.clipboard was undefined and this handler threw an unhandled
// TypeError — the button did nothing and said nothing. execCommand("copy") is
// deprecated but works over plain http, which is the whole point here.
$("#copy-yaml").onclick = async () => {
  const text = $("#yaml code").textContent;
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(text);
    else if (!execCommandCopy(text)) throw new Error("the browser refused the copy");
    flash("YAML copied");
  } catch (err) {
    flash(`Could not copy: ${err.message}. Open the YAML drawer and copy it by hand.`, true);
  }
};

// The pre-secure-context copy: hand the text to an off-screen textarea, select
// it, and let the browser's own copy command take it from there.
function execCommandCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

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
//
// Deviation from the Task 15 brief: it proposes a single-argument
// setStateChangeHandler, dropping the second (onRerender) callback. On disk
// setStateChangeHandler takes two — renameKey() calls onRerender() to restore
// a rejected rename without a spurious re-validate — so both are kept.
// renderAll() draws the stage itself (state.js), which is why nothing here
// calls renderStage() alongside it.
setStateChangeHandler(
  () => { renderAll(); refreshStageData(); scheduleConvert(); },
  () => renderAll(),
);
renderAll();
refreshStageDataNow();
renderToolbar();
// Capabilities decide what the toolbar even offers, so they are fetched once
// at boot; a feature that appears later needs a reload, which is fine for a
// tool somebody starts on their own machine.
apiCapabilities().then((caps) => {
  renderRenderControls(caps);
  if (!caps.plex && caps.plexError) flash(`Plex previews off: ${caps.plexError}`);
});
convert();
