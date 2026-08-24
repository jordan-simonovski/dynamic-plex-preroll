"use strict";
// timeline.js — the left rail. Scenes in playback order, each sized by its own
// duration so the shape of the pre-roll is visible at a glance: a 16-second
// hero next to a 2-second sting should LOOK like that.
//
// CRITICAL FIX (Task 8 regression): selecting a card here is the ONLY place
// in the app that writes selection.sceneIndex. Before this file existed
// nothing ever did — it stayed 0 forever — so the inspector's layoutSection()
// (inspector.js), which addresses state.scenes[selection.sceneIndex]'s
// layout, could only ever reach scene 0's layout. Every other scene's layout
// (double-feature.yaml's "intermission" and "trailer-label", for instance)
// had no editing UI at all. select-scene-index below is the structural fix.

// Rail geometry, in CSS pixels.
const TIMELINE_PX_PER_SECOND = 9;
const TIMELINE_MIN_HEIGHT = 40;
const TIMELINE_MAX_HEIGHT = 220;

// sceneDuration is what the scene actually occupies. A clips scene has no
// duration of its own — it runs perClip seconds per item — so it is estimated
// from the resolved item count, falling back to the placeholder count.
function sceneDuration(scene) {
  if (!scene) return 0;
  if (scene.kind === "clips") {
    const items = stageItems(scene.source);
    const playable = items.filter((i) => i.hasMedia !== false).length || items.length;
    return (scene.perClip || 0) * playable;
  }
  return scene.duration || 0;
}

function timelineHeight(seconds) {
  return Math.max(TIMELINE_MIN_HEIGHT, Math.min(TIMELINE_MAX_HEIGHT, seconds * TIMELINE_PX_PER_SECOND));
}

function sceneSummary(sc) {
  if (sc.kind === "image") return sc.file || "(no image)";
  if (sc.kind === "clips") return sc.source ? `${sc.source} clips` : "(no source)";
  return sc.layout || "(no layout)";
}

function renderTimeline() {
  const total = state.scenes.reduce((sum, sc) => sum + sceneDuration(sc), 0);
  const cards = state.scenes.map((sc, i) => {
    const secs = sceneDuration(sc);
    return `<button type="button" class="scene-card${i === selection.sceneIndex ? " selected" : ""}"
      style="height:${timelineHeight(secs)}px"
      draggable="true" data-scene-index="${i}"
      data-action="select-scene-index" data-index="${i}"
      aria-current="${i === selection.sceneIndex}">
      <span class="scene-num">${i + 1}</span>
      <span class="scene-kind">${esc(sc.kind)}</span>
      <span class="scene-summary">${esc(sceneSummary(sc))}</span>
      <span class="scene-secs">${secs ? `${Math.round(secs * 10) / 10}s` : "—"}</span>
    </button>`;
  }).join("");

  $("#rail").innerHTML = `
    <h2>Timeline</h2>
    <p class="muted">${state.scenes.length} scene${state.scenes.length === 1 ? "" : "s"} · ${Math.round(total * 10) / 10}s</p>
    <p class="muted">Drag a card to reorder, or with one focused: Alt+↑ / Alt+↓.</p>
    <div class="scene-list" id="scene-list">${cards || `<p class="empty">No scenes yet.</p>`}</div>
    <div class="rail-actions">
      <button type="button" class="btn" data-action="add-scene" data-kind="render">+ Frame</button>
      <button type="button" class="btn ghost" data-action="add-scene" data-kind="clips">+ Clips</button>
      <button type="button" class="btn ghost" data-action="add-scene" data-kind="image">+ Image</button>
      <button type="button" class="btn ghost danger" data-action="remove-scene-selected">Remove scene</button>
    </div>`;
  wireSceneDrag();
}

