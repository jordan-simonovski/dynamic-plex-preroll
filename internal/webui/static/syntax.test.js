"use strict";
// Every static .js file must at least parse. The browser reports a syntax
// error as a silently blank page and the Go tests cannot see it at all, so
// this is the cheapest real check available without a browser.
// Run: node --test 'internal/webui/static/*.test.js'

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));

test("there are static scripts to check", () => {
  assert.ok(files.length >= 5, `expected several scripts, found ${files.join(", ")}`);
});

for (const file of files) {
  test(`${file} parses`, () => {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotThrow(() => new vm.Script(src, { filename: file }));
  });
}
