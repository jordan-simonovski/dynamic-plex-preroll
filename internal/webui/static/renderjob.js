"use strict";
// renderjob.js — "Render preview" in the toolbar, the progress it reports, and
// the video that comes out. Rendering is a subprocess that can take minutes,
// so nothing here blocks: the button starts a job, a timer polls it, and the
// panel below the stage shows whatever the renderer has said so far.
//
// The state machine (nextRenderView/startView) is kept pure and DOM-free on
// purpose — it is checked head-on by renderjob_test.js against synthetic poll
// responses. Everything below it is DOM glue: apply the view to the page, or
// wire the one thing that isn't state-driven (the <video> element's own
// `error` event, fired by the browser itself when a superseded file 404s).

const RENDER_POLL_MS = 1000;
// How many CONSECUTIVE failed status requests it takes to declare a render
// lost. A render takes minutes; a dropped request in the middle of that is
// usually a blip (a laptop's wifi, the server restarting), and giving up on
// the first one leaves nothing asking about a subprocess that is still going.
// Bounded, and the cadence is unchanged: resilience, not aggression.
const RENDER_POLL_MAX_FAILURES = 5;
// Where the running job's id is parked so a page reload can find it again.
const RENDER_JOB_KEY = "preroll-ui.render-job";

let renderPollTimer = null;

// ---- pure state machine -----------------------------------------------------

// startView turns apiStartRender()'s result into what the panel should show
// right after the POST answers. res.ok false covers every non-202 reply alike
// — invalid manifest (422), a render already running (409), or no renderer at
// all (503) — because the server's own text is the useful message in all three
// cases and there is nothing UI-specific to add.
function startView(res) {
  if (!res.ok) {
    return { status: `Not rendered: ${res.error}`, isError: true, buttonDisabled: false, startPolling: null };
  }
  return { status: "Rendering… this can take a few minutes.", isError: false, buttonDisabled: true, startPolling: res.id };
}

// nextRenderView turns one poll response (or a poll-error sentinel, when the
// GET itself failed) into what the panel should show. job.log is the
// renderer's own stdout/stderr — the only honest progress signal there is —
// shown verbatim rather than turned into an invented percentage.
function nextRenderView(job) {
  if (job.kind === "poll-error") {
    // job.attempt is the count of CONSECUTIVE failures including this one.
    // Below the ceiling the render is still assumed alive and polling
    // continues (button stays disabled, log untouched); at or above it the
    // job is declared lost. A poll-error with no attempt count is treated as
    // exhausted — fail closed, same spirit as the unknown-state branch below.
    // A 404 (this job was superseded by a newer render) lands here too: it is
    // indistinguishable from a dropped request without inspecting the status
    // code, and the cost of not distinguishing them is a few seconds' delay
    // before the same "lost track" message.
    if (job.attempt < RENDER_POLL_MAX_FAILURES) {
      return {
        status: `Lost contact with the render — retrying (${job.attempt}/${RENDER_POLL_MAX_FAILURES})`,
        isError: false, buttonDisabled: true, keepPolling: true, log: undefined, showVideo: false,
      };
    }
    return { status: `Lost track of the render: ${job.message}`, isError: true, buttonDisabled: false, keepPolling: false, log: undefined, showVideo: false };
  }
  if (job.state === "running") {
    return {
      status: `Rendering… ${Math.round(job.seconds || 0)}s`, isError: false,
      buttonDisabled: true, keepPolling: true, log: job.log || "", showVideo: false,
    };
  }
  if (job.state === "failed") {
    return {
      status: `Render failed: ${job.error || "see the output below"}`, isError: true,
      buttonDisabled: false, keepPolling: false, log: job.log || "", showVideo: false,
    };
  }
  if (job.state === "done") {
    return {
      status: `Rendered in ${Math.round(job.seconds)}s`, isError: false,
      buttonDisabled: false, keepPolling: false, log: job.log || "", showVideo: true,
      videoSrc: `/api/render/${encodeURIComponent(job.id)}/video`,
    };
  }
  // Fail closed: an unrecognised state is shown as an error, never as a
  // success. render.go only ever emits running|failed|done today, so this is
  // unreachable in practice — but a silent fall-through here would present a
  // future/unknown state as a finished render, video and all.
  return {
    status: `Unexpected render state: ${job.state}`, isError: true,
    buttonDisabled: false, keepPolling: false, log: job.log || "", showVideo: false,
  };
}

// pollStep folds one poll outcome and the running failure count into the view
// to show and the count to carry forward. It exists so the whole retry budget
// — a blip, a recovery resetting it, and the exhaustion that ends the job — is
// one pure function a headless test can drive with a sequence of responses,
// rather than arithmetic buried in a setTimeout.
function pollStep(outcome, failures) {
  if (outcome.kind === "poll-error") {
    const attempt = failures + 1;
    return { view: nextRenderView({ ...outcome, attempt }), failures: attempt };
  }
  // Any answer from the server, whatever it says, means contact is back.
  return { view: nextRenderView(outcome), failures: 0 };
}

// ---- DOM glue ----------------------------------------------------------------

