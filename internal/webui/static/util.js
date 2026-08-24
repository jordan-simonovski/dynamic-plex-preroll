"use strict";
// util.js — DOM and string helpers with no knowledge of the manifest's shape.
// Everything here is either a one-line DOM convenience or an HTML builder that
// escapes its inputs; nothing reads or writes application state.

const $ = (sel) => document.querySelector(sel);

// ---- deep path access ------------------------------------------------------
function getPath(obj, path) {
  return path.split(".").reduce((cur, k) => cur?.[k], obj);
}
// A missing intermediate key means the path and the state have drifted apart
// (the classic cause: a key containing a dot, which splits into steps that do
// not exist). Report it and leave the state alone — walking on would throw a
// TypeError inside an input handler, where nothing catches it and the user's
// keystroke vanishes with no explanation. Returns whether the write happened.
function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    cur = cur?.[k];
    if (cur == null || typeof cur !== "object") {
      flash(`Could not update ${path} — the editor cannot address that field`, true);
      return false;
    }
  }
  cur[keys.at(-1)] = value;
  return true;
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
    ` value="${esc(value ?? 0)}" step="${esc(opts.step ?? "any")}"` +
    (opts.min != null ? ` min="${esc(opts.min)}"` : "") + `>`;
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

// ---- misc ------------------------------------------------------------------
// Presence, not truthiness: new keys are seeded with "", so a truthiness test
// would hand out the same key twice and the second add would overwrite the
// first in place.
function uniqueKey(map, base) {
  if (!Object.hasOwn(map, base)) return base;
  let i = 2;
  while (Object.hasOwn(map, `${base}${i}`)) i++;
  return `${base}${i}`;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

let flashTimer = null;
function flash(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ""; }, 4000);
}
