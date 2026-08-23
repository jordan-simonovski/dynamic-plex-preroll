// Node check for the template picker (static/providers.js's TEMPLATE_CATALOG
// and static/pickers.js's template-picker half, added in Task 14). Browser
// scripts with no module system, so they run inside a vm context — one shared
// lexical scope across runInContext calls, exactly like classic <script>
// tags — on a stub DOM just big enough to boot them, matching
// inspector_test.js's/filepicker_test.js's convention.
//
//   node internal/webui/templatepicker_test.js
//
// This is the CORRECTNESS CORE of Task 14: the template context differs by
// where a template appears (a list's row template vs. a clip label's text vs.
// a render scene's own text), and offering a variable that isn't actually in
// scope there produces a manifest that fails at render (Go's
// Option("missingkey=error") — see templating.go). templateScopeKind and
// templateGroups (pickers.js) are the ONLY place that decision is made, so
// they get hit hard here, including a sweep that every insertable snippet
// stays inside the family of variables the Go source actually puts in scope
// for that context:
//   - list row template      -> render.go's itemContext   (render.go:294-303)
//   - clip label text        -> engine.go's itemVars       (engine.go:229-237)
//   - render scene text      -> engine.go's sceneContext    (engine.go:339-348)
//
// What this file CANNOT check: that showModal() actually opens a native
// dialog, that Tab cycles inside it, or that the caret visibly lands where
// setSelectionRange says — those are in the human-check list in the task
// report, not here.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const staticDir = path.join(__dirname, "static");

// ---- stub DOM ---------------------------------------------------------------
// Enough for pickers.js/inspector.js/stage.js to boot and for the dialog's
// body to be written somewhere readable. Modelled on inspector_test.js's.
const drawCtx = new Proxy({ font: "", fillStyle: "", strokeStyle: "", textAlign: "", textBaseline: "", lineWidth: 1 }, {
  get: (t, k) => (k in t ? t[k] : (k === "measureText"
    ? (s) => ({ width: String(s).length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })
    : () => {})),
  set: (t, k, v) => { t[k] = v; return true; },
});
function makeEl(sel, parent) {
  const el = {
    sel, parent,
    innerHTML: "", textContent: "", value: "", checked: false,
    clientWidth: 960, width: 0, height: 0, style: {},
    dataset: {}, options: [], attrs: {}, modalOpen: false,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, closest() { return null; },
    querySelector: () => makeEl(undefined, el),
    querySelectorAll: () => [],
    getContext: () => drawCtx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {},
    hasAttribute(a) { return el.attrs[a] !== undefined; },
    setAttribute(a, v) { el.attrs[a] = v; },
    toggleAttribute(a, on) { if (on) el.attrs[a] = ""; else delete el.attrs[a]; },
    contains(x) { for (let n = x; n; n = n.parent) if (n === el) return true; return false; },
    focus() { document.activeElement = el; callOrder.push(`focus:${sel}`); },
    setSelectionRange(s, e) { el.selectionStart = s; el.selectionEnd = e; },
    showModal() { el.modalOpen = true; },
    close() { el.modalOpen = false; callOrder.push(`close:${sel}`); },
  };
  return el;
}
// callOrder proves the accessibility-critical ordering: pick-template must
// focus the field BEFORE closing the dialog (see pickers.js's comment on
// why — the WHATWG dialog-closing steps only steal focus back to the invoker
// if focus is still inside the dialog when close() runs).
let callOrder = [];
const els = new Map();
const document = {
  activeElement: null,
  querySelector(sel) {
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  },
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  fonts: { add() {} },
};

const ctx = vm.createContext({
  document,
  window: { addEventListener() {}, devicePixelRatio: 1 },
  FontFace: class { load() { return Promise.reject(new Error("no font server in a test")); } },
  Image: class { set src(v) { this._src = v; } },
  fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  setTimeout, clearTimeout,
  confirm: () => true,
  CSS: { escape: (s) => s },
  navigator: { clipboard: { writeText: async () => {} } },
  console,
  scheduleConvert: () => {},
});

