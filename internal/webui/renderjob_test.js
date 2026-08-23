"use strict";
// Node check for the pure half of static/renderjob.js: the state machine that
// turns a POST /api/render result and each GET /api/render/{id} poll into what
// the panel should show, plus (at the bottom) the reattach-after-reload glue
// driven on a stub DOM with a stub localStorage. What is still human-only: that
// the button and panel look right, that the <video> element's own `error`
// event fires, and that a real browser reload behaves like the stub does.
//
// Lives outside static/ (like pickers_test.js and geometry_test.js) so it is
// never embedded by //go:embed all:static and never served to the browser.
// Run: node internal/webui/renderjob_test.js

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const RenderJob = require(path.join(__dirname, "static", "renderjob.js"));
const { startView, nextRenderView, pollStep, RENDER_POLL_MAX_FAILURES } = RenderJob;

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

// ---- Finding #12a: one blip must not abandon the render ---------------------

test("nextRenderView: a failed poll below the retry ceiling keeps polling instead of giving up", () => {
  const v = nextRenderView({ kind: "poll-error", message: "network error", attempt: 1 });
  assert.strictEqual(v.keepPolling, true);
  assert.strictEqual(v.buttonDisabled, true); // the render is still assumed alive
  assert.strictEqual(v.isError, false);       // a blip is not a failure yet
  assert.strictEqual(v.showVideo, false);
  assert.strictEqual(v.log, undefined);       // last-known log left alone
  assert.match(v.status, /retrying \(1\/5\)/);
});

test("nextRenderView: the last attempt inside the budget still retries", () => {
  const v = nextRenderView({ kind: "poll-error", message: "x", attempt: RENDER_POLL_MAX_FAILURES - 1 });
  assert.strictEqual(v.keepPolling, true);
});

test("nextRenderView: exhausting the budget declares the render lost and stops", () => {
  const v = nextRenderView({ kind: "poll-error", message: "server unreachable", attempt: RENDER_POLL_MAX_FAILURES });
  assert.strictEqual(v.keepPolling, false);
  assert.strictEqual(v.buttonDisabled, false);
  assert.strictEqual(v.isError, true);
  assert.match(v.status, /lost track/i);
  assert.match(v.status, /server unreachable/);
});

test("nextRenderView: retries are bounded — no attempt count ever polls forever", () => {
  for (const attempt of [RENDER_POLL_MAX_FAILURES, RENDER_POLL_MAX_FAILURES + 1, 99]) {
    assert.strictEqual(nextRenderView({ kind: "poll-error", message: "x", attempt }).keepPolling, false, `attempt ${attempt}`);
  }
});

// pollStep is the retry budget itself: drive it with a whole sequence and the
// blip/recovery/exhaustion behaviour is checkable without a browser.
test("pollStep: transient failures, a recovery that resets the budget, then a terminal state", () => {
  const sequence = [
    { id: "x", state: "running", seconds: 1 },        // fine
    { kind: "poll-error", message: "blip" },          // 1st failure
    { kind: "poll-error", message: "blip" },          // 2nd failure
    { id: "x", state: "running", seconds: 4 },        // recovered
    { kind: "poll-error", message: "blip" },          // failure count restarts
    { id: "x", state: "done", seconds: 9 },           // finished
  ];
  let failures = 0;
  const seen = [];
  for (const outcome of sequence) {
    const step = pollStep(outcome, failures);
    failures = step.failures;
    seen.push({ keepPolling: step.view.keepPolling, failures, status: step.view.status });
  }
  assert.deepStrictEqual(seen.map((s) => s.failures), [0, 1, 2, 0, 1, 0]);
  // Nothing before the terminal state stops polling — the whole point.
  assert.deepStrictEqual(seen.map((s) => s.keepPolling), [true, true, true, true, true, false]);
  assert.match(seen[2].status, /retrying \(2\/5\)/); // the count is the consecutive one
  assert.match(seen[4].status, /retrying \(1\/5\)/); // and the recovery really did reset it
  assert.match(seen[5].status, /Rendered in 9s/);
});

test("pollStep: an unbroken run of failures ends the job exactly at the ceiling, not before", () => {
  let failures = 0;
  const stops = [];
  for (let i = 0; i < RENDER_POLL_MAX_FAILURES; i++) {
    const step = pollStep({ kind: "poll-error", message: "down" }, failures);
    failures = step.failures;
    stops.push(step.view.keepPolling);
  }
  assert.deepStrictEqual(stops, [true, true, true, true, false]);
});

