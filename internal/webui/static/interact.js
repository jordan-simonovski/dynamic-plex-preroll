"use strict";
// interact.js — dragging and resizing on the stage.
//
// Split out of stage.js because it is the one honest seam there: stage.js
// measures and draws a frame, this decides what a gesture MEANS. The split
// also buys the thing that matters most here — everything above the "pointer
// plumbing" heading is pure. It takes a pointer position already converted to
// manifest pixels plus a snapshot of the world, and returns what changed,
// mutating nothing. So a whole press/move/release sequence runs under plain
// `node` (internal/webui/interact_test.js), which is the only verification
// available: nothing in this repo can drive a real pointer.
//
// Every number still comes from geometry.js. This file only sequences it.
//
// Note for Task 11: the machine below is deliberately not the only way to
// move an element. A patch is just `{x, y}` (or `{x, startY}`, or `{size}`)
// applied to the element, so a keyboard nudge is `Geometry.nudge(el, dx, dy)`
// applied the same way — no drag needs to be faked, and no state here needs to
// exist for it. The inspector's numeric fields already write the same values
// through their own data-path binding and are untouched by any of this.
// stage.js's stageKeyNav is where that keyboard path actually lives — it is
// named differently from this file's own stageKeyDown (below) on purpose; see
// that function's comment.

// Tolerances are SCREEN pixels, divided by the live scale at press time so the
// handle and the snap feel the same size however the stage is scaled.
const INTERACT_SNAP_PX = 6;
const INTERACT_HANDLE_PX = 8;

const INTERACT_NO_GUIDES = { x: null, y: null };

const Interact = {
  SNAP_PX: INTERACT_SNAP_PX,
  HANDLE_PX: INTERACT_HANDLE_PX,
  NO_GUIDES: INTERACT_NO_GUIDES,

  // begin turns a press into a gesture. `world` is a snapshot of what is on
  // the stage: { boxes, elements, selected, width, height }.
  //
  // It returns { select, drag }. `select` is what this press selects — an
  // element index, or null for empty canvas, which selects the scene. `drag`
  // is the gesture to feed to move()/cancel(), or null when there is nothing
  // under the pointer to drag.
  //
  // A press on the SELECTED element's handle resizes it; anything else hit
  // tests afresh and moves whatever it landed on. That order is the whole
  // rule, and it is safe because the handle is only ever drawn for the
  // selected element — it can never steal a press meant for something else.
  begin(p, world) {
    const boxes = world.boxes || [];
    const elements = world.elements || [];
    const sel = world.selected;
    const onHandle = sel != null && boxes[sel] != null &&
      Geometry.onHandle(boxes[sel], p.x, p.y, INTERACT_HANDLE_PX / p.scale);
    const hit = onHandle ? sel : Geometry.hitTest(boxes, p.x, p.y);
    if (hit === -1 || !boxes[hit] || !elements[hit]) return { select: null, drag: null };

    const el = elements[hit];
    return {
      select: hit,
      drag: {
        mode: onHandle ? "resize" : "move",
        index: hit,
        // The live element, kept only so the plumbing can notice the layout
        // being replaced underneath a gesture. Nothing is computed from it.
        target: el,
        // Everything the gesture computes from is snapshotted HERE, at press
        // time. Geometry.dragPatch and Geometry.resizeSize are absolute
        // (el.x + dx, startSize * factor), so re-reading the element each
        // frame — which it has already been moving — compounds the delta and
        // the element runs away from the pointer.
        origin: {
          type: el.type,
          x: el.x || 0,
          y: el.y || 0,
          startY: el.startY || 0,
          size: el.size || 0,
        },
        box: boxes[hit],
        startX: p.x,
        startY: p.y,
        tol: INTERACT_SNAP_PX / p.scale,
        // Only the OTHER elements are snap targets: an element must not snap
        // to the box it is currently being dragged out of.
        targets: Geometry.snapTargets(world.width, world.height, boxes.filter((_, i) => i !== hit)),
      },
    };
  },

  // move returns the patch for the element this gesture owns and the guides it
  // has locked onto. It mutates nothing — the caller applies the patch — which
  // is what keeps "what gets committed, and when" in one visible place.
  move(drag, p) {
    if (!drag) return null;
    const dy = p.y - drag.startY;
    if (drag.mode === "resize") {
      return {
        patch: { size: Geometry.resizeSize(drag.origin.size, drag.box.h, dy) },
        guides: INTERACT_NO_GUIDES,
      };
    }
    return Geometry.dragPatch(drag.origin, drag.box, p.x - drag.startX, dy, drag.targets, drag.tol);
  },

  // cancel is the patch that puts the element back exactly where the press
  // found it: Escape, and a pointercancel from the OS. Without it an
  // interrupted gesture leaves a half-drag committed and the only way back is
  // retyping the numbers.
  cancel(drag) {
    if (!drag) return null;
    if (drag.mode === "resize") return { patch: { size: drag.origin.size }, guides: INTERACT_NO_GUIDES };
    return { patch: Geometry.moveTo(drag.origin, 0, 0), guides: INTERACT_NO_GUIDES };
  },
};