for (const f of ["providers.js", "util.js", "geometry.js", "interact.js", "state.js", "api.js", "stage.js", "pickers.js", "inspector.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}
// state/selection/actions are top-level let/const bindings, so (like
// inspector_test.js/filepicker_test.js) they live in the shared script scope
// rather than on the context's global object — pulled out through this
// in-context helper, the same trick every other Node check in this package
// uses.
vm.runInContext(`globalThis.__t = {
  getState: () => state,
  setState: (s) => { state = normalize(s); },
  select: (scene, element) => { selection.sceneIndex = scene; selection.element = element ?? null; },
  setStageData,
  actions,
};`, ctx);

const {
  __t, templateScopeKind, templateGroups, templateExample, templateExampleDisclosure,
  openTemplatePicker, templateButton, elementInspector, currentLayout, esc,
} = ctx;
const realActions = __t.actions;
const getState = __t.getState;

// ---- assertions --------------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const has = (name, html, needle) => check(name, html.includes(needle), `missing ${JSON.stringify(needle)} in ${JSON.stringify(html)}`);
const not = (name, html, needle) => check(name, !html.includes(needle), `unexpectedly found ${JSON.stringify(needle)} in ${JSON.stringify(html)}`);

// =============================================================================
// Part 1: templateScopeKind — the raw context classification.
// =============================================================================
eq("a list row template is 'item' scope regardless of scene kind", templateScopeKind("item", "render"), "item");
eq("... even for a clips scene (a list can live in a clip label layout too)", templateScopeKind("item", "clips"), "item");
eq("a text field inside a clips scene's label layout is 'clip-label'", templateScopeKind("text", "clips"), "clip-label");
eq("a text field inside a render scene's own layout is 'scene-text'", templateScopeKind("text", "render"), "scene-text");
eq("a text field with no scene selected degrades to 'scene-text', never a crash", templateScopeKind("text", undefined), "scene-text");

// =============================================================================
// Part 2: templateGroups — which catalogue groups render.go/engine.go
// actually put in scope for each context. This is the bug the brief itself
// shipped once (showing Globals inside a list's item template, which
// render.go's itemContext never provides) — asserted directly so it can never
// come back silently.
// =============================================================================
{
  const titles = (groups) => groups.map(([t]) => t);

  eq("item scope: Item fields + Helpers, and CRUCIALLY no Globals",
    JSON.stringify(titles(templateGroups("item", "render"))), JSON.stringify(["Item fields", "Helpers"]));
  eq("item scope ignores scene kind entirely — still no Globals under a clips scene",
    JSON.stringify(titles(templateGroups("item", "clips"))), JSON.stringify(["Item fields", "Helpers"]));

  eq("clip-label text scope: Item fields + Globals + Helpers (engine.go's itemVars overlays both)",
    JSON.stringify(titles(templateGroups("text", "clips"))), JSON.stringify(["Item fields", "Globals", "Helpers"]));

  eq("render-scene text scope: Globals + Helpers, and CRUCIALLY no Item fields",
    JSON.stringify(titles(templateGroups("text", "render"))), JSON.stringify(["Globals", "Helpers"]));
  eq("...same when no scene is selected yet", JSON.stringify(titles(templateGroups("text", undefined))), JSON.stringify(["Globals", "Helpers"]));
}

// ---- the sweep: no group, in any context, ever offers a variable outside
// that context's real render-time scope. This is the assertion that would
// have caught the brief's own bug and any future regression of it.
{
  const GLOBAL_VAR_RE = /\{\{[^}]*\.(Period|PeriodInterval|MovieSectionId|TVShowSectionId|MaxItems)\b/;
  const ITEM_VAR_RE = /\{\{[^}]*\.(Rank|Name|Views)\b/;
  const allInserts = (groups) => groups.flatMap(([, entries]) => entries.map((e) => e.insert));

  for (const sceneKind of ["render", "clips", "image", undefined]) {
    for (const insert of allInserts(templateGroups("item", sceneKind))) {
      check(`item scope (sceneKind=${sceneKind}) insert has no global: ${insert}`, !GLOBAL_VAR_RE.test(insert));
    }
  }
  for (const insert of allInserts(templateGroups("text", "render"))) {
    check(`render-scene text insert has no item field: ${insert}`, !ITEM_VAR_RE.test(insert));
  }
  for (const insert of allInserts(templateGroups("text", undefined))) {
    check(`no-scene text insert has no item field: ${insert}`, !ITEM_VAR_RE.test(insert));
  }
  // clip-label text is the one context where BOTH families are legitimately
  // in scope (engine.go:229-237 overlays item fields onto the data context) —
  // asserted as a positive, not just an absence of the other check.
  const clipLabelInserts = allInserts(templateGroups("text", "clips"));
  check("clip-label text offers at least one global", clipLabelInserts.some((i) => GLOBAL_VAR_RE.test(i)));
  check("clip-label text offers at least one item field", clipLabelInserts.some((i) => ITEM_VAR_RE.test(i)));
}

// ---- helpers pick the variant that actually fits the scope: a `.Name`-bound
// helper in a render-scene headline would fail at render (missingkey=error).
{
  const helperFor = (groups, label) => groups.find(([t]) => t === "Helpers")[1].find((e) => e.label === label);
  eq("item scope's 'upper' is .Name-bound", helperFor(templateGroups("item", "render"), "upper").insert, "{{ upper .Name }}");
  eq("clip-label's 'upper' is .Name-bound (item field IS in scope there)",
    helperFor(templateGroups("text", "clips"), "upper").insert, "{{ upper .Name }}");
  eq("render-scene text's 'upper' is .Period-bound — the brief's own headline example",
    helperFor(templateGroups("text", "render"), "upper").insert, "{{ upper .Period }}");
  eq("render-scene text's 'pluralize' falls back to a real numeric global (.MaxItems), not .Views",
    helperFor(templateGroups("text", "render"), "pluralize").insert, '{{ pluralize .MaxItems "item" "items" }}');
}

// =============================================================================
// Part 3: templateExample / templateExampleDisclosure — the live example and
// its honesty check, against real stage state.
// =============================================================================
const FIXTURE = () => ({
  resolution: "1920x1080",
  data: { topMovies: { provider: "plex.top", params: {} }, empty: { provider: "plex.top", params: {} } },
  layouts: {
    main: {
      font: "", background: { color: "black", image: "" },
      elements: [
        { type: "text", x: 100, y: 200, size: 60, color: "white", align: "center", text: "Top Movies — {{ upper .Period }}" },
        { type: "list", source: "topMovies", x: 100, startY: 400, stepY: 70, size: 40, color: "red", item: "{{ .Rank }}. {{ truncate 36 .Name }}" },
      ],
    },
    label: { font: "", background: { color: "none", image: "" }, elements: [{ type: "text", x: 10, y: 20, size: 30, text: "{{ .Rank }} · {{ .Period }}" }] },
  },
  scenes: [
    { kind: "render", layout: "main", duration: 6, vars: {} },
    { kind: "clips", source: "topMovies", perClip: 4, label: "label" },
    { kind: "clips", source: "empty", perClip: 4, label: "label" },
  ],
});

{
  __t.setState(FIXTURE());
  // Plex configured, topMovies resolved with a real (hostile-titled, to prove
  // escaping) item.
  __t.setStageData({
    vars: { Period: "Month", PeriodInterval: "MONTH", MovieSectionId: "1", TVShowSectionId: "2", MaxItems: "5" },
    sources: { topMovies: { items: [{ rank: 1, name: '<b>Arrival</b> & Friends', views: 7 }] }, empty: { items: [] } },
  });

  // ---- item scope: a real title, truncated, with no global ever reachable.
  __t.select(0, 1); // the list element
  eq("item example: renders the real (resolved) item's fields", templateExample("{{ .Rank }}. {{ .Name }}", "item"),
    "1. <b>Arrival</b> & Friends");
  eq("item example: a global referenced from item scope stays UNRESOLVED — proves no leak, not a silent wrong value",
    templateExample("{{ .Period }}", "item"), "{{ .Period }}");
  eq("item example: no disclosure needed — Plex is configured and the item is real",
    templateExampleDisclosure("item", { kind: "render", source: "topMovies" }), "");

  // ---- render-scene text: globals only, real value, item field unresolved.
  __t.select(0, 0); // the title text element, scene 0 is "render"
  eq("scene-text example: a real global resolves", templateExample("{{ upper .Period }}", "text"), "MONTH");
  eq("scene-text example: an item field referenced from scene-text stays UNRESOLVED",
    templateExample("{{ .Name }}", "text"), "{{ .Name }}");
  eq("scene-text: no disclosure needed — globals are real", templateExampleDisclosure("text", { kind: "render" }), "");

  // ---- clip-label text: both families resolve together.
  __t.select(1, 0); // scene 1 is "clips" with source topMovies, label layout's text element
  eq("clip-label example: item field resolves", templateExample("{{ .Rank }}", "text"), "1");
  eq("clip-label example: global resolves too (engine.go's itemVars overlays both)",
    templateExample("{{ .Period }}", "text"), "Month");
  eq("clip-label: no disclosure — topMovies is resolved", templateExampleDisclosure("text", { kind: "clips", source: "topMovies" }), "");

  // ---- clip-label text with an UNRESOLVED source: honest placeholder note.
  __t.select(2, 0); // scene 2 is "clips" with source "empty" (declared, no items -> placeholder)
  has("clip-label with an unresolved source discloses which one",
    templateExampleDisclosure("text", { kind: "clips", source: "empty" }), '"empty"');
  has("...and says to connect Plex", templateExampleDisclosure("text", { kind: "clips", source: "empty" }), "connect Plex");
}

{
  // Globals not configured, but the source itself IS resolved — isolates the
  // globals-placeholder branch of the disclosure from the item-placeholder
  // one (both can fire; whichever is more specific to the field wins, see
  // the block below for that case).
  __t.setState(FIXTURE());
  __t.setStageData({ sources: { topMovies: { items: [{ rank: 1, name: "Arrival", views: 7 }] }, empty: { items: [] } } });
  __t.select(0, 0);
  has("no globals configured: scene-text discloses placeholder globals",
    templateExampleDisclosure("text", { kind: "render" }), "Plex is not configured");
  __t.select(1, 0);
  has("no globals configured: clip-label with a RESOLVED source still discloses placeholder globals",
    templateExampleDisclosure("text", { kind: "clips", source: "topMovies" }), "Plex is not configured");
  __t.select(0, 1);
  eq("no globals configured: item scope needs no globals disclosure — and its own source IS resolved",
    templateExampleDisclosure("item", { kind: "render", source: "topMovies" }), "");
}

{
  // Nothing configured at all, including the source itself: the item-
  // placeholder note (more specific to what is actually shown) wins over the
  // generic globals one, and item scope never shows the globals note at all.
  __t.setState(FIXTURE());
  __t.setStageData({}); // setStageData's own fallback: vars: {}, sources: {}
  __t.select(0, 1);
  has("nothing configured: item scope discloses its own placeholder item",
    templateExampleDisclosure("item", { kind: "render", source: "topMovies" }), "placeholder item");
  not("...never the globals message — item scope has no globals to disclose",
    templateExampleDisclosure("item", { kind: "render", source: "topMovies" }), "Plex is not configured");
  // Item scope still falls back to PLACEHOLDER_ITEMS for its own example —
  // proven indirectly: the example must be a non-empty, plausible line, not a
  // crash or "undefined".
  const example = templateExample("{{ .Rank }}. {{ .Name }}", "item");
  check("item scope with no data configured still produces a placeholder example",
    /^\d+\. .+/.test(example), example);
}

// =============================================================================
// Part 4: openTemplatePicker — the DOM glue, exercised end to end.
// =============================================================================
{
  __t.setState(FIXTURE());
  __t.setStageData({
    vars: { Period: "Month", MaxItems: "5" },
    sources: { topMovies: { items: [{ rank: 1, name: "Arrival", views: 7 }] } },
  });

  __t.select(0, 1); // list element -> item scope
  openTemplatePicker("layouts.main.elements.1.item", "item");
  const itemBody = document.querySelector("#template-picker-body").innerHTML;
  has("item picker: shows Item fields", itemBody, "Item fields");
  not("item picker: never shows Globals", itemBody, "Globals");
  has("item picker: shows Helpers", itemBody, "Helpers");
  has("item picker: each row shows the snippet", itemBody, "{{ .Rank }}");
  has("item picker: each row shows its explanation", itemBody, "starting at 1");
  has("item picker: each row shows a live example", itemBody, "→ 1");
  eq("item picker: the dialog is actually shown", document.querySelector("#template-picker").modalOpen, true);

  __t.select(0, 0); // render-scene text element -> scene-text scope
  openTemplatePicker("layouts.main.elements.0.text", "text");
  const textBody = document.querySelector("#template-picker-body").innerHTML;
  has("text picker (render scene): shows Globals", textBody, "Globals");
  not("text picker (render scene): never shows Item fields", textBody, "Item fields");
  has("text picker (render scene): the headline example resolves", textBody, "MONTH");

  __t.select(1, 0); // clip-label text element -> clip-label scope
  openTemplatePicker("layouts.label.elements.0.text", "text");
  const labelBody = document.querySelector("#template-picker-body").innerHTML;
  has("text picker (clip label): shows Item fields", labelBody, "Item fields");
  has("text picker (clip label): shows Globals", labelBody, "Globals");
}

// ---- a hostile item name cannot break out of the example's markup ----------
{
  __t.setState(FIXTURE());
  __t.setStageData({ vars: { Period: "Month" }, sources: { topMovies: { items: [{ rank: 1, name: '"><script>alert(1)</script>', views: 1 }] } } });
  __t.select(0, 1);
  openTemplatePicker("layouts.main.elements.1.item", "item");
  const hostileBody = document.querySelector("#template-picker-body").innerHTML;
  not("a hostile item title cannot inject a script tag into the example", hostileBody, "<script>alert(1)</script>");
  has("...it is escaped instead", hostileBody, esc('"><script>alert(1)</script>'));
}

// =============================================================================
// Part 5: pick-template — caret insertion, focus order, and the append
// fallback when the field itself is not on the page.
// =============================================================================
{
  __t.setState(FIXTURE());
  __t.setStageData({});

  // Mid-string insertion at an explicit caret, not at the end.
  const path = "layouts.main.elements.0.text";
  const input = document.querySelector(`[data-path="${path}"]`);
  input.value = "AB";
  input.selectionStart = 1;
  input.selectionEnd = 1;
  callOrder = [];
  __t.select(0, 0);
  openTemplatePicker(path, "text");
  realActions["pick-template"]({ insert: "{{ upper .Period }}" });
  eq("pick-template inserts AT THE CURSOR, not appended", input.value, "A{{ upper .Period }}B");
  eq("pick-template writes the same value into state", getState().layouts.main.elements[0].text, "A{{ upper .Period }}B");
  eq("pick-template places the caret right after the inserted snippet",
    JSON.stringify([input.selectionStart, input.selectionEnd]),
    JSON.stringify([1 + "{{ upper .Period }}".length, 1 + "{{ upper .Period }}".length]));
  eq("pick-template closes the dialog", document.querySelector("#template-picker").modalOpen, false);
  const focusIdx = callOrder.indexOf(`focus:[data-path="${path}"]`);
  const closeIdx = callOrder.indexOf("close:#template-picker");
  check("pick-template focuses the field BEFORE closing the dialog (so the browser's own\n" +
    "  focus-restore-to-invoker behaviour never fires and steals focus back)",
    focusIdx !== -1 && closeIdx !== -1 && focusIdx < closeIdx, callOrder.join(", "));

  // A stray pick-template after the target was cleared is a no-op.
  const before = JSON.stringify(getState());
  realActions["pick-template"]({ insert: "{{ .Bogus }}" });
  eq("pick-template with no open target is a no-op", JSON.stringify(getState()), before);

  // close-template-picker clears the target too, so a stray click-through
  // after Close can never write anywhere.
  openTemplatePicker(path, "text");
  realActions["close-template-picker"]();
  eq("close-template-picker closes the dialog", document.querySelector("#template-picker").modalOpen, false);
  const before2 = JSON.stringify(getState());
  realActions["pick-template"]({ insert: "{{ .Bogus }}" });
  eq("pick-template after Close is a no-op", JSON.stringify(getState()), before2);

  // Fallback: the target path has no matching [data-path] element on the
  // page (e.g. the panel re-rendered out from under the open dialog) — append
  // rather than throw. The stub's querySelector auto-vivifies any selector
  // (unlike a real DOM, which returns null for nothing matched), so this one
  // call is patched to actually return null, proving the fallback path runs.
  getState().layouts.main.elements[0].text = "existing";
  openTemplatePicker(path, "text");
  const realQuerySelector = document.querySelector;
  document.querySelector = (sel) => (sel === `[data-path="${path}"]` ? null : realQuerySelector(sel));
  realActions["pick-template"]({ insert: "{{ upper .Period }}" });
  document.querySelector = realQuerySelector;
  eq("pick-template without a live field falls back to appending onto state",
    getState().layouts.main.elements[0].text, "existing{{ upper .Period }}");
}

// ---- templateButton: escapes its path, and carries the right data-scope ----
{
  const btn = templateButton('layouts."weird".elements.0.text', "text");
  has("templateButton carries the target path", btn, `data-target="layouts.&quot;weird&quot;.elements.0.text"`);
  has("templateButton carries the scope", btn, `data-scope="text"`);
  has("templateButton is reachable by keyboard (a real <button>, not a div)", btn, "<button");
}

// ---- integration: elementInspector actually wires the button in, per type -
{
  __t.setState(FIXTURE());
  __t.select(0, 0);
  const textPanel = elementInspector("layouts.main.elements.0", currentLayout().elements[0]);
  has("text element panel offers the Insert button, scoped to text", textPanel, `data-scope="text"`);
  const listPanel = elementInspector("layouts.main.elements.1", currentLayout().elements[1]);
  has("list element panel offers the Insert button, scoped to item", listPanel, `data-scope="item"`);
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("templatepicker.js checks passed");
