"use strict";
// Node check for the pure half of static/pickers.js: the colour conversions
// behind the colour picker's swatch. The composite control itself (text
// field + native picker + swatch) needs a DOM and is covered by the human
// checks in pickers.js's task brief, not here.
//
// Lives outside static/ (like geometry_test.js and syntax_test.js) so it is
// never embedded by //go:embed all:static and never served to the browser.
// Run: node internal/webui/pickers_test.js

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const PICKERS_PATH = path.join(__dirname, "static", "pickers.js");
const Pickers = require(PICKERS_PATH);

test("hex values pass through, normalised to six digits and lower case", () => {
  assert.strictEqual(Pickers.toHexColor("#ABCDEF"), "#abcdef");
  assert.strictEqual(Pickers.toHexColor("#abc"), "#aabbcc");
  assert.strictEqual(Pickers.toHexColor("  #101010 "), "#101010");
});

test("the named colours a manifest actually uses map to hex", () => {
  assert.strictEqual(Pickers.toHexColor("white"), "#ffffff");
  assert.strictEqual(Pickers.toHexColor("BLACK"), "#000000");
  assert.strictEqual(Pickers.toHexColor("gold"), "#ffd700");
});

test("values the native picker cannot represent return null, never a guess", () => {
  assert.strictEqual(Pickers.toHexColor("none"), null, "transparent is not a colour the swatch can hold");
  assert.strictEqual(Pickers.toHexColor("transparent"), null);
  assert.strictEqual(Pickers.toHexColor("rgba(0,0,0,0.5)"), null);
  assert.strictEqual(Pickers.toHexColor(""), null);
  assert.strictEqual(Pickers.toHexColor(undefined), null);
  assert.strictEqual(Pickers.toHexColor("srgb(1,0,0)"), null);
});

// ---- round trip against the manifests actually shipped ---------------------
// Every colour form found in manifests/*.yaml (grepped, not guessed): named
// (white, black), 6-digit hex already lower-case, and "none". toHexColor must
// never be asked to produce the DSL string back — colorField() keeps the text
// field's value verbatim and only derives the swatch/native-picker hex from
// it — but this pins the derivation so the swatch itself never lies.
test("every colour form shipped in manifests/*.yaml resolves as expected", () => {
  const shipped = {
    white: "#ffffff",
    black: "#000000",
    "#0c1018": "#0c1018", "#cdd6e0": "#cdd6e0", "#9a9aa6": "#9a9aa6",
    "#ffd36e": "#ffd36e", "#b59ad0": "#b59ad0", "#efe7f5": "#efe7f5",
    "#101418": "#101418", "#8aa0b5": "#8aa0b5", "#dfe7ef": "#dfe7ef",
    "#0d0f14": "#0d0f14", "#0b0b14": "#0b0b14", "#f5f5f5": "#f5f5f5",
    "#c9c9d4": "#c9c9d4", "#12141a": "#12141a", "#dcdce6": "#dcdce6",
  };
  for (const [dslValue, hex] of Object.entries(shipped)) {
    assert.strictEqual(Pickers.toHexColor(dslValue), hex, dslValue);
  }
  // "none" appears as both a scene background and — per the brief — must
  // never resolve to a swatch colour.
  assert.strictEqual(Pickers.toHexColor("none"), null);
});
