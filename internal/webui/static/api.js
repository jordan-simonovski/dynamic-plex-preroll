"use strict";
// api.js — every network call the UI makes, in one place. Each function returns
// plain data and never touches the DOM, so the views stay free of fetch/JSON
// plumbing and a failing server has exactly one place to be handled.

async function apiConvert(manifest) {
  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    return await res.json();
  } catch (err) {
    return { yaml: "", errors: [`server unreachable: ${err.message}`] };
  }
}

async function apiListManifests() {
  try {
    return await (await fetch("/api/manifests")).json();
  } catch {
    return []; // the list is a convenience; the editor still works without it
  }
}

// Throws on both a refused request and a non-2xx reply; the caller reports
// either the same way, so one catch covers both.
async function apiGetManifest(name) {
  const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiSaveManifest(name, manifest) {
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    return res.ok ? { ok: true } : { ok: false, error: await res.text() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function apiDeleteManifest(name) {
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`, { method: "DELETE" });
    return res.ok ? { ok: true } : { ok: false, error: await res.text() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Resolving data runs the real providers, so it can be slow and it can fail;
// both are ordinary and the caller gets a well-formed answer either way (see
// internal/webui/data.go: it always answers 200).
async function apiResolveData(dataMap) {
  try {
    const res = await fetch("/api/data/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: dataMap }),
    });
    return await res.json();
  } catch (err) {
    return { configured: false, reason: err.message, sources: {} };
  }
}

async function apiCapabilities() {
  try {
    return await (await fetch("/api/capabilities")).json();
  } catch {
    // Everything optional is off when we cannot ask — the safe default, since
    // every caller uses these flags to decide whether to SHOW a feature.
    return { plex: false, render: false, media: false };
  }
}

// The media listing changes only when someone adds a file, so it is fetched
// once and reused until the picker closes — pickers.js drops it there, so
// reopening the dialog sees a file added since.
let fileListCache = null;
async function apiListFiles() {
  if (fileListCache) return fileListCache;
  try {
    fileListCache = await (await fetch("/api/files")).json();
  } catch {
    fileListCache = { files: [], roots: [] };
  }
  return fileListCache;
}
function invalidateFileList() { fileListCache = null; }

// apiStartRender posts the in-editor manifest as-is — not the saved file, if
// any — so Render always previews what is on screen. The server parses and
// validates it before doing anything slow, so an invalid manifest fails in
// milliseconds with the validator's own message rather than after minutes of
// rendering; res.ok false covers that 422 the same way it covers a 409
// (another render already running) or a 503 (no renderer configured).
async function apiStartRender(manifest) {
  try {
    const res = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    if (res.status === 202) return { ok: true, id: (await res.json()).id };
    return { ok: false, error: await res.text() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Throws on both a refused request and a non-2xx reply, same as
// apiGetManifest above: pollRenderJob is the only caller and already wraps
// this in a try/catch, so one catch there covers both.
async function apiRenderStatus(id) {
  const res = await fetch(`/api/render/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}
