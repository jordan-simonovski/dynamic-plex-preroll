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

let renderPollTimer = null;
let renderCapable = false;

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

// ---- DOM glue ----------------------------------------------------------------

// renderRenderControls draws the toolbar button, or nothing at all when this
// deployment has no renderer — an always-visible button that always fails is
// worse than no button.
function renderRenderControls(caps) {
  renderCapable = !!(caps && caps.render);
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
  if (view.startPolling) pollRenderJob(view.startPolling);
}

function pollRenderJob(id) {
  clearTimeout(renderPollTimer);
  renderPollTimer = setTimeout(async () => {
    let job;
    try {
      job = await apiRenderStatus(id);
    } catch (err) {
      applyRenderView(nextRenderView({ kind: "poll-error", message: err.message }));
      return; // polling stops: nothing left to ask about a request that itself failed
    }
    applyRenderView(nextRenderView(job));
    if (job.state === "running") pollRenderJob(id); // only terminal states stop the loop
  }, RENDER_POLL_MS);
}

function applyRenderView(view) {
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
  module.exports = { startView, nextRenderView };
}
