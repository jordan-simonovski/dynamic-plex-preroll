"use strict";
// Node check for the pure half of static/renderjob.js: the state machine that
// turns a POST /api/render result and each GET /api/render/{id} poll into what
// the panel should show. The DOM glue around it (the button, the panel, the
// <video> element's own `error` event) needs a browser and is covered by the
// human checks in task-17-report.md, not here.
//
// Lives outside static/ (like pickers_test.js and geometry_test.js) so it is
// never embedded by //go:embed all:static and never served to the browser.
// Run: node internal/webui/renderjob_test.js

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const RenderJob = require(path.join(__dirname, "static", "renderjob.js"));
const { startView, nextRenderView } = RenderJob;

// ---- startView: the POST /api/render result ---------------------------------

test("startView: a 202 disables the button and hands back the id to poll", () => {
  const v = startView({ ok: true, id: "deadbeefcafebabe" });
  assert.strictEqual(v.isError, false);
  assert.strictEqual(v.buttonDisabled, true);
  assert.strictEqual(v.startPolling, "deadbeefcafebabe");
  assert.match(v.status, /rendering/i);
});

test("startView: an invalid manifest (422) is shown, not silently dropped", () => {
  const v = startView({ ok: false, error: "scenes[0].duration: must be > 0" });
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.buttonDisabled, false);
  assert.strictEqual(v.startPolling, null); // never starts polling on a rejected start
  assert.match(v.status, /scenes\[0\]\.duration/);
});

test("startView: a concurrent render (409) reads the server's own refusal", () => {
  const v = startView({ ok: false, error: "a render is already running" });
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.startPolling, null);
  assert.match(v.status, /already running/);
});

test("startView: no renderer configured (503) is shown the same way as any other refusal", () => {
  const v = startView({ ok: false, error: "no renderer available: set -render-bin" });
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.buttonDisabled, false);
});

// ---- nextRenderView: each GET /api/render/{id} poll --------------------------

test("nextRenderView: running keeps the button disabled and keeps polling", () => {
  const v = nextRenderView({ id: "x", state: "running", seconds: 12.7, log: "ffmpeg: frame=1\n" });
  assert.strictEqual(v.keepPolling, true);
  assert.strictEqual(v.buttonDisabled, true);
  assert.strictEqual(v.showVideo, false);
  assert.strictEqual(v.log, "ffmpeg: frame=1\n");
  assert.match(v.status, /13s/); // Math.round(12.7), not floor
});

test("nextRenderView: running with no seconds yet still renders a number, not NaN", () => {
  const v = nextRenderView({ id: "x", state: "running" });
  assert.doesNotMatch(v.status, /NaN/);
});

test("nextRenderView: failed stops polling, re-enables the button, and surfaces the error text", () => {
  const v = nextRenderView({
    id: "x", state: "failed", seconds: 4,
    error: "convert: unable to read font `/no/such/Font.ttf'", log: "convert: unable to read font\nexit status 1\n",
  });
  assert.strictEqual(v.keepPolling, false);
  assert.strictEqual(v.buttonDisabled, false);
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.showVideo, false);
  assert.match(v.status, /unable to read font/); // the renderer's own stderr, not a generic message
  assert.strictEqual(v.log, "convert: unable to read font\nexit status 1\n");
});

test("nextRenderView: failed with no error field still says something, never blank", () => {
  const v = nextRenderView({ id: "x", state: "failed", seconds: 1 });
  assert.match(v.status, /render failed/i);
});

test("nextRenderView: a timed-out render is just another failed state to this function", () => {
  // internal/webui/render.go reports a timeout as state:"failed" with
  // Error set to "render timed out after ...". No separate branch needed.
  const v = nextRenderView({ id: "x", state: "failed", seconds: 1200, error: "render timed out after 20m0s" });
  assert.strictEqual(v.keepPolling, false);
  assert.match(v.status, /timed out/);
});

test("nextRenderView: done stops polling, re-enables the button, and points the video at this job's id", () => {
  const v = nextRenderView({ id: "abc123ff00112233", state: "done", seconds: 47, log: "done\n" });
  assert.strictEqual(v.keepPolling, false);
  assert.strictEqual(v.buttonDisabled, false);
  assert.strictEqual(v.isError, false);
  assert.strictEqual(v.showVideo, true);
  assert.strictEqual(v.videoSrc, "/api/render/abc123ff00112233/video");
  assert.match(v.status, /47s/);
});

test("nextRenderView: a poll that errors mid-run stops polling without touching the log or video", () => {
  const v = nextRenderView({ kind: "poll-error", message: "server unreachable" });
  assert.strictEqual(v.keepPolling, false);
  assert.strictEqual(v.buttonDisabled, false);
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.showVideo, false);
  assert.strictEqual(v.log, undefined); // caller must leave the last-known log alone
  assert.match(v.status, /lost track/i);
});

test("nextRenderView: an unrecognised state fails closed instead of falling through to the success view", () => {
  const v = nextRenderView({ id: "x", state: "cancelled", seconds: 3, log: "killed\n" });
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.showVideo, false);
  assert.strictEqual(v.keepPolling, false);
  assert.strictEqual(v.buttonDisabled, false);
  assert.match(v.status, /unexpected render state/i);
  assert.match(v.status, /cancelled/);
});

// ---- terminal-state coverage: nothing here can poll forever ------------------

test("every state nextRenderView understands is either keepPolling:true (running) or false (everything else)", () => {
  const cases = [
    { id: "x", state: "running" },
    { id: "x", state: "failed" },
    { id: "x", state: "done", seconds: 1 },
    { id: "x", state: "cancelled" },
    { kind: "poll-error", message: "x" },
  ];
  for (const job of cases) {
    const v = nextRenderView(job);
    const expected = job.state === "running";
    assert.strictEqual(v.keepPolling, expected, JSON.stringify(job));
  }
});