// The stored job id survives a reload; localStorage can throw outright (private
// browsing, site data blocked), and a render preview is not worth taking the
// page down for, so both directions swallow it.
function rememberRenderJob(id) {
  try {
    if (id) localStorage.setItem(RENDER_JOB_KEY, id);
    else localStorage.removeItem(RENDER_JOB_KEY);
  } catch { /* no storage: reattach is simply unavailable */ }
}
function rememberedRenderJob() {
  try {
    return localStorage.getItem(RENDER_JOB_KEY) || "";
  } catch {
    return "";
  }
}

// resumeRenderJob reattaches to a render that was running when the page was
// reloaded. A stored id that the server no longer knows — a finished-and-
// superseded job, a restarted server, a stale id from days ago — 404s, and
// that is NOT an error worth a banner on a fresh page load: there is simply
// nothing to resume, so it is forgotten silently. Only a live answer opens the
// panel.
async function resumeRenderJob() {
  const id = rememberedRenderJob();
  if (!id) return;
  let job;
  try {
    job = await apiRenderStatus(id);
  } catch {
    rememberRenderJob(""); // unknown id: nothing to resume, nothing to say
    return;
  }
  $("#render-panel").hidden = false;
  const view = nextRenderView(job);
  applyRenderView(view); // clears the stored id if this is already terminal
  if (view.keepPolling) pollRenderJob(id);
}

// renderRenderControls draws the toolbar button, or nothing at all when this
// deployment has no renderer — an always-visible button that always fails is
// worse than no button.
function renderRenderControls(caps) {
  const renderCapable = !!(caps && caps.render);
  $("#render-actions").innerHTML = renderCapable
    ? `<button class="btn" id="btn-render">Render preview</button>`
    : `<span class="muted" title="Start the UI with -render-bin pointing at the plex-pre-rolls binary">Rendering unavailable</span>`;
  if (!renderCapable) return;
  $("#btn-render").onclick = startRenderJob;
  // A finished render's files are deleted the instant a new render starts —
  // there is only one scratch slot server-side — so a <video> left open on the
  // old file 404s on its next range request. The browser reports that as a
  // native `error` event on the element, not a thrown exception, so it is
  // handled here rather than in the poll loop.
  $("#render-video").onerror = () => {
    const video = $("#render-video");
    if (video.hidden || !video.src) return; // no active playback to lose
    video.hidden = true;
    setRenderStatus("This render's video is no longer available — a newer render replaced it.", true);
  };
  // A render survives the page that started it, so pick one up if we reloaded
  // mid-render. Last, so the panel it may fill is fully wired first; and
  // fire-and-forget, because nothing here depends on the outcome.
  resumeRenderJob();
}

async function startRenderJob() {
  const panel = $("#render-panel");
  const btn = $("#btn-render");
  // Disabled synchronously, before the POST is even sent: apiStartRender is
  // async, and without this a second click during "Validating…" could fire a
  // second POST that the server correctly refuses (409) but that would just
  // race the first request's own "Rendering…" status.
  if (btn) btn.disabled = true;
  panel.hidden = false;
  setRenderStatus("Validating…");
  $("#render-video").hidden = true;
  $("#render-log").textContent = "";

  const res = await apiStartRender(state);
  const view = startView(res);
  setRenderStatus(view.status, view.isError);
  if (btn) btn.disabled = view.buttonDisabled;
  if (view.startPolling) {
    rememberRenderJob(view.startPolling); // so a reload can find this render again
    pollRenderJob(view.startPolling);
  }
}

// failures is the count of consecutive failed status requests carried between
// ticks; a good answer resets it (pollStep), so only an unbroken run of
// failures ends the job.
function pollRenderJob(id, failures = 0) {
  clearTimeout(renderPollTimer);
  renderPollTimer = setTimeout(async () => {
    let outcome;
    try {
      outcome = await apiRenderStatus(id);
    } catch (err) {
      outcome = { kind: "poll-error", message: err.message };
    }
    // keepPolling IS the decision — re-deriving it from job.state here would
    // be a second copy of the state machine, free to disagree with the one the
    // tests pin.
    const step = pollStep(outcome, failures);
    applyRenderView(step.view);
    if (step.view.keepPolling) pollRenderJob(id, step.failures);
  }, RENDER_POLL_MS);
}

function applyRenderView(view) {
  // Every terminal state forgets the job: there is nothing left to reattach
  // to, and a stored id outliving its job is what would make the next reload
  // ask about a render that is over.
  if (!view.keepPolling) rememberRenderJob("");
  setRenderStatus(view.status, view.isError);
  if (view.log !== undefined) $("#render-log").textContent = view.log;
  const btn = $("#btn-render");
  if (btn) btn.disabled = view.buttonDisabled;
  if (view.showVideo) {
    const video = $("#render-video");
    video.src = view.videoSrc;
    video.hidden = false;
    video.load();
  }
}

function setRenderStatus(text, isError = false) {
  const el = $("#render-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// Node: exported for renderjob_test.js. Browser: the functions above are
// already global from the classic script.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { startView, nextRenderView, pollStep, RENDER_POLL_MAX_FAILURES };
}