// ---- pointer plumbing ------------------------------------------------------
// One gesture at a time, in one variable. Pointer capture is what makes a drag
// survive leaving the canvas — exactly what happens when somebody drags an
// element to the edge of the frame and past it — and it is also why the
// release path has to tolerate a pointer that is nowhere near the stage.

let stageDrag = null;
let stageDragGuides = INTERACT_NO_GUIDES;

function stagePointerPos(e) {
  const canvas = $("#stage");
  const { width } = stageDimensions();
  return Geometry.toManifest(e.clientX, e.clientY, canvas.getBoundingClientRect(), width);
}

function stagePointerDown(e) {
  // Any press on the stage means the user is interacting with the stage, not
  // the data panel — leave data mode unconditionally, once per gesture, so
  // it covers both selectElement()'s renderInspector() call below AND
  // stageEndDrag()'s later one at release, without needing a check in either
  // (the Task 15 brief names a since-renamed "selectAt"; on disk this
  // function, plus stage.js's stageKeyNav, are the two real entry points).
  selection.dataSource = null;
  // A gesture whose pointerup never arrived (a browser dropping the event, a
  // second pointer on a touchscreen) would otherwise be overwritten here still
  // holding capture. Closing it first means there is no path to a wedged drag.
  if (stageDrag) stageEndDrag();
  const canvas = $("#stage");
  // Task 9/11 review fix: below, a press that hits an element calls
  // preventDefault() so the browser does not start its own drag-image
  // gesture — but that ALSO suppresses the compatibility mousedown event's
  // default action, which is what would otherwise have focused the canvas.
  // tabindex="0" alone is not enough, then: without this, clicking an
  // element selects it but leaves focus wherever it already was, so the
  // keyboard nudge Task 11 adds has nowhere to land right after the click
  // that was supposed to enable it. Focusing explicitly, unconditionally,
  // rather than only on the branch that calls preventDefault, is what keeps
  // an empty-canvas click (which selects the scene, not an element) equally
  // reachable by keyboard afterwards.
  canvas.focus?.();
  const layout = currentLayout();
  if (!layout) return;
  const dims = stageDimensions();
  const { select, drag } = Interact.begin(stagePointerPos(e), {
    boxes: stageBoxes(),
    elements: layout.elements || [],
    selected: selection.element,
    width: dims.width,
    height: dims.height,
  });

  // Selection commits on PRESS, before any movement: a click is just a drag
  // that went nowhere, and one handler owning both is what stops the outline
  // and the inspector disagreeing about what is selected.
  if (select !== selection.element) selectElement(select);
  stageDrag = drag;
  if (!drag) return;

  stageDrag.pointerId = e.pointerId;
  // moved tracks whether this gesture ever actually applied a patch, so a
  // press-then-release with no movement in between (a plain select-click)
  // does not cost a POST /api/convert for a manifest that did not change
  // (Task 10 review finding).
  stageDrag.moved = false;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault(); // or the browser starts its own drag of the canvas image
}

