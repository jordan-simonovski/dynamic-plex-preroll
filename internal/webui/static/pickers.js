"use strict";
// pickers.js — the colour picker: a text field (the value), a native
// <input type="color"> and a swatch, offered alongside each other.
//
// The rule this control follows: the TEXT FIELD is the value. A picker only
// ever writes into it, so nothing the DSL accepts can be lost by opening one.
// render.go resolves a colour string itself (ImageMagick's PixelWand), and
// accepts far more than the 7-character #rrggbb a native colour input can
// hold — named colours, short hex, rgba(), and "none"/"transparent" for no
// fill at all (see render.go's isTransparent, mirrored in geometry.js). A
// value the native picker cannot represent must render with no swatch, never
// a guessed one, and typing it must never get silently rewritten to a hex.

// CSS_NAMED_COLORS is the subset of named colours that actually turn up in
// pre-roll manifests, plus the obvious rest. ImageMagick knows hundreds more;
// anything not here simply has no swatch, which is a missing convenience, not
// a broken value.
const CSS_NAMED_COLORS = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", olive: "#808000", lime: "#00ff00", aqua: "#00ffff",
  teal: "#008080", navy: "#000080", fuchsia: "#ff00ff", purple: "#800080", orange: "#ffa500",
  gold: "#ffd700", pink: "#ffc0cb", brown: "#a52a2a", beige: "#f5f5dc", ivory: "#fffff0",
  khaki: "#f0e68c", crimson: "#dc143c", salmon: "#fa8072", coral: "#ff7f50", tomato: "#ff6347",
  orchid: "#da70d6", plum: "#dda0dd", violet: "#ee82ee", indigo: "#4b0082", turquoise: "#40e0d0",
};

function namedColorHex(name) {
  return CSS_NAMED_COLORS[String(name || "").trim().toLowerCase()] || null;
}

// toHexColor converts a DSL colour into the #rrggbb the native picker needs,
// or null when it cannot be represented. Returning null rather than a guess is
// the whole point: "none" must not silently become black.
function toHexColor(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "") return null;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  return namedColorHex(v);
}

// colorField renders a text input (the value), a native picker, and a swatch.
// The picker is data-color-for="<path>"; the delegated change handler in
// app.js writes the chosen hex into the text input (and into state) when it
// fires. The text input is data-color-text plus the ordinary data-path every
// other control uses, so typing it goes through the existing setPath/syncPath
// machinery unchanged — colorField only adds the preview.
function colorField(label, path, value, hint) {
  const hex = toHexColor(value);
  const swatch = swatchHTML(path, hex);
  return `<label class="field"><span>${esc(label)}</span>
    <span class="color-row">
      ${swatch}
      <input type="text" data-path="${esc(path)}" data-color-text value="${esc(value ?? "")}" placeholder="white, #101010, none">
      <input type="color" class="color-pick" data-color-for="${esc(path)}" value="${esc(hex || "#ffffff")}"
             aria-label="${esc(label)} colour picker">
    </span>
    ${hint ? `<small>${esc(hint)}</small>` : ""}
    <small class="muted">Any ImageMagick colour works — a name, #rrggbb, rgba(), or <code>none</code> for transparent.</small>
  </label>`;
}

// swatchHTML is also used by syncColorRow() to refresh the swatch in place
// while the text field is being typed into, without touching the field itself
// (a full renderInspector() mid-keystroke would steal the cursor — see
// app.js's onEditorInput comment). aria-hidden: the text field is the
// accessible source of truth for the value: the swatch is a visual bonus,
// never the only indication of state.
function swatchHTML(path, hex) {
  return hex
    ? `<span class="swatch" data-swatch-for="${esc(path)}" style="background:${hex}" aria-hidden="true"></span>`
    : `<span class="swatch swatch-none" data-swatch-for="${esc(path)}" aria-hidden="true"
             title="No swatch: this value is not a plain colour"></span>`;
}

// syncColorRow updates a colour row's swatch (and, when the new value is
// representable, its native picker) to match state — called after typing so
// the preview keeps up without re-rendering the whole panel. It looks the row
// up by path via querySelectorAll, the same delegation syncPath() (app.js)
// already uses for the same reason: a path can contain a quote and would
// break a [data-path="..."] selector built by hand.
function syncColorRow(path, value) {
  const hex = toHexColor(value);
  for (const swatch of document.querySelectorAll("[data-swatch-for]")) {
    if (swatch.dataset.swatchFor !== path) continue;
    swatch.classList.toggle("swatch-none", !hex);
    swatch.style.background = hex || "";
    swatch.title = hex ? "" : "No swatch: this value is not a plain colour";
  }
  if (!hex) return; // leave the native picker showing its last valid colour
  for (const picker of document.querySelectorAll("[data-color-for]")) {
    if (picker.dataset.colorFor === path) picker.value = hex;
  }
}

// Node: exported for pickers_test.js. Browser: the functions above are already
// global from the classic script.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { toHexColor, namedColorHex };
}