// moveScene reorders and keeps the selection pointing at the SAME scene, not
// the same position — the user dragged a thing, not an index.
function moveScene(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.scenes.length || to >= state.scenes.length) return;
  selection.dataSource = null; // leave the data panel
  const [moved] = state.scenes.splice(from, 1);
  state.scenes.splice(to, 0, moved);
  if (selection.sceneIndex === from) selection.sceneIndex = to;
  else if (from < selection.sceneIndex && to >= selection.sceneIndex) selection.sceneIndex--;
  else if (from > selection.sceneIndex && to <= selection.sceneIndex) selection.sceneIndex++;
}

// railReorderTarget is the Task 11 keyboard path for what moveScene() above
// otherwise only reaches by HTML5 drag-and-drop — the retired Scenes card had
// per-row up/down buttons, and losing them to a pointer-only rail would be
// exactly the capability regression this phase is not allowed to introduce.
// Pure (no DOM) so the decision is testable with plain {key, altKey} shapes
// under `node`, same as stage.js's stageKeyAction; the DOM glue below
// (sceneCardKeyDown) is the untestable sliver that turns it into a moveScene
// call and puts focus back on the card that moved.
//
// Alt+Up/Down rather than the bare arrow: plain Up/Down while a card is
// focused would look like it should move focus between cards, and nothing
// here does that (cards are Tabbed to individually).
function railReorderTarget(index, key, altKey, count) {
  if (!altKey) return null;
  if (key === "ArrowUp") return index > 0 ? index - 1 : null;
  if (key === "ArrowDown") return index < count - 1 ? index + 1 : null;
  return null;
}

function focusSceneCard(index) {
  document.querySelector(`.scene-card[data-scene-index="${index}"]`)?.focus?.();
}

function sceneCardKeyDown(e) {
  const card = e.currentTarget;
  const from = +card.dataset.sceneIndex;
  const to = railReorderTarget(from, e.key, e.altKey, state.scenes.length);
  if (to == null) return;
  e.preventDefault();
  moveScene(from, to);
  onStateChange();
  // moveScene keeps the SAME scene selected, not the same position, so the
  // card to refocus is the one it moved TO — mirroring that same philosophy
  // for focus: the user reordered a thing, not an index.
  focusSceneCard(to);
}

// HTML5 drag-and-drop rather than pointer events: it is native, it gives the
// drag image for free, and reordering a list is exactly what it is for. The
// stage uses pointer events because it needs sub-pixel positions; this does not.
let dragSceneIndex = null;
function wireSceneDrag() {
  for (const card of document.querySelectorAll(".scene-card")) {
    card.addEventListener("keydown", sceneCardKeyDown);
    card.addEventListener("dragstart", (e) => {
      dragSceneIndex = +card.dataset.sceneIndex;
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag without data set.
      e.dataTransfer.setData("text/plain", String(dragSceneIndex));
    });
    card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drop-target"); });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drop-target");
      if (dragSceneIndex === null) return;
      moveScene(dragSceneIndex, +card.dataset.sceneIndex);
      dragSceneIndex = null;
      onStateChange();
    });
    card.addEventListener("dragend", () => {
      dragSceneIndex = null;
      for (const c of document.querySelectorAll(".scene-card")) c.classList.remove("drop-target");
    });
  }
}

// ---- actions ---------------------------------------------------------------
actions["select-scene-index"] = (d) => {
  selection.sceneIndex = +d.index;
  selection.element = null;
  selection.dataSource = null; // leave the data panel
  renderTimeline();
  renderStage();
  renderInspector();
};
actions["add-scene"] = (d) => {
  state.scenes.push(sceneDefaults(d.kind));
  selection.sceneIndex = state.scenes.length - 1;
  selection.element = null;
  selection.dataSource = null; // leave the data panel
  onStateChange();
};
actions["remove-scene-selected"] = () => {
  if (!state.scenes.length) return;
  state.scenes.splice(selection.sceneIndex, 1);
  selection.sceneIndex = Math.max(0, Math.min(selection.sceneIndex, state.scenes.length - 1));
  selection.element = null;
  selection.dataSource = null; // leave the data panel
  onStateChange();
};