function stagePointerMove(e) {
  // Task 9/10 review finding: without the pointerId check, a second finger
  // pressing elsewhere on a touchscreen closes THIS gesture (see the orphan
  // guard in stagePointerDown) and starts its own — but the first finger, now
  // uncaptured, keeps sending pointermove events that would otherwise be read
  // as driving whatever gesture happens to be live, i.e. the second finger's.
  if (!stageDrag || e.pointerId !== stageDrag.pointerId) return;
  // A render can replace the layout's elements underneath a gesture — a
  // manifest load resolving mid-drag, a rename retargeting a layout. Writing
  // into an element nobody can see any more is worse than dropping the drag.
  if (((currentLayout() || {}).elements || [])[stageDrag.index] !== stageDrag.target) {
    stageEndDrag();
    return;
  }
  const out = Interact.move(stageDrag, stagePointerPos(e));
  Object.assign(stageDrag.target, out.patch);
  stageDrag.moved = true;
  stageDragGuides = out.guides;
  renderStage();
}

// stageEndDrag is the ONE exit. pointerup, pointercancel, Escape and a
// vanished element all come through here, so there is a single place the
// gesture is forgotten and no path that can leave it stuck holding capture.
function stageEndDrag() {
  if (!stageDrag) return;
  const canvas = $("#stage");
  const id = stageDrag.pointerId;
  if (id != null && canvas.hasPointerCapture && canvas.hasPointerCapture(id)) {
    canvas.releasePointerCapture(id);
  }
  const moved = stageDrag.moved;
  stageDrag = null;
  stageDragGuides = INTERACT_NO_GUIDES;
  renderStage();
  renderInspector(); // the numeric fields must show where it actually landed
  if (moved) scheduleConvert(); // one round-trip at the END of the gesture, not per frame
}

function stagePointerUp(e) {
  if (!stageDrag || e.pointerId !== stageDrag.pointerId) return; // the wrong finger releasing
  stageEndDrag();
}

// e is optional: the pointercancel listener passes a real event (and only
// that pointer's cancel may abort this gesture), but stageKeyDown's Escape
// path below calls this with none — a keyboard cancel is not pointer-scoped.
function stageCancelDrag(e) {
  if (!stageDrag) return;
  if (e && e.pointerId !== stageDrag.pointerId) return;
  Object.assign(stageDrag.target, Interact.cancel(stageDrag).patch);
  // moved is left exactly as stagePointerMove last set it: if the gesture
  // never moved, the revert is a true no-op (writing the origin back over
  // itself) and costs no convert either; if it had moved, moved is already
  // true and the revert still gets saved, same as before this fix.
  stageEndDrag();
}

// Escape aborts the gesture in flight. Task 11 owns the keyboard as a way to
// MOVE things; this is only the way out of a drag that is already running, so
// it stays out of the way of anything typed into the inspector.
function stageKeyDown(e) {
  if (e.key !== "Escape" || !stageDrag) return;
  stageCancelDrag();
  e.preventDefault();
}

// drawGuides paints the lines the gesture is locked onto, in manifest space
// like everything else on the stage; renderStage calls it after the selection
// outline. `px` is manifestPerCSS, so the line is one screen pixel wide
// whatever the manifest resolution.
function drawGuides(ctx, width, height, px) {
  if (stageDragGuides.x === null && stageDragGuides.y === null) return;
  ctx.save();
  ctx.strokeStyle = "rgba(229,160,13,0.9)";
  ctx.lineWidth = 1 * px;
  ctx.beginPath();
  if (stageDragGuides.x !== null) { ctx.moveTo(stageDragGuides.x, 0); ctx.lineTo(stageDragGuides.x, height); }
  if (stageDragGuides.y !== null) { ctx.moveTo(0, stageDragGuides.y); ctx.lineTo(width, stageDragGuides.y); }
  ctx.stroke();
  ctx.restore();
}

// Browser: a classic script's top-level const is visible to later scripts.
// Node: exported so interact_test.js can reach the pure half directly.
if (typeof module !== "undefined" && module.exports) module.exports = Interact;
