// Node check for the pure bits of static/app.js. The file is a browser script
// with no module system, so it runs inside a vm context on top of a stub DOM
// just big enough to boot it; the assertions then call its functions directly.
//
//   node internal/webui/app_js_test.js
//
// ponytail: stub DOM, not jsdom — this covers pure functions and one async
// ordering guard. Reach for a real DOM only when rendering itself needs testing.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- stub DOM --------------------------------------------------------------
function makeEl() {
  return {
    innerHTML: "", textContent: "", value: "", checked: false,
    dataset: {}, options: [],
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, closest() { return null; },
    querySelector: () => makeEl(),
  };
}
const els = new Map();
const document = {
  querySelector(sel) {
    if (!els.has(sel)) els.set(sel, makeEl());
    return els.get(sel);
  },
  createElement: () => makeEl(),
};

// Requests to /api/convert are parked in `pending` so a test can resolve them
// out of order; everything else answers immediately.
const pending = [];
function fetchStub(url) {
  if (url === "/api/convert") {
    return new Promise((resolve) => pending.push(resolve));
  }
  return Promise.resolve({ ok: true, json: async () => [] });
}
function reply(body) {
  return { ok: true, json: async () => body };
}

let confirmAnswer = true;
const flashes = [];

const ctx = vm.createContext({
  document,
  fetch: fetchStub,
  setTimeout, clearTimeout,
  confirm: () => confirmAnswer,
  navigator: { clipboard: { writeText: async () => {} } },
  console,
});

const staticDir = path.join(__dirname, "static");
for (const f of ["providers.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
}
// `state` is a top-level `let`, so it lives in the context's lexical scope
// rather than on the global object; this bridge reaches it.
vm.runInContext(`globalThis.__t = {
  getState: () => state,
  setState: (s) => { state = s; },
};`, ctx);

// The renderers are exercised at boot above; from here they only add noise.
ctx.renderAll = () => {};
ctx.flash = (msg, isError) => flashes.push({ msg, isError });
pending.length = 0; // drop the boot convert; later converts get higher seqs

// ---- assertions ------------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// uniqueKey: presence, not truthiness — new keys are seeded with "".
{
  const { uniqueKey } = ctx;
  check("uniqueKey: free base", uniqueKey({}, "Var") === "Var");
  check("uniqueKey: empty-string value still counts as taken",
    uniqueKey({ Var: "" }, "Var") === "Var2", uniqueKey({ Var: "" }, "Var"));
  check("uniqueKey: skips both empty keys",
    uniqueKey({ Var: "", Var2: "" }, "Var") === "Var3");
  // The reported symptom: two clicks of "+ Add variable" must make two rows.
  const vars = {};
  vars[uniqueKey(vars, "Var")] = "";
  vars[uniqueKey(vars, "Var")] = "";
  check("uniqueKey: two adds make two keys", Object.keys(vars).length === 2,
    JSON.stringify(vars));
}

// select: an empty bound value must not display the first option as chosen.
{
  const { select } = ctx;
  const html = select("scenes.0.layout", "", ["title", "outro"]);
  check("select: empty value prepends an empty option",
    html.indexOf('<option value="" selected>') === html.indexOf("<option"), html);
  check("select: empty value leaves real options unselected",
    !html.includes('<option value="title" selected'), html);

  const known = select("p", "outro", ["title", "outro"]);
  check("select: known value selected", known.includes('<option value="outro" selected'), known);
  check("select: known value adds no empty option", !known.includes('value=""'), known);

  const missing = select("p", "gone", ["title"]);
  check("select: unknown value kept and labelled",
    missing.includes('<option value="gone" selected>gone (missing)'), missing);

  const withEmpty = select("p", "", ["", "left", "right"], { emptyLabel: "left (default)" });
  check("select: list that already has an empty option gets only one",
    withEmpty.split('value=""').length === 2, withEmpty);
}

// renameKey: dotted names would break every data-path, and every rejection
// must say so rather than silently restoring the old name.
{
  const { renameKey, getPath, setPath } = ctx;
  const fresh = () => ctx.__t.setState({ data: { good: { provider: "plex.top", params: {} } }, scenes: [], layouts: {} });

  fresh(); flashes.length = 0;
  renameKey("data", "good", "top.movies");
  check("renameKey: dotted name rejected",
    Object.keys(ctx.__t.getState().data).join() === "good", Object.keys(ctx.__t.getState().data).join());
  check("renameKey: dotted name flashes an error",
    flashes.length === 1 && flashes[0].isError === true, JSON.stringify(flashes));

  fresh(); flashes.length = 0;
  renameKey("data", "good", "");
  check("renameKey: empty name flashes an error",
    flashes.length === 1 && flashes[0].isError === true, JSON.stringify(flashes));

  ctx.__t.setState({ data: { a: {}, b: {} }, scenes: [], layouts: {} }); flashes.length = 0;
  renameKey("data", "a", "b");
  check("renameKey: duplicate name flashes an error",
    flashes.length === 1 && flashes[0].isError === true, JSON.stringify(flashes));
  check("renameKey: duplicate name keeps both keys",
    Object.keys(ctx.__t.getState().data).join() === "a,b");

  fresh(); flashes.length = 0;
  renameKey("data", "good", "renamed");
  check("renameKey: valid rename applied",
    Object.keys(ctx.__t.getState().data).join() === "renamed");

  // Why the dot rejection exists: paths are split on ".".
  const obj = { data: { "top.movies": { params: {} } } };
  check("getPath: a dotted key is unreachable",
    getPath(obj, "data.top.movies.params") === undefined);
  let threw = false;
  try { setPath(obj, "data.top.movies.params.x", 1); } catch { threw = true; }
  check("setPath: a dotted key throws", threw);
}

// convert(): responses that land out of order must not overwrite newer state.
(async () => {
  const pane = document.querySelector("#yaml code");
  const first = ctx.convert();
  const second = ctx.convert();
  check("convert: two requests in flight", pending.length === 2, String(pending.length));
  pending[1](reply({ yaml: "NEW", errors: [] }));
  await second;
  pending[0](reply({ yaml: "OLD", errors: [] }));
  await first;
  check("convert: stale response ignored", pane.textContent === "NEW", pane.textContent);

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("app.js checks passed");
})();