test("pollStep: every terminal state still stops and re-enables the button", () => {
  for (const outcome of [{ id: "x", state: "done", seconds: 1 }, { id: "x", state: "failed" }, { id: "x", state: "weird" }]) {
    const step = pollStep(outcome, 3);
    assert.strictEqual(step.view.keepPolling, false, JSON.stringify(outcome));
    assert.strictEqual(step.view.buttonDisabled, false, JSON.stringify(outcome));
    assert.strictEqual(step.failures, 0, "an answer, even a bad one, means contact is back");
  }
});

// ---- Finding #12b: a reload must not orphan the render ----------------------
// Reattaching is DOM + storage + fetch glue, so it is driven here in a vm
// context on stubs — the same shape app_js_test.js uses to boot the static
// scripts. localStorage does not exist in Node, so it is stubbed too, including
// the private-browsing case where merely touching it throws.

const fs = require("node:fs");
const vm = require("node:vm");
const staticDir = path.join(__dirname, "static");

const RENDER_JOB_KEY = "preroll-ui.render-job";

// boot loads util.js, api.js and renderjob.js into one context (classic
// <script> semantics: one shared scope) and hands back the levers a test needs.
function boot({ stored = null, storageThrows = false } = {}) {
  const els = new Map();
  const makeEl = () => ({
    innerHTML: "", textContent: "", value: "", src: "", hidden: true,
    dataset: {}, style: {}, disabled: false,
    classList: { classes: new Set(), toggle(c, on) { on ? this.classes.add(c) : this.classes.delete(c); }, add() {}, remove() {} },
    load() {}, addEventListener() {},
  });
  const document = {
    querySelector(sel) {
      if (!els.has(sel)) els.set(sel, makeEl());
      return els.get(sel);
    },
  };

  const store = new Map();
  if (stored) store.set(RENDER_JOB_KEY, stored);
  // A browser with site data blocked throws on the property access itself, not
  // on the call — so does this stub.
  const localStorage = storageThrows
    ? new Proxy({}, { get() { throw new Error("access denied"); } })
    : {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };

  const fetchLog = [];
  const replies = []; // each entry: a Response-ish object, consumed in order
  const fetchStub = (url, opts) => {
    fetchLog.push({ url, method: (opts && opts.method) || "GET" });
    const next = replies.shift();
    if (!next) return Promise.reject(new Error("no reply queued"));
    return typeof next === "function" ? next() : Promise.resolve(next);
  };

  // Timers are manual: a test decides when the next poll tick happens. A Map
  // keyed by a monotonic id, not an array, so a clearTimeout after a tick
  // cannot resurrect a slot.
  const timers = new Map();
  let lastTimer = 0;
  const ctx = vm.createContext({
    document, localStorage, fetch: fetchStub, console,
    state: { name: "test" }, // startRenderJob posts the in-editor manifest
    setTimeout: (fn) => { timers.set(++lastTimer, fn); return lastTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  for (const f of ["util.js", "api.js", "renderjob.js"]) {
    vm.runInContext(fs.readFileSync(path.join(staticDir, f), "utf8"), ctx, { filename: f });
  }
  return {
    ctx, fetchLog, replies,
    pending: () => timers.size, // how many polls are scheduled
    el: (sel) => ctx.document.querySelector(sel),
    storedId: () => (storageThrows ? null : (store.has(RENDER_JOB_KEY) ? store.get(RENDER_JOB_KEY) : null)),
    // Runs every timer scheduled so far, in order, and awaits the microtasks
    // each one queues.
    async tick() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) await fn();
    },
  };
}
const ok = (body) => ({ ok: true, json: async () => body });
const notFound = () => ({ ok: false, text: async () => "no such render" });

test("resume: nothing stored means nothing is asked of the server", async () => {
  const ui = boot();
  await ui.ctx.resumeRenderJob();
  assert.deepStrictEqual(ui.fetchLog, []);
  assert.strictEqual(ui.el("#render-panel").hidden, true);
});

test("resume: a stale stored id (404) degrades silently — no banner, and it is forgotten", async () => {
  const ui = boot({ stored: "deadbeefcafebabe" });
  ui.replies.push(notFound());
  await ui.ctx.resumeRenderJob();
  assert.deepStrictEqual(ui.fetchLog.map((f) => f.url), ["/api/render/deadbeefcafebabe"]);
  assert.strictEqual(ui.storedId(), null, "a stale id must not survive to the next reload");
  assert.strictEqual(ui.el("#render-panel").hidden, true, "the panel must stay shut on a fresh page load");
  assert.strictEqual(ui.el("#render-status").textContent, "", "no error text on a fresh page load");
  assert.strictEqual(ui.pending(), 0, "nothing left polling a job the server does not know");
});

test("resume: a still-running render is picked up and polling continues to the video", async () => {
  const ui = boot({ stored: "abc123ff00112233" });
  ui.replies.push(ok({ id: "abc123ff00112233", state: "running", seconds: 30, log: "frame=1\n" }));
  await ui.ctx.resumeRenderJob();
  assert.strictEqual(ui.el("#render-panel").hidden, false);
  assert.match(ui.el("#render-status").textContent, /Rendering… 30s/);
  assert.strictEqual(ui.el("#btn-render").disabled, true);
  assert.strictEqual(ui.el("#render-log").textContent, "frame=1\n");
  assert.strictEqual(ui.storedId(), "abc123ff00112233", "still running: the id is still worth keeping");
  assert.strictEqual(ui.pending(), 1, "the resumed job is being polled");

  ui.replies.push(ok({ id: "abc123ff00112233", state: "done", seconds: 44, log: "done\n" }));
  await ui.tick();
  assert.strictEqual(ui.el("#render-video").src, "/api/render/abc123ff00112233/video");
  assert.strictEqual(ui.el("#render-video").hidden, false);
  assert.strictEqual(ui.el("#btn-render").disabled, false);
  assert.strictEqual(ui.storedId(), null, "a finished job is forgotten");
});

test("resume: a render that finished while the page was away shows its result once, then forgets it", async () => {
  const ui = boot({ stored: "abc123ff00112233" });
  ui.replies.push(ok({ id: "abc123ff00112233", state: "failed", seconds: 3, error: "convert: no such font", log: "boom\n" }));
  await ui.ctx.resumeRenderJob();
  assert.match(ui.el("#render-status").textContent, /convert: no such font/);
  assert.strictEqual(ui.storedId(), null);
  assert.strictEqual(ui.pending(), 0);
});

test("resume: it is wired at boot, but only where there is a renderer", async () => {
  const withRenderer = boot({ stored: "abc123ff00112233" });
  withRenderer.replies.push(notFound());
  withRenderer.ctx.renderRenderControls({ render: true });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(withRenderer.fetchLog.map((f) => f.url), ["/api/render/abc123ff00112233"]);

  const without = boot({ stored: "abc123ff00112233" });
  without.ctx.renderRenderControls({ render: false });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(without.fetchLog, [], "no renderer, nothing to reattach to");
});

test("start: a started render is remembered, and every terminal state forgets it", async () => {
  const ui = boot();
  ui.replies.push({ status: 202, json: async () => ({ id: "0011223344556677" }) });
  await ui.ctx.startRenderJob();
  assert.strictEqual(ui.storedId(), "0011223344556677", "a reload mid-render must be able to find this job");
  assert.strictEqual(ui.pending(), 1);

  // A blip does NOT forget it — that is the whole point of the retry budget.
  ui.replies.push(() => Promise.reject(new Error("network down")));
  await ui.tick();
  assert.strictEqual(ui.storedId(), "0011223344556677", "a transient failure must not orphan the job");
  assert.match(ui.el("#render-status").textContent, /retrying \(1\/5\)/);
  assert.strictEqual(ui.pending(), 1, "still polling after a blip");

  for (let i = 0; i < RENDER_POLL_MAX_FAILURES - 1; i++) {
    ui.replies.push(() => Promise.reject(new Error("network down")));
    await ui.tick();
  }
  assert.match(ui.el("#render-status").textContent, /lost track/i);
  assert.strictEqual(ui.storedId(), null, "given up: nothing left to reattach to");
  assert.strictEqual(ui.pending(), 0, "polling really stopped");
});

test("storage that throws on access (private browsing) leaves the page working", async () => {
  const ui = boot({ stored: "abc123ff00112233", storageThrows: true });
  assert.doesNotThrow(() => ui.ctx.rememberRenderJob("0011223344556677"));
  assert.strictEqual(ui.ctx.rememberedRenderJob(), "");
  await ui.ctx.resumeRenderJob(); // nothing readable: nothing to resume, no throw
  assert.deepStrictEqual(ui.fetchLog, []);
  // And a render still starts and polls normally without any persistence.
  ui.replies.push({ status: 202, json: async () => ({ id: "0011223344556677" }) });
  await ui.ctx.startRenderJob();
  assert.strictEqual(ui.pending(), 1);
  assert.match(ui.el("#render-status").textContent, /Rendering/);
});
