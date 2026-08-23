# Pre-roll UI Phase 2 — Visual Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the phase-1 form into a scene-centric visual editor: a live 16:9 stage that draws the selected scene exactly where the renderer will draw it, drag-and-drop element placement, a contextual inspector with colour/file/template pickers, real Plex data behind the preview, and a one-click render that plays the resulting mp4 in the page.

**Architecture:** Three-column shell — scene timeline (left), stage canvas (centre), contextual inspector (right) — over the same mutable `state` object that already mirrors the DSL. All layout maths lives in one **pure, DOM-free** module (`geometry.js`) that mirrors `internal/render/render.go` rule for rule, so the drawing and hit-testing logic is unit-testable in Node with no browser. The Go server grows four read-mostly capabilities alongside the existing manifest API: media-file enumeration, live Plex data resolution (with an image proxy), a capability probe, and a render endpoint that shells out to the already-built `plex-pre-rolls` binary as a subprocess. `cmd/preroll-ui` stays `CGO_ENABLED=0`; every heavy dependency is reached across a process boundary or not at all.

**Tech Stack:** Go 1.26 stdlib (`net/http` method routing, `embed`, `os/exec`), `gopkg.in/yaml.v3` and `github.com/kelseyhightower/envconfig` (both already dependencies), vanilla HTML/CSS/JS with no build step, `<canvas>` 2D, `node --test` for the pure-JS unit tests.

**Model assignment:** Each task carries a **Model:** line. Opus for the tasks that set architecture — the frontend file split, the stage geometry and interaction model, the render-subprocess design. Sonnet for tasks that follow an established pattern.

## Global Constraints

- Go version: `go 1.26` (from `go.mod`). **No new Go module dependencies.** Stdlib plus the existing `gopkg.in/yaml.v3`, `github.com/kelseyhightower/envconfig`, `golang.org/x/term`.
- **No JS build step, no npm, no CDN, no external fonts or assets.** Plain files served from `embed.FS`, loaded with `<script src>` in dependency order. The editor must work with the machine fully offline.
- `cmd/preroll-ui` MUST build with `CGO_ENABLED=0` and MUST NEVER import `internal/render`, `internal/engine`, `internal/pipeline`, or `gopkg.in/gographics/imagick.v2`. Rendering happens ONLY by executing the `plex-pre-rolls` binary as a subprocess.
- The manifest directory is read by the batch renderer: saves stay **fail-closed** (`manifest.Parse`, never `Decode`, before writing) and **atomic** (temp file + `os.Rename`, as `writeManifest` already does). Render scratch files NEVER land in the manifest directory.
- Manifest filenames from the client stay validated by the existing `nameRE = ^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(yaml|yml)$`. Every new path-taking endpoint must be equally traversal-proof: resolve with `filepath.Abs`, then reject anything not under an allowed root.
- Do NOT surface `Scene.Transition` — it exists in the DSL but is consumed nowhere in the engine.
- **Degrade, never break.** With no Plex connection, no `plex-pre-rolls` binary, and no media directory, the editor must remain fully usable: placeholder data on the stage, hidden render button, empty file picker with an explanatory line. Every live feature is additive.
- The stage is a *preview*, not a renderer. Where it can only approximate `render.go` (font fallback, ImageMagick's `ModulateImage` dimming vs a black overlay, trailer video frames), the UI says so in the interface rather than pretending.
- Tests: std `testing` for Go; `node --test` for the pure JS modules. No testify, no JS test framework, no fixtures beyond literals.
- **No browser automation is available in this environment.** Any step that can only be confirmed by clicking is written as an explicit **Human check** with the exact thing to look at. Everything provable headlessly is proved headlessly — that is why the geometry is a pure module.
- Commit after every task with the message given in the task.

## Where the user's six explicit asks are delivered

| Ask | Delivered by |
| --- | --- |
| Data sources explained and testable | Task 5 (`POST /api/data/resolve`), Task 15 (descriptions + "Test this source" table) |
| File picker for fonts/images/audio | Task 4 (`GET /api/files`, `GET /api/files/raw`), Task 13 (browsable dialog with font/image previews) |
| Template picker + plain-English explanation | Task 14 (catalogue, explanations, live example, insert-at-cursor) |
| Colour picker + swatch | Task 12 (native `<input type="color">` + swatch + DSL-safe text field) |
| Video preview of the result | Task 17 (`<video>` fed by `GET /api/render/{id}/video`) |
| One-off render from the UI | Task 16 (subprocess endpoints), Task 17 (button, progress, error surfacing) |

## File Structure

### Go — created

```
internal/webui/capabilities.go        GET /api/capabilities — what this deployment can do (plex? render? media?)
internal/webui/capabilities_test.go
internal/webui/files.go               GET /api/files (enumerate media roots), GET /api/files/raw (serve one, traversal-proof)
internal/webui/files_test.go
internal/webui/plexsource.go          Optional Plex wiring: env -> plexclient + provider registry, nil when unconfigured
internal/webui/data.go                POST /api/data/resolve (run real providers), GET /api/plex/image (allowlisted proxy)
internal/webui/data_test.go
internal/webui/render.go              POST /api/render, GET /api/render/{id}, GET /api/render/{id}/video — subprocess job
internal/webui/render_test.go
internal/webui/static_test.go         Asserts every <script src> in index.html exists in the embed FS
```

### Go — modified

```
internal/configmanager/configmanager.go   Add non-panicking ReadConfig(); MustReadConfig wraps it
internal/configmanager/configmanager_test.go
internal/webui/webui.go                   Server gains MediaDirs/RenderBin/RenderDir/WorkDir/Plex; new routes registered
cmd/preroll-ui/main.go                    New flags/env: -media-dir, -render-bin, -render-dir; optional Plex wiring
Dockerfile                                preroll-ui binary built into the plex-pre-rolls stage; standalone stage removed
docker-compose.yml                        Single combined image for both services
README.md                                 Visual editor section: what it does, the env it wants, offline behaviour
```

### Frontend — final file set (`internal/webui/static/`)

Loaded in this order; each is a classic script, so top-level `const` bindings are visible to later scripts.

```
providers.js    (modify) PURE DATA. Provider descriptions + per-param explanations, template variable/function
                         catalogue with plain-English text and example output. No DOM, no state.
util.js         (create) $, esc, field/textInput/numInput/select builders, getPath/setPath/coerce, uniqueKey,
                         flash, debounce. No knowledge of the manifest's shape.
state.js        (create) emptyManifest, the `state` object, normalize(), key renames + reference retargeting,
                         sceneDefaults, defaultParams, and the selection model (selected scene / element).
geometry.js     (create) PURE, DOM-FREE layout maths mirroring internal/render/render.go: baselines, boxes,
                         hit-testing, snapping, drag/resize patches, cover/grid rects. Node-testable.
geometry.test.js(create) node --test unit tests for geometry.js.
syntax.test.js  (create) node --test: every static .js file parses.
api.js          (create) Every fetch: convert, manifests CRUD, capabilities, data resolve, files, render job.
                         Returns plain data or throws; no DOM.
stage.js        (create) The canvas: draws the selected scene, owns pointer interactions, uses geometry.js.
timeline.js     (create) Left rail: scene thumbnails with durations to scale, drag reorder, add-scene.
inspector.js    (create) Right panel: property forms for the selected element / scene / pre-roll / data source.
pickers.js      (create) Colour picker+swatch, file picker dialog, template inserter. Reused by inspector.js.
renderjob.js    (create) Render button, job polling, <video> preview, error surfacing.
app.js          (modify) Boot, toolbar (new/open/save/delete/start-from-template), YAML drawer toggle, event wiring.
sections.js     (create in Task 2, DELETED by Task 15) Temporary home for the phase-1 stacked-card renderers
                         while the visual editor is built beside them. Retired card by card.
index.html      (modify) Three-column shell, YAML drawer, script tags.
style.css       (modify) Layout for rail/stage/inspector, dialogs, swatches, timeline, video panel.
```

**Why this split:** `geometry.js` is separated first and hardest because it is the only part of the visual editor that can be tested without a browser — keeping it pure is what makes the rest verifiable at all. `state.js` and `util.js` split along "knows the DSL" vs "doesn't". `stage.js`, `timeline.js`, `inspector.js` are the three panes and change independently. `pickers.js` is shared by inspector and the toolbar, so it cannot live inside either.

---

### Task 1: Non-panicking config read + capabilities endpoint

**Model:** Sonnet — mechanical refactor plus one small handler, fully specified below.

The UI must start with no Plex env at all. `configmanager.MustReadConfig()` panics on missing required vars, so the UI needs a variant that returns an error. `GET /api/capabilities` is then the single place the frontend asks "what can this deployment do", so every later feature has one flag to hide behind.

**Files:**
- Modify: `internal/configmanager/configmanager.go`
- Modify: `internal/configmanager/configmanager_test.go`
- Modify: `internal/webui/webui.go`
- Create: `internal/webui/capabilities.go`
- Create: `internal/webui/capabilities_test.go`

**Interfaces:**
- Produces:
  - `func configmanager.ReadConfig() (Config, error)` — same parse as `MustReadConfig`, returns the error instead of panicking.
  - `webui.Server` gains fields: `MediaDirs []string`, `RenderBin string`, `RenderDir string`, `WorkDir string`, `Plex *PlexSource` (the last defined in Task 5; declared as a nil-able pointer here via a forward type in `plexsource.go`, so **Task 5 must land the type**; until then the field is declared in Task 5, not here).
  - `GET /api/capabilities` → `{"plex":bool,"render":bool,"media":bool,"plexError":string}`.

- [ ] **Step 1: Write the failing config test**

Append to `internal/configmanager/configmanager_test.go`:

```go
func TestReadConfigReturnsErrorInsteadOfPanicking(t *testing.T) {
	for _, key := range []string{"PLEX_URL", "PLEX_TOKEN", "MAX_ITEMS", "PERIOD_INTERVAL", "MOVIE_SECTION_ID", "TV_SHOW_SECTION_ID"} {
		t.Setenv(key, "")
	}
	if _, err := ReadConfig(); err == nil {
		t.Fatal("want an error when required vars are unset, got nil")
	}
}

func TestReadConfigSucceedsWhenSet(t *testing.T) {
	t.Setenv("PLEX_URL", "http://plex:32400")
	t.Setenv("PLEX_TOKEN", "tok")
	t.Setenv("MAX_ITEMS", "5")
	t.Setenv("PERIOD_INTERVAL", "MONTH")
	t.Setenv("MOVIE_SECTION_ID", "1")
	t.Setenv("TV_SHOW_SECTION_ID", "2")
	cfg, err := ReadConfig()
	if err != nil {
		t.Fatalf("ReadConfig: %v", err)
	}
	if cfg.PlexURL != "http://plex:32400" || cfg.MaxItems != 5 {
		t.Fatalf("config not populated: %+v", cfg)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./internal/configmanager/ -run ReadConfig -v`
Expected: FAIL — `undefined: ReadConfig`.

- [ ] **Step 3: Add `ReadConfig` and make `MustReadConfig` wrap it**

In `internal/configmanager/configmanager.go`, replace the `MustReadConfig` function with:

```go
// ReadConfig returns the application configuration, or the reason it could not
// be read. Callers that can run without Plex (the config UI) use this; the
// batch renderer cannot, and uses MustReadConfig.
func ReadConfig() (Config, error) {
	conf := &Config{}
	if err := envconfig.Process(envVarPrefix, conf); err != nil {
		return Config{}, err
	}
	return *conf, nil
}

// MustReadConfig Returns a shallow copy of application configuration. Panics if the configuration is invalid.
func MustReadConfig() Config {
	conf, err := ReadConfig()
	if err != nil {
		panic(err)
	}
	return conf
}
```

- [ ] **Step 4: Run the config tests**

Run: `go test ./internal/configmanager/ -v`
Expected: PASS, including `TestReadConfigReturnsErrorInsteadOfPanicking` and `TestReadConfigSucceedsWhenSet`.

- [ ] **Step 5: Write the failing capabilities test**

Create `internal/webui/capabilities_test.go`:

```go
package webui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCapabilitiesAllOff(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "GET", ts.URL+"/api/capabilities", "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var caps capabilities
	if err := json.NewDecoder(res.Body).Decode(&caps); err != nil {
		t.Fatal(err)
	}
	if caps.Plex || caps.Render || caps.Media {
		t.Fatalf("a bare server must advertise nothing: %+v", caps)
	}
}

func TestCapabilitiesReportsRenderAndMedia(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "plex-pre-rolls")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	media := filepath.Join(dir, "media")
	if err := os.MkdirAll(media, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Server{ManifestDir: dir, RenderBin: bin, MediaDirs: []string{media}}
	caps := s.capabilitySet()
	if !caps.Render {
		t.Error("an executable render binary must report render:true")
	}
	if !caps.Media {
		t.Error("an existing media dir must report media:true")
	}
}
```

- [ ] **Step 6: Run it and watch it fail**

Run: `go test ./internal/webui/ -run Capabilities -v`
Expected: FAIL — `undefined: capabilities`, `undefined: capabilitySet`.

- [ ] **Step 7: Add the Server fields and the capabilities handler**

In `internal/webui/webui.go`, replace the `Server` struct and add the new route:

```go
// Server is the config UI's HTTP server. ManifestDir is where manifests are
// listed, loaded, saved, and deleted. Everything else is optional: each unset
// field simply switches its feature off, so the editor runs with nothing but
// a manifest directory.
type Server struct {
	ManifestDir string
	// MediaDirs are the roots the file picker may enumerate and serve from.
	// Nothing outside them is ever readable through the API.
	MediaDirs []string
	// RenderBin is the path to the plex-pre-rolls binary. Empty (or not
	// executable) hides the render button.
	RenderBin string
	// RenderDir holds render scratch: the generated manifest and the mp4. It
	// is deliberately NOT the manifest directory, which the batch renderer globs.
	RenderDir string
	// WorkDir is the working directory render subprocesses run in, so relative
	// manifest paths (media/common/Font.ttf) resolve the same way they do for a
	// batch run. Empty means the UI process's own directory.
	WorkDir string
}
```

and in `Handler()`, immediately after `mux.HandleFunc("POST /api/convert", s.convert)`:

```go
	mux.HandleFunc("GET /api/capabilities", s.capabilities)
```

Create `internal/webui/capabilities.go`:

```go
package webui

import (
	"net/http"
	"os"
)

// capabilities tells the browser which optional features this deployment can
// actually perform, so the UI hides what would only fail. Everything here is
// off by default: the editor's core (edit, validate, save) never depends on it.
type capabilities struct {
	Plex   bool `json:"plex"`
	Render bool `json:"render"`
	Media  bool `json:"media"`
	// PlexError explains why Plex is off, so the UI can say "PLEX_TOKEN unset"
	// instead of silently showing placeholders forever.
	PlexError string `json:"plexError,omitempty"`
}

func (s *Server) capabilities(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.capabilitySet())
}

// capabilitySet probes the filesystem each call rather than caching: a user who
// mounts a media volume or drops the render binary in place mid-session should
// see the feature appear on the next reload, not need a restart.
func (s *Server) capabilitySet() capabilities {
	caps := capabilities{}
	if info, err := os.Stat(s.RenderBin); s.RenderBin != "" && err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
		caps.Render = true
	}
	for _, dir := range s.MediaDirs {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			caps.Media = true
			break
		}
	}
	return caps
}
```

- [ ] **Step 8: Run the webui tests**

Run: `go test ./internal/webui/ -v`
Expected: PASS — all pre-existing tests plus `TestCapabilitiesAllOff` and `TestCapabilitiesReportsRenderAndMedia`.

- [ ] **Step 9: Confirm the UI binary still builds CGO-free**

Run: `CGO_ENABLED=0 go build -o /dev/null ./cmd/preroll-ui && go vet ./...`
Expected: no output, exit 0.

- [ ] **Step 10: Commit**

```bash
git add internal/configmanager/ internal/webui/webui.go internal/webui/capabilities.go internal/webui/capabilities_test.go
git commit -m "webui: non-panicking config read and a capabilities probe"
```

---

### Task 2: Split the frontend into focused files (no behaviour change)

**Model:** Opus — this decides the module boundaries every later task builds on, and it is a refactor of live, working code that must come out byte-for-byte equivalent in behaviour.

`app.js` is ~650 lines and will roughly triple. Split it **before** adding anything, so every later task lands in a small file. This task adds no features: at the end the page looks and behaves exactly as it does now.

**Files:**
- Create: `internal/webui/static/util.js`
- Create: `internal/webui/static/state.js`
- Create: `internal/webui/static/api.js`
- Create: `internal/webui/static/sections.js`
- Create: `internal/webui/static/syntax.test.js`
- Create: `internal/webui/static_test.go`
- Modify: `internal/webui/static/app.js`
- Modify: `internal/webui/static/index.html`

**Interfaces:**
- Produces (later tasks depend on these exact names):
  - `util.js`: `$(sel)`, `esc(s)`, `field(label, inputHTML, hint)`, `textInput(path, value, opts)`, `numInput(path, value, opts)`, `select(path, value, options, opts)`, `getPath(obj, path)`, `setPath(obj, path, value)`, `coerce(input)`, `uniqueKey(map, base)`, `flash(msg, isError)`, `debounce(fn, ms)`.
  - `state.js`: mutable `state`, `emptyManifest()`, `normalize(m)`, `replaceState(m)`, `renameKey(mapPath, oldKey, newKey)`, `retargetSource(o,n)`, `retargetLayout(o,n)`, `sceneDefaults(kind)`, `defaultParams(provider)`, `deriveOutput(name)`, and the shared registries `actions` and `rerenderHooks`.
  - `api.js`: `async apiConvert(manifest)` → `{yaml, errors}`, `async apiListManifests()` → `string[]`, `async apiGetManifest(name)` → manifest object, `async apiSaveManifest(name, manifest)` → `{ok, error}`, `async apiDeleteManifest(name)` → `{ok, error}`, `async apiCapabilities()` → `{plex,render,media,plexError}`.
  - `sections.js`: `renderGeneral()`, `renderAudio()`, `renderData()`, `renderLayouts()`, `renderScenes()`, `renderAll()`.
  - `app.js`: `renderToolbar()`, `scheduleConvert()`, `convert()`, boot.

- [ ] **Step 1: Write the failing static-wiring test**

Create `internal/webui/static_test.go`:

```go
package webui

import (
	"io/fs"
	"regexp"
	"testing"
)

var scriptSrcRE = regexp.MustCompile(`<script src="([^"]+)"`)

// The page loads plain classic scripts in dependency order; a typo'd or
// forgotten filename is a blank page in the browser and nothing at all in the
// Go tests, so assert the wiring here where it is cheap.
func TestEveryScriptTagIsEmbedded(t *testing.T) {
	index, err := fs.ReadFile(staticFS, "static/index.html")
	if err != nil {
		t.Fatal(err)
	}
	matches := scriptSrcRE.FindAllStringSubmatch(string(index), -1)
	if len(matches) < 4 {
		t.Fatalf("expected the page to load several scripts, found %d", len(matches))
	}
	for _, m := range matches {
		if _, err := fs.ReadFile(staticFS, "static/"+m[1]); err != nil {
			t.Errorf("index.html loads %q which is not embedded: %v", m[1], err)
		}
	}
}

// Node test files must never be shipped to the browser or served as part of
// the app; they live beside the modules on purpose (no build step) so guard
// against one being wired into the page.
func TestTestFilesAreNotLoadedByThePage(t *testing.T) {
	index, err := fs.ReadFile(staticFS, "static/index.html")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range scriptSrcRE.FindAllStringSubmatch(string(index), -1) {
		if len(m[1]) > 8 && m[1][len(m[1])-8:] == ".test.js" {
			t.Errorf("index.html must not load the Node test file %q", m[1])
		}
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./internal/webui/ -run Script -v`
Expected: FAIL — `expected the page to load several scripts, found 2` (index.html currently loads only `providers.js` and `app.js`).

- [ ] **Step 3: Create `util.js`**

Create `internal/webui/static/util.js` — this is a *move* of the existing helpers out of `app.js`, unchanged apart from `debounce`:

```js
"use strict";
// util.js — DOM and string helpers with no knowledge of the manifest's shape.
// Everything here is either a one-line DOM convenience or an HTML builder that
// escapes its inputs; nothing reads or writes application state.

const $ = (sel) => document.querySelector(sel);

// ---- deep path access ------------------------------------------------------
function getPath(obj, path) {
  return path.split(".").reduce((cur, k) => cur?.[k], obj);
}
function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys.at(-1)] = value;
}
function coerce(input) {
  if (input.dataset.type === "number") {
    const n = parseFloat(input.value);
    return Number.isFinite(n) ? n : 0;
  }
  if (input.dataset.type === "int") {
    const n = parseInt(input.value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return input.value;
}

// ---- html builders ---------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function field(label, inputHTML, hint = "") {
  return `<label class="field"><span>${esc(label)}</span>${inputHTML}` +
    (hint ? `<small>${esc(hint)}</small>` : "") + `</label>`;
}
function textInput(path, value, opts = {}) {
  return `<input type="text" data-path="${esc(path)}" value="${esc(value ?? "")}"` +
    ` placeholder="${esc(opts.placeholder || "")}">`;
}
function numInput(path, value, opts = {}) {
  return `<input type="number" data-path="${esc(path)}" data-type="${opts.int ? "int" : "number"}"` +
    ` value="${esc(value ?? 0)}" step="${esc(opts.step ?? "any")}"` +
    (opts.min != null ? ` min="${esc(opts.min)}"` : "") + `>`;
}
// If value isn't among options (e.g. it names a data source or layout that
// was since deleted/renamed), inject it as an extra, labelled-missing option
// so the select shows the real state instead of silently falling back to the
// first option — which would corrupt state the moment the user touches it.
// An empty value on a list with no "" option gets one prepended, so "nothing
// chosen yet" renders as empty instead of the first option — the form must
// never claim a choice the user didn't make.
function select(path, value, options, opts = {}) {
  const missing = value !== "" && value != null && !options.includes(value);
  const empty = (value === "" || value == null) && !options.includes("");
  const list = missing ? [...options, value] : (empty ? ["", ...options] : options);
  const body = list.map((o) =>
    `<option value="${esc(o)}"${o === value || (empty && o === "") ? " selected" : ""}>` +
    `${esc(o === "" ? (opts.emptyLabel ?? "(none)") : (missing && o === value ? `${o} (missing)` : o))}</option>`).join("");
  const rerender = opts.rerender ? ` data-rerender="${esc(opts.rerender)}"` : "";
  const extra = opts.attrs ?? "";
  return `<select data-path="${esc(path)}"${rerender} ${extra}>${body}</select>`;
}

// ---- misc ------------------------------------------------------------------
// Presence, not truthiness: new keys are seeded with "", so a truthiness test
// would hand out the same key twice and the second add would overwrite the
// first in place.
function uniqueKey(map, base) {
  if (!Object.hasOwn(map, base)) return base;
  let i = 2;
  while (Object.hasOwn(map, `${base}${i}`)) i++;
  return `${base}${i}`;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

let flashTimer = null;
function flash(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ""; }, 4000);
}
```

- [ ] **Step 4: Create `state.js`**

Create `internal/webui/static/state.js` — moved verbatim from `app.js` except that `renameKey` now calls the injected `onStateChange` hook instead of reaching for `renderAll` directly, and `replaceState` is new:

```js
"use strict";
// state.js — the manifest as a mutable plain object shaped exactly like the
// DSL's JSON form, plus the operations that keep it internally consistent
// (renames retarget every reference). This file knows the DSL; it knows
// nothing about how any of it is drawn.

function emptyManifest() {
  return {
    name: "",
    resolution: "1920x1080",
    fps: 24,
    output: "",
    length: 0,
    audio: { file: "", mode: "soundtrack", start: 0, fadeOut: null },
    data: {},
    layouts: {},
    scenes: [],
  };
}
let state = emptyManifest();

// Selection: what the inspector is currently describing. sceneIndex is the
// scene the stage draws; element is an index into that scene's layout's
// elements, or null when the scene itself is selected.
let selection = { sceneIndex: 0, element: null, dataSource: null };

// onStateChange is set by app.js during boot. Every mutator here calls it
// instead of naming a renderer, so state.js has no dependency on the views.
let onStateChange = () => {};
function setStateChangeHandler(fn) { onStateChange = fn; }

// The server omits empty fields (omitempty), so rebuild the containers the
// renderers index into.
function normalize(m) {
  const base = emptyManifest();
  const out = { ...base, ...m };
  out.audio = { ...base.audio, ...(m.audio || {}) };
  out.data = m.data || {};
  out.layouts = m.layouts || {};
  out.scenes = m.scenes || [];
  for (const ds of Object.values(out.data)) ds.params = ds.params || {};
  for (const l of Object.values(out.layouts)) {
    l.background = l.background || { color: "", image: "" };
    l.elements = l.elements || [];
  }
  return out;
}

// replaceState swaps the whole manifest and resets the selection, which would
// otherwise point at a scene or element the new manifest does not have.
function replaceState(m) {
  state = normalize(m);
  selection = { sceneIndex: 0, element: null, dataSource: null };
}

function deriveOutput(name) {
  return name ? `output/${name}.mp4` : "";
}

function defaultParams(provider) {
  const params = {};
  for (const [key, p] of Object.entries(PROVIDERS[provider].params))
    if (p.default) params[key] = p.default;
  return params;
}

function sceneDefaults(kind) {
  const first = (map) => Object.keys(map)[0] || "";
  return {
    image:  { kind: "image", file: "", duration: 4 },
    render: { kind: "render", layout: first(state.layouts), duration: 6, vars: {}, background: null },
    clips:  { kind: "clips", source: first(state.data), perClip: 4, label: "" },
  }[kind];
}

function renameKey(mapPath, oldKey, newKey) {
  const map = getPath(state, mapPath);
  // Dots are the separator in the data-path strings every input is addressed
  // by, so a dotted key would make every later edit miss or land elsewhere.
  const reject = !newKey ? "A name can't be empty"
    : newKey.includes(".") ? "A name can't contain a dot"
    : map[newKey] !== undefined ? `${newKey} is already taken` : "";
  if (reject) {
    onStateChange(); // restore the old name in the input
    flash(`${reject} — kept "${oldKey}"`, true);
    return;
  }
  if (newKey === oldKey) return;
  const rebuilt = {};
  for (const [k, v] of Object.entries(map)) rebuilt[k === oldKey ? newKey : k] = v;
  setPath(state, mapPath, rebuilt);
  if (mapPath === "data") retargetSource(oldKey, newKey);
  if (mapPath === "layouts") retargetLayout(oldKey, newKey);
  onStateChange();
}
// Renaming a data source or layout fixes every reference to it, so a rename
// never silently dangles.
function retargetSource(oldKey, newKey) {
  for (const sc of state.scenes) {
    if (sc.source === oldKey) sc.source = newKey;
    if (sc.background && sc.background.source === oldKey) sc.background.source = newKey;
  }
  for (const layout of Object.values(state.layouts))
    for (const el of layout.elements || [])
      if (el.source === oldKey) el.source = newKey;
}
function retargetLayout(oldKey, newKey) {
  for (const sc of state.scenes) {
    if (sc.layout === oldKey) sc.layout = newKey;
    if (sc.label === oldKey) sc.label = newKey;
  }
}

// Registries the view files populate: actions["add-data"] = (dataset) => {...}
// for [data-action] clicks, and rerenderHooks for selects that change the
// form's shape (declared with data-rerender="<hook>").
const actions = {};
const rerenderHooks = {};
```

- [ ] **Step 5: Create `api.js`**

Create `internal/webui/static/api.js`:

```js
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

async function apiGetManifest(name) {
  const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiSaveManifest(name, manifest) {
  const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  return res.ok ? { ok: true } : { ok: false, error: await res.text() };
}

async function apiDeleteManifest(name) {
  const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`, { method: "DELETE" });
  return res.ok ? { ok: true } : { ok: false, error: await res.text() };
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
```

- [ ] **Step 6: Create `sections.js` by moving the phase-1 renderers out of `app.js`**

Create `internal/webui/static/sections.js` containing, moved **verbatim** from the current `app.js`, in this order: `renderGeneral`, `renderAudio`, `renderData`, `dataCard`, `extraParamRows`, the `actions["add-data"|"remove-data"|"add-param"|"remove-param"]` assignments, `rerenderHooks["provider"]`, `renderLayouts`, `layoutCard`, `templateChips`, `elementCard`, the `actions["add-layout"|"remove-layout"|"add-element"|"remove-element"]` assignments, `renderScenes`, `sceneCard`, `sceneFields`, `varRows`, the `actions["add-scene"|"remove-scene"|"move-scene"|"add-var"|"remove-var"]` assignments, and `rerenderHooks["scene-kind"]`. Add at the top:

```js
"use strict";
// sections.js — the phase-1 stacked-card form. TEMPORARY: each card is retired
// as the visual editor takes over its job (Layouts in Task 8, Scenes in Task
// 10, Data in Task 15), and this file is deleted with the last of them.
```

and at the bottom:

```js
function renderAll() {
  renderGeneral();
  renderAudio();
  renderData();
  renderLayouts();
  renderScenes();
}
```

Delete every one of those functions from `app.js`, and delete from `app.js` the helper definitions now living in `util.js` (`$`, `getPath`, `setPath`, `coerce`, `esc`, `field`, `textInput`, `numInput`, `select`, `uniqueKey`, `flash`, `flashTimer`) and in `state.js` (`emptyManifest`, `state`, `normalize`, `deriveOutput`, `defaultParams`, `sceneDefaults`, `renameKey`, `retargetSource`, `retargetLayout`, `actions`, `rerenderHooks`).

- [ ] **Step 7: Rewrite `app.js` as boot + toolbar + convert loop only**

Replace the whole of `internal/webui/static/app.js` with:

```js
"use strict";
// app.js — boot, the manifest toolbar, the YAML/validation pane, and the
// delegated event wiring. Everything that draws a specific part of the
// manifest lives in its own file; this one only starts them and connects them.

// ---- server round-trip -----------------------------------------------------
// convert() is fired by the debounce and directly by New/Open/Delete, so two
// requests can be in flight; only the newest may touch the DOM, or the pane
// ends up showing an older state's YAML.
let convertSeq = 0;
async function convert() {
  const seq = ++convertSeq;
  const out = await apiConvert(state);
  if (seq !== convertSeq) return; // a newer convert() has already answered
  $("#yaml code").textContent = out.yaml || "";
  const list = $("#errors");
  list.innerHTML = "";
  for (const e of out.errors || []) {
    const li = document.createElement("li");
    li.textContent = e;
    list.appendChild(li);
  }
}
const scheduleConvert = debounce(convert, 300);

// ---- toolbar ---------------------------------------------------------------
async function renderToolbar() {
  const names = await apiListManifests();
  $("#manifest-actions").innerHTML = `
    <select id="manifest-picker">
      <option value="">— open manifest —</option>
      ${names.map((n) => `<option>${esc(n)}</option>`).join("")}
    </select>
    <button class="btn ghost" id="btn-new">New</button>
    <button class="btn" id="btn-save">Save</button>
    <button class="btn ghost danger" id="btn-delete">Delete</button>`;
  $("#manifest-picker").onchange = (e) => e.target.value && loadManifest(e.target.value);
  $("#btn-new").onclick = () => {
    if (!confirm("Discard the current editor contents?")) return;
    replaceState(emptyManifest());
    $("#manifest-picker").value = "";
    renderAll();
    convert();
  };
  $("#btn-save").onclick = saveManifest;
  $("#btn-delete").onclick = deleteManifest;
}

async function loadManifest(name) {
  let m;
  try {
    m = await apiGetManifest(name);
  } catch (err) {
    flash(`Could not load ${name}: ${err.message}`, true);
    return;
  }
  replaceState(m);
  renderAll();
  convert();
  flash(`Loaded ${name}`);
}

async function saveManifest() {
  if (!state.name) {
    flash("Give the pre-roll a name before saving", true);
    return;
  }
  const filename = `${state.name}.yaml`;
  const res = await apiSaveManifest(filename, state);
  if (!res.ok) {
    flash(`Not saved: ${res.error}`, true);
    return;
  }
  flash(`Saved ${filename}`);
  await renderToolbar();
  $("#manifest-picker").value = filename;
}

async function deleteManifest() {
  const name = $("#manifest-picker").value;
  if (!name) {
    flash("Open a manifest first", true);
    return;
  }
  if (!confirm(`Delete ${name}? The file is removed from the manifest directory.`)) return;
  const res = await apiDeleteManifest(name);
  if (!res.ok) {
    flash(`Not deleted: ${res.error}`, true);
    return;
  }
  flash(`Deleted ${name}`);
  replaceState(emptyManifest());
  renderAll();
  convert();
  renderToolbar();
}

// ---- delegated events ------------------------------------------------------
$("#editor").addEventListener("input", (e) => {
  const path = e.target.dataset.path;
  if (!path) return;
  if (path === "name") {
    // Keep output auto-derived while the user hasn't customised it.
    const wasAuto = state.output === deriveOutput(state.name);
    setPath(state, path, coerce(e.target));
    if (wasAuto) {
      state.output = deriveOutput(state.name);
      const out = $('#section-general input[data-path="output"]');
      if (out) out.value = state.output;
    }
  } else {
    setPath(state, path, coerce(e.target));
  }
  scheduleConvert();
});

$("#editor").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.actionToggle === "scene-bg") {
    const sc = state.scenes[+t.dataset.index];
    sc.background = t.checked
      ? { source: Object.keys(state.data)[0] || "", mode: "art", tile: "", dim: 0.35, limit: 0 }
      : null;
    renderScenes();
    scheduleConvert();
    return;
  }
  if (t.dataset.rename) {
    renameKey(t.dataset.rename, t.dataset.old, t.value.trim());
    return;
  }
  if (t.dataset.rerender) {
    rerenderHooks[t.dataset.rerender]?.(t.dataset, t);
    renderAll();
    scheduleConvert();
  }
});

$("#editor").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  actions[btn.dataset.action]?.(btn.dataset);
  scheduleConvert();
});

$("#copy-yaml").onclick = async () => {
  await navigator.clipboard.writeText($("#yaml code").textContent);
  flash("YAML copied");
};

// ---- boot ------------------------------------------------------------------
// State mutations that change the form's shape re-render everything and
// re-validate; state.js calls this without knowing what "everything" is.
setStateChangeHandler(() => { renderAll(); scheduleConvert(); });
renderAll();
renderToolbar();
convert();
```

- [ ] **Step 8: Wire the new scripts into `index.html`**

In `internal/webui/static/index.html`, replace the two `<script>` lines with:

```html
<script src="providers.js"></script>
<script src="util.js"></script>
<script src="state.js"></script>
<script src="api.js"></script>
<script src="sections.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 9: Add a Node syntax test for every static script**

Create `internal/webui/static/syntax.test.js`:

```js
"use strict";
// Every static .js file must at least parse. The browser reports a syntax
// error as a silently blank page and the Go tests cannot see it at all, so
// this is the cheapest real check available without a browser.
// Run: node --test internal/webui/static/

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
```

- [ ] **Step 10: Run the Node tests**

Run: `node --test internal/webui/static/`
Expected: PASS — one `# pass` line per script, `# fail 0`.

- [ ] **Step 11: Run the Go tests**

Run: `go test ./internal/webui/ -v`
Expected: PASS, including `TestEveryScriptTagIsEmbedded` and `TestTestFilesAreNotLoadedByThePage`.

- [ ] **Step 12: Human check — the app is unchanged**

Run: `go run ./cmd/preroll-ui -manifest-dir manifests` and open `http://localhost:8382`.
Expected, and this is the whole point of the task: the page looks and behaves **exactly** as before. Open `top-movies-trailer-wall.yaml` from the picker; all five cards populate; the YAML pane matches the file; edit a field and the YAML updates. Nothing new appears.
(No browser automation is available here — this is a manual look, and it is the only way to confirm a pure refactor of DOM code.)

- [ ] **Step 13: Commit**

```bash
git add internal/webui/static/ internal/webui/static_test.go
git commit -m "webui: split the frontend into util/state/api/sections/app"
```

---

### Task 3: `geometry.js` — the pure layout maths, mirrored from render.go

**Model:** Opus — this is the single most consequential file in the phase. Every pixel the stage draws and every drag it interprets comes from here, and it must reproduce `internal/render/render.go` exactly. It is also the only part testable without a browser, so its purity is load-bearing for the plan's verifiability.

**The rules being mirrored** (read `internal/render/render.go` alongside this task):
- `dw.Annotation(x, y, text)` places the text's **baseline** at `y`. Canvas's default `textBaseline = "alphabetic"` does the same, so `fillText(text, x, y)` is a 1:1 translation — no offset fudging.
- `SetTextAlignment(left|center|right)` anchors the line horizontally at `x`. Canvas's `textAlign` matches name for name (`centre` also accepted by render.go, normalised to `center`).
- Text elements: `lineHeight = el.lineHeight > 0 ? el.lineHeight : el.size * 1.2`; the block of N lines is centred vertically on `el.y`, so line `i`'s baseline is `el.y - (N-1)/2*lineHeight + i*lineHeight`.
- List elements: row `i`'s baseline is `el.startY + i*el.stepY`. **No vertical centring** — the first row's baseline *is* `startY`. `align` still applies (render.go sets alignment before the type switch).
- Colour defaults: text `white`, background `black`; `none`/`transparent` means a transparent canvas.
- Backgrounds: `cover` scales to fill and centre-crops; `grid` is 2×2 (2×1 for exactly two, max four), each cell centre-cropped — and grid only applies when there is **more than one** image, otherwise render.go falls through to cover.

**Files:**
- Create: `internal/webui/static/geometry.js`
- Create: `internal/webui/static/geometry.test.js`
- Modify: `internal/webui/static/index.html`

**Interfaces:**
- Produces the `Geometry` object (a browser global from a classic script, and a CommonJS export for `node --test`):
  - `Geometry.lineHeight(el) -> number`
  - `Geometry.textBaselines(el, lineCount) -> number[]`
  - `Geometry.listBaselines(el, rowCount) -> number[]`
  - `Geometry.align(el) -> "left"|"center"|"right"`
  - `Geometry.lineBox(el, text, baseline, measure) -> {x,y,w,h}` where `measure(text) -> {width, ascent, descent}`
  - `Geometry.elementBox(el, lines, measure) -> {x,y,w,h}`
  - `Geometry.union(a,b) -> {x,y,w,h}`
  - `Geometry.contains(box, px, py) -> bool`
  - `Geometry.hitTest(boxes, px, py) -> number` (topmost index, or -1)
  - `Geometry.handlePoint(box) -> {x,y}`
  - `Geometry.onHandle(box, px, py, tol) -> bool`
  - `Geometry.moveTo(el, dx, dy) -> patch object`
  - `Geometry.resizeSize(startSize, startBoxHeight, dy) -> number`
  - `Geometry.snapTargets(width, height, boxes) -> {xs:number[], ys:number[]}`
  - `Geometry.snap(value, targets, tol) -> {value, guide}`
  - `Geometry.safeArea(width, height, inset) -> {x,y,w,h}`
  - `Geometry.coverRect(iw, ih, tw, th) -> {sx,sy,sw,sh}`
  - `Geometry.gridCells(count, width, height) -> [{x,y,w,h}]`
  - `Geometry.isTransparent(color) -> bool`
  - `Geometry.toManifest(clientX, clientY, rect, width) -> {x, y, scale}`

- [ ] **Step 1: Write the failing geometry tests**

Create `internal/webui/static/geometry.test.js`:

```js
"use strict";
// Unit tests for the pure layout maths. Every assertion here is a rule taken
// from internal/render/render.go; if the renderer's behaviour changes, one of
// these must fail. Run: node --test internal/webui/static/

const test = require("node:test");
const assert = require("node:assert");
const Geometry = require("./geometry.js");

// A deterministic stand-in for canvas text metrics: half an em per character,
// ascent 0.8em, descent 0.2em. Real metrics come from ctx.measureText in the
// browser; injecting them is what keeps this module testable in Node.
const fakeMeasure = (size) => (text) => ({
  width: text.length * size * 0.5,
  ascent: size * 0.8,
  descent: size * 0.2,
});

test("lineHeight falls back to 1.2x the font size", () => {
  assert.strictEqual(Geometry.lineHeight({ size: 100, lineHeight: 0 }), 120);
  assert.strictEqual(Geometry.lineHeight({ size: 100, lineHeight: 64 }), 64);
});

test("a single-line text block sits exactly on its y", () => {
  assert.deepStrictEqual(Geometry.textBaselines({ y: 150, size: 96 }, 1), [150]);
});

test("a multi-line text block is centred vertically on y", () => {
  // 3 lines, lineHeight 100, centred on y=500 -> 400, 500, 600.
  assert.deepStrictEqual(
    Geometry.textBaselines({ y: 500, size: 80, lineHeight: 100 }, 3),
    [400, 500, 600],
  );
});

test("list rows start AT startY and step down, never centred", () => {
  assert.deepStrictEqual(
    Geometry.listBaselines({ startY: 320, stepY: 96 }, 3),
    [320, 416, 512],
  );
});

test("align normalises the DSL's spellings", () => {
  assert.strictEqual(Geometry.align({}), "left");
  assert.strictEqual(Geometry.align({ align: "" }), "left");
  assert.strictEqual(Geometry.align({ align: "CENTRE" }), "center");
  assert.strictEqual(Geometry.align({ align: "Center" }), "center");
  assert.strictEqual(Geometry.align({ align: "right" }), "right");
});

test("lineBox anchors left, centre and right against x", () => {
  const el = { x: 1000, size: 100, y: 500 };
  const m = fakeMeasure(100); // "abcd" -> width 200, ascent 80, descent 20
  assert.deepStrictEqual(Geometry.lineBox({ ...el, align: "left" }, "abcd", 500, m),
    { x: 1000, y: 420, w: 200, h: 100 });
  assert.deepStrictEqual(Geometry.lineBox({ ...el, align: "center" }, "abcd", 500, m),
    { x: 900, y: 420, w: 200, h: 100 });
  assert.deepStrictEqual(Geometry.lineBox({ ...el, align: "right" }, "abcd", 500, m),
    { x: 800, y: 420, w: 200, h: 100 });
});

test("elementBox spans every line of a multi-line text element", () => {
  const el = { type: "text", x: 0, y: 500, size: 100, lineHeight: 100, align: "left" };
  const box = Geometry.elementBox(el, ["ab", "abcdef"], fakeMeasure(100));
  // baselines 450 and 550; widths 100 and 300; top 450-80=370, bottom 550+20=570
  assert.deepStrictEqual(box, { x: 0, y: 370, w: 300, h: 200 });
});

test("elementBox of an element with no lines degrades to a point at its anchor", () => {
  assert.deepStrictEqual(
    Geometry.elementBox({ type: "text", x: 12, y: 34 }, [], fakeMeasure(50)),
    { x: 12, y: 34, w: 0, h: 0 });
});

test("hitTest picks the topmost box, matching draw order", () => {
  const boxes = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 50, y: 50, w: 100, h: 100 },
  ];
  assert.strictEqual(Geometry.hitTest(boxes, 10, 10), 0);
  assert.strictEqual(Geometry.hitTest(boxes, 75, 75), 1, "later elements draw over earlier ones");
  assert.strictEqual(Geometry.hitTest(boxes, 500, 500), -1);
});

test("the resize handle sits at the box's bottom-right and has a tolerance", () => {
  const box = { x: 100, y: 200, w: 300, h: 50 };
  assert.deepStrictEqual(Geometry.handlePoint(box), { x: 400, y: 250 });
  assert.ok(Geometry.onHandle(box, 405, 245, 10));
  assert.ok(!Geometry.onHandle(box, 420, 250, 10));
});

test("dragging a text element moves x/y; dragging a list moves x/startY", () => {
  assert.deepStrictEqual(Geometry.moveTo({ type: "text", x: 10, y: 20 }, 5, -5), { x: 15, y: 15 });
  assert.deepStrictEqual(Geometry.moveTo({ type: "list", x: 10, startY: 20 }, 5, -5), { x: 15, startY: 15 });
});

test("moveTo rounds to one decimal so YAML stays readable", () => {
  assert.deepStrictEqual(Geometry.moveTo({ type: "text", x: 0, y: 0 }, 1.23456, 0), { x: 1.2, y: 0 });
});

test("resizeSize scales the font by the handle's vertical travel and clamps", () => {
  assert.strictEqual(Geometry.resizeSize(100, 100, 50), 150);
  assert.strictEqual(Geometry.resizeSize(100, 100, -50), 50);
  assert.strictEqual(Geometry.resizeSize(100, 100, -99), 8, "clamped at the small end");
  assert.strictEqual(Geometry.resizeSize(100, 100, 10000), 512, "clamped at the large end");
  assert.strictEqual(Geometry.resizeSize(100, 0, 50), 100, "a zero-height box cannot scale");
});

test("snapping locks onto the nearest target inside the tolerance", () => {
  assert.deepStrictEqual(Geometry.snap(958, [0, 960, 1920], 8), { value: 960, guide: 960 });
  assert.deepStrictEqual(Geometry.snap(900, [0, 960, 1920], 8), { value: 900, guide: null });
});

test("snapTargets offers the canvas edges, its centre, and every other box", () => {
  const t = Geometry.snapTargets(1920, 1080, [{ x: 100, y: 200, w: 100, h: 100 }]);
  assert.deepStrictEqual(t.xs, [0, 960, 1920, 100, 150, 200]);
  assert.deepStrictEqual(t.ys, [0, 540, 1080, 200, 250, 300]);
});

test("safeArea insets 5% by default", () => {
  assert.deepStrictEqual(Geometry.safeArea(1920, 1080),
    { x: 96, y: 54, w: 1728, h: 972 });
});

test("coverRect crops the overflow centred, mirroring coverResize", () => {
  // A 2000x1000 image into a 1000x1000 cell: scale 1, crop 1000 off the width.
  assert.deepStrictEqual(Geometry.coverRect(2000, 1000, 1000, 1000),
    { sx: 500, sy: 0, sw: 1000, sh: 1000 });
  // A 1000x2000 image into a 1000x1000 cell: crop 1000 off the height.
  assert.deepStrictEqual(Geometry.coverRect(1000, 2000, 1000, 1000),
    { sx: 0, sy: 500, sw: 1000, sh: 1000 });
  assert.deepStrictEqual(Geometry.coverRect(0, 0, 100, 100), { sx: 0, sy: 0, sw: 0, sh: 0 });
});

test("gridCells is 2x2, 2x1 for exactly two, and never more than four", () => {
  assert.deepStrictEqual(Geometry.gridCells(2, 1920, 1080), [
    { x: 0, y: 0, w: 960, h: 1080 },
    { x: 960, y: 0, w: 960, h: 1080 },
  ]);
  assert.strictEqual(Geometry.gridCells(3, 1920, 1080).length, 3);
  assert.deepStrictEqual(Geometry.gridCells(3, 1920, 1080)[2], { x: 0, y: 540, w: 960, h: 540 });
  assert.strictEqual(Geometry.gridCells(9, 1920, 1080).length, 4, "render.go slices to four");
});

test("isTransparent matches render.go's none/transparent check", () => {
  assert.ok(Geometry.isTransparent("none"));
  assert.ok(Geometry.isTransparent("  TRANSPARENT "));
  assert.ok(!Geometry.isTransparent("black"));
  assert.ok(!Geometry.isTransparent(""));
});

test("toManifest converts a pointer position back into manifest pixels", () => {
  const rect = { left: 10, top: 20, width: 960 }; // a 1920-wide manifest at 50%
  const p = Geometry.toManifest(490, 320, rect, 1920);
  assert.strictEqual(p.scale, 0.5);
  assert.strictEqual(p.x, 960);
  assert.strictEqual(p.y, 600);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test internal/webui/static/geometry.test.js`
Expected: FAIL — `Cannot find module './geometry.js'`.

- [ ] **Step 3: Write `geometry.js`**

Create `internal/webui/static/geometry.js`:

```js
"use strict";
// geometry.js — the pure layout maths behind the stage. NO DOM, NO fetch, NO
// application state: every function takes its inputs and returns new values.
// That is deliberate — it is the only part of the visual editor that can be
// tested without a browser, and the tests in geometry.test.js are the contract
// against internal/render/render.go.
//
// Coordinate space is "manifest pixels": the same space render.go draws in,
// origin top-left, extent = Preroll.resolution. The stage scales that space to
// CSS pixels; nothing in this file knows about CSS, devicePixelRatio, or zoom.
//
// Text metrics arrive through a `measure(text) -> {width, ascent, descent}`
// callback (the browser passes one backed by ctx.measureText). Injecting them
// is what keeps this file pure.

const GEO_DEFAULT_LINE_SPACING = 1.2;   // render.go: defaultLineSpacing
const GEO_DEFAULT_TEXT_COLOR = "white"; // render.go: setFillColor's fallback
const GEO_DEFAULT_BG_COLOR = "black";   // render.go: setupCanvas's fallback
const GEO_MIN_SIZE = 8;
const GEO_MAX_SIZE = 512;

function geoRound1(n) { return Math.round(n * 10) / 10; }
function geoClamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

const Geometry = {
  DEFAULT_LINE_SPACING: GEO_DEFAULT_LINE_SPACING,
  DEFAULT_TEXT_COLOR: GEO_DEFAULT_TEXT_COLOR,
  DEFAULT_BG_COLOR: GEO_DEFAULT_BG_COLOR,

  // render.go drawLines: an unset lineHeight is 1.2x the font size.
  lineHeight(el) {
    return el.lineHeight > 0 ? el.lineHeight : (el.size || 0) * GEO_DEFAULT_LINE_SPACING;
  },

  // render.go drawLines: the block of N lines is centred vertically on el.y,
  // and each returned number is a BASELINE, not a top edge.
  textBaselines(el, lineCount) {
    const lh = Geometry.lineHeight(el);
    const start = (el.y || 0) - ((lineCount - 1) / 2) * lh;
    const out = [];
    for (let i = 0; i < lineCount; i++) out.push(start + i * lh);
    return out;
  },

  // render.go's list branch: y = el.StartY + i*el.StepY. There is no vertical
  // centring here — the first row's baseline IS startY. Getting this wrong is
  // the classic "my list is half a row too high" bug.
  listBaselines(el, rowCount) {
    const out = [];
    for (let i = 0; i < rowCount; i++) out.push((el.startY || 0) + i * (el.stepY || 0));
    return out;
  },

  // render.go alignType: centre is accepted as a spelling of center.
  align(el) {
    const a = String(el.align || "").toLowerCase();
    if (a === "center" || a === "centre") return "center";
    if (a === "right") return "right";
    return "left";
  },

  // The box for ONE line whose baseline sits at `baseline`, anchored
  // horizontally at el.x according to the alignment.
  lineBox(el, text, baseline, measure) {
    const m = measure(text);
    const align = Geometry.align(el);
    let left = el.x || 0;
    if (align === "center") left = (el.x || 0) - m.width / 2;
    else if (align === "right") left = (el.x || 0) - m.width;
    return { x: left, y: baseline - m.ascent, w: m.width, h: m.ascent + m.descent };
  },

  // The union of every line's box: the element's selection rectangle and its
  // hit area. An element with nothing to draw collapses to a point at its
  // anchor so it stays selectable.
  elementBox(el, lines, measure) {
    const baselines = el.type === "list"
      ? Geometry.listBaselines(el, lines.length)
      : Geometry.textBaselines(el, lines.length);
    let box = null;
    for (let i = 0; i < lines.length; i++) {
      const b = Geometry.lineBox(el, lines[i], baselines[i], measure);
      box = box === null ? b : Geometry.union(box, b);
    }
    return box || { x: el.x || 0, y: (el.type === "list" ? el.startY : el.y) || 0, w: 0, h: 0 };
  },

  union(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  },

  contains(box, px, py) {
    return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
  },

  // Topmost hit wins: render.go draws elements in array order, so the last one
  // drawn is the one on top, and the search runs backwards.
  hitTest(boxes, px, py) {
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (Geometry.contains(boxes[i], px, py)) return i;
    }
    return -1;
  },

  // One handle, bottom-right. More handles would imply the DSL can express a
  // width or a non-uniform scale; it cannot — an element has a font size and
  // an anchor, so one handle is the whole vocabulary.
  handlePoint(box) { return { x: box.x + box.w, y: box.y + box.h }; },

  // tol is supplied by the caller in MANIFEST pixels (screen tolerance / scale),
  // so the handle stays the same physical size however the stage is scaled.
  onHandle(box, px, py, tol) {
    const h = Geometry.handlePoint(box);
    return Math.abs(px - h.x) <= tol && Math.abs(py - h.y) <= tol;
  },

  // The patch a completed drag applies. A list has no y — its vertical anchor
  // is startY — so dragging one moves x/startY instead of x/y.
  moveTo(el, dx, dy) {
    if (el.type === "list") {
      return { x: geoRound1((el.x || 0) + dx), startY: geoRound1((el.startY || 0) + dy) };
    }
    return { x: geoRound1((el.x || 0) + dx), y: geoRound1((el.y || 0) + dy) };
  },

  // Resizing changes the font size, the only size the DSL has. The scale
  // factor is how much taller the box got, so the drag feels proportional.
  resizeSize(startSize, startBoxHeight, dy) {
    if (startBoxHeight <= 0) return startSize;
    const factor = (startBoxHeight + dy) / startBoxHeight;
    return geoClamp(geoRound1(startSize * factor), GEO_MIN_SIZE, GEO_MAX_SIZE);
  },

  // Guides a drag can lock onto: the canvas edges and centre, plus the edges
  // and centre of every other element's box.
  snapTargets(width, height, boxes) {
    const xs = [0, width / 2, width];
    const ys = [0, height / 2, height];
    for (const b of boxes) {
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    return { xs, ys };
  },

  // Returns the snapped value and the guide it locked onto (null when nothing
  // was near enough), so the caller can draw the guide line it snapped to.
  snap(value, targets, tol) {
    let best = null;
    let bestDistance = tol;
    for (const t of targets) {
      const d = Math.abs(value - t);
      if (d <= bestDistance) { bestDistance = d; best = t; }
    }
    return best === null ? { value, guide: null } : { value: best, guide: best };
  },

  // Title-safe rectangle. 5% is the broadcast convention and is only a guide —
  // nothing in the renderer enforces it.
  safeArea(width, height, inset) {
    const i = inset == null ? 0.05 : inset;
    return { x: width * i, y: height * i, w: width * (1 - 2 * i), h: height * (1 - 2 * i) };
  },

  // render.go coverResize expressed as a SOURCE rectangle, which is what
  // canvas drawImage's 9-argument form wants: scale to fill, crop the overflow
  // centred, never letterbox.
  coverRect(iw, ih, tw, th) {
    if (iw <= 0 || ih <= 0) return { sx: 0, sy: 0, sw: 0, sh: 0 };
    const scale = Math.max(tw / iw, th / ih);
    const sw = Math.min(iw, tw / scale);
    const sh = Math.min(ih, th / scale);
    return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh };
  },

  // render.go buildGrid: 2 columns, 2 rows, except exactly two images which
  // share one row; anything past the fourth is dropped.
  // NOTE: render.go only takes the grid path when there is MORE than one
  // image — a single image falls through to cover. Callers must check that.
  gridCells(count, width, height) {
    const n = Math.min(count, 4);
    const cols = 2;
    const rows = n === 2 ? 1 : 2;
    const tw = Math.floor(width / cols);
    const th = Math.floor(height / rows);
    const cells = [];
    for (let i = 0; i < n; i++) {
      cells.push({ x: (i % cols) * tw, y: Math.floor(i / cols) * th, w: tw, h: th });
    }
    return cells;
  },

  // render.go isTransparent.
  isTransparent(color) {
    const c = String(color || "").trim().toLowerCase();
    return c === "none" || c === "transparent";
  },

  // Pointer position -> manifest pixels. rect is a DOMRect-shaped
  // {left, top, width}; passing it in rather than reading it keeps this pure.
  toManifest(clientX, clientY, rect, width) {
    const scale = rect.width / width;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale, scale };
  },
};

// Browser: a classic script's top-level const is visible to later scripts.
// Node: exported so geometry.test.js can require it. The repo has no
// package.json, so .js here is CommonJS and this guard is all that is needed.
if (typeof module !== "undefined" && module.exports) module.exports = Geometry;
```

- [ ] **Step 4: Run the geometry tests**

Run: `node --test internal/webui/static/geometry.test.js`
Expected: PASS — `# pass 20`, `# fail 0`.

- [ ] **Step 5: Load it in the page**

In `internal/webui/static/index.html`, insert after the `util.js` line:

```html
<script src="geometry.js"></script>
```

- [ ] **Step 6: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS. `TestEveryScriptTagIsEmbedded` now covers `geometry.js`.

- [ ] **Step 7: Commit**

```bash
git add internal/webui/static/geometry.js internal/webui/static/geometry.test.js internal/webui/static/index.html
git commit -m "webui: pure, node-testable layout geometry mirroring render.go"
```

---

### Task 4: Media file endpoints — enumerate and serve, traversal-proof

**Model:** Sonnet — a well-understood pattern (containment check + `http.ServeFile`), fully specified below.

The file picker (Task 13) needs two things from the server: a list of what fonts/images/audio exist under the configured roots, and the ability to fetch one so a font can be previewed in its own face and an image as a thumbnail. Both must be as unforgeable as the manifest-name endpoint.

**Files:**
- Create: `internal/webui/files.go`
- Create: `internal/webui/files_test.go`
- Modify: `internal/webui/webui.go` (routes)
- Modify: `cmd/preroll-ui/main.go` (`-media-dir` flag)

**Interfaces:**
- Consumes: `Server.MediaDirs []string` (Task 1).
- Produces:
  - `GET /api/files` → `{"files":[{"path":"media/common/Adult-Swim-Font.ttf","name":"Adult-Swim-Font.ttf","kind":"font","size":123456}, ...],"roots":["media"]}`. `path` is exactly the string a manifest should contain: relative to `WorkDir` when the root is under it, otherwise the root-relative path prefixed with the root.
  - `GET /api/files/raw?path=<path>` → the file's bytes, or 400/404. Only paths under a configured root are ever served.
  - `func fileKind(name string) string` → `"font"|"image"|"audio"|"video"|""`.

- [ ] **Step 1: Write the failing tests**

Create `internal/webui/files_test.go`:

```go
package webui

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func mediaServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	root := t.TempDir()
	sub := filepath.Join(root, "common")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"Font.ttf":  "fontbytes",
		"bg.png":    "pngbytes",
		"track.mp3": "mp3bytes",
		"notes.txt": "ignored",
	} {
		if err := os.WriteFile(filepath.Join(sub, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{ManifestDir: t.TempDir(), MediaDirs: []string{root}, WorkDir: filepath.Dir(root)}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, root
}

func TestFilesListsOnlyMediaKinds(t *testing.T) {
	ts, _ := mediaServer(t)
	res := do(t, "GET", ts.URL+"/api/files", "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var out struct {
		Files []struct {
			Path, Name, Kind string
			Size             int64
		} `json:"files"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, f := range out.Files {
		kinds[f.Name] = f.Kind
	}
	if kinds["Font.ttf"] != "font" || kinds["bg.png"] != "image" || kinds["track.mp3"] != "audio" {
		t.Fatalf("wrong kinds: %v", kinds)
	}
	if _, ok := kinds["notes.txt"]; ok {
		t.Fatal("a .txt is not media and must not be listed")
	}
}

func TestFilesWithNoMediaDirIsEmptyNotAnError(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "GET", ts.URL+"/api/files", "")
	if res.StatusCode != 200 {
		t.Fatalf("an unconfigured media dir must still answer 200, got %d", res.StatusCode)
	}
	var out struct {
		Files []any `json:"files"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	if len(out.Files) != 0 {
		t.Fatalf("expected no files, got %d", len(out.Files))
	}
}

func TestFilesRawServesAFileUnderTheRoot(t *testing.T) {
	ts, root := mediaServer(t)
	rel := filepath.Base(root) + "/common/Font.ttf"
	res := do(t, "GET", ts.URL+"/api/files/raw?path="+rel, "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != "fontbytes" {
		t.Fatalf("got %q", body)
	}
}

func TestFilesRawRejectsTraversal(t *testing.T) {
	ts, root := mediaServer(t)
	secret := filepath.Join(filepath.Dir(root), "secret.txt")
	if err := os.WriteFile(secret, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, attempt := range []string{
		"../secret.txt",
		filepath.Base(root) + "/../secret.txt",
		"/etc/passwd",
		filepath.Base(root) + "/common/../../secret.txt",
	} {
		res := do(t, "GET", ts.URL+"/api/files/raw?path="+attempt, "")
		if res.StatusCode == 200 {
			t.Errorf("traversal %q was served", attempt)
		}
	}
}

func TestFileKind(t *testing.T) {
	for name, want := range map[string]string{
		"a.TTF": "font", "a.otf": "font", "a.woff2": "font",
		"a.png": "image", "a.JPG": "image", "a.webp": "image",
		"a.mp3": "audio", "a.m4a": "audio", "a.wav": "audio",
		"a.mp4": "video", "a.mkv": "video",
		"a.txt": "", "a": "",
	} {
		if got := fileKind(name); got != want {
			t.Errorf("fileKind(%q) = %q, want %q", name, got, want)
		}
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `go test ./internal/webui/ -run 'Files|FileKind' -v`
Expected: FAIL — `undefined: fileKind`, and the `/api/files` requests 404.

- [ ] **Step 3: Write `files.go`**

Create `internal/webui/files.go`:

```go
package webui

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// mediaKinds maps an extension to the kind of media it is. Only these are
// listed: the picker exists to fill font/image/audio manifest fields, and a
// directory of arbitrary files is noise, not choice.
var mediaKinds = map[string]string{
	".ttf": "font", ".otf": "font", ".ttc": "font", ".woff": "font", ".woff2": "font",
	".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".bmp": "image",
	".mp3": "audio", ".m4a": "audio", ".aac": "audio", ".wav": "audio", ".flac": "audio", ".ogg": "audio",
	".mp4": "video", ".mkv": "video", ".mov": "video", ".webm": "video",
}

// fileKind classifies a filename by extension, returning "" for anything that
// is not media.
func fileKind(name string) string {
	return mediaKinds[strings.ToLower(filepath.Ext(name))]
}

type mediaFile struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}

type filesResponse struct {
	Files []mediaFile `json:"files"`
	Roots []string    `json:"roots"`
}

// list enumerates every media file under every configured root. A missing or
// unreadable root is skipped, not fatal: the picker degrades to "nothing to
// show" rather than breaking the editor.
func (s *Server) files(w http.ResponseWriter, r *http.Request) {
	out := filesResponse{Files: []mediaFile{}, Roots: []string{}}
	for _, root := range s.MediaDirs {
		abs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		if info, err := os.Stat(abs); err != nil || !info.IsDir() {
			continue
		}
		out.Roots = append(out.Roots, s.manifestRelative(abs))
		filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil //nolint:nilerr // an unreadable entry is skipped, not fatal
			}
			kind := fileKind(d.Name())
			if kind == "" {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			out.Files = append(out.Files, mediaFile{
				Path: s.manifestRelative(path),
				Name: d.Name(),
				Kind: kind,
				Size: info.Size(),
			})
			return nil
		})
	}
	sort.Slice(out.Files, func(i, j int) bool { return out.Files[i].Path < out.Files[j].Path })
	writeJSON(w, http.StatusOK, out)
}

// manifestRelative renders an absolute path the way a manifest should spell
// it: relative to the directory renders run in, so "media/common/Font.ttf"
// resolves identically for the UI's preview and for the batch renderer.
// A path outside WorkDir is left absolute — still correct in a manifest, just
// less portable.
func (s *Server) manifestRelative(abs string) string {
	base := s.WorkDir
	if base == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return abs
		}
		base = cwd
	}
	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return abs
	}
	rel, err := filepath.Rel(baseAbs, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return abs
	}
	return filepath.ToSlash(rel)
}

// raw serves one media file so the browser can preview it: a font in its own
// face, an image as a thumbnail. The path is untrusted, so it is resolved to
// an absolute path and checked for containment in a configured root — the same
// fail-closed posture as manifestPath, and the reason ".." can never escape.
func (s *Server) filesRaw(w http.ResponseWriter, r *http.Request) {
	requested := r.URL.Query().Get("path")
	if requested == "" {
		httpError(w, http.StatusBadRequest, fmt.Errorf("path is required"))
		return
	}
	resolved, err := s.resolveMediaPath(requested)
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	info, err := os.Stat(resolved)
	if err != nil || info.IsDir() {
		httpError(w, http.StatusNotFound, fmt.Errorf("no such media file"))
		return
	}
	// Previews are read from an editor the user controls; nothing here is
	// rendered as HTML, and nosniff stops the browser deciding otherwise.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, resolved)
}

// resolveMediaPath turns a client-supplied path into an absolute path proven
// to sit inside one of the configured media roots, or an error. Relative paths
// are resolved against WorkDir, which is how manifests spell them.
func (s *Server) resolveMediaPath(requested string) (string, error) {
	candidate := requested
	if !filepath.IsAbs(candidate) {
		base := s.WorkDir
		if base == "" {
			cwd, err := os.Getwd()
			if err != nil {
				return "", err
			}
			base = cwd
		}
		candidate = filepath.Join(base, candidate)
	}
	// EvalSymlinks after Abs: a symlink inside a root pointing out of it must
	// not become a hole in the containment check.
	abs, err := filepath.Abs(candidate)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	for _, root := range s.MediaDirs {
		rootAbs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		if real, err := filepath.EvalSymlinks(rootAbs); err == nil {
			rootAbs = real
		}
		rel, err := filepath.Rel(rootAbs, abs)
		if err != nil {
			continue
		}
		if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return abs, nil
		}
	}
	return "", fmt.Errorf("path %q is not inside a configured media directory", requested)
}
```

- [ ] **Step 4: Register the routes**

In `internal/webui/webui.go`'s `Handler()`, after the capabilities line:

```go
	mux.HandleFunc("GET /api/files", s.files)
	mux.HandleFunc("GET /api/files/raw", s.filesRaw)
```

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/webui/ -run 'Files|FileKind' -v`
Expected: PASS — all five tests, including every traversal attempt rejected.

- [ ] **Step 6: Add the `-media-dir` flag**

In `cmd/preroll-ui/main.go`, add after the `dir` flag:

```go
	media := flag.String("media-dir", envOr("MEDIA_DIR", "media"), "comma-separated directories the file picker may browse and serve from")
```

and change the server construction to:

```go
	srv := &webui.Server{
		ManifestDir: *dir,
		MediaDirs:   splitDirs(*media),
	}
```

and add at the bottom of the file:

```go
// splitDirs turns a comma-separated flag value into a list, dropping blanks so
// an empty or trailing-comma value yields no roots rather than the working
// directory.
func splitDirs(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
```

Add `"strings"` to the import block.

- [ ] **Step 7: Verify the flag end to end**

Run:
```bash
CGO_ENABLED=0 go build -o /tmp/preroll-ui ./cmd/preroll-ui && \
  /tmp/preroll-ui -manifest-dir manifests -media-dir media & sleep 1 && \
  curl -s localhost:8382/api/files | head -c 400; echo; \
  curl -s -o /dev/null -w '%{http_code}\n' 'localhost:8382/api/files/raw?path=../etc/passwd'; \
  kill %1
```
Expected: the JSON lists `media/common/Adult-Swim-Font.ttf` (kind `font`), `media/common/locket-crumb.mp3` (kind `audio`), `media/common/plex-as-logo.png` (kind `image`); the traversal attempt prints `400`.

- [ ] **Step 8: Commit**

```bash
git add internal/webui/files.go internal/webui/files_test.go internal/webui/webui.go cmd/preroll-ui/main.go
git commit -m "webui: enumerate and serve media files for the file picker"
```

---

### Task 5: Live Plex data — provider resolution endpoint and image proxy

**Model:** Sonnet — new surface, but the wiring is copied from `cmd/plex-pre-rolls/main.go` and the code is given in full.

The stage should show real titles and real artwork, and each data source needs a "Test" button that proves what it returns. Both are the same operation: run the real provider and hand back the items. The one subtlety is images — Plex art URLs carry the token and may be served over a certificate the browser will not accept, so they are proxied through the UI with a strict allowlist rather than handed to the page.

**Files:**
- Create: `internal/webui/plexsource.go`
- Create: `internal/webui/data.go`
- Create: `internal/webui/data_test.go`
- Modify: `internal/webui/webui.go` (`Plex` field + routes)
- Modify: `internal/webui/capabilities.go` (report `plex`)
- Modify: `cmd/preroll-ui/main.go` (optional Plex wiring)

**Interfaces:**
- Consumes: `configmanager.ReadConfig()` (Task 1), `plexclient.PlexClient`, `plexclient.NewDiscoverClient`, `providers.NewRegistry`, `plexprovider.Register`, `templating.RenderParams`, `content.Items`.
- Produces:
  - `type PlexSource struct { Registry *providers.Registry; Vars map[string]any; BaseURL string; Token string; HTTPClient *http.Client }`
  - `func NewPlexSource() (*PlexSource, error)` — reads env, returns `(nil, err)` when Plex is not configured.
  - `POST /api/data/resolve` body `{"data":{"<name>":{"provider":"...","params":{...}}}}` → `{"configured":bool,"vars":{...},"sources":{"<name>":{"items":[{"rank":1,"name":"...","views":3,"art":"/api/plex/image?u=...","thumb":"...","hasMedia":true}],"error":""}}}`
  - `GET /api/plex/image?u=<absolute plex url>` → the image bytes, only for allowlisted hosts.

- [ ] **Step 1: Write the failing tests**

Create `internal/webui/data_test.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
)

// fakeProvider stands in for a Plex-backed provider so the endpoint can be
// tested without a server: providers.Provider is a one-method interface.
type fakeProvider struct {
	items content.Items
	err   error
	got   map[string]string
}

func (f *fakeProvider) Fetch(_ context.Context, params map[string]string) (content.Items, error) {
	f.got = params
	return f.items, f.err
}

func TestResolveWithNoPlexIsNotAnError(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "POST", ts.URL+"/api/data/resolve", `{"data":{"top":{"provider":"plex.top","params":{}}}}`)
	if res.StatusCode != 200 {
		t.Fatalf("an unconfigured server must answer 200 so the editor falls back to placeholders, got %d", res.StatusCode)
	}
	var out resolveResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Configured {
		t.Fatal("configured must be false with no Plex env")
	}
}

func TestResolveRunsTheProviderAndRendersParamTemplates(t *testing.T) {
	fake := &fakeProvider{items: content.Items{
		{Name: "Dune", Views: 7, Art: "http://plex:32400/art?X-Plex-Token=tok", MediaURL: "http://plex:32400/clip"},
		{Name: "Arrival", Views: 2},
	}}
	reg := providers.NewRegistry()
	reg.Register("plex.top", fake)
	s := &Server{
		ManifestDir: t.TempDir(),
		Plex: &PlexSource{
			Registry: reg,
			Vars:     map[string]any{"MovieSectionId": "1", "Period": "Month"},
			BaseURL:  "http://plex:32400",
		},
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	res := do(t, "POST", ts.URL+"/api/data/resolve",
		`{"data":{"top":{"provider":"plex.top","params":{"section":"{{ .MovieSectionId }}"}}}}`)
	var out resolveResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.Configured {
		t.Fatal("configured must be true when a registry is present")
	}
	if fake.got["section"] != "1" {
		t.Fatalf("param templates must be rendered before the provider runs, got %q", fake.got["section"])
	}
	src := out.Sources["top"]
	if len(src.Items) != 2 {
		t.Fatalf("want 2 items, got %d", len(src.Items))
	}
	if src.Items[0].Rank != 1 || src.Items[0].Name != "Dune" || src.Items[0].Views != 7 {
		t.Fatalf("item 0 wrong: %+v", src.Items[0])
	}
	if !src.Items[0].HasMedia || src.Items[1].HasMedia {
		t.Fatal("hasMedia must reflect whether a playable MediaURL was resolved")
	}
	if src.Items[0].Art == "" || src.Items[0].Art[0] != '/' {
		t.Fatalf("art must be rewritten to the local proxy, got %q", src.Items[0].Art)
	}
	if src.Items[1].Art != "" {
		t.Fatal("an item with no art must stay empty, not point at a broken proxy URL")
	}
}

func TestResolveReportsAProviderErrorPerSource(t *testing.T) {
	reg := providers.NewRegistry()
	reg.Register("plex.top", &fakeProvider{err: errors.New("plex: connection refused")})
	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{Registry: reg, BaseURL: "http://plex:32400"}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	res := do(t, "POST", ts.URL+"/api/data/resolve", `{"data":{"top":{"provider":"plex.top","params":{}}}}`)
	if res.StatusCode != 200 {
		t.Fatalf("one broken source must not fail the whole request, got %d", res.StatusCode)
	}
	var out resolveResponse
	json.NewDecoder(res.Body).Decode(&out)
	if out.Sources["top"].Error == "" {
		t.Fatal("the source's error must be reported so the UI can show it")
	}
}

func TestImageProxyRejectsForeignHosts(t *testing.T) {
	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{BaseURL: "http://plex:32400"}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	for _, u := range []string{
		"http://evil.example/steal",
		"http://127.0.0.1:22/",
		"file:///etc/passwd",
		"",
	} {
		res := do(t, "GET", ts.URL+"/api/plex/image?u="+url.QueryEscape(u), "")
		if res.StatusCode == 200 {
			t.Errorf("proxy served a foreign URL %q", u)
		}
	}
}

func TestImageProxyPassesThroughAnAllowlistedURL(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("PNGDATA"))
	}))
	t.Cleanup(upstream.Close)

	s := &Server{ManifestDir: t.TempDir(), Plex: &PlexSource{BaseURL: upstream.URL, HTTPClient: upstream.Client()}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	res := do(t, "GET", ts.URL+"/api/plex/image?u="+url.QueryEscape(upstream.URL+"/art?X-Plex-Token=tok"), "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != "PNGDATA" {
		t.Fatalf("got %q", body)
	}
}
```

Add to the import block of `data_test.go`: `"context"`, `"errors"`, `"io"`, `"net/url"`.

- [ ] **Step 2: Run them and watch them fail**

Run: `go test ./internal/webui/ -run 'Resolve|ImageProxy' -v`
Expected: FAIL — `undefined: PlexSource`, `undefined: resolveResponse`.

- [ ] **Step 3: Write `plexsource.go`**

Create `internal/webui/plexsource.go`:

```go
package webui

import (
	"crypto/tls"
	"net/http"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/configmanager"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/plexclient"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers"
	plexprovider "github.com/jordan-simonovski/dynamic-plex-preroll/internal/providers/plex"
)

// PlexSource is the UI's optional live connection to Plex: the same provider
// registry and template variables the batch renderer builds, so a "Test this
// source" in the editor runs exactly what a render will run. It is a pointer
// on Server and nil whenever Plex is not configured — every caller checks.
//
// This file imports plexclient/providers, all of which are CGO-free. It must
// never reach for render/engine/pipeline: preroll-ui stays CGO_ENABLED=0.
type PlexSource struct {
	Registry *providers.Registry
	// Vars are the globals every template string resolves against, matching
	// cmd/plex-pre-rolls/main.go so previews and renders agree.
	Vars map[string]any
	// BaseURL is the Plex server root. It is the allowlist for the image
	// proxy: nothing outside it (or the two Plex CDN hosts) is ever fetched.
	BaseURL string
	// HTTPClient honours PLEX_INSECURE the same way the renderer does.
	HTTPClient *http.Client
}

// NewPlexSource builds the live connection from the environment, or explains
// why it cannot. A nil source is a supported, ordinary state: the editor falls
// back to placeholder data and says so.
func NewPlexSource() (*PlexSource, error) {
	config, err := configmanager.ReadConfig()
	if err != nil {
		return nil, err
	}
	client := &plexclient.PlexClient{
		PlexToken:       config.PlexToken,
		PlexURL:         config.PlexURL,
		PeriodInterval:  config.PeriodInterval.ToInt(),
		MovieSectionId:  config.MovieSectionId,
		TVShowSectionId: config.TVShowSectionId,
		MaxItems:        config.MaxItems,
		Debug:           config.Debug,
	}
	httpClient := &http.Client{Timeout: 30 * time.Second}
	if config.PlexInsecure {
		httpClient.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // opt-in via PLEX_INSECURE, same as the renderer
		}
	}
	client.HTTPClient = httpClient

	registry := providers.NewRegistry()
	plexprovider.Register(registry, client, plexclient.NewDiscoverClient(config.PlexToken, config.Debug))

	return &PlexSource{
		Registry: registry,
		Vars: map[string]any{
			"Period":          config.PeriodInterval.ToString(),
			"PeriodInterval":  string(config.PeriodInterval),
			"MovieSectionId":  config.MovieSectionId,
			"TVShowSectionId": config.TVShowSectionId,
			"MaxItems":        config.MaxItems,
		},
		BaseURL:    config.PlexURL,
		HTTPClient: httpClient,
	}, nil
}
```

- [ ] **Step 4: Write `data.go`**

Create `internal/webui/data.go`:

```go
package webui

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/templating"
)

// resolveTimeout caps a preview fetch. A slow Plex must not wedge the editor's
// stage: the source reports a timeout and the stage falls back to placeholders.
const resolveTimeout = 20 * time.Second

// previewItemLimit caps how many items each source returns to the browser. The
// stage draws a handful and the test table shows a page; nobody needs 200 rows
// of JSON on every keystroke.
const previewItemLimit = 25

// plexImageHosts are the Plex CDN hosts (used by Discover-backed sources)
// allowed alongside the configured server. Everything else is refused: the
// proxy takes a URL from the page, so without this it is an SSRF hole.
var plexImageHosts = map[string]bool{
	"images.plex.tv":          true,
	"metadata-static.plex.tv": true,
	"provider.plex.tv":        true,
}

type previewItem struct {
	Rank     int    `json:"rank"`
	Name     string `json:"name"`
	Views    int    `json:"views"`
	Art      string `json:"art,omitempty"`
	Thumb    string `json:"thumb,omitempty"`
	HasMedia bool   `json:"hasMedia"`
	Type     string `json:"type,omitempty"`
}

type resolvedSource struct {
	Items []previewItem `json:"items"`
	Error string        `json:"error,omitempty"`
}

type resolveResponse struct {
	Configured bool                      `json:"configured"`
	Reason     string                    `json:"reason,omitempty"`
	Vars       map[string]any            `json:"vars,omitempty"`
	Sources    map[string]resolvedSource `json:"sources"`
}

type resolveRequest struct {
	Data map[string]manifest.DataSource `json:"data"`
}

// resolve runs each named data source against the real providers and returns
// what they yield. It always answers 200: "Plex is not configured" and "this
// one source is broken" are both ordinary states the editor renders, not
// transport failures. Serving them as errors would make the stage go blank
// every time somebody typed an incomplete section id.
func (s *Server) resolve(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeJSON(w, http.StatusOK, resolveResponse{Reason: err.Error(), Sources: map[string]resolvedSource{}})
		return
	}
	var req resolveRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusOK, resolveResponse{Reason: err.Error(), Sources: map[string]resolvedSource{}})
		return
	}
	out := resolveResponse{Sources: map[string]resolvedSource{}}
	if s.Plex == nil || s.Plex.Registry == nil {
		out.Reason = "Plex is not configured (set PLEX_URL and PLEX_TOKEN); showing placeholder data"
		writeJSON(w, http.StatusOK, out)
		return
	}
	out.Configured = true
	out.Vars = s.Plex.Vars

	ctx, cancel := context.WithTimeout(r.Context(), resolveTimeout)
	defer cancel()

	for name, ds := range req.Data {
		out.Sources[name] = s.resolveOne(ctx, ds)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) resolveOne(ctx context.Context, ds manifest.DataSource) resolvedSource {
	params, err := templating.RenderParams(ds.Params, s.Plex.Vars)
	if err != nil {
		return resolvedSource{Items: []previewItem{}, Error: err.Error()}
	}
	items, err := s.Plex.Registry.Fetch(ctx, ds.Provider, params)
	if err != nil {
		return resolvedSource{Items: []previewItem{}, Error: err.Error()}
	}
	out := make([]previewItem, 0, len(items))
	for i, it := range items {
		if i >= previewItemLimit {
			break
		}
		out = append(out, previewItem{
			Rank:     i + 1,
			Name:     it.Name,
			Views:    it.Views,
			Art:      s.proxyImage(it.Art),
			Thumb:    s.proxyImage(it.Thumb),
			HasMedia: it.MediaURL != "",
			Type:     it.Type,
		})
	}
	return resolvedSource{Items: out}
}

// proxyImage rewrites a token-bearing Plex image URL into a same-origin URL
// this server will fetch on the browser's behalf. Two reasons it cannot just
// be handed over: the URL carries the Plex token (which should not be pasted
// into page markup), and a Plex server on https with its *.plex.direct cert
// fails browser verification when reached by IP.
func (s *Server) proxyImage(raw string) string {
	if raw == "" {
		return ""
	}
	return "/api/plex/image?u=" + url.QueryEscape(raw)
}

// image fetches an allowlisted Plex image and streams it back. The URL comes
// from the page, so it is checked against the configured server and the Plex
// CDN hosts before anything is dialled.
func (s *Server) image(w http.ResponseWriter, r *http.Request) {
	if s.Plex == nil {
		httpError(w, http.StatusServiceUnavailable, fmt.Errorf("plex is not configured"))
		return
	}
	raw := r.URL.Query().Get("u")
	if err := s.allowImageURL(raw); err != nil {
		httpError(w, http.StatusForbidden, err)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, raw, nil)
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	client := s.Plex.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		// The URL carries the token; never echo the raw error.
		httpError(w, http.StatusBadGateway, fmt.Errorf("could not reach the Plex server for that image"))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		httpError(w, http.StatusBadGateway, fmt.Errorf("plex returned status %d for that image", resp.StatusCode))
		return
	}
	if ct := resp.Header.Get("Content-Type"); strings.HasPrefix(ct, "image/") {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=300")
	io.Copy(w, io.LimitReader(resp.Body, 16<<20))
}

// allowImageURL is the whole security boundary of the proxy: http(s) only, and
// the host+port must be the configured Plex server or a known Plex CDN host.
func (s *Server) allowImageURL(raw string) error {
	if raw == "" {
		return fmt.Errorf("u is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("u is not a URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("only http(s) image URLs are proxied")
	}
	if plexImageHosts[strings.ToLower(u.Hostname())] {
		return nil
	}
	base, err := url.Parse(s.Plex.BaseURL)
	if err != nil || base.Host == "" {
		return fmt.Errorf("no Plex server configured to allow that image")
	}
	if !strings.EqualFold(u.Host, base.Host) {
		return fmt.Errorf("image host %q is not the configured Plex server", u.Host)
	}
	return nil
}
```

- [ ] **Step 5: Add the `Plex` field, the routes, and the capability**

In `internal/webui/webui.go`, add to the `Server` struct:

```go
	// Plex is the optional live connection used for data previews and the
	// image proxy. Nil means the editor runs on placeholder data.
	Plex *PlexSource
```

and in `Handler()`, after the files routes:

```go
	mux.HandleFunc("POST /api/data/resolve", s.resolve)
	mux.HandleFunc("GET /api/plex/image", s.image)
```

In `internal/webui/capabilities.go`, inside `capabilitySet()` before the `return`:

```go
	caps.Plex = s.Plex != nil && s.Plex.Registry != nil
	if !caps.Plex {
		caps.PlexError = s.PlexError
	}
```

and add to the `Server` struct in `webui.go`:

```go
	// PlexError explains why Plex is off, surfaced through /api/capabilities so
	// the UI can say "PLEX_TOKEN unset" rather than silently faking everything.
	PlexError string
```

- [ ] **Step 6: Run the tests**

Run: `go test ./internal/webui/ -v`
Expected: PASS — every pre-existing test plus `TestResolveWithNoPlexIsNotAnError`, `TestResolveRunsTheProviderAndRendersParamTemplates`, `TestResolveReportsAProviderErrorPerSource`, `TestImageProxyRejectsForeignHosts`, `TestImageProxyPassesThroughAnAllowlistedURL`.

- [ ] **Step 7: Wire Plex into `cmd/preroll-ui/main.go`**

Replace the server construction with:

```go
	srv := &webui.Server{
		ManifestDir: *dir,
		MediaDirs:   splitDirs(*media),
	}
	// Plex is optional: without it the editor shows placeholder data and the
	// UI says so. A missing token must never stop the editor from starting.
	if plex, err := webui.NewPlexSource(); err != nil {
		srv.PlexError = err.Error()
		log.Printf("plex data previews disabled: %v", err)
	} else {
		srv.Plex = plex
		log.Printf("plex data previews enabled (%s)", plex.BaseURL)
	}
```

- [ ] **Step 8: Prove the CGO-free constraint still holds**

Run:
```bash
CGO_ENABLED=0 go build -o /dev/null ./cmd/preroll-ui && \
go list -deps ./cmd/preroll-ui | grep -E 'imagick|internal/(render|engine|pipeline)' && echo "FORBIDDEN IMPORT" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 9: Commit**

```bash
git add internal/webui/plexsource.go internal/webui/data.go internal/webui/data_test.go internal/webui/webui.go internal/webui/capabilities.go cmd/preroll-ui/main.go
git commit -m "webui: resolve data sources against real Plex, proxy artwork"
```

---

### Task 6: The stage — three-column shell and a read-only 16:9 canvas

**Model:** Opus — this establishes the shell, the draw loop, the scaling model, and the placeholder-data contract that Tasks 7–10 all build on.

The page becomes rail / stage / inspector. In this task the stage is **read-only**: it draws the selected scene at true proportions with placeholder data, and nothing is clickable yet. The phase-1 cards keep working underneath, so the app is fully usable throughout. The YAML pane stops being a permanent co-star and becomes a toggleable drawer with its validation errors intact.

**Files:**
- Create: `internal/webui/static/stage.js`
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/style.css`
- Modify: `internal/webui/static/app.js`
- Modify: `internal/webui/static/state.js`

**Interfaces:**
- Consumes: `Geometry` (Task 3), `state`/`selection` (Task 2), `esc`/`$` (Task 2).
- Produces:
  - `stage.js`: `renderStage()`, `stageMeasure(ctx, size)` → a `measure` callback for `Geometry`, `stageLines(el, scene)` → the array of strings an element will draw, `setStageData(sources)`, `stageDimensions()` → `{width, height}`.
  - `state.js`: `currentScene()` → the selected scene object or `null`, `currentLayout()` → the layout object the selected scene draws, or `null`.

- [ ] **Step 1: Add the scene/layout accessors to `state.js`**

Append to `internal/webui/static/state.js`:

```js
// currentScene and currentLayout are the two lookups every view needs, and
// both must tolerate a selection that has gone stale (a deleted scene, a
// renamed layout) by returning null rather than throwing mid-render.
function currentScene() {
  return state.scenes[selection.sceneIndex] || null;
}
function currentLayout() {
  const sc = currentScene();
  if (!sc) return null;
  // A clips scene draws no layout of its own; its label layout is what the
  // stage previews, since that is the only thing the user positions.
  const name = sc.kind === "clips" ? sc.label : sc.layout;
  return state.layouts[name] || null;
}
function currentLayoutName() {
  const sc = currentScene();
  if (!sc) return "";
  return (sc.kind === "clips" ? sc.label : sc.layout) || "";
}
function manifestDimensions() {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(state.resolution || ""));
  // A half-typed resolution must not collapse the stage; 1920x1080 is the
  // DSL's own default and the only sane thing to draw against.
  if (!m) return { width: 1920, height: 1080 };
  return { width: parseInt(m[1], 10) || 1920, height: parseInt(m[2], 10) || 1080 };
}
```

- [ ] **Step 2: Rebuild the page shell**

Replace the `<body>` of `internal/webui/static/index.html` with:

```html
<body>
<header class="topbar">
  <h1>Pre-roll <span>Studio</span></h1>
  <div class="topbar-actions" id="manifest-actions"></div>
  <div class="topbar-actions" id="render-actions"></div>
  <span class="spacer"></span>
  <button class="btn ghost" id="toggle-yaml" aria-expanded="false" aria-controls="yaml-drawer">YAML</button>
  <span id="status" aria-live="polite"></span>
</header>

<main class="studio">
  <nav class="rail" id="rail" aria-label="Scenes"></nav>

  <section class="stage-pane">
    <div class="stage-bar">
      <span id="stage-label" class="muted"></span>
      <span class="spacer"></span>
      <label class="check"><input type="checkbox" id="toggle-safe"> Safe area</label>
    </div>
    <div class="stage-frame" id="stage-frame">
      <canvas id="stage" role="img" aria-label="Scene preview"></canvas>
    </div>
    <p class="muted" id="stage-note"></p>
  </section>

  <aside class="inspector" id="inspector" aria-label="Properties"></aside>
</main>

<div class="editor" id="editor">
  <section class="card" id="section-general"></section>
  <section class="card" id="section-audio"></section>
  <section class="card" id="section-data"></section>
  <section class="card" id="section-layouts"></section>
  <section class="card" id="section-scenes"></section>
</div>

<div class="drawer" id="yaml-drawer" hidden>
  <div class="preview-head">
    <h2>manifest.yaml</h2>
    <button id="copy-yaml" class="btn ghost">Copy</button>
  </div>
  <ul id="errors" class="errors" aria-live="polite" aria-label="Validation errors"></ul>
  <pre id="yaml"><code></code></pre>
</div>

<script src="providers.js"></script>
<script src="util.js"></script>
<script src="geometry.js"></script>
<script src="state.js"></script>
<script src="api.js"></script>
<script src="stage.js"></script>
<script src="sections.js"></script>
<script src="app.js"></script>
</body>
```

- [ ] **Step 3: Write `stage.js`**

Create `internal/webui/static/stage.js`:

```js
"use strict";
// stage.js — the live 16:9 preview. It draws the selected scene into a canvas
// using the SAME rules internal/render/render.go uses, so what the user drags
// into place is where the renderer puts it.
//
// All maths lives in geometry.js; this file owns only the canvas, the fonts,
// the images, and the data. That division is why the hard part is testable in
// Node: everything here needs a browser, and nothing here does arithmetic that
// geometry.js could have done.

// stageSources holds the last data resolved for the manifest's sources:
// { "<sourceName>": { items: [...], error: "" } }. Empty until Task 7 fills it
// from the server; every reader falls back to placeholders.
let stageSources = {};
function setStageData(sources) { stageSources = sources || {}; }

// PLACEHOLDER_ITEMS stand in when a source has not been (or cannot be)
// resolved. They are deliberately realistic — varied lengths, plausible view
// counts — because a preview made of "Item 1 / Item 2" hides exactly the
// layout problems the stage exists to reveal.
const PLACEHOLDER_ITEMS = [
  { rank: 1, name: "The Grand Budapest Hotel", views: 42, hasMedia: true },
  { rank: 2, name: "Arrival", views: 31, hasMedia: true },
  { rank: 3, name: "Dune: Part Two", views: 27, hasMedia: true },
  { rank: 4, name: "Everything Everywhere All at Once", views: 19, hasMedia: true },
  { rank: 5, name: "Paddington 2", views: 12, hasMedia: true },
];

function stageItems(sourceName) {
  const resolved = stageSources[sourceName];
  if (resolved && resolved.items && resolved.items.length) return resolved.items;
  return PLACEHOLDER_ITEMS;
}

function stageDimensions() { return manifestDimensions(); }

// ---- template rendering (approximate, on purpose) --------------------------
// The real renderer runs Go text/template. Reimplementing that in the browser
// would be a second, divergent implementation of a thing the server already
// does correctly. Instead the stage substitutes the variables it knows and
// leaves anything else visible as its own source text, so the user can SEE an
// unresolved expression rather than a silent blank.
function stageVars(scene) {
  const vars = {
    Period: "Month", PeriodInterval: "MONTH",
    MovieSectionId: "1", TVShowSectionId: "2", MaxItems: "5",
    ...(stageSources.__vars || {}),
  };
  for (const [k, v] of Object.entries((scene && scene.vars) || {})) vars[k] = v;
  return vars;
}

const FUNC_RE = /\{\{\s*(upper|lower|title)\s+\.(\w+)\s*\}\}/g;
const TRUNCATE_RE = /\{\{\s*truncate\s+(\d+)\s+\.(\w+)\s*\}\}/g;
const PLURALIZE_RE = /\{\{\s*pluralize\s+\.(\w+)\s+"([^"]*)"\s+"([^"]*)"\s*\}\}/g;
const VAR_RE = /\{\{\s*\.(\w+)\s*\}\}/g;

function stageTemplate(text, vars) {
  const get = (name) => (vars[name] === undefined ? null : String(vars[name]));
  return String(text ?? "")
    .replace(TRUNCATE_RE, (m, n, name) => {
      const v = get(name);
      if (v === null) return m;
      const max = parseInt(n, 10);
      return v.length <= max ? v : v.slice(0, Math.max(0, max - 1)) + "…";
    })
    .replace(PLURALIZE_RE, (m, name, one, many) => {
      const v = get(name);
      return v === null ? m : (Number(v) === 1 ? one : many);
    })
    .replace(FUNC_RE, (m, fn, name) => {
      const v = get(name);
      if (v === null) return m;
      if (fn === "upper") return v.toUpperCase();
      if (fn === "lower") return v.toLowerCase();
      return v.replace(/\b\w/g, (c) => c.toUpperCase());
    })
    .replace(VAR_RE, (m, name) => {
      const v = get(name);
      return v === null ? m : v;
    });
}

// stageLines returns exactly the strings an element will draw, in order: one
// per newline for a text element, one per data item for a list.
function stageLines(el, scene) {
  const vars = stageVars(scene);
  if (el.type === "list") {
    return stageItems(el.source).map((item) =>
      stageTemplate(el.item, { ...vars, Rank: item.rank, Name: item.name, Views: item.views }));
  }
  return stageTemplate(el.text, vars).split("\n");
}

// ---- fonts -----------------------------------------------------------------
// A layout names a font FILE. The browser can only use it through @font-face,
// so each distinct path gets a generated family loaded from /api/files/raw. If
// it will not load (no media dir, wrong path), the stage falls back to a
// generic sans and SAYS SO in the note under the canvas — silently swapping
// metrics would make the preview quietly wrong.
const loadedFonts = new Map(); // path -> { family, ok }
let fontFallbackWarning = "";

function stageFontFamily(path) {
  if (!path) {
    fontFallbackWarning = "This layout has no font set — preview uses a system sans-serif.";
    return "sans-serif";
  }
  const entry = loadedFonts.get(path);
  if (entry) {
    if (!entry.ok) fontFallbackWarning = `Could not load ${path} — preview uses a system sans-serif, so text width is approximate.`;
    return entry.ok ? entry.family : "sans-serif";
  }
  const family = `prerollfont${loadedFonts.size}`;
  loadedFonts.set(path, { family, ok: false });
  const face = new FontFace(family, `url("/api/files/raw?path=${encodeURIComponent(path)}")`);
  face.load().then((loaded) => {
    document.fonts.add(loaded);
    loadedFonts.set(path, { family, ok: true });
    renderStage();
  }).catch(() => {
    loadedFonts.set(path, { family, ok: false });
    renderStage();
  });
  return "sans-serif";
}

// ---- measurement -----------------------------------------------------------
// The measure callback geometry.js consumes. Ascent/descent come from the real
// font metrics when the browser reports them, falling back to the 0.8/0.2 em
// split that matches most Latin faces closely enough for a selection box.
function stageMeasure(ctx, size) {
  return (text) => {
    const m = ctx.measureText(text);
    const ascent = m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || size * 0.8;
    const descent = m.actualBoundingBoxDescent || m.fontBoundingBoxDescent || size * 0.2;
    return { width: m.width, ascent, descent };
  };
}

// ---- draw ------------------------------------------------------------------
function renderStage() {
  const canvas = $("#stage");
  if (!canvas) return;
  const { width, height } = stageDimensions();
  const frame = $("#stage-frame");
  const cssWidth = frame.clientWidth;
  const cssHeight = cssWidth * height / width;
  // Keep the backing store at device resolution so text is not blurry, then
  // scale the whole context so every draw call below is in MANIFEST pixels —
  // the same numbers the DSL holds and geometry.js returns.
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = cssWidth + "px";
  canvas.style.height = cssHeight + "px";
  const scale = (cssWidth * dpr) / width;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  fontFallbackWarning = "";
  const scene = currentScene();
  const layout = currentLayout();

  drawBackground(ctx, scene, layout, width, height);
  if (layout) {
    const family = stageFontFamily(layout.font);
    for (const el of layout.elements || []) drawElement(ctx, el, scene, family);
  }
  if ($("#toggle-safe")?.checked) drawSafeArea(ctx, width, height);

  updateStageChrome(scene, layout);
}

// drawBackground mirrors render.go's canvas setup: a scene background (art /
// poster / trailer frames) wins, then the layout's image, then its colour,
// then black. A transparent layout colour over a scene background is exactly
// what the trailer-wall manifests do.
function drawBackground(ctx, scene, layout, width, height) {
  drawCheckerboard(ctx, width, height); // shows through anything transparent

  const sceneBg = scene && scene.background;
  if (sceneBg && sceneBg.source) {
    drawSceneBackground(ctx, sceneBg, width, height);
  }
  if (!layout) return;
  const color = layout.background?.color;
  if (layout.background?.image) {
    drawImagePath(ctx, layout.background.image, { x: 0, y: 0, w: width, h: height });
    return;
  }
  if (Geometry.isTransparent(color)) return; // the scene background shows through
  ctx.fillStyle = safeColor(color, Geometry.DEFAULT_BG_COLOR);
  ctx.fillRect(0, 0, width, height);
}

// Task 7 replaces this with real artwork; until then a scene background is a
// labelled placeholder so the layering is visible and the note explains it.
function drawSceneBackground(ctx, sceneBg, width, height) {
  ctx.fillStyle = "#20242c";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#4a5164";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(height / 24)}px sans-serif`;
  ctx.fillText(`${sceneBg.mode || "art"} from ${sceneBg.source}`, width / 2, height / 2);
  if (sceneBg.dim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(1, sceneBg.dim)})`;
    ctx.fillRect(0, 0, width, height);
  }
}

// Placeholder until Task 7; a layout background image is a local media path,
// which /api/files/raw can serve.
const imageCache = new Map(); // url -> HTMLImageElement | "failed"
function loadImage(url) {
  const cached = imageCache.get(url);
  if (cached) return cached === "failed" ? null : cached;
  const img = new Image();
  img.onload = () => renderStage();
  img.onerror = () => { imageCache.set(url, "failed"); renderStage(); };
  img.src = url;
  imageCache.set(url, img);
  return img.complete && img.naturalWidth ? img : null;
}

function drawImagePath(ctx, path, cell) {
  const img = loadImage(`/api/files/raw?path=${encodeURIComponent(path)}`);
  if (!img) {
    ctx.fillStyle = "#1b1f26";
    ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
    return;
  }
  const r = Geometry.coverRect(img.naturalWidth, img.naturalHeight, cell.w, cell.h);
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, cell.x, cell.y, cell.w, cell.h);
}

// A faint checkerboard under everything, so "background: none" reads as
// transparent instead of as black — that distinction decides whether a clip
// label works at all.
function drawCheckerboard(ctx, width, height) {
  const cell = Math.round(width / 48);
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? "#15181d" : "#1b1f26";
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

function drawElement(ctx, el, scene, family) {
  const size = el.size || 0;
  ctx.font = `${size}px "${family}", sans-serif`;
  ctx.fillStyle = safeColor(el.color, Geometry.DEFAULT_TEXT_COLOR);
  ctx.textAlign = Geometry.align(el);
  ctx.textBaseline = "alphabetic"; // matches ImageMagick's Annotation origin
  const lines = stageLines(el, scene);
  const baselines = el.type === "list"
    ? Geometry.listBaselines(el, lines.length)
    : Geometry.textBaselines(el, lines.length);
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], el.x || 0, baselines[i]);
}

// safeColor keeps an in-progress colour ("#ff", "reddd") from throwing or
// silently painting the previous element's colour: canvas ignores an invalid
// fillStyle assignment, so it is validated before use.
const colorProbe = document.createElement("canvas").getContext("2d");
function safeColor(value, fallback) {
  const v = String(value ?? "").trim();
  if (v === "" || Geometry.isTransparent(v)) return fallback === undefined ? "transparent" : fallback;
  colorProbe.fillStyle = "#000000";
  colorProbe.fillStyle = v;
  const first = colorProbe.fillStyle;
  colorProbe.fillStyle = "#ffffff";
  colorProbe.fillStyle = v;
  // An invalid value leaves fillStyle at whatever it was, so two different
  // seeds landing on different results means the value was rejected.
  return first === colorProbe.fillStyle ? v : fallback;
}

function drawSafeArea(ctx, width, height) {
  const s = Geometry.safeArea(width, height);
  ctx.save();
  ctx.strokeStyle = "rgba(229,160,13,0.6)";
  ctx.setLineDash([12, 12]);
  ctx.lineWidth = 2;
  ctx.strokeRect(s.x, s.y, s.w, s.h);
  ctx.restore();
}

// updateStageChrome writes the label above the canvas and the honest note
// below it: what is approximate, and why.
function updateStageChrome(scene, layout) {
  const label = $("#stage-label");
  const note = $("#stage-note");
  if (!scene) {
    label.textContent = "No scenes yet";
    note.textContent = "Add a scene to start.";
    return;
  }
  const idx = selection.sceneIndex + 1;
  label.textContent = `Scene ${idx} · ${scene.kind}` + (currentLayoutName() ? ` · ${currentLayoutName()}` : "");
  const notes = [];
  if (scene.kind === "image") notes.push("A still-image scene is played as-is; there is nothing to lay out.");
  if (scene.kind === "clips" && !scene.label) notes.push("A clip montage with no label layout draws no text.");
  if (scene.kind === "render" && !layout) notes.push("This scene names a layout that does not exist.");
  if (fontFallbackWarning) notes.push(fontFallbackWarning);
  note.textContent = notes.join(" ");
}

// The stage is sized from its container, so a window resize must redraw it.
window.addEventListener("resize", debounce(renderStage, 100));
```

- [ ] **Step 4: Add the shell styles**

Append to `internal/webui/static/style.css`:

```css
/* ---- phase 2: rail / stage / inspector ---------------------------------- */
.topbar .spacer { flex: 1; }

.studio {
  display: grid;
  grid-template-columns: 190px minmax(420px, 1fr) 340px;
  gap: 16px;
  padding: 16px 20px;
  align-items: start;
}
@media (max-width: 1100px) { .studio { grid-template-columns: 1fr; } }

.rail, .inspector {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}

.stage-pane { display: flex; flex-direction: column; gap: 8px; }
.stage-bar { display: flex; align-items: center; gap: 12px; }
.stage-bar .spacer { flex: 1; }
.stage-frame {
  background: #000;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  line-height: 0;
}
#stage { display: block; width: 100%; touch-action: none; }
#stage-note { min-height: 18px; }

.drawer {
  border-top: 1px solid var(--border);
  background: var(--panel);
  padding: 12px 20px 20px;
}

/* The phase-1 cards live below the studio while they are being retired. */
.editor { padding: 0 20px 24px; max-width: 1500px; margin: 0 auto; }
```

- [ ] **Step 5: Boot the stage and the YAML drawer from `app.js`**

In `internal/webui/static/app.js`, change the state-change handler and boot block at the bottom to:

```js
// ---- yaml drawer -----------------------------------------------------------
$("#toggle-yaml").onclick = () => {
  const drawer = $("#yaml-drawer");
  const open = drawer.hasAttribute("hidden");
  drawer.toggleAttribute("hidden", !open);
  $("#toggle-yaml").setAttribute("aria-expanded", String(open));
};
$("#toggle-safe").onchange = renderStage;

// ---- boot ------------------------------------------------------------------
// A state mutation redraws every view and re-validates. state.js calls this
// without knowing what "every view" is.
setStateChangeHandler(() => { renderAll(); renderStage(); scheduleConvert(); });
renderAll();
renderStage();
renderToolbar();
convert();
```

and in the three delegated listeners on `#editor`, add `renderStage();` immediately before each `scheduleConvert();` call, so editing a number in the old form moves the element on the stage.

- [ ] **Step 6: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS. `TestEveryScriptTagIsEmbedded` now covers `stage.js`.

- [ ] **Step 7: Human check — the stage draws the real geometry**

Run: `go run ./cmd/preroll-ui -manifest-dir manifests -media-dir media` and open `http://localhost:8382`.
No browser automation is available in this environment, so verify by eye:
1. Open `top-movies-trailer-wall.yaml`. The stage shows a 16:9 frame: the title "Top Movies — MONTH" near the top-left and five placeholder titles stepping down from y=320, in the Adult Swim font (the note under the canvas is empty when the font loaded; if it says "Could not load", the `-media-dir` flag is wrong).
2. In the old Layouts card, change the title element's `y` from 150 to 400 — the title moves down the stage immediately.
3. Set the title's Align to `center` and its `x` to 960 — the title centres.
4. Tick "Safe area" — a dashed gold rectangle appears 5% inside the frame.
5. Open `double-feature.yaml` and `collections.yaml`; each draws without a console error.
6. Click YAML in the topbar — the drawer opens with the same YAML and validation errors as before.

- [ ] **Step 8: Commit**

```bash
git add internal/webui/static/ 
git commit -m "webui: three-column shell with a live scene stage"
```

---

### Task 7: Real data, real artwork, real backgrounds on the stage

**Model:** Sonnet — wiring an existing endpoint into an existing draw loop.

The stage currently invents its items and paints a grey rectangle for a scene background. Now it asks the server for the real ones and draws art/posters exactly as `render.go` composes them, falling back to today's behaviour whenever Plex is absent.

**Files:**
- Modify: `internal/webui/static/api.js`
- Modify: `internal/webui/static/stage.js`
- Modify: `internal/webui/static/app.js`

**Interfaces:**
- Consumes: `POST /api/data/resolve` (Task 5), `GET /api/capabilities` (Task 1), `Geometry.gridCells`/`coverRect` (Task 3).
- Produces: `api.js`: `async apiResolveData(dataMap)` → `{configured, reason, vars, sources}`. `stage.js`: `refreshStageData()`, and `stageSources.__vars` populated from the server.

- [ ] **Step 1: Add the API call**

Append to `internal/webui/static/api.js`:

```js
// Resolving data runs the real providers, so it can be slow and it can fail;
// both are ordinary and the caller gets a well-formed answer either way.
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
```

- [ ] **Step 2: Fetch data into the stage**

Append to `internal/webui/static/stage.js`:

```js
// refreshStageData asks the server to run every data source and redraws with
// what came back. It is debounced hard (2s) because each call hits Plex for
// real: the stage is allowed to lag the form, but it must never hammer the
// server on every keystroke.
let stageDataReason = "";
async function refreshStageDataNow() {
  if (!Object.keys(state.data).length) {
    setStageData({});
    renderStage();
    return;
  }
  const out = await apiResolveData(state.data);
  const sources = out.sources || {};
  sources.__vars = out.vars || {};
  setStageData(sources);
  stageDataReason = out.configured ? "" : (out.reason || "Plex is not configured — showing placeholder data.");
  renderStage();
}
const refreshStageData = debounce(refreshStageDataNow, 2000);
```

and add `stageDataReason` to the note in `updateStageChrome`, immediately before `note.textContent = notes.join(" ");`:

```js
  if (stageDataReason) notes.push(stageDataReason);
  for (const [name, src] of Object.entries(stageSources)) {
    if (name !== "__vars" && src && src.error) notes.push(`${name}: ${src.error}`);
  }
```

- [ ] **Step 3: Draw real artwork behind a scene**

In `internal/webui/static/stage.js`, replace `drawSceneBackground` with:

```js
// drawSceneBackground mirrors engine.go + render.go: take up to `limit` items
// from the source (default 4), use each item's Art or Thumb depending on mode,
// lay them out cover or grid, then dim.
//
// Two honest approximations, both called out in the note under the canvas:
// a trailers-mode background is a real montage of video in the render but only
// the items' posters here, and render.go dims with ImageMagick's ModulateImage
// (a brightness scale) where the stage uses a black overlay — close, not equal.
function drawSceneBackground(ctx, sceneBg, width, height) {
  const items = stageItems(sceneBg.source);
  const limit = sceneBg.limit > 0 ? sceneBg.limit : 4;
  const key = sceneBg.mode === "poster" || sceneBg.mode === "trailers" ? "thumb" : "art";
  const urls = [];
  for (const item of items) {
    const u = item[key] || item.art || item.thumb;
    if (u) urls.push(u);
    if (urls.length >= limit) break;
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  if (!urls.length) {
    ctx.fillStyle = "#20242c";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#4a5164";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(height / 28)}px sans-serif`;
    ctx.fillText(`${sceneBg.mode || "art"} from ${sceneBg.source}`, width / 2, height / 2);
  } else {
    // render.go only grids when there is MORE than one image; a single image
    // always covers the frame.
    const cells = (sceneBg.tile === "grid" && urls.length > 1)
      ? Geometry.gridCells(urls.length, width, height)
      : [{ x: 0, y: 0, w: width, h: height }];
    for (let i = 0; i < cells.length; i++) drawImageURL(ctx, urls[i], cells[i]);
  }

  if (sceneBg.dim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(1, sceneBg.dim)})`;
    ctx.fillRect(0, 0, width, height);
  }
}

// Artwork arrives as a same-origin proxy URL from /api/data/resolve, so it is
// loaded directly rather than through /api/files/raw.
function drawImageURL(ctx, url, cell) {
  const img = loadImage(url);
  if (!img) {
    ctx.fillStyle = "#1b1f26";
    ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
    return;
  }
  const r = Geometry.coverRect(img.naturalWidth, img.naturalHeight, cell.w, cell.h);
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, cell.x, cell.y, cell.w, cell.h);
}
```

and in `updateStageChrome`, add before `note.textContent = ...`:

```js
  if (scene.background && scene.background.mode === "trailers") {
    notes.push("The render plays a muted trailer montage here; the preview shows the same items' posters.");
  }
  if (scene.background && scene.background.dim > 0) {
    notes.push("Dimming is approximated with a black overlay; the render uses a brightness scale.");
  }
```

- [ ] **Step 4: Refresh data when the sources change**

In `internal/webui/static/app.js`, change the state-change handler to:

```js
setStateChangeHandler(() => { renderAll(); renderStage(); refreshStageData(); scheduleConvert(); });
```

and in the `#editor` `input` listener, after `setPath(...)`, add:

```js
  // Only a data-source edit can change what the providers return; anything
  // else just redraws.
  if (path.startsWith("data.")) refreshStageData();
```

and in the boot block, after `renderStage();` add `refreshStageDataNow();`.

- [ ] **Step 5: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS.

- [ ] **Step 6: Human check — with and without Plex**

**Without Plex** (`env -u PLEX_URL -u PLEX_TOKEN go run ./cmd/preroll-ui -manifest-dir manifests -media-dir media`):
open `top-movies-trailer-wall.yaml`. The five placeholder titles still draw, the scene background is the labelled grey placeholder, and the note under the canvas reads "Plex is not configured (set PLEX_URL and PLEX_TOKEN); showing placeholder data." Nothing is broken and nothing spins.

**With Plex** (`go run ./cmd/preroll-ui -manifest-dir manifests -media-dir media` with the repo's `.env` exported):
the same manifest now lists real film titles from the library, and the background is a 2×2 grid of their real posters, dimmed. The note mentions the trailer-montage and dimming approximations.

- [ ] **Step 7: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: stage draws real Plex items and artwork, placeholders offline"
```

---

### Task 8: Selection and the contextual inspector — retire the Layouts card

**Model:** Opus — the selection model and the inspector's dispatch shape are what every remaining UI task plugs into, and this is where the first phase-1 card is removed.

Clicking an element on the stage selects it; the right-hand inspector shows properties for whatever is selected — element, scene, or the pre-roll itself. Once the inspector covers layout and element properties, the Layouts card has no job left and is deleted.

**Files:**
- Create: `internal/webui/static/inspector.js`
- Modify: `internal/webui/static/stage.js`
- Modify: `internal/webui/static/sections.js` (delete the layouts section)
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/app.js`
- Modify: `internal/webui/static/style.css`

**Interfaces:**
- Consumes: `Geometry.elementBox`/`hitTest` (Task 3), `selection`/`currentScene`/`currentLayout` (Tasks 2, 6), `stageLines`/`stageMeasure` (Task 6).
- Produces:
  - `stage.js`: `stageBoxes()` → `[{x,y,w,h}]` for the current layout's elements, in draw order; `selectAt(clientX, clientY)` → sets `selection.element` and redraws.
  - `inspector.js`: `renderInspector()`, `elementPath()` → the `state` path prefix of the selected element (e.g. `layouts.top-over-trailers.elements.0`) or `null`.

- [ ] **Step 1: Expose the element boxes and click-to-select from the stage**

In `internal/webui/static/stage.js`, add a module-level cache and fill it inside `renderStage`. Replace the element-drawing loop in `renderStage` with:

```js
  stageBoxCache = [];
  if (layout) {
    const family = stageFontFamily(layout.font);
    const els = layout.elements || [];
    for (const el of els) {
      drawElement(ctx, el, scene, family);
      stageBoxCache.push(measureElement(ctx, el, scene, family));
    }
    drawSelection(ctx, width);
  }
```

and append to `stage.js`:

```js
// stageBoxCache is the selection/hit rectangle of every element in the current
// layout, in draw order, recomputed on every render. It is cached rather than
// derived on demand because measuring text needs the canvas context with the
// right font already set — cheap during the draw, awkward afterwards.
let stageBoxCache = [];
function stageBoxes() { return stageBoxCache; }

function measureElement(ctx, el, scene, family) {
  // ctx state is whatever drawElement left: same font, same alignment. Setting
  // it again keeps measureElement correct if it is ever called out of order.
  ctx.font = `${el.size || 0}px "${family}", sans-serif`;
  return Geometry.elementBox(el, stageLines(el, scene), stageMeasure(ctx, el.size || 0));
}

// drawSelection outlines the selected element and draws its single resize
// handle. Stroke widths are divided by the stage scale so the outline is a
// constant thickness on screen whatever the manifest resolution.
function drawSelection(ctx, width) {
  if (selection.element == null) return;
  const box = stageBoxCache[selection.element];
  if (!box) return;
  const { width: manifestWidth } = stageDimensions();
  const px = manifestWidth / $("#stage").clientWidth; // manifest px per CSS px
  ctx.save();
  ctx.strokeStyle = "#e5a00d";
  ctx.lineWidth = 1.5 * px;
  ctx.setLineDash([6 * px, 4 * px]);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
  const h = Geometry.handlePoint(box);
  const s = 5 * px;
  ctx.fillStyle = "#e5a00d";
  ctx.fillRect(h.x - s, h.y - s, s * 2, s * 2);
  ctx.restore();
}

// selectAt turns a click into a selection: the topmost element under the
// pointer, or nothing (which selects the scene itself).
function selectAt(clientX, clientY) {
  const canvas = $("#stage");
  const { width } = stageDimensions();
  const p = Geometry.toManifest(clientX, clientY, canvas.getBoundingClientRect(), width);
  const hit = Geometry.hitTest(stageBoxCache, p.x, p.y);
  selection.element = hit === -1 ? null : hit;
  renderStage();
  renderInspector();
}
```

- [ ] **Step 2: Write `inspector.js`**

Create `internal/webui/static/inspector.js`:

```js
"use strict";
// inspector.js — the right-hand panel. It describes whatever is selected: an
// element on the stage, the scene, or the pre-roll itself. Every control binds
// through data-path exactly like the phase-1 form did, so the existing
// delegated input/change listeners keep working unchanged.

// elementPath is the state path prefix of the selected element. Null whenever
// nothing is selected or the selection has gone stale (a deleted element, a
// scene whose layout was renamed away).
function elementPath() {
  if (selection.element == null) return null;
  const name = currentLayoutName();
  const layout = currentLayout();
  if (!layout || !layout.elements || !layout.elements[selection.element]) return null;
  return `layouts.${name}.elements.${selection.element}`;
}

function renderInspector() {
  const el = $("#inspector");
  const scene = currentScene();
  if (!scene) {
    el.innerHTML = `<h2>Pre-roll</h2>${prerollFields()}
      <p class="empty">No scenes yet — add one from the timeline.</p>`;
    return;
  }
  const path = elementPath();
  el.innerHTML = path
    ? elementInspector(path, currentLayout().elements[selection.element])
    : sceneInspector(scene, selection.sceneIndex);
}

// ---- pre-roll --------------------------------------------------------------
function prerollFields() {
  return `<div class="stack">
    ${field("Name", textInput("name", state.name, { placeholder: "my-preroll" }),
      "Letters, digits, dots, dashes — it becomes the filename")}
    ${field("Output file", textInput("output", state.output, { placeholder: "output/my-preroll.mp4" }))}
    ${field("Resolution", select("resolution", state.resolution, ["1920x1080", "3840x2160", "1280x720"], { rerender: "resolution" }))}
    ${field("FPS", numInput("fps", state.fps, { int: true, min: 1 }))}
    ${field("Length (s)", numInput("length", state.length, { min: 0 }), "0 lets the scenes decide the total length")}
  </div>`;
}

// ---- element ---------------------------------------------------------------
function elementInspector(base, el) {
  const back = `<button class="btn ghost" data-action="select-scene">← Scene</button>`;
  const common = `
    ${field("Font size", numInput(`${base}.size`, el.size))}
    ${field("Colour", textInput(`${base}.color`, el.color, { placeholder: "white" }))}
    ${field("Align", select(`${base}.align`, el.align ?? "", ["", "left", "center", "right"], { emptyLabel: "left (default)" }),
      "Where x anchors the text: its left edge, its centre, or its right edge")}`;
  if (el.type === "list") {
    return `<h2>List element</h2>${back}
      <div class="stack">
        ${field("Data source", select(`${base}.source`, el.source, Object.keys(state.data)), "Which feed this list iterates")}
        ${field("Row template", textInput(`${base}.item`, el.item, { placeholder: "{{ .Rank }}. {{ .Name }}" }))}
        ${field("X", numInput(`${base}.x`, el.x))}
        ${field("First row Y", numInput(`${base}.startY`, el.startY), "The first row's baseline sits exactly here")}
        ${field("Row spacing", numInput(`${base}.stepY`, el.stepY))}
        ${common}
      </div>
      <button class="btn ghost danger" data-action="remove-selected-element">Remove element</button>`;
  }
  return `<h2>Text element</h2>${back}
    <div class="stack">
      ${field("Text", `<textarea data-path="${esc(base)}.text">${esc(el.text)}</textarea>`,
        "Newlines stack; the block is centred vertically on Y")}
      ${field("X", numInput(`${base}.x`, el.x))}
      ${field("Y", numInput(`${base}.y`, el.y))}
      ${field("Line height", numInput(`${base}.lineHeight`, el.lineHeight ?? 0), "0 = 1.2 × the font size")}
      ${common}
    </div>
    <button class="btn ghost danger" data-action="remove-selected-element">Remove element</button>`;
}

// ---- scene -----------------------------------------------------------------
function sceneInspector(sc, i) {
  const base = `scenes.${i}`;
  return `<h2>Scene ${i + 1}</h2>
    <div class="stack">
      ${field("Kind", select(`${base}.kind`, sc.kind, ["image", "render", "clips"],
        { rerender: "scene-kind", attrs: `data-index="${i}"` }))}
      ${sceneKindFields(sc, i, base)}
    </div>
    ${layoutSection(sc)}
    <details><summary>Pre-roll settings</summary>${prerollFields()}</details>`;
}

function sceneKindFields(sc, i, base) {
  if (sc.kind === "image") {
    return `${field("Image file", textInput(`${base}.file`, sc.file, { placeholder: "media/common/intro.png" }))}
      ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}`;
  }
  if (sc.kind === "clips") {
    return `${field("Data source", select(`${base}.source`, sc.source, Object.keys(state.data)),
        "Items need trailer/media URLs — e.g. plex.trailers, or trailers: true")}
      ${field("Seconds per clip", numInput(`${base}.perClip`, sc.perClip, { min: 0 }))}
      ${field("Label layout", select(`${base}.label`, sc.label ?? "", ["", ...Object.keys(state.layouts)], { emptyLabel: "(no label)" }),
        "Drawn over every clip with that item's Name/Rank in scope — needs a transparent background")}`;
  }
  const bg = sc.background;
  return `${field("Layout", select(`${base}.layout`, sc.layout, Object.keys(state.layouts), { rerender: "scene-layout" }))}
    ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}
    ${varRows(sc, i, base)}
    <label class="check"><input type="checkbox" data-action-toggle="scene-bg" data-index="${i}"${bg ? " checked" : ""}> Dynamic background</label>
    ${bg ? `
      ${field("Source", select(`${base}.background.source`, bg.source, Object.keys(state.data)))}
      ${field("Mode", select(`${base}.background.mode`, bg.mode, ["art", "poster", "trailers"]),
        "art/poster: still images · trailers: muted video montage")}
      ${field("Tile", select(`${base}.background.tile`, bg.tile ?? "", ["", "cover", "grid", "sequence"], { emptyLabel: "cover (default)" }),
        "grid: up to 4 items 2×2 · sequence: trailers back to back")}
      ${field("Dim", `<input type="range" data-path="${esc(base)}.background.dim" data-type="number" min="0" max="1" step="0.05" value="${esc(bg.dim ?? 0)}">`,
        "0 = untouched, 1 = black — keeps overlaid text legible")}
      ${field("Item limit", numInput(`${base}.background.limit`, bg.limit ?? 0, { int: true, min: 0 }), "0 = all")}` : ""}`;
}

// layoutSection is the layout the selected scene draws: its font, its
// background, and the buttons that add elements to it. This is the half of the
// old Layouts card that had to survive; the per-element half moved to
// elementInspector.
function layoutSection(sc) {
  const name = currentLayoutName();
  const layout = currentLayout();
  if (!layout) {
    return sc.kind === "render"
      ? `<h3>Layout</h3><p class="empty">This scene has no layout yet.</p>
         <button class="btn" data-action="add-layout">+ New layout</button>`
      : "";
  }
  const base = `layouts.${name}`;
  const els = (layout.elements || []).map((el, i) =>
    `<button class="element-row${i === selection.element ? " selected" : ""}" data-action="select-element" data-index="${i}">
       <span class="kind">${esc(el.type)}</span>
       <span class="label">${esc(el.type === "list" ? (el.item || "(row template)") : (el.text || "(empty)").split("\n")[0])}</span>
     </button>`).join("");
  return `<h3>Layout · ${esc(name)}</h3>
    <div class="stack">
      ${field("Font file", textInput(`${base}.font`, layout.font, { placeholder: "media/common/MyFont.ttf" }))}
      ${field("Background colour", textInput(`${base}.background.color`, layout.background?.color, { placeholder: "black, #101010, none" }),
        `Use "none" for transparent — required for clip labels and dynamic backgrounds`)}
      ${field("Background image", textInput(`${base}.background.image`, layout.background?.image, { placeholder: "media/common/bg.png" }),
        "Wins over the colour when set")}
    </div>
    <h3>Elements</h3>
    <div class="element-list">${els || `<p class="empty">No elements — a layout needs at least one.</p>`}</div>
    <button class="btn ghost" data-action="add-element-here" data-kind="text">+ Text</button>
    <button class="btn ghost" data-action="add-element-here" data-kind="list">+ List</button>`;
}

// ---- actions ---------------------------------------------------------------
actions["select-scene"] = () => { selection.element = null; renderStage(); renderInspector(); };
actions["select-element"] = (d) => { selection.element = +d.index; renderStage(); renderInspector(); };
actions["remove-selected-element"] = () => {
  const layout = currentLayout();
  if (!layout || selection.element == null) return;
  layout.elements.splice(selection.element, 1);
  selection.element = null;
  renderStage();
  renderInspector();
};
actions["add-element-here"] = (d) => {
  const layout = currentLayout();
  if (!layout) return;
  const { width, height } = stageDimensions();
  // New elements land in the middle of the frame rather than at 0,0 — an
  // element off the top-left corner looks broken and cannot be grabbed.
  layout.elements.push(d.kind === "list"
    ? { type: "list", source: Object.keys(state.data)[0] || "", item: "{{ .Rank }}. {{ .Name }}",
        x: Math.round(width * 0.05), startY: Math.round(height * 0.35),
        stepY: Math.round(height * 0.09), size: Math.round(height * 0.05), color: "white" }
    : { type: "text", text: "Text", x: Math.round(width / 2), y: Math.round(height / 2),
        size: Math.round(height * 0.09), color: "white", align: "center" });
  selection.element = layout.elements.length - 1;
  renderStage();
  renderInspector();
};
actions["add-layout"] = () => {
  const name = uniqueKey(state.layouts, "layout");
  const { width, height } = stageDimensions();
  state.layouts[name] = {
    background: { color: "black", image: "" },
    font: "",
    elements: [{ type: "text", text: "Title", x: Math.round(width / 2), y: Math.round(height / 2),
                 size: Math.round(height * 0.09), color: "white", align: "center" }],
  };
  const sc = currentScene();
  if (sc && sc.kind === "render") sc.layout = name;
  selection.element = 0;
  onStateChange();
  renderInspector();
};

// Changing a render scene's layout invalidates the element selection, which
// indexes into the OLD layout's array.
rerenderHooks["scene-layout"] = () => { selection.element = null; };
// A resolution change moves nothing in the manifest but rescales the stage.
rerenderHooks["resolution"] = () => {};
```

- [ ] **Step 3: Retire the Layouts card**

- Delete from `internal/webui/static/sections.js`: `renderLayouts`, `layoutCard`, `elementCard`, `templateChips`, and the `actions["add-layout"|"remove-layout"|"add-element"|"remove-element"]` assignments. Keep `varRows` — `inspector.js` calls it.
- In `sections.js`'s `renderAll`, delete the `renderLayouts();` line and add `renderInspector();` as the last call.
- In `internal/webui/static/index.html`, delete `<section class="card" id="section-layouts"></section>` and add `<script src="inspector.js"></script>` between `stage.js` and `sections.js`.

- [ ] **Step 4: Wire the canvas click and the inspector's events**

In `internal/webui/static/app.js`, add before the boot block:

```js
// The inspector uses the same data-path/data-action conventions as the phase-1
// form, so it gets the same three delegated listeners rather than its own.
for (const root of ["#editor", "#inspector"]) {
  const el = $(root);
  el.addEventListener("input", onEditorInput);
  el.addEventListener("change", onEditorChange);
  el.addEventListener("click", onEditorClick);
}

$("#stage").addEventListener("click", (e) => selectAt(e.clientX, e.clientY));
```

and refactor the three existing inline `$("#editor").addEventListener(...)` bodies into named functions `onEditorInput(e)`, `onEditorChange(e)`, `onEditorClick(e)` with identical bodies (so the loop above can register both roots), deleting the old inline registrations. In `onEditorChange`, replace the two `renderScenes();` calls with `renderAll();` so the inspector repaints too.

- [ ] **Step 5: Style the inspector**

Append to `internal/webui/static/style.css`:

```css
.inspector h2 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--accent); }
.inspector h3 { margin: 16px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); }
.inspector .stack { display: flex; flex-direction: column; gap: 8px; }
.inspector details { margin-top: 14px; }
.inspector summary { cursor: pointer; color: var(--muted); font-size: 12px; }

.element-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.element-row {
  display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 8px; color: var(--text); font: inherit; cursor: pointer;
}
.element-row.selected { border-color: var(--accent); }
.element-row .kind { color: var(--muted); font-size: 11px; text-transform: uppercase; }
.element-row .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 6: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS.

- [ ] **Step 7: Human check — selection and the retired card**

Run the server and open `top-movies-trailer-wall.yaml`:
1. The Layouts card is gone from the page.
2. The inspector shows "Scene 1", its kind, layout, duration, the dynamic-background controls, a "Layout · top-over-trailers" section with font and background fields, and the two elements listed.
3. Click the title text on the stage — a dashed gold outline appears around it with a square handle at its bottom-right, and the inspector switches to "Text element" with the title's text, x, y, size, colour and align.
4. Change Font size to 140 — the title grows on the stage and the outline follows it.
5. Click the list on the stage — the inspector switches to "List element" and shows First row Y / Row spacing.
6. Click empty canvas — the inspector goes back to the scene.
7. "← Scene", "+ Text", "+ List", "Remove element" all do what they say, and the YAML drawer reflects each change.

- [ ] **Step 8: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: click-to-select on the stage with a contextual inspector"
```

---

### Task 9: Drag to move, handle to resize, snapping and guides

**Model:** Opus — the interaction model. Getting the pointer/capture/commit sequence right (and keeping every calculation in `geometry.js`) is what makes this feel like an editor rather than a toy.

**Files:**
- Modify: `internal/webui/static/geometry.js`
- Modify: `internal/webui/static/geometry.test.js`
- Modify: `internal/webui/static/stage.js`
- Modify: `internal/webui/static/app.js`

**Interfaces:**
- Consumes: `Geometry.moveTo`/`resizeSize`/`snap`/`snapTargets`/`onHandle` (Task 3), `stageBoxes` (Task 8).
- Produces:
  - `geometry.js`: `Geometry.dragPatch(el, box, dx, dy, targets, tol)` → `{patch, guides:{x,y}}` — one pure function that does the whole move-with-snapping calculation, so the pointer handler contains no arithmetic.
  - `stage.js`: `stageDragGuides` (drawn as lines), pointer handlers bound in Task 9 Step 5.

- [ ] **Step 1: Write the failing test for `dragPatch`**

Append to `internal/webui/static/geometry.test.js`:

```js
test("dragPatch snaps the element's own edges to the guides", () => {
  const el = { type: "text", x: 100, y: 500, size: 100, align: "left" };
  const box = { x: 100, y: 460, w: 200, h: 100 };
  const targets = { xs: [0, 960, 1920], ys: [0, 540, 1080] };
  // Dragging right by 855 puts the box's left edge at 955, five short of the
  // 960 centre guide: it should snap, and x moves by the SNAPPED delta.
  const out = Geometry.dragPatch(el, box, 855, 0, targets, 8);
  assert.strictEqual(out.patch.x, 960);
  assert.strictEqual(out.guides.x, 960);
  assert.strictEqual(out.patch.y, 500, "an unsnapped axis keeps its raw delta");
  assert.strictEqual(out.guides.y, null);
});

test("dragPatch leaves an unsnapped drag exactly where it was dropped", () => {
  const el = { type: "text", x: 100, y: 500 };
  const box = { x: 100, y: 460, w: 200, h: 100 };
  const out = Geometry.dragPatch(el, box, 30, 40, { xs: [0], ys: [0] }, 8);
  assert.deepStrictEqual(out.patch, { x: 130, y: 540 });
  assert.deepStrictEqual(out.guides, { x: null, y: null });
});

test("dragPatch moves a list by startY, not y", () => {
  const el = { type: "list", x: 96, startY: 320 };
  const box = { x: 96, y: 280, w: 400, h: 500 };
  const out = Geometry.dragPatch(el, box, 10, 10, { xs: [], ys: [] }, 8);
  assert.deepStrictEqual(out.patch, { x: 106, startY: 330 });
});

test("dragPatch snaps to whichever of the box's three x anchors is closest", () => {
  const el = { type: "text", x: 100, y: 500, align: "left" };
  const box = { x: 100, y: 460, w: 200, h: 100 }; // right edge at 300
  // Dragging right by 655 puts the RIGHT edge at 955 — 5 from the 960 guide.
  const out = Geometry.dragPatch(el, box, 655, 0, { xs: [960], ys: [] }, 8);
  assert.strictEqual(out.patch.x, 760, "x moves so the right edge lands on 960");
  assert.strictEqual(out.guides.x, 960);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test internal/webui/static/geometry.test.js`
Expected: FAIL — `Geometry.dragPatch is not a function`.

- [ ] **Step 3: Add `dragPatch` to `geometry.js`**

Insert into the `Geometry` object, after `moveTo`:

```js
  // dragPatch is the whole move calculation: apply the raw delta, then look at
  // the box's three anchors on each axis (left/centre/right, top/middle/bottom)
  // and take the nearest snap within tolerance, adjusting the delta by however
  // far that anchor had to move. Returning the guides it locked onto lets the
  // stage draw them; keeping the arithmetic here keeps the pointer handler
  // free of maths and this behaviour testable in Node.
  dragPatch(el, box, dx, dy, targets, tol) {
    const anchorsX = [box.x + dx, box.x + box.w / 2 + dx, box.x + box.w + dx];
    const anchorsY = [box.y + dy, box.y + box.h / 2 + dy, box.y + box.h + dy];
    let adjustX = 0;
    let guideX = null;
    let bestX = tol;
    for (const a of anchorsX) {
      const s = Geometry.snap(a, targets.xs || [], bestX);
      if (s.guide !== null) { bestX = Math.abs(a - s.guide); adjustX = s.guide - a; guideX = s.guide; }
    }
    let adjustY = 0;
    let guideY = null;
    let bestY = tol;
    for (const a of anchorsY) {
      const s = Geometry.snap(a, targets.ys || [], bestY);
      if (s.guide !== null) { bestY = Math.abs(a - s.guide); adjustY = s.guide - a; guideY = s.guide; }
    }
    return {
      patch: Geometry.moveTo(el, dx + adjustX, dy + adjustY),
      guides: { x: guideX, y: guideY },
    };
  },
```

- [ ] **Step 4: Run the geometry tests**

Run: `node --test internal/webui/static/geometry.test.js`
Expected: PASS — 24 tests, 0 failures.

- [ ] **Step 5: Add the pointer interaction to `stage.js`**

Append to `internal/webui/static/stage.js`:

```js
// ---- pointer interaction ---------------------------------------------------
// One gesture at a time, tracked in a single object. Pointer capture means the
// drag keeps working when the pointer leaves the canvas, which is exactly what
// happens when somebody drags an element to the edge of the frame.
const SNAP_TOLERANCE_PX = 6;  // screen pixels
const HANDLE_TOLERANCE_PX = 8;

let drag = null;              // { mode, index, startX, startY, box, targets, el }
let stageDragGuides = { x: null, y: null };

function stagePointerDown(e) {
  const canvas = $("#stage");
  const { width } = stageDimensions();
  const p = Geometry.toManifest(e.clientX, e.clientY, canvas.getBoundingClientRect(), width);
  const layout = currentLayout();
  if (!layout) return;

  // A pointerdown on the selected element's handle starts a resize; anywhere
  // else re-runs hit testing and starts a move on whatever it landed on.
  const selectedBox = selection.element == null ? null : stageBoxCache[selection.element];
  const handleTol = HANDLE_TOLERANCE_PX / p.scale;
  const mode = selectedBox && Geometry.onHandle(selectedBox, p.x, p.y, handleTol) ? "resize" : "move";

  let index = selection.element;
  if (mode === "move") {
    index = Geometry.hitTest(stageBoxCache, p.x, p.y);
    selection.element = index === -1 ? null : index;
    renderStage();
    renderInspector();
    if (index === -1) return;
  }

  const box = stageBoxCache[index];
  const others = stageBoxCache.filter((_, i) => i !== index);
  const { height } = stageDimensions();
  drag = {
    mode, index, box,
    el: layout.elements[index],
    startX: p.x, startY: p.y,
    scale: p.scale,
    startSize: layout.elements[index].size || 0,
    targets: Geometry.snapTargets(width, height, others),
  };
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function stagePointerMove(e) {
  if (!drag) return;
  const canvas = $("#stage");
  const { width } = stageDimensions();
  const p = Geometry.toManifest(e.clientX, e.clientY, canvas.getBoundingClientRect(), width);
  const dx = p.x - drag.startX;
  const dy = p.y - drag.startY;

  if (drag.mode === "resize") {
    drag.el.size = Geometry.resizeSize(drag.startSize, drag.box.h, dy);
  } else {
    const out = Geometry.dragPatch(drag.el, drag.box, dx, dy, drag.targets, SNAP_TOLERANCE_PX / p.scale);
    Object.assign(drag.el, out.patch);
    stageDragGuides = out.guides;
  }
  renderStage();
}

function stagePointerUp(e) {
  if (!drag) return;
  const canvas = $("#stage");
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  drag = null;
  stageDragGuides = { x: null, y: null };
  renderStage();
  renderInspector();   // the numeric fields must show where it actually landed
  scheduleConvert();   // one round-trip at the END of the gesture, not per frame
}

// drawGuides paints the lines the current drag is snapped to. Called from
// renderStage after the selection outline.
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
```

and in `renderStage`, replace the `drawSelection(ctx, width);` call with:

```js
    drawSelection(ctx, width);
    drawGuides(ctx, width, height, width / $("#stage").clientWidth);
```

- [ ] **Step 6: Bind the pointer events and drop the click handler**

In `internal/webui/static/app.js`, replace the `$("#stage").addEventListener("click", ...)` line with:

```js
// pointerdown does the selecting too, so there is no separate click handler:
// a click is just a drag with no movement, and two handlers would fight over
// which one owns the selection.
$("#stage").addEventListener("pointerdown", stagePointerDown);
$("#stage").addEventListener("pointermove", stagePointerMove);
$("#stage").addEventListener("pointerup", stagePointerUp);
$("#stage").addEventListener("pointercancel", stagePointerUp);
```

- [ ] **Step 7: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS — geometry now at 24 tests.

- [ ] **Step 8: Human check — dragging**

Run the server, open `top-movies-trailer-wall.yaml`:
1. Drag the title around — it follows the pointer, and the inspector's X/Y update when you let go.
2. Drag it near the horizontal centre — a vertical gold guide appears and the title clicks onto 960; the YAML drawer shows `x: 960`.
3. Drag the bottom-right handle down — the font size grows; release and the inspector's Font size shows the new number.
4. Drag the list — its `x` and `startY` change (never `y`), and every row moves together.
5. Drag an element past the canvas edge and release outside the window — the drag ends cleanly and the element keeps its last position (pointer capture).
6. Type `x: 96` into the inspector — the element jumps back. Numbers and dragging are two views of one value.

- [ ] **Step 9: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: drag to move, handle to resize, edge and centre snapping"
```

---

### Task 10: Scene timeline rail — retire the Scenes card

**Model:** Sonnet — a list view with HTML5 drag-and-drop reorder, following the inspector's established conventions.

The left rail becomes the timeline: every scene as a card whose height is proportional to its duration, click to select, drag to reorder, add-scene buttons at the bottom. The Scenes card is then deleted.

**Files:**
- Create: `internal/webui/static/timeline.js`
- Modify: `internal/webui/static/sections.js` (delete the scenes section)
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/style.css`
- Modify: `internal/webui/static/app.js`

**Interfaces:**
- Consumes: `state.scenes`, `selection.sceneIndex`, `sceneDefaults` (Task 2), `renderStage`/`renderInspector` (Tasks 6, 8).
- Produces: `timeline.js`: `renderTimeline()`, `sceneDuration(scene)` → the scene's length in seconds, `moveScene(from, to)`.

- [ ] **Step 1: Write `timeline.js`**

Create `internal/webui/static/timeline.js`:

```js
"use strict";
// timeline.js — the left rail. Scenes in playback order, each sized by its own
// duration so the shape of the pre-roll is visible at a glance: a 16-second
// hero next to a 2-second sting should LOOK like that.

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
    return `<button class="scene-card${i === selection.sceneIndex ? " selected" : ""}"
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
    <div class="scene-list" id="scene-list">${cards || `<p class="empty">No scenes yet.</p>`}</div>
    <div class="rail-actions">
      <button class="btn" data-action="add-scene" data-kind="render">+ Frame</button>
      <button class="btn ghost" data-action="add-scene" data-kind="clips">+ Clips</button>
      <button class="btn ghost" data-action="add-scene" data-kind="image">+ Image</button>
      <button class="btn ghost danger" data-action="remove-scene-selected">Remove scene</button>
    </div>`;
  wireSceneDrag();
}

// moveScene reorders and keeps the selection pointing at the SAME scene, not
// the same position — the user dragged a thing, not an index.
function moveScene(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.scenes.length || to >= state.scenes.length) return;
  const [moved] = state.scenes.splice(from, 1);
  state.scenes.splice(to, 0, moved);
  if (selection.sceneIndex === from) selection.sceneIndex = to;
  else if (from < selection.sceneIndex && to >= selection.sceneIndex) selection.sceneIndex--;
  else if (from > selection.sceneIndex && to <= selection.sceneIndex) selection.sceneIndex++;
}

// HTML5 drag-and-drop rather than pointer events: it is native, it gives the
// drag image for free, and reordering a list is exactly what it is for. The
// stage uses pointer events because it needs sub-pixel positions; this does not.
let dragSceneIndex = null;
function wireSceneDrag() {
  for (const card of document.querySelectorAll(".scene-card")) {
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
  renderTimeline();
  renderStage();
  renderInspector();
};
actions["add-scene"] = (d) => {
  state.scenes.push(sceneDefaults(d.kind));
  selection.sceneIndex = state.scenes.length - 1;
  selection.element = null;
  onStateChange();
};
actions["remove-scene-selected"] = () => {
  if (!state.scenes.length) return;
  state.scenes.splice(selection.sceneIndex, 1);
  selection.sceneIndex = Math.max(0, Math.min(selection.sceneIndex, state.scenes.length - 1));
  selection.element = null;
  onStateChange();
};
```

- [ ] **Step 2: Retire the Scenes card**

- Delete from `internal/webui/static/sections.js`: `renderScenes`, `sceneCard`, `sceneFields`, and the `actions["add-scene"|"remove-scene"|"move-scene"]` assignments. **Keep** `varRows`, `actions["add-var"]`, `actions["remove-var"]` and `rerenderHooks["scene-kind"]` — the inspector uses all four. Change the two `renderScenes()` calls inside `actions["add-var"]`/`actions["remove-var"]` to `renderInspector()`.
- Delete the `renderScenes();` line from `renderAll`, and add `renderTimeline();` as its first call.
- In `internal/webui/static/index.html`, delete `<section class="card" id="section-scenes"></section>` and add `<script src="timeline.js"></script>` after `inspector.js`.

- [ ] **Step 3: Register the rail's delegated events**

In `internal/webui/static/app.js`, extend the listener-binding loop:

```js
for (const root of ["#editor", "#inspector", "#rail"]) {
```

- [ ] **Step 4: Style the rail**

Append to `internal/webui/static/style.css`:

```css
.rail h2 { margin: 0 0 2px; font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--accent); }
.scene-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.scene-card {
  display: grid; grid-template-areas: "num kind" "sum sum" "secs secs";
  grid-template-columns: auto 1fr; align-content: start; gap: 2px 6px;
  width: 100%; text-align: left; cursor: grab;
  background: var(--panel-2); border: 1px solid var(--border); border-left: 3px solid var(--border);
  border-radius: 6px; padding: 6px 8px; color: var(--text); font: inherit; overflow: hidden;
}
.scene-card.selected { border-color: var(--accent); border-left-color: var(--accent); }
.scene-card.drop-target { outline: 2px dashed var(--accent); outline-offset: -2px; }
.scene-card .scene-num { grid-area: num; font-weight: 600; color: var(--accent); }
.scene-card .scene-kind { grid-area: kind; font-size: 11px; text-transform: uppercase; color: var(--muted); }
.scene-card .scene-summary { grid-area: sum; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scene-card .scene-secs { grid-area: secs; align-self: end; font-size: 11px; color: var(--muted); }
.rail-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.rail-actions .btn { flex: 1 1 auto; padding: 6px 8px; font-size: 12px; }
```

- [ ] **Step 5: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS.

- [ ] **Step 6: Human check — the timeline**

Run the server and open `double-feature.yaml` (several scenes of different lengths):
1. The Scenes card is gone; the rail lists every scene, numbered, and the taller cards are the longer ones. The header shows the scene count and the total seconds.
2. Click scene 3 — it highlights, the stage draws it, and the inspector describes it.
3. Drag scene 3 above scene 1 — the order changes, the YAML drawer's `scenes:` list matches, and scene 3 stays selected as it moves.
4. "+ Frame" adds a render scene at the end and selects it; "Remove scene" deletes the selected one and the selection lands on a neighbour without throwing.
5. Open `trailers-example.yaml`: a clips scene shows an estimated duration (`perClip × items`) rather than a dash.

- [ ] **Step 7: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: scene timeline rail with duration-scaled cards and drag reorder"
```

---

### Task 11: Keyboard control and accessibility for the stage

**Model:** Sonnet — small, self-contained, and every rule is spelled out.

A canvas is opaque to assistive technology and to anyone not using a mouse. Selection and nudging therefore need a keyboard path, and the canvas needs to announce what it is showing. This is the accessibility floor, not a nice-to-have.

**Files:**
- Modify: `internal/webui/static/geometry.js`
- Modify: `internal/webui/static/geometry.test.js`
- Modify: `internal/webui/static/stage.js`
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/app.js`

**Interfaces:**
- Produces: `Geometry.nudge(el, dx, dy)` → the same patch shape as `moveTo`; `stage.js`: `stageKeyDown(e)`, `stageDescription()` → the string the canvas's `aria-label` carries.

- [ ] **Step 1: Write the failing test**

Append to `internal/webui/static/geometry.test.js`:

```js
test("nudge is moveTo with whole-pixel steps", () => {
  assert.deepStrictEqual(Geometry.nudge({ type: "text", x: 100, y: 200 }, 1, 0), { x: 101, y: 200 });
  assert.deepStrictEqual(Geometry.nudge({ type: "list", x: 100, startY: 200 }, 0, -10), { x: 100, startY: 190 });
  assert.deepStrictEqual(Geometry.nudge({ type: "text", x: 100.6, y: 200 }, 1, 0), { x: 102, y: 200 },
    "a nudge lands on whole pixels so repeated presses stay predictable");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test internal/webui/static/geometry.test.js`
Expected: FAIL — `Geometry.nudge is not a function`.

- [ ] **Step 3: Add `nudge`**

Insert into the `Geometry` object, after `dragPatch`:

```js
  // nudge is an arrow-key move: the same patch shape as a drag, but rounded to
  // whole pixels so ten presses of "right" move exactly ten pixels rather than
  // accumulating a fractional offset.
  nudge(el, dx, dy) {
    if (el.type === "list") {
      return { x: Math.round((el.x || 0) + dx), startY: Math.round((el.startY || 0) + dy) };
    }
    return { x: Math.round((el.x || 0) + dx), y: Math.round((el.y || 0) + dy) };
  },
```

- [ ] **Step 4: Run the geometry tests**

Run: `node --test internal/webui/static/geometry.test.js`
Expected: PASS — 25 tests.

- [ ] **Step 5: Add the keyboard handler and the description**

Append to `internal/webui/static/stage.js`:

```js
// ---- keyboard --------------------------------------------------------------
// The canvas is focusable so the stage is reachable by Tab. Arrows nudge the
// selected element (Shift for a coarse step), Tab cycles the selection within
// the scene, Escape drops back to the scene, Delete removes the element.
const NUDGE_STEP = 1;
const NUDGE_STEP_COARSE = 10;

function stageKeyDown(e) {
  const layout = currentLayout();
  if (!layout || !layout.elements || !layout.elements.length) return;

  if (e.key === "Tab") {
    const n = layout.elements.length;
    const current = selection.element == null ? -1 : selection.element;
    const next = e.shiftKey ? (current <= 0 ? n - 1 : current - 1) : (current + 1) % n;
    selection.element = next;
    e.preventDefault();
    renderStage();
    renderInspector();
    return;
  }
  if (e.key === "Escape") {
    selection.element = null;
    renderStage();
    renderInspector();
    return;
  }
  if (selection.element == null) return;
  const el = layout.elements[selection.element];

  if (e.key === "Delete" || e.key === "Backspace") {
    layout.elements.splice(selection.element, 1);
    selection.element = null;
    e.preventDefault();
    onStateChange();
    return;
  }

  const step = e.shiftKey ? NUDGE_STEP_COARSE : NUDGE_STEP;
  const deltas = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0],
    ArrowUp: [0, -step], ArrowDown: [0, step],
  }[e.key];
  if (!deltas) return;
  Object.assign(el, Geometry.nudge(el, deltas[0], deltas[1]));
  e.preventDefault();
  renderStage();
  renderInspector();
  scheduleConvert();
}

// stageDescription is what a screen reader is told the canvas contains. A
// canvas is otherwise a blank rectangle to assistive technology, and this is
// the only place the scene's actual content is described.
function stageDescription() {
  const scene = currentScene();
  if (!scene) return "Scene preview: no scenes yet";
  const layout = currentLayout();
  const parts = [`Scene ${selection.sceneIndex + 1} of ${state.scenes.length}, kind ${scene.kind}`];
  if (layout) {
    const els = layout.elements || [];
    parts.push(`${els.length} element${els.length === 1 ? "" : "s"}`);
    if (selection.element != null && els[selection.element]) {
      const el = els[selection.element];
      const anchor = el.type === "list" ? `x ${el.x}, first row ${el.startY}` : `x ${el.x}, y ${el.y}`;
      parts.push(`selected: ${el.type} element at ${anchor}, size ${el.size}`);
    }
  }
  return parts.join(". ");
}
```

and at the end of `renderStage`, after `updateStageChrome(scene, layout);`:

```js
  canvas.setAttribute("aria-label", stageDescription());
```

- [ ] **Step 6: Make the canvas focusable and bind the handler**

In `internal/webui/static/index.html`, change the canvas tag to:

```html
      <canvas id="stage" tabindex="0" role="application" aria-label="Scene preview"></canvas>
```

and add under the stage frame, inside `.stage-pane`:

```html
      <p class="muted">Click an element to select it, drag to move, drag the corner handle to resize. With the stage focused: Tab cycles elements, arrows nudge (Shift for 10px), Delete removes, Escape selects the scene.</p>
```

In `internal/webui/static/app.js`, add beside the other stage bindings:

```js
$("#stage").addEventListener("keydown", stageKeyDown);
```

- [ ] **Step 7: Add the focus style**

Append to `internal/webui/static/style.css`:

```css
#stage:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 8: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS — geometry at 25 tests.

- [ ] **Step 9: Human check — keyboard only**

Run the server, open `top-movies-trailer-wall.yaml`, and use no mouse:
1. Tab until the stage has a gold focus ring.
2. Press Tab again — the first element is selected and outlined; Tab cycles through them, Shift+Tab back.
3. Arrow keys move the selected element one pixel per press; Shift+Arrow moves ten. The inspector's numbers keep up.
4. Escape deselects; Delete removes the selected element.
5. With a screen reader (VoiceOver: Cmd+F5), focusing the canvas announces the scene number, kind, element count and the current selection.

- [ ] **Step 10: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: keyboard selection, nudging and a described stage"
```

---

### Task 12: Colour picker with a swatch — the DSL's own values, unmangled

**Model:** Sonnet — one control, one round-trip rule, fully specified.

Colours are free text today. The DSL accepts anything ImageMagick accepts: `white`, `#101010`, `rgba(0,0,0,0.5)`, and crucially `none`. A native `<input type="color">` can only hold `#rrggbb`, so it is offered **alongside** the text field, never in place of it — the text is the source of truth and the picker only ever writes into it.

**Files:**
- Create: `internal/webui/static/pickers.js`
- Create: `internal/webui/static/pickers.test.js`
- Modify: `internal/webui/static/inspector.js`
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/style.css`
- Modify: `internal/webui/static/app.js`

**Interfaces:**
- Produces:
  - `pickers.js`: `colorField(label, path, value, hint)` → the HTML for a labelled colour control; `toHexColor(value)` → `#rrggbb` or `null` (pure); `namedColorHex(name)` → `#rrggbb` or `null` (pure).

- [ ] **Step 1: Write the failing tests**

Create `internal/webui/static/pickers.test.js`:

```js
"use strict";
// Only the PURE half of pickers.js is tested here — the colour conversions.
// The dialogs need a DOM and are covered by the human checks in their tasks.
// Run: node --test internal/webui/static/

const test = require("node:test");
const assert = require("node:assert");
const Pickers = require("./pickers.js");

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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test internal/webui/static/pickers.test.js`
Expected: FAIL — `Cannot find module './pickers.js'`.

- [ ] **Step 3: Write `pickers.js` with the colour control**

Create `internal/webui/static/pickers.js`:

```js
"use strict";
// pickers.js — the three assisted inputs: a colour picker, a media file
// browser, and a template inserter. Each one exists because the underlying
// manifest value is a string that is easy to get wrong and impossible to
// preview: a colour, a path, a template expression.
//
// The rule every picker follows: the TEXT FIELD is the value. A picker only
// ever writes into it, so nothing the DSL accepts can be lost by opening one.

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
// The picker is data-color-for="<path>", which the delegated change handler
// uses to write the chosen hex into the text input and into state.
function colorField(label, path, value, hint) {
  const hex = toHexColor(value);
  const swatch = hex
    ? `<span class="swatch" style="background:${hex}"></span>`
    : `<span class="swatch swatch-none" title="No swatch: this value is not a plain colour"></span>`;
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

// Node: exported for pickers.test.js. Browser: the functions above are already
// global from the classic script.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { toHexColor, namedColorHex };
}
```

- [ ] **Step 4: Run the picker tests**

Run: `node --test internal/webui/static/pickers.test.js`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Use `colorField` in the inspector**

In `internal/webui/static/inspector.js`:
- In `elementInspector`'s `common`, replace the Colour line with:
  ```js
    ${colorField("Colour", `${base}.color`, el.color, "Blank means white")}
  ```
- In `layoutSection`, replace the Background colour line with:
  ```js
    ${colorField("Background colour", `${base}.background.color`, layout.background?.color,
      "Use none for transparent — required for clip labels and dynamic backgrounds")}
  ```

- [ ] **Step 6: Handle the picker's change event**

In `internal/webui/static/app.js`, at the top of `onEditorChange(e)`:

```js
  // The native picker writes into the text field, never around it: the text is
  // the value and may hold things the picker cannot express.
  if (e.target.dataset.colorFor) {
    const path = e.target.dataset.colorFor;
    setPath(state, path, e.target.value);
    renderInspector();
    renderStage();
    scheduleConvert();
    return;
  }
```

and register `pickers.js` in `index.html` before `inspector.js`:

```html
<script src="pickers.js"></script>
```

- [ ] **Step 7: Style the colour row**

Append to `internal/webui/static/style.css`:

```css
.color-row { display: grid; grid-template-columns: 20px 1fr 34px; gap: 6px; align-items: center; }
.swatch {
  width: 20px; height: 20px; border-radius: 4px;
  border: 1px solid var(--border); background: #000;
}
/* A value with no representable colour gets a struck-through swatch rather
   than a misleading black square. */
.swatch-none {
  background:
    linear-gradient(45deg, transparent 45%, var(--danger) 45%, var(--danger) 55%, transparent 55%),
    repeating-conic-gradient(#2a2f38 0% 25%, #1b1f26 0% 50%) 0 / 8px 8px;
}
input[type="color"].color-pick { padding: 0; height: 28px; border-radius: 4px; cursor: pointer; }
.color-row + small code { font-family: var(--mono); }
```

- [ ] **Step 8: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS.

- [ ] **Step 9: Human check — round-tripping DSL colours**

Run the server and open `top-movies-trailer-wall.yaml`:
1. Select the title element. The colour row shows a white swatch, the text `white`, and a colour picker set to white.
2. Use the picker to choose a red — the text becomes `#rr0000`-ish, the swatch turns red, the title turns red on the stage, and the YAML shows the hex.
3. Type `none` into the text field — the swatch becomes the struck-through "no swatch" square, the YAML shows `color: none`, and **nothing rewrites it to a hex**. This is the case that must not regress.
4. Type `rgba(255,0,0,0.5)` — no swatch, YAML keeps it verbatim, the stage draws the title semi-transparent.
5. In the Layout section, set Background colour to `none` — the stage's checkerboard shows through and the dynamic background becomes visible behind the text.

- [ ] **Step 10: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: colour picker and swatch that never mangle a DSL colour"
```

---

### Task 13: File picker — browse the media directory instead of typing paths

**Model:** Sonnet — a dialog over the endpoint built in Task 4.

Every font, image and audio path in a manifest is currently typed blind and only fails at render time. The picker lists what actually exists, previews fonts in their own face and images as thumbnails, and writes the manifest-relative path the server gave it.

**Files:**
- Modify: `internal/webui/static/api.js`
- Modify: `internal/webui/static/pickers.js`
- Modify: `internal/webui/static/inspector.js`
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/style.css`
- Modify: `internal/webui/static/app.js`

**Interfaces:**
- Consumes: `GET /api/files`, `GET /api/files/raw` (Task 4), `apiCapabilities` (Task 1).
- Produces:
  - `api.js`: `async apiListFiles()` → `{files, roots}`.
  - `pickers.js`: `fileField(label, path, value, kind, hint)` → HTML for a text input plus a Browse button; `openFilePicker(path, kind)` → shows the dialog; `fileKindLabel(kind)`.

- [ ] **Step 1: Add the API call**

Append to `internal/webui/static/api.js`:

```js
// The media listing changes only when someone adds a file, so it is fetched
// once and reused by every picker in the session.
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
```

- [ ] **Step 2: Add the picker to `pickers.js`**

Append to `internal/webui/static/pickers.js` (before the `module.exports` guard):

```js
// ---- file picker -----------------------------------------------------------
// A path field plus a Browse button. The text input stays the value — a path
// outside the media roots is still perfectly legal in a manifest, it just
// cannot be browsed to.
function fileField(label, path, value, kind, hint) {
  return `<label class="field"><span>${esc(label)}</span>
    <span class="file-row">
      <input type="text" data-path="${esc(path)}" value="${esc(value ?? "")}" placeholder="media/common/...">
      <button type="button" class="btn ghost" data-action="browse-files"
        data-target="${esc(path)}" data-kind="${esc(kind)}">Browse</button>
    </span>
    ${hint ? `<small>${esc(hint)}</small>` : ""}
  </label>`;
}

function fileKindLabel(kind) {
  return { font: "font", image: "image", audio: "audio track", video: "video" }[kind] || "file";
}

// filePickerTarget remembers which manifest path the open dialog will write to.
let filePickerTarget = null;

async function openFilePicker(path, kind) {
  filePickerTarget = path;
  const dialog = $("#file-picker");
  const body = $("#file-picker-body");
  $("#file-picker-title").textContent = `Choose a ${fileKindLabel(kind)}`;
  body.innerHTML = `<p class="muted">Loading…</p>`;
  dialog.showModal();

  const { files, roots } = await apiListFiles();
  const matching = files.filter((f) => f.kind === kind);
  if (!matching.length) {
    body.innerHTML = roots.length
      ? `<p class="empty">No ${fileKindLabel(kind)} files found under ${esc(roots.join(", "))}.
         Drop one in and reopen this dialog.</p>`
      : `<p class="empty">No media directory is configured. Start the UI with
         <code>-media-dir</code> (or <code>MEDIA_DIR</code>) pointing at your media folder,
         or type the path by hand — the field accepts anything.</p>`;
    return;
  }
  body.innerHTML = matching.map((f) => filePickerRow(f, kind)).join("");
  // A font can only be previewed in its own face once it is loaded, and each
  // one needs its own @font-face. They are loaded lazily, per open dialog.
  if (kind === "font") {
    for (const f of matching) previewFont(f.path);
  }
}

function filePickerRow(f, kind) {
  const url = `/api/files/raw?path=${encodeURIComponent(f.path)}`;
  const preview = kind === "image"
    ? `<img class="file-thumb" src="${esc(url)}" alt="" loading="lazy">`
    : kind === "font"
      ? `<span class="file-sample" data-font-sample="${esc(f.path)}">Top Movies — Month</span>`
      : kind === "audio"
        ? `<audio class="file-audio" controls preload="none" src="${esc(url)}"></audio>`
        : "";
  return `<button type="button" class="file-row-item" data-action="pick-file" data-path-value="${esc(f.path)}">
    <span class="file-name">${esc(f.name)}</span>
    <span class="file-path">${esc(f.path)}</span>
    <span class="file-size">${Math.round(f.size / 1024)} KB</span>
    ${preview}
  </button>`;
}

// previewFont loads the file as a real @font-face and applies it to that row's
// sample text, so the list shows what each font actually looks like rather
// than a filename to guess from.
const previewFonts = new Map();
function previewFont(path) {
  const apply = (family) => {
    for (const el of document.querySelectorAll(`[data-font-sample="${CSS.escape(path)}"]`)) {
      el.style.fontFamily = `"${family}", sans-serif`;
    }
  };
  if (previewFonts.has(path)) { apply(previewFonts.get(path)); return; }
  const family = `preview${previewFonts.size}`;
  previewFonts.set(path, family);
  new FontFace(family, `url("/api/files/raw?path=${encodeURIComponent(path)}")`)
    .load()
    .then((loaded) => { document.fonts.add(loaded); apply(family); })
    .catch(() => { /* an unreadable font simply shows in the default face */ });
}

actions["browse-files"] = (d) => openFilePicker(d.target, d.kind);
actions["pick-file"] = (d) => {
  if (!filePickerTarget) return;
  setPath(state, filePickerTarget, d.pathValue);
  $("#file-picker").close();
  filePickerTarget = null;
  onStateChange();
};
actions["close-file-picker"] = () => { $("#file-picker").close(); filePickerTarget = null; };
```

- [ ] **Step 3: Add the dialog markup**

In `internal/webui/static/index.html`, add before the `<script>` block:

```html
<dialog id="file-picker" class="picker">
  <div class="picker-head">
    <h2 id="file-picker-title">Choose a file</h2>
    <button class="btn ghost" data-action="close-file-picker">Close</button>
  </div>
  <div id="file-picker-body" class="picker-body"></div>
</dialog>
```

- [ ] **Step 4: Use `fileField` everywhere a path is typed**

In `internal/webui/static/inspector.js`:
- In `layoutSection`, replace the Font file and Background image lines with:
  ```js
    ${fileField("Font file", `${base}.font`, layout.font, "font", "The .ttf/.otf the renderer draws with")}
  ```
  and
  ```js
    ${fileField("Background image", `${base}.background.image`, layout.background?.image, "image", "Wins over the colour when set")}
  ```
- In `sceneKindFields`'s image branch, replace the Image file line with:
  ```js
    ${fileField("Image file", `${base}.file`, sc.file, "image")}
  ```
- In `prerollFields`, leave the output field as plain text (it names a file that does not exist yet).

- [ ] **Step 5: Register the dialog's clicks**

In `internal/webui/static/app.js`, extend the listener-binding loop to cover the dialog:

```js
for (const root of ["#editor", "#inspector", "#rail", "#file-picker"]) {
```

- [ ] **Step 6: Style the dialog**

Append to `internal/webui/static/style.css`:

```css
dialog.picker {
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 0; width: min(720px, 92vw); max-height: 80vh;
}
dialog.picker::backdrop { background: rgba(0, 0, 0, .6); }
.picker-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.picker-head h2 { margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: .8px; color: var(--accent); }
.picker-body { padding: 12px 16px; overflow-y: auto; max-height: calc(80vh - 56px); }

.file-row { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
.file-row-item {
  display: grid; grid-template-columns: 1fr auto; grid-template-areas: "name size" "path path" "prev prev";
  gap: 2px 8px; width: 100%; text-align: left; margin-bottom: 6px;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 10px; color: var(--text); font: inherit; cursor: pointer;
}
.file-row-item:hover { border-color: var(--accent); }
.file-row-item .file-name { grid-area: name; font-weight: 600; }
.file-row-item .file-path { grid-area: path; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.file-row-item .file-size { grid-area: size; font-size: 11px; color: var(--muted); }
.file-thumb { grid-area: prev; max-height: 90px; max-width: 100%; border-radius: 4px; margin-top: 6px; }
.file-sample { grid-area: prev; font-size: 26px; margin-top: 6px; }
.file-audio { grid-area: prev; width: 100%; margin-top: 6px; }
```

- [ ] **Step 7: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS.

- [ ] **Step 8: Human check — the picker**

Run: `go run ./cmd/preroll-ui -manifest-dir manifests -media-dir media`, open `top-movies-trailer-wall.yaml`:
1. In the inspector's Layout section, click Browse beside Font file. The dialog lists `Adult-Swim-Font.ttf` with the sample text "Top Movies — Month" **rendered in that font**.
2. Click it — the dialog closes, the field reads `media/common/Adult-Swim-Font.ttf`, and the stage redraws in that face.
3. Select the image scene of `double-feature.yaml` and Browse for an image — `plex-as-logo.png` shows as a thumbnail.
4. Run the server again with `-media-dir /does/not/exist`. Browse now shows the "No media directory is configured / no files found" message and the text field still accepts a hand-typed path. Nothing is broken.

- [ ] **Step 9: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: browse and preview media files instead of typing paths"
```

---

### Task 14: Template picker — every variable and helper, explained, with a live example

**Model:** Sonnet — a catalogue plus an insert-at-cursor dialog.

Template strings currently have to be typed from memory. This gives every variable and helper a plain-English explanation and a live example rendered against the current data, and inserts the chosen one at the cursor.

**Files:**
- Modify: `internal/webui/static/providers.js`
- Modify: `internal/webui/static/pickers.js`
- Modify: `internal/webui/static/inspector.js`
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/style.css`

**Interfaces:**
- Consumes: `stageTemplate`/`stageVars`/`stageItems` (Task 6), `internal/templating/templating.go`'s FuncMap (`upper`, `lower`, `title`, `pluralize`, `truncate`) — confirmed by reading that file.
- Produces:
  - `providers.js`: `TEMPLATE_CATALOG` — `{globals: [...], itemFields: [...], funcs: [...]}` where each entry is `{insert, label, explain}`.
  - `pickers.js`: `templateButton(path)` → the "Insert…" button HTML; `openTemplatePicker(path, scope)`.

- [ ] **Step 1: Replace the flat chip arrays with an explained catalogue**

In `internal/webui/static/providers.js`, replace the `TEMPLATE_VARS` / `ITEM_FIELDS` / `TEMPLATE_FUNCS` block with:

```js
// TEMPLATE_CATALOG is what the template picker shows. Every entry carries a
// plain-English explanation, because "{{ .PeriodInterval }}" tells you nothing
// on its own. Globals mirror the vars map in cmd/plex-pre-rolls/main.go; item
// fields mirror render.go's itemContext; funcs mirror templating.FuncMap.
const TEMPLATE_CATALOG = {
  globals: [
    { insert: "{{ .Period }}", label: ".Period",
      explain: 'The reporting window as a word — "Day", "Week", "Month", "Year", or "All Time". This is the one to put in a headline.' },
    { insert: "{{ .PeriodInterval }}", label: ".PeriodInterval",
      explain: 'The same window as the raw setting — "DAY", "WEEK", "MONTH", "YEAR". Use it in data-source params, not in text.' },
    { insert: "{{ .MovieSectionId }}", label: ".MovieSectionId",
      explain: "Your Plex movie library's section id, from MOVIE_SECTION_ID. Almost always what a movie source's `section` param should be." },
    { insert: "{{ .TVShowSectionId }}", label: ".TVShowSectionId",
      explain: "Your Plex TV library's section id, from TV_SHOW_SECTION_ID." },
    { insert: "{{ .MaxItems }}", label: ".MaxItems",
      explain: "The configured item cap, from MAX_ITEMS. Handy as a source's `limit` so one setting drives every manifest." },
  ],
  itemFields: [
    { insert: "{{ .Rank }}", label: ".Rank",
      explain: "The row's position in the list, starting at 1. Only meaningful inside a list element's row template." },
    { insert: "{{ .Name }}", label: ".Name",
      explain: "The item's title." },
    { insert: "{{ .Views }}", label: ".Views",
      explain: "How many times it was watched. Collections expose their item count here instead." },
  ],
  funcs: [
    { insert: "{{ upper .Name }}", label: "upper",
      explain: "Upper-cases the text. Common in a headline: {{ upper .Period }} gives MONTH." },
    { insert: "{{ lower .Name }}", label: "lower",
      explain: "Lower-cases the text." },
    { insert: "{{ title .Name }}", label: "title",
      explain: "Capitalises the first letter of every word." },
    { insert: "{{ truncate 36 .Name }}", label: "truncate N",
      explain: "Cuts the text to at most N characters, adding an ellipsis when it had to cut. The fix for a long film title running off the frame." },
    { insert: '{{ pluralize .Views "view" "views" }}', label: "pluralize",
      explain: 'Picks the singular word when the number is 1 and the plural otherwise: "1 view" / "3 views".' },
  ],
};

// Kept as flat lists for anything that just wants the strings.
const TEMPLATE_VARS = TEMPLATE_CATALOG.globals.map((e) => e.insert);
const ITEM_FIELDS = TEMPLATE_CATALOG.itemFields.map((e) => e.insert);
const TEMPLATE_FUNCS = TEMPLATE_CATALOG.funcs.map((e) => e.label);
```

- [ ] **Step 2: Add the template picker to `pickers.js`**

Append to `internal/webui/static/pickers.js` (before the `module.exports` guard):

```js
// ---- template picker -------------------------------------------------------
// scope is "item" for a list's row template (where .Rank/.Name/.Views are in
// scope) and "text" for everything else. Showing item fields on a text element
// would be offering something that fails at render time.
function templateButton(path, scope) {
  return `<button type="button" class="btn ghost small" data-action="insert-template"
    data-target="${esc(path)}" data-scope="${esc(scope)}">Insert variable…</button>`;
}

let templateTarget = null;

function openTemplatePicker(path, scope) {
  templateTarget = path;
  const groups = scope === "item"
    ? [["Item fields", TEMPLATE_CATALOG.itemFields], ["Helpers", TEMPLATE_CATALOG.funcs], ["Globals", TEMPLATE_CATALOG.globals]]
    : [["Globals", TEMPLATE_CATALOG.globals], ["Helpers", TEMPLATE_CATALOG.funcs]];
  $("#template-picker-body").innerHTML = groups.map(([title, entries]) => `
    <h3>${esc(title)}</h3>
    ${entries.map((e) => `<button type="button" class="template-row" data-action="pick-template" data-insert="${esc(e.insert)}">
      <code>${esc(e.insert)}</code>
      <span class="template-explain">${esc(e.explain)}</span>
      <span class="template-example">→ ${esc(templateExample(e.insert, scope))}</span>
    </button>`).join("")}`).join("");
  $("#template-picker").showModal();
}

// templateExample renders the snippet against the SAME data the stage is
// drawing, so the example is what the user will actually get — real film
// titles when Plex is connected, the placeholders when it is not.
function templateExample(snippet, scope) {
  const scene = currentScene();
  const vars = stageVars(scene);
  if (scope === "item") {
    const el = elementPath() ? currentLayout().elements[selection.element] : null;
    const item = stageItems(el && el.source)[0] || { rank: 1, name: "Example Title", views: 3 };
    return stageTemplate(snippet, { ...vars, Rank: item.rank, Name: item.name, Views: item.views });
  }
  return stageTemplate(snippet, vars);
}

actions["insert-template"] = (d) => openTemplatePicker(d.target, d.scope);
actions["close-template-picker"] = () => { $("#template-picker").close(); templateTarget = null; };
actions["pick-template"] = (d) => {
  if (!templateTarget) return;
  // Insert AT THE CURSOR of the field the button belongs to, so a snippet can
  // be dropped into the middle of an existing string. Appending would make the
  // picker useless for anything but an empty field.
  const input = document.querySelector(`[data-path="${CSS.escape(templateTarget)}"]`);
  const snippet = d.insert;
  if (input) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + snippet + input.value.slice(end);
    setPath(state, templateTarget, input.value);
    input.focus();
    input.setSelectionRange(start + snippet.length, start + snippet.length);
  } else {
    setPath(state, templateTarget, String(getPath(state, templateTarget) ?? "") + snippet);
  }
  $("#template-picker").close();
  templateTarget = null;
  renderStage();
  scheduleConvert();
};
```

- [ ] **Step 3: Add the dialog markup**

In `internal/webui/static/index.html`, add beside the file picker dialog:

```html
<dialog id="template-picker" class="picker">
  <div class="picker-head">
    <h2>Insert a variable</h2>
    <button class="btn ghost" data-action="close-template-picker">Close</button>
  </div>
  <div id="template-picker-body" class="picker-body"></div>
</dialog>
```

and extend the listener-binding loop in `app.js`:

```js
for (const root of ["#editor", "#inspector", "#rail", "#file-picker", "#template-picker"]) {
```

- [ ] **Step 4: Add the Insert button to every template field**

In `internal/webui/static/inspector.js`:
- In `elementInspector`'s list branch, replace the Row template line with:
  ```js
    ${field("Row template", textInput(`${base}.item`, el.item, { placeholder: "{{ .Rank }}. {{ .Name }}" }) +
      templateButton(`${base}.item`, "item"),
      "One line per item from the data source")}
  ```
- In `elementInspector`'s text branch, replace the Text line with:
  ```js
    ${field("Text", `<textarea data-path="${esc(base)}.text">${esc(el.text)}</textarea>` +
      templateButton(`${base}.text`, "text"),
      "Newlines stack; the block is centred vertically on Y")}
  ```

- [ ] **Step 5: Style the template rows**

Append to `internal/webui/static/style.css`:

```css
.btn.small { padding: 4px 8px; font-size: 11px; margin-top: 4px; }
.template-row {
  display: block; width: 100%; text-align: left; margin-bottom: 6px;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 10px; color: var(--text); font: inherit; cursor: pointer;
}
.template-row:hover { border-color: var(--accent); }
.template-row code { font-family: var(--mono); font-size: 12px; color: var(--accent); }
.template-explain { display: block; font-size: 12px; color: var(--muted); margin-top: 3px; }
.template-example { display: block; font-family: var(--mono); font-size: 11px; margin-top: 4px; }
```

- [ ] **Step 6: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS.

- [ ] **Step 7: Human check — the picker**

Run the server, open `top-movies-trailer-wall.yaml`:
1. Select the title text element and click "Insert variable…". The dialog groups Globals and Helpers, each row showing the snippet, an explanation, and a rendered example (`{{ .Period }} → Month`).
2. Put the cursor in the middle of the text, pick `{{ upper .Period }}` — it lands **at the cursor**, not at the end, and the stage updates.
3. Select the list element and click its Insert button — the dialog now leads with Item fields, and `{{ truncate 36 .Name }}` previews with a real film title (or a placeholder with no Plex).
4. `{{ pluralize .Views "view" "views" }}` shows the plural form matching the example item's view count.

- [ ] **Step 8: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: template picker with explanations and live examples"
```

---

### Task 15: Data sources explained and testable — retire the last phase-1 cards

**Model:** Sonnet — a description pass over `providers.js`, a results table, and the deletion of `sections.js`.

Each provider gets a plain-English description of what it returns and when to use it, each param an explanation, and a "Test this source" action that runs the real provider and shows what came back. With data sources living in the inspector, the last three cards go and `sections.js` is deleted.

**Files:**
- Modify: `internal/webui/static/providers.js`
- Modify: `internal/webui/static/inspector.js`
- Modify: `internal/webui/static/state.js`
- Delete: `internal/webui/static/sections.js`
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/app.js`
- Modify: `internal/webui/static/style.css`

**Interfaces:**
- Consumes: `apiResolveData` (Task 7), `PROVIDERS` (existing).
- Produces:
  - `providers.js`: each provider entry gains `title`, `describe`, `when`; each param's `hint` becomes a full sentence.
  - `inspector.js`: `dataInspector()`, `renderDataPanel()`; `selection.dataSource` drives it.

- [ ] **Step 1: Expand `providers.js` with descriptions**

In `internal/webui/static/providers.js`, replace each provider's `hint` with `title`, `describe` and `when`, and lengthen each param hint. In full, the seven entries become:

```js
const PROVIDERS = {
  "plex.top": {
    title: "Most watched",
    describe: "The most-viewed items in one library section over a recent window, ordered by view count.",
    when: "Use for a countdown — 'Top 5 movies this month'. It is the only source that gives you meaningful view counts.",
    params: {
      type:     { options: ["", "movie", "show"], hint: "Restrict to films or TV. Leave blank for both." },
      section:  { hint: "Which Plex library to look in, by section id. {{ .MovieSectionId }} uses the one from your config.", default: "{{ .MovieSectionId }}" },
      period:   { options: ["", "{{ .PeriodInterval }}", "DAY", "WEEK", "MONTH", "YEAR"], hint: "How far back 'recently watched' reaches. {{ .PeriodInterval }} follows your PERIOD_INTERVAL setting.", default: "{{ .PeriodInterval }}" },
      limit:    { hint: "How many items to return. Match this to the number of rows your list element can fit.", default: "5" },
      trailers: { options: ["", "true"], hint: "Also resolve each item's trailer URL, so the same source can feed both the list text and a matching trailer background." },
    },
  },
  "plex.unwatched": {
    title: "Not watched yet",
    describe: "Items in a library section that nobody has watched.",
    when: "Use for a 'still on the shelf' reminder, or to build a montage of things the household has been ignoring.",
    params: {
      section: { hint: "Which Plex library to look in, by section id. Required.", default: "{{ .MovieSectionId }}" },
      type:    { options: ["", "movie", "show", "season", "episode"], hint: "Restrict to one kind of item." },
      sort:    { hint: "Plex sort expression, e.g. addedAt:desc for newest first, titleSort for A–Z." },
      limit:   { hint: "How many items to return." },
    },
  },
  "plex.trailers": {
    title: "Trailers",
    describe: "One streamable trailer per item in a section, resolved from each item's extras.",
    when: "Use to feed a clip montage. Items with no trailer are dropped, so ask for more candidates than you need.",
    params: {
      section: { hint: "Which Plex library to look in, by section id. Required.", default: "{{ .MovieSectionId }}" },
      filter:  { options: ["", "unwatched"], hint: "Restrict the candidates before trailers are looked up." },
      type:    { options: ["", "movie", "show"], hint: "Restrict to films or TV. Defaults to films." },
      sort:    { hint: "Plex sort expression, e.g. addedAt:desc for the newest arrivals." },
      limit:   { hint: "How many candidates to consider — not how many trailers you get, since some items have none." },
    },
  },
  "plex.section": {
    title: "Library listing",
    describe: "A general listing of one library section. Any parameter this source does not recognise is passed straight to Plex as a filter.",
    when: "Use when nothing more specific fits: a decade night, a genre selection, a random pick. It is the escape hatch.",
    extra: true,
    params: {
      section:   { hint: "Which Plex library to look in, by section id. Required.", default: "{{ .MovieSectionId }}" },
      type:      { options: ["", "movie", "show", "season", "episode"], hint: "Restrict to one kind of item." },
      sort:      { hint: "Plex sort expression, e.g. addedAt:desc, titleSort, random." },
      limit:     { hint: "How many items to return." },
      unwatched: { options: ["", "true"], hint: "Only items nobody has watched." },
      random:    { options: ["", "true"], hint: "Sample 200 items, shuffle them, then trim to the limit — a fairer random than Plex's own sort." },
      trailers:  { options: ["", "true"], hint: "Also resolve each item's trailer URL." },
    },
  },
  "plex.collections": {
    title: "Collections",
    describe: "The collections in a section, each one's item count exposed as Views.",
    when: "Use to advertise what is grouped in the library — 'The Bond Collection (25 titles)'.",
    params: {
      section: { hint: "Which Plex library to look in, by section id. Required.", default: "{{ .MovieSectionId }}" },
      sort:    { hint: "Plex sort expression." },
      limit:   { hint: "How many collections to return." },
    },
  },
  "plex.watchlist": {
    title: "Your watchlist",
    describe: "The watchlist on your Plex account, from Plex Discover rather than your own server.",
    when: "Use for a 'coming up' card. Set inLibrary to split what you already own from what you do not.",
    params: {
      filter:    { options: ["", "all", "available", "released"], hint: "all: everything · available: streamable somewhere · released: already out. Defaults to all." },
      type:      { options: ["", "movie", "show"], hint: "Restrict to films or TV." },
      sort:      { hint: "Discover sort expression." },
      limit:     { hint: "How many items to return." },
      inLibrary: { options: ["", "true", "false"], hint: "true: only items you already have · false: only items you do not. Leave blank for both." },
      trailers:  { options: ["", "true"], hint: "Resolve trailers for the items that matched your library — cloud-only items have none to resolve." },
    },
  },
  "plex.trending": {
    title: "Trending on Plex",
    describe: "The trending row from the Plex Discover home page — what is popular across Plex, not in your library.",
    when: "Use for a 'what everyone is watching' card, usually with inLibrary:true so you only advertise what you actually have.",
    params: {
      type:      { options: ["", "movie", "show"], hint: "Restrict to films or TV." },
      limit:     { hint: "How many items to return." },
      inLibrary: { options: ["", "true", "false"], hint: "true: only items you already have · false: only items you do not. Leave blank for both." },
      trailers:  { options: ["", "true"], hint: "Resolve trailers for the items that matched your library." },
    },
  },
};
```

- [ ] **Step 2: Add the data panel to `inspector.js`**

Append to `internal/webui/static/inspector.js`:

```js
// ---- data sources ----------------------------------------------------------
// Data sources are not part of any one scene, so they get their own inspector
// mode rather than a card: selection.dataSource names the one being edited,
// and a null means the list.
function dataInspector() {
  const name = selection.dataSource;
  if (name === null || !state.data[name]) return dataListPanel();
  return dataSourcePanel(name, state.data[name]);
}

function dataListPanel() {
  const rows = Object.entries(state.data).map(([name, ds]) => {
    const meta = PROVIDERS[ds.provider] || {};
    return `<button class="element-row" data-action="select-data" data-name="${esc(name)}">
      <span class="kind">${esc(meta.title || ds.provider || "?")}</span>
      <span class="label">${esc(name)}</span>
    </button>`;
  }).join("");
  return `<h2>Data sources</h2>
    <p class="muted">Named feeds of Plex items. List elements, clip scenes and dynamic backgrounds all pull from these by name.</p>
    <div class="element-list">${rows || `<p class="empty">No data sources yet.</p>`}</div>
    <button class="btn" data-action="add-data">+ Add data source</button>`;
}

function dataSourcePanel(name, ds) {
  const meta = PROVIDERS[ds.provider] || { params: {} };
  const rows = Object.entries(meta.params || {}).map(([key, p]) => {
    const path = `data.${name}.params.${key}`;
    const val = ds.params?.[key] ?? "";
    const input = p.options
      ? select(path, val, p.options)
      : textInput(path, val, { placeholder: p.default || "" }) + templateButton(path, "text");
    return field(key, input, p.hint);
  }).join("");
  const result = renderTestResult(name);
  return `<h2>Data source</h2>
    <button class="btn ghost" data-action="select-data-list">← All sources</button>
    <div class="stack">
      <label class="field"><span>Name</span>
        <input type="text" data-rename="data" data-old="${esc(name)}" value="${esc(name)}"></label>
      ${field("Provider", select(`data.${name}.provider`, ds.provider, Object.keys(PROVIDERS),
        { rerender: "provider", attrs: `data-ds="${esc(name)}"` }))}
    </div>
    <div class="provider-doc">
      <p><strong>${esc(meta.title || ds.provider)}</strong> — ${esc(meta.describe || "")}</p>
      <p class="muted">${esc(meta.when || "")}</p>
    </div>
    <h3>Parameters</h3>
    <div class="stack">${rows}</div>
    ${meta.extra ? extraParamRows(name, ds, meta) : ""}
    <h3>Test</h3>
    <p class="muted">Runs this source against your real Plex server and shows what it returns.</p>
    <button class="btn" data-action="test-data" data-name="${esc(name)}">Test this source</button>
    <div id="test-result">${result}</div>
    <button class="btn ghost danger" data-action="remove-data" data-name="${esc(name)}">Remove source</button>`;
}

// plex.section passes unknown params through to Plex as filters; these rows
// edit the params not covered by the provider's declared knobs.
function extraParamRows(name, ds, meta) {
  const extras = Object.entries(ds.params || {}).filter(([k]) => !(k in meta.params));
  const rows = extras.map(([k, v]) => `<div class="kv">
    <input type="text" data-rename="data.${esc(name)}.params" data-old="${esc(k)}" value="${esc(k)}">
    <input type="text" data-path="data.${esc(name)}.params.${esc(k)}" value="${esc(v)}">
    <button class="btn ghost danger" data-action="remove-param" data-ds="${esc(name)}" data-key="${esc(k)}">×</button>
  </div>`).join("");
  return `<h3>Extra Plex filters</h3>
    <p class="muted">Anything here is handed to Plex verbatim as a query filter, e.g. decade=1990 or year&gt;&gt;=2000.</p>
    ${rows}
    <button class="btn ghost" data-action="add-param" data-ds="${esc(name)}">+ Add filter</button>`;
}

// testResults holds the last "Test this source" answer per source name, so the
// table survives a re-render of the panel.
const testResults = {};

function renderTestResult(name) {
  const r = testResults[name];
  if (!r) return "";
  if (r.pending) return `<p class="muted">Running…</p>`;
  if (r.error) return `<ul class="errors"><li>${esc(r.error)}</li></ul>`;
  if (!r.items.length) return `<p class="empty">The source ran and returned no items. Check the section id and any filters.</p>`;
  return `<table class="test-table">
    <thead><tr><th>#</th><th>Name</th><th>Views</th><th>Trailer</th></tr></thead>
    <tbody>${r.items.map((it) => `<tr>
      <td>${it.rank}</td><td>${esc(it.name)}</td><td>${it.views || ""}</td>
      <td>${it.hasMedia ? "yes" : "—"}</td></tr>`).join("")}</tbody>
  </table>
  <p class="muted">${r.items.length} item${r.items.length === 1 ? "" : "s"} returned.</p>`;
}

actions["select-data"] = (d) => { selection.dataSource = d.name; renderInspector(); };
actions["select-data-list"] = () => { selection.dataSource = ""; renderInspector(); };
actions["add-data"] = () => {
  const name = uniqueKey(state.data, "source");
  state.data[name] = { provider: "plex.top", params: defaultParams("plex.top") };
  selection.dataSource = name;
  onStateChange();
};
actions["remove-data"] = (d) => {
  delete state.data[d.name];
  selection.dataSource = "";
  onStateChange();
};
actions["add-param"] = (d) => {
  const ds = state.data[d.ds];
  ds.params[uniqueKey(ds.params, "filter")] = "";
  renderInspector();
};
actions["remove-param"] = (d) => { delete state.data[d.ds].params[d.key]; renderInspector(); };
actions["test-data"] = async (d) => {
  testResults[d.name] = { pending: true };
  renderInspector();
  const out = await apiResolveData({ [d.name]: state.data[d.name] });
  const src = (out.sources || {})[d.name] || { items: [] };
  testResults[d.name] = out.configured
    ? { items: src.items || [], error: src.error || "" }
    : { items: [], error: out.reason || "Plex is not configured." };
  renderInspector();
};

// Switching provider resets params to that provider's defaults — stale keys
// would otherwise leak through plex.section's passthrough as bogus filters.
rerenderHooks["provider"] = (dataset) => {
  const ds = state.data[dataset.ds];
  ds.params = defaultParams(ds.provider);
};
```

and change `renderInspector()`'s body to dispatch on the data mode:

```js
function renderInspector() {
  const el = $("#inspector");
  // A non-null dataSource means the inspector is describing a data source
  // rather than the stage's selection. "" is the list; null is "not in data
  // mode at all".
  if (selection.dataSource !== null) { el.innerHTML = dataInspector(); return; }
  const scene = currentScene();
  if (!scene) {
    el.innerHTML = `<h2>Pre-roll</h2>${prerollFields()}${audioFields()}
      <p class="empty">No scenes yet — add one from the timeline.</p>`;
    return;
  }
  const path = elementPath();
  el.innerHTML = path
    ? elementInspector(path, currentLayout().elements[selection.element])
    : sceneInspector(scene, selection.sceneIndex);
}

// audioFields is the last of the phase-1 Audio card, moved here: the soundtrack
// belongs to the pre-roll, so it lives with the pre-roll's other settings.
function audioFields() {
  const a = state.audio;
  return `<h3>Soundtrack</h3>
    <div class="stack">
      ${fileField("Audio file", "audio.file", a.file, "audio", "Leave empty for no soundtrack")}
      ${field("Mode", select("audio.mode", a.mode, ["soundtrack", "original", "mix"]),
        "soundtrack: music only · original: clip audio · mix: both")}
      ${field("Start offset (s)", numInput("audio.start", a.start, { min: 0 }),
        "Seek into the track — drop in on the hook, not the intro")}
      <label class="check"><input type="checkbox" data-action-toggle="audio-fade"${a.fadeOut ? " checked" : ""}> Fade out at the end</label>
      ${a.fadeOut ? `
        ${field("Fade starts at (s)", numInput("audio.fadeOut.start", a.fadeOut.start, { min: 0 }))}
        ${field("Fade duration (s)", numInput("audio.fadeOut.duration", a.fadeOut.duration, { min: 0 }))}` : ""}
    </div>`;
}
```

and in `sceneInspector`, change the trailing `<details>` to:

```js
    <details><summary>Pre-roll settings</summary>${prerollFields()}${audioFields()}
      <h3>Data</h3>
      <button class="btn ghost" data-action="select-data-list">Edit data sources</button>
    </details>`;
```

- [ ] **Step 3: Move `varRows` into `inspector.js` and delete `sections.js`**

- Copy `varRows`, `actions["add-var"]` and `actions["remove-var"]` from `sections.js` into `inspector.js` (with `renderScenes()` already replaced by `renderInspector()` in Task 10), and copy `rerenderHooks["scene-kind"]` into `inspector.js`.
- Delete `internal/webui/static/sections.js`.
- In `internal/webui/static/state.js`, add the top-level render orchestrator that used to live in `sections.js`:

  ```js
  // renderAll repaints every view. state.js owns it because state.js is what
  // calls onStateChange, and every view file is loaded before app.js boots.
  function renderAll() {
    renderTimeline();
    renderStage();
    renderInspector();
  }
  ```
  and delete the `setStateChangeHandler`-installed duplicate in `app.js`, replacing the boot handler with:
  ```js
  setStateChangeHandler(() => { renderAll(); refreshStageData(); scheduleConvert(); });
  ```
- In `internal/webui/static/index.html`, delete the whole `<div class="editor" id="editor">…</div>` block and the `<script src="sections.js"></script>` line.
- In `internal/webui/static/app.js`, remove `"#editor"` from the listener-binding loop and delete the `deriveOutput` special case's `$('#section-general input[data-path="output"]')` lookup, replacing that branch with:
  ```js
    if (path === "name") {
      const wasAuto = state.output === deriveOutput(state.name);
      setPath(state, path, coerce(e.target));
      if (wasAuto) {
        state.output = deriveOutput(state.name);
        renderInspector();
      }
    } else {
  ```
- In `internal/webui/static/app.js`'s `onEditorChange`, add the audio-fade toggle beside the scene-background one:
  ```js
    if (t.dataset.actionToggle === "audio-fade") {
      state.audio.fadeOut = t.checked ? { start: 0, duration: 2 } : null;
      renderInspector();
      scheduleConvert();
      return;
    }
  ```
- In `internal/webui/static/timeline.js`, make selecting a scene leave data mode, or the inspector would keep showing a data source after the user clicked a scene:
  ```js
  actions["select-scene-index"] = (d) => {
    selection.sceneIndex = +d.index;
    selection.element = null;
    selection.dataSource = null;   // leave the data panel
    renderTimeline();
    renderStage();
    renderInspector();
  };
  ```
- In `internal/webui/static/stage.js`, do the same in `selectAt` and `stagePointerDown` — clicking the stage must also leave data mode. Add `selection.dataSource = null;` immediately before each `renderInspector();` call in those two functions.
- In `internal/webui/static/state.js`, `selection.dataSource` stays initialised to `null` (already the case) and `replaceState` already resets it — confirm both, because `renderInspector` now dispatches on that field.

- [ ] **Step 4: Style the provider doc and the test table**

Append to `internal/webui/static/style.css`:

```css
.provider-doc {
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 10px; margin: 10px 0; font-size: 12px;
}
.provider-doc p { margin: 0 0 4px; }
.test-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
.test-table th, .test-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--border); }
.test-table th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
```

- [ ] **Step 5: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS. `TestEveryScriptTagIsEmbedded` now sees the reduced script list with no `sections.js`.

- [ ] **Step 6: Confirm `sections.js` really is gone**

Run: `grep -rn "sections.js" internal/webui/ ; ls internal/webui/static/`
Expected: no matches, and no `sections.js` in the listing.

- [ ] **Step 7: Human check — the whole editor, cards gone**

Run the server with Plex configured and open `top-movies-trailer-wall.yaml`:
1. The page is now rail + stage + inspector only. No stacked cards below.
2. The inspector's "Pre-roll settings" details holds name, output, resolution, fps, length, the soundtrack fields (with a Browse button for the audio file), and an "Edit data sources" button.
3. Click "Edit data sources" → the list shows `topMovies` labelled "Most watched". Click it: the panel explains what `plex.top` returns and when to use it, and every parameter has a full-sentence hint.
4. Click "Test this source" — a table appears listing real film titles, view counts, and whether a trailer resolved. Change `limit` to 3 and test again — three rows.
5. With Plex unconfigured, the same button shows "Plex is not configured…" in the error style and nothing else breaks.
6. "← All sources" returns to the list; selecting a scene in the rail leaves data mode and returns to the scene inspector.

- [ ] **Step 8: Commit**

```bash
git add -A internal/webui/static/
git commit -m "webui: explained, testable data sources; retire the phase-1 cards"
```

---

### Task 16: Render endpoints — shell out to `plex-pre-rolls`

**Model:** Opus — this is the process-boundary design that keeps `preroll-ui` CGO-free, and the failure modes (missing binary, failed render, long render, concurrent requests) are the whole point of the task.

**The shape, and why:** the UI writes the manifest to a scratch directory, runs the already-built renderer as a subprocess with the same working directory a batch run uses, and polls. One job at a time, tracked in a single slot. No queue, no worker pool, no sandbox — this is a local admin tool the user runs on their own machine, and the user has explicitly said so.

**Files:**
- Create: `internal/webui/render.go`
- Create: `internal/webui/render_test.go`
- Modify: `internal/webui/webui.go` (routes)
- Modify: `cmd/preroll-ui/main.go` (`-render-bin`, `-render-dir`, `-work-dir`)

**Interfaces:**
- Consumes: `Server.RenderBin`, `Server.RenderDir`, `Server.WorkDir` (Task 1), `manifest.Parse`/`ToYAML`.
- Produces:
  - `POST /api/render` body = manifest JSON → `202 {"id":"<hex>"}`, `422` for an invalid manifest, `409` while a render is running, `503` with no binary.
  - `GET /api/render/{id}` → `{"id","state":"running|done|failed","log":"...","error":"","seconds":12.3}`.
  - `GET /api/render/{id}/video` → the mp4, or 404.
  - `func (s *Server) renderJobStatus(id string) (*renderJob, bool)`.

- [ ] **Step 1: Write the failing tests**

Create `internal/webui/render_test.go`:

```go
package webui

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeRenderer writes a stub mp4 to the -manifest's output path and exits 0,
// so the whole subprocess round-trip is exercised without ImageMagick.
const fakeRendererOK = `#!/bin/sh
# args: -manifest <path>
manifest="$2"
out=$(grep '^output:' "$manifest" | sed 's/^output: *//')
mkdir -p "$(dirname "$out")"
printf 'FAKEMP4' > "$out"
echo "wrote $out"
`

const fakeRendererFail = `#!/bin/sh
echo "plex: connection refused" >&2
exit 1
`

func renderServer(t *testing.T, script string) (*httptest.Server, *Server) {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(root, "fake-renderer")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		ManifestDir: filepath.Join(root, "manifests"),
		RenderDir:   filepath.Join(root, "renders"),
		WorkDir:     root,
		RenderBin:   bin,
	}
	if err := os.MkdirAll(s.ManifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, s
}

// waitForJob polls until the job leaves the running state, which is exactly
// what the browser does.
func waitForJob(t *testing.T, ts *httptest.Server, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		res := do(t, "GET", ts.URL+"/api/render/"+id, "")
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		if out["state"] != "running" {
			return out
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job %s never finished", id)
	return nil
}

func TestRenderWithoutABinaryIsUnavailable(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	if res.StatusCode != 503 {
		t.Fatalf("want 503 with no render binary, got %d", res.StatusCode)
	}
}

func TestRenderRejectsAnInvalidManifest(t *testing.T) {
	ts, _ := renderServer(t, fakeRendererOK)
	res := do(t, "POST", ts.URL+"/api/render", `{"name":"draft"}`)
	if res.StatusCode != 422 {
		t.Fatalf("an invalid manifest must never reach the renderer; got %d", res.StatusCode)
	}
}

func TestRenderRunsAndServesTheVideo(t *testing.T) {
	ts, s := renderServer(t, fakeRendererOK)
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	if res.StatusCode != 202 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)
	if started.ID == "" {
		t.Fatal("no job id returned")
	}

	out := waitForJob(t, ts, started.ID)
	if out["state"] != "done" {
		t.Fatalf("job failed: %+v", out)
	}

	video := do(t, "GET", ts.URL+"/api/render/"+started.ID+"/video", "")
	if video.StatusCode != 200 {
		t.Fatalf("video status %d", video.StatusCode)
	}
	if ct := video.Header.Get("Content-Type"); !strings.HasPrefix(ct, "video/") {
		t.Fatalf("content type %q", ct)
	}

	// Render scratch must never land in the directory the batch renderer globs.
	entries, _ := os.ReadDir(s.ManifestDir)
	if len(entries) != 0 {
		t.Fatalf("render wrote into the manifest directory: %v", entries)
	}
}

func TestRenderSurfacesTheSubprocessError(t *testing.T) {
	ts, _ := renderServer(t, fakeRendererFail)
	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)

	out := waitForJob(t, ts, started.ID)
	if out["state"] != "failed" {
		t.Fatalf("want failed, got %+v", out)
	}
	if !strings.Contains(out["log"].(string), "connection refused") {
		t.Fatalf("the renderer's own output must be surfaced, got %q", out["log"])
	}
}

func TestRenderRefusesASecondConcurrentJob(t *testing.T) {
	// A renderer that blocks long enough for the second request to arrive.
	ts, _ := renderServer(t, "#!/bin/sh\nsleep 2\nexit 0\n")
	first := do(t, "POST", ts.URL+"/api/render", validJSON)
	if first.StatusCode != 202 {
		t.Fatalf("first render status %d", first.StatusCode)
	}
	second := do(t, "POST", ts.URL+"/api/render", validJSON)
	if second.StatusCode != 409 {
		t.Fatalf("want 409 while a render is running, got %d", second.StatusCode)
	}
}

func TestRenderStatusOfAnUnknownJobIs404(t *testing.T) {
	ts, _ := renderServer(t, fakeRendererOK)
	res := do(t, "GET", ts.URL+"/api/render/deadbeefdeadbeef", "")
	if res.StatusCode != 404 {
		t.Fatalf("want 404, got %d", res.StatusCode)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `go test ./internal/webui/ -run Render -v`
Expected: FAIL — every request 404s; the render routes do not exist.

- [ ] **Step 3: Write `render.go`**

Create `internal/webui/render.go`:

```go
package webui

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
)

// renderTimeout is a hard ceiling on a single render. A trailer montage over a
// slow link is genuinely slow, so this is generous; without it a wedged ffmpeg
// would hold the single job slot forever.
const renderTimeout = 20 * time.Minute

// renderLogLimit caps how much subprocess output is kept. Enough to see what
// went wrong, bounded so a chatty failure cannot grow without limit.
const renderLogLimit = 64 << 10

// jobIDRE is the shape of a server-generated job id. Ids are only ever
// generated here, so validating the shape on the way back in is a cheap way to
// keep a client-supplied string out of a filesystem path.
var jobIDRE = regexp.MustCompile(`^[0-9a-f]{16}$`)

// renderJob is one render. There is exactly one slot: this is a local,
// single-user admin tool, and a queue would be machinery with no user.
// ponytail: one job at a time. If somebody genuinely needs a queue, that is a
// different tool, not a bigger version of this one.
type renderJob struct {
	ID      string    `json:"id"`
	State   string    `json:"state"` // running | done | failed
	Log     string    `json:"log"`
	Error   string    `json:"error,omitempty"`
	Seconds float64   `json:"seconds"`
	started time.Time
	cancel  context.CancelFunc
	output  string // absolute path to the mp4
}

// startRender validates the posted manifest, writes it to the render scratch
// directory, and runs the renderer as a subprocess.
//
// Why a subprocess at all: rendering needs ImageMagick via CGO and ffmpeg on
// PATH. Linking that into this binary would make the config UI unbuildable
// anywhere the toolchain is missing — which is most places somebody wants to
// edit a manifest. The renderer already exists as a binary; running it is one
// exec.Command instead of a build-system problem.
func (s *Server) startRender(w http.ResponseWriter, r *http.Request) {
	if !s.capabilitySet().Render {
		httpError(w, http.StatusServiceUnavailable,
			fmt.Errorf("no renderer available: set -render-bin (or RENDER_BIN) to the plex-pre-rolls binary"))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	// Parse, not Decode: rendering an invalid manifest wastes minutes to
	// produce the error the validator already knows.
	preroll, err := manifest.Parse(body)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, err)
		return
	}

	s.renderMu.Lock()
	if s.currentJob != nil && s.currentJob.State == "running" {
		s.renderMu.Unlock()
		httpError(w, http.StatusConflict, fmt.Errorf("a render is already running"))
		return
	}
	s.renderMu.Unlock()

	id, err := newJobID()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.MkdirAll(s.RenderDir, 0o755); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	// The preview writes into the render directory, never to the manifest's
	// own output path: a preview must not clobber the file the Plex server is
	// pointed at, and the scratch directory is the one thing we clean up.
	outputPath := filepath.Join(s.RenderDir, id+".mp4")
	absOutput, err := filepath.Abs(outputPath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	preroll.Output = absOutput

	yamlBytes, err := preroll.ToYAML()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	manifestPath := filepath.Join(s.RenderDir, id+".yaml")
	if err := os.WriteFile(manifestPath, yamlBytes, 0o644); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), renderTimeout)
	job := &renderJob{ID: id, State: "running", started: time.Now(), cancel: cancel, output: absOutput}

	s.renderMu.Lock()
	s.cleanupPreviousJobLocked()
	s.currentJob = job
	s.renderMu.Unlock()

	go s.runRender(ctx, job, manifestPath)
	writeJSON(w, http.StatusAccepted, map[string]string{"id": id})
}

// runRender executes the renderer and records the outcome. The working
// directory is the same one a batch run uses, so relative manifest paths
// (media/common/Font.ttf, output/...) resolve identically.
func (s *Server) runRender(ctx context.Context, job *renderJob, manifestPath string) {
	defer job.cancel()

	cmd := exec.CommandContext(ctx, s.RenderBin, "-manifest", manifestPath)
	cmd.Dir = s.WorkDir
	// The environment is inherited whole: the renderer needs the same PLEX_*
	// configuration this process was started with, and reconstructing it here
	// would be a second place for it to drift.
	cmd.Env = os.Environ()

	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()

	logText := out.String()
	if len(logText) > renderLogLimit {
		// Keep the TAIL: the error is at the end, the ffmpeg banner is not.
		logText = "… (earlier output trimmed) …\n" + logText[len(logText)-renderLogLimit:]
	}

	s.renderMu.Lock()
	defer s.renderMu.Unlock()
	job.Log = logText
	job.Seconds = time.Since(job.started).Seconds()
	switch {
	case err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded):
		job.State = "failed"
		job.Error = fmt.Sprintf("render timed out after %s", renderTimeout)
	case err != nil:
		job.State = "failed"
		job.Error = err.Error()
	default:
		if _, statErr := os.Stat(job.output); statErr != nil {
			job.State = "failed"
			job.Error = "the renderer exited cleanly but wrote no video"
			return
		}
		job.State = "done"
	}
}

// renderStatus is what the browser polls. Polling rather than streaming keeps
// both ends trivial: no SSE reconnection logic, no partial-frame parsing, and
// a status object that is the same shape whether the job is running or long
// finished.
func (s *Server) renderStatus(w http.ResponseWriter, r *http.Request) {
	job, ok := s.renderJobStatus(r.PathValue("id"))
	if !ok {
		httpError(w, http.StatusNotFound, fmt.Errorf("no such render"))
		return
	}
	writeJSON(w, http.StatusOK, job)
}

// renderVideo serves the finished mp4. The id is regenerated-shape-checked and
// the path is built here, never taken from the request, so there is nothing to
// traverse with.
func (s *Server) renderVideo(w http.ResponseWriter, r *http.Request) {
	job, ok := s.renderJobStatus(r.PathValue("id"))
	if !ok || job.State != "done" {
		httpError(w, http.StatusNotFound, fmt.Errorf("no finished render with that id"))
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, job.output)
}

// renderJobStatus returns a COPY of the current job, so a caller cannot read a
// half-written field while runRender is finishing.
func (s *Server) renderJobStatus(id string) (*renderJob, bool) {
	if !jobIDRE.MatchString(id) {
		return nil, false
	}
	s.renderMu.Lock()
	defer s.renderMu.Unlock()
	if s.currentJob == nil || s.currentJob.ID != id {
		return nil, false
	}
	snapshot := *s.currentJob
	return &snapshot, true
}

// cleanupPreviousJobLocked deletes the last render's scratch. One slot means
// one set of files; keeping a history would need a retention policy nobody
// asked for. Caller must hold renderMu.
func (s *Server) cleanupPreviousJobLocked() {
	if s.currentJob == nil {
		return
	}
	os.Remove(s.currentJob.output)
	os.Remove(filepath.Join(s.RenderDir, s.currentJob.ID+".yaml"))
	s.currentJob = nil
}

func newJobID() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// renderState is the mutable half of Server, embedded rather than declared
// inline so the struct in webui.go stays a plain list of configuration.
type renderState struct {
	renderMu   sync.Mutex
	currentJob *renderJob
}
```

- [ ] **Step 4: Embed the render state and register the routes**

In `internal/webui/webui.go`, add to the `Server` struct, after the configuration fields:

```go
	// renderState holds the single in-flight render. Server is constructed
	// once per process, so embedding the mutex here is safe.
	renderState
```

and in `Handler()`, after the data routes:

```go
	mux.HandleFunc("POST /api/render", s.startRender)
	mux.HandleFunc("GET /api/render/{id}", s.renderStatus)
	mux.HandleFunc("GET /api/render/{id}/video", s.renderVideo)
```

- [ ] **Step 5: Run the render tests**

Run: `go test ./internal/webui/ -run Render -v`
Expected: PASS — all six, including the 409 and the "never wrote into the manifest directory" assertion.

- [ ] **Step 6: Run everything, including the race detector**

Run: `go test -race ./internal/webui/ -v`
Expected: PASS with no race reports. (`runRender` writes the job from a goroutine while `renderStatus` reads it; the mutex is what makes that safe, and `-race` is how it is proved.)

- [ ] **Step 7: Add the render flags to `cmd/preroll-ui/main.go`**

Add the flags:

```go
	renderBin := flag.String("render-bin", envOr("RENDER_BIN", defaultRenderBin()), "path to the plex-pre-rolls binary; empty disables rendering from the UI")
	renderDir := flag.String("render-dir", envOr("RENDER_DIR", "pre-roll-output/.ui-renders"), "scratch directory for UI-triggered renders")
	workDir := flag.String("work-dir", envOr("WORK_DIR", ""), "working directory renders run in; empty means this process's own")
```

extend the server construction:

```go
	srv := &webui.Server{
		ManifestDir: *dir,
		MediaDirs:   splitDirs(*media),
		RenderBin:   *renderBin,
		RenderDir:   *renderDir,
		WorkDir:     *workDir,
	}
```

and add:

```go
// defaultRenderBin looks for the renderer the way a user would expect: on PATH
// first (the Docker image installs it there), then beside this binary, then in
// the working directory. Not finding it is normal — the UI simply hides the
// render button.
func defaultRenderBin() string {
	if p, err := exec.LookPath("plex-pre-rolls"); err == nil {
		return p
	}
	if self, err := os.Executable(); err == nil {
		beside := filepath.Join(filepath.Dir(self), "plex-pre-rolls")
		if info, err := os.Stat(beside); err == nil && !info.IsDir() {
			return beside
		}
	}
	if info, err := os.Stat("plex-pre-rolls"); err == nil && !info.IsDir() {
		return "plex-pre-rolls"
	}
	return ""
}
```

Add `"os/exec"` and `"path/filepath"` to the imports.

- [ ] **Step 8: Verify the binary and the CGO constraint**

Run:
```bash
CGO_ENABLED=0 go build -o /dev/null ./cmd/preroll-ui && \
go list -deps ./cmd/preroll-ui | grep -E 'imagick|internal/(render|engine|pipeline)' && echo "FORBIDDEN IMPORT" || echo "clean"
```
Expected: `clean`. The subprocess design exists precisely so this stays true.

- [ ] **Step 9: Commit**

```bash
git add internal/webui/render.go internal/webui/render_test.go internal/webui/webui.go cmd/preroll-ui/main.go
git commit -m "webui: render a manifest by shelling out to plex-pre-rolls"
```

---

### Task 17: Render button, progress, and the video preview

**Model:** Sonnet — a poll loop and a `<video>` element over the endpoints from Task 16.

**Files:**
- Create: `internal/webui/static/renderjob.js`
- Modify: `internal/webui/static/api.js`
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/style.css`
- Modify: `internal/webui/static/app.js`

**Interfaces:**
- Consumes: `POST /api/render`, `GET /api/render/{id}`, `GET /api/render/{id}/video` (Task 16), `apiCapabilities` (Task 1).
- Produces: `renderjob.js`: `renderRenderControls(caps)`, `startRenderJob()`, `pollRenderJob(id)`.

- [ ] **Step 1: Add the API calls**

Append to `internal/webui/static/api.js`:

```js
async function apiStartRender(manifest) {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  if (res.status === 202) return { ok: true, id: (await res.json()).id };
  return { ok: false, error: await res.text() };
}

async function apiRenderStatus(id) {
  const res = await fetch(`/api/render/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}
```

- [ ] **Step 2: Write `renderjob.js`**

Create `internal/webui/static/renderjob.js`:

```js
"use strict";
// renderjob.js — "Render" in the toolbar, the progress it reports, and the
// video that comes out. Rendering is a subprocess that can take minutes, so
// nothing here blocks: the button starts a job, a timer polls it, and the
// panel below the stage shows whatever the renderer has said so far.

const RENDER_POLL_MS = 1000;

let renderPollTimer = null;
let renderCapable = false;

// renderRenderControls draws the toolbar button, or nothing at all when this
// deployment has no renderer — an always-visible button that always fails is
// worse than no button.
function renderRenderControls(caps) {
  renderCapable = !!(caps && caps.render);
  $("#render-actions").innerHTML = renderCapable
    ? `<button class="btn" id="btn-render">Render preview</button>`
    : `<span class="muted" title="Start the UI with -render-bin pointing at the plex-pre-rolls binary">Rendering unavailable</span>`;
  if (renderCapable) $("#btn-render").onclick = startRenderJob;
}

async function startRenderJob() {
  const panel = $("#render-panel");
  panel.hidden = false;
  setRenderStatus("Validating…");
  $("#render-video").hidden = true;
  $("#render-log").textContent = "";

  const res = await apiStartRender(state);
  if (!res.ok) {
    // 422 carries the validator's own message, which is the useful one.
    setRenderStatus(`Not rendered: ${res.error}`, true);
    return;
  }
  setRenderStatus("Rendering… this can take a few minutes.");
  $("#btn-render").disabled = true;
  pollRenderJob(res.id);
}

function pollRenderJob(id) {
  clearTimeout(renderPollTimer);
  renderPollTimer = setTimeout(async () => {
    let job;
    try {
      job = await apiRenderStatus(id);
    } catch (err) {
      setRenderStatus(`Lost track of the render: ${err.message}`, true);
      $("#btn-render").disabled = false;
      return;
    }
    // The renderer's own stdout/stderr is the only honest progress signal
    // there is — show it rather than inventing a percentage.
    $("#render-log").textContent = job.log || "";
    if (job.state === "running") {
      setRenderStatus(`Rendering… ${Math.round(job.seconds || 0)}s`);
      pollRenderJob(id);
      return;
    }
    $("#btn-render").disabled = false;
    if (job.state === "failed") {
      setRenderStatus(`Render failed: ${job.error || "see the output below"}`, true);
      return;
    }
    setRenderStatus(`Rendered in ${Math.round(job.seconds)}s`);
    const video = $("#render-video");
    video.src = `/api/render/${encodeURIComponent(id)}/video`;
    video.hidden = false;
    video.load();
  }, RENDER_POLL_MS);
}

function setRenderStatus(text, isError = false) {
  const el = $("#render-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}
```

- [ ] **Step 3: Add the panel markup**

In `internal/webui/static/index.html`, inside `.stage-pane` after the `#stage-note` paragraph:

```html
      <section class="render-panel" id="render-panel" hidden>
        <div class="preview-head">
          <h2>Render preview</h2>
          <span id="render-status" aria-live="polite"></span>
        </div>
        <video id="render-video" controls playsinline hidden></video>
        <pre id="render-log" class="render-log"></pre>
      </section>
```

and add the script, after `timeline.js`:

```html
<script src="renderjob.js"></script>
```

- [ ] **Step 4: Boot the controls**

In `internal/webui/static/app.js`, in the boot block after `renderToolbar();`:

```js
// Capabilities decide what the toolbar even offers, so they are fetched once
// at boot; a feature that appears later needs a reload, which is fine for a
// tool somebody starts on their own machine.
apiCapabilities().then((caps) => {
  renderRenderControls(caps);
  if (!caps.plex && caps.plexError) flash(`Plex previews off: ${caps.plexError}`);
});
```

- [ ] **Step 5: Style the panel**

Append to `internal/webui/static/style.css`:

```css
.render-panel {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px 14px;
}
.render-panel h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--accent); }
#render-status { font-size: 12px; color: var(--muted); }
#render-status.error { color: var(--danger); }
#render-video { width: 100%; border-radius: 6px; background: #000; margin-top: 8px; }
.render-log {
  margin: 8px 0 0; padding: 10px; max-height: 200px; overflow: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; color: var(--muted);
}
```

- [ ] **Step 6: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS.

- [ ] **Step 7: Human check — the three states**

**No renderer** (`go run ./cmd/preroll-ui -manifest-dir manifests -render-bin ""`):
the toolbar shows "Rendering unavailable" with an explanatory tooltip and no button. Everything else works.

**A failing render** (`-render-bin /bin/false`):
click Render preview — the status goes red with the exit error and the log pane shows whatever the process printed.

**A real render** (build the renderer first: `CGO_CFLAGS_ALLOW='-Xpreprocessor' go build ./cmd/plex-pre-rolls`, requires ImageMagick + ffmpeg locally, then `go run ./cmd/preroll-ui -manifest-dir manifests -media-dir media -render-bin ./plex-pre-rolls` with `.env` exported):
open `top-movies-locket.yaml`, click Render preview. The status counts seconds, the log fills with the renderer's output, and when it finishes a `<video>` appears below the stage playing the finished mp4. The UI stays responsive throughout — the timeline, stage and inspector all still work while it renders.
Confirm afterwards that `manifests/` gained no files and `pre-roll-output/.ui-renders/` holds exactly one `.mp4` and one `.yaml`.

- [ ] **Step 8: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: render preview button with progress and an inline video"
```

---

### Task 18: Start from an existing manifest instead of an empty form

**Model:** Sonnet — a dialog over endpoints that already exist.

A new manifest is currently a blank form. The thirteen manifests in `manifests/` are the best documentation the project has, and they are invisible from the editor. "New" becomes a chooser: start empty, or start from any existing manifest with its name cleared so saving cannot clobber the original.

**Files:**
- Modify: `internal/webui/static/app.js`
- Modify: `internal/webui/static/index.html`
- Modify: `internal/webui/static/style.css`

**Interfaces:**
- Consumes: `apiListManifests`, `apiGetManifest` (Task 2), `replaceState`, `deriveOutput` (Task 2).
- Produces: `app.js`: `openNewManifestDialog()`, `startFromTemplate(name)`, `summariseManifest(m)`.

- [ ] **Step 1: Add the chooser to `app.js`**

Replace the `$("#btn-new").onclick` assignment in `renderToolbar` with:

```js
  $("#btn-new").onclick = openNewManifestDialog;
```

and add above `renderToolbar`:

```js
// summariseManifest is the one-line description shown beside each starting
// point: what it is made of, so the list reads as a menu of approaches rather
// than a list of filenames.
function summariseManifest(m) {
  const scenes = m.scenes || [];
  const kinds = {};
  for (const sc of scenes) kinds[sc.kind] = (kinds[sc.kind] || 0) + 1;
  const parts = Object.entries(kinds).map(([k, n]) => `${n} ${k}`);
  const sources = Object.values(m.data || {}).map((ds) => ds.provider);
  const unique = [...new Set(sources)];
  return [
    parts.length ? parts.join(", ") : "no scenes",
    unique.length ? `from ${unique.join(", ")}` : "",
  ].filter(Boolean).join(" · ");
}

// openNewManifestDialog offers the existing manifests as starting points. They
// are fetched one by one because the summary needs their contents; on a local
// server with a dozen manifests that is instant, and the alternative is a new
// endpoint for something the browser can already ask for.
async function openNewManifestDialog() {
  const dialog = $("#new-picker");
  const body = $("#new-picker-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  dialog.showModal();

  const names = await apiListManifests();
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      return { name, manifest: await apiGetManifest(name) };
    } catch {
      return { name, manifest: null };
    }
  }));

  body.innerHTML = `
    <button type="button" class="template-row" data-action="new-empty">
      <code>Empty manifest</code>
      <span class="template-explain">Start from nothing: one blank pre-roll, no scenes.</span>
    </button>
    <h3>Start from an existing manifest</h3>
    <p class="muted">A copy is loaded with the name cleared, so saving creates a new file and never overwrites the original.</p>
    ${loaded.map(({ name, manifest }) => `
      <button type="button" class="template-row" data-action="new-from" data-name="${esc(name)}">
        <code>${esc(name)}</code>
        <span class="template-explain">${esc(manifest ? summariseManifest(manifest) : "could not be read")}</span>
      </button>`).join("")}`;
}

async function startFromTemplate(name) {
  let m;
  try {
    m = await apiGetManifest(name);
  } catch (err) {
    flash(`Could not read ${name}: ${err.message}`, true);
    return;
  }
  // Clear the identity, keep the design. Leaving the name in place would make
  // the very next Save silently overwrite the manifest they copied.
  m.name = "";
  m.output = "";
  replaceState(m);
  $("#new-picker").close();
  $("#manifest-picker").value = "";
  renderAll();
  refreshStageDataNow();
  convert();
  flash(`Started from ${name} — give it a name before saving`);
}

actions["new-empty"] = () => {
  replaceState(emptyManifest());
  $("#new-picker").close();
  $("#manifest-picker").value = "";
  renderAll();
  convert();
};
actions["new-from"] = (d) => startFromTemplate(d.name);
actions["close-new-picker"] = () => $("#new-picker").close();
```

- [ ] **Step 2: Add the dialog markup and register its events**

In `internal/webui/static/index.html`, beside the other dialogs:

```html
<dialog id="new-picker" class="picker">
  <div class="picker-head">
    <h2>New pre-roll</h2>
    <button class="btn ghost" data-action="close-new-picker">Close</button>
  </div>
  <div id="new-picker-body" class="picker-body"></div>
</dialog>
```

and extend the listener-binding loop in `app.js`:

```js
for (const root of ["#inspector", "#rail", "#file-picker", "#template-picker", "#new-picker"]) {
```

- [ ] **Step 3: Run every test**

Run: `node --test internal/webui/static/ && go test ./internal/webui/ -v`
Expected: both PASS.

- [ ] **Step 4: Human check — starting points**

Run the server and click New:
1. The dialog lists "Empty manifest" first, then all thirteen manifests, each with a summary like `1 render · from plex.top` or `1 clips · from plex.trailers`.
2. Pick `top-movies-trailer-wall.yaml` — the editor loads its full design, the stage draws it, and the inspector's Name field is **empty**. The status line says to give it a name.
3. Click Save without a name — refused with "Give the pre-roll a name before saving". Type `my-wall`, save, and `manifests/my-wall.yaml` appears while `top-movies-trailer-wall.yaml` is untouched (`git status` shows no change to it).
4. Pick "Empty manifest" — a blank editor with no scenes, and the inspector shows the pre-roll fields with a "No scenes yet" note.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: start a new manifest from any existing one"
```

---

### Task 19: One combined Docker image, compose wiring, and the README

**Model:** Sonnet — build-file edits with an exact end state, plus documentation.

The UI now needs the renderer binary next to it, so the two stop being separate images. The heavy render image gains the UI binary; the standalone `preroll-ui` stage is deleted; compose runs both services from that one image with different commands.

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `README.md`

- [ ] **Step 1: Build both binaries in the render stage and delete the standalone stage**

In `Dockerfile`, replace the build/CMD block at the end of the `plex-pre-rolls` stage:

```dockerfile
WORKDIR /build
COPY . .

# Two binaries out of one stage. plex-pre-rolls needs CGO for ImageMagick;
# preroll-ui is built CGO-free on purpose — it never links the renderer, it
# executes it, which is why one image can serve both roles.
RUN CGO_CFLAGS_ALLOW='-Xpreprocessor' GOOS=linux GOARCH=$BUILDARCH \
	&& go mod download \
	&& go build -o /usr/local/bin/plex-pre-rolls ./cmd/plex-pre-rolls \
	&& CGO_ENABLED=0 go build -o /usr/local/bin/preroll-ui ./cmd/preroll-ui

CMD ["plex-pre-rolls"]
```

and **delete** the entire `# ---- preroll-ui: browser-based manifest editor` stage at the bottom of the file. The `plex-token` stage stays as it is.

- [ ] **Step 2: Point both services at the one image**

Replace `docker-compose.yml` with:

```yaml
services:
  plex-pre-roll:
    build:
      context: .
      target: plex-pre-rolls
    env_file: .env
    volumes:
      - ./manifests/:/build/manifests/
      - ./media/:/build/media/
      - ./pre-roll-output/:/build/output/

  # One-shot helper to mint a Plex token. Not started by `docker compose up`;
  # run it explicitly:
  #   docker compose run --rm plex-token -login you@example.com
  plex-token:
    build:
      context: .
      target: plex-token
    profiles: ["tools"]

  # The config UI runs from the SAME image as the renderer, because the render
  # button executes plex-pre-rolls as a subprocess. It is the heavy image, but
  # shipping a second slim one would mean the render button could never work.
  preroll-ui:
    build:
      context: .
      target: plex-pre-rolls
    command: ["preroll-ui"]
    env_file: .env
    ports:
      - "8382:8382"
    volumes:
      - ./manifests/:/build/manifests/
      - ./media/:/build/media/
      - ./pre-roll-output/:/build/output/
    environment:
      - MANIFEST_DIR=/build/manifests
      - MEDIA_DIR=/build/media
      - RENDER_BIN=/usr/local/bin/plex-pre-rolls
      - RENDER_DIR=/build/output/.ui-renders
      - WORK_DIR=/build
```

Note: the `version:` key is dropped — Compose has ignored it since v2 and warns about it.

- [ ] **Step 3: Verify the image builds and both binaries are present**

Run:
```bash
docker compose build preroll-ui && \
docker compose run --rm --entrypoint sh preroll-ui -c 'which plex-pre-rolls preroll-ui && preroll-ui -h 2>&1 | head -20'
```
Expected: both paths print, and the flag list shows `-addr`, `-manifest-dir`, `-media-dir`, `-render-bin`, `-render-dir`, `-work-dir`.

- [ ] **Step 4: Verify the UI comes up with rendering enabled**

Run:
```bash
docker compose up -d preroll-ui && sleep 3 && \
curl -s localhost:8382/api/capabilities; echo; \
curl -s localhost:8382/api/files | head -c 200; echo; \
docker compose logs preroll-ui | tail -5; docker compose down
```
Expected: capabilities reports `"render":true` and `"media":true` (and `"plex":true` if `.env` is populated); the file list shows the mounted media.

- [ ] **Step 5: Document the editor in the README**

Add a section to `README.md` after the existing config-UI material (replacing it where it describes the old form):

```markdown
## Pre-roll Studio (the config UI)

`preroll-ui` is a visual editor for manifests. Run it and open <http://localhost:8382>.

```bash
docker compose up -d preroll-ui
# or, locally:
go run ./cmd/preroll-ui -manifest-dir manifests -media-dir media
```

**The three panes.** The left rail is the timeline: every scene, sized by its
duration, click to select and drag to reorder. The centre is the stage: a live
16:9 preview of the selected scene drawn with the same rules the renderer uses,
so an element sits where you put it. Click an element to select it, drag to
move it, drag the corner handle to resize. The right pane is the inspector,
showing properties for whatever is selected — an element, the scene, a data
source, or the pre-roll itself. The canonical YAML is still there behind the
**YAML** button, with its live validation errors.

**Keyboard.** Focus the stage and press Tab to cycle elements, arrows to nudge
(Shift for ten pixels), Delete to remove, Escape to select the scene.

**Configuration.**

| Flag | Env | Default | What it does |
| --- | --- | --- | --- |
| `-addr` | `UI_ADDR` | `:8382` | Listen address |
| `-manifest-dir` | `MANIFEST_DIR` | `manifests` | Where manifests are listed, loaded and saved |
| `-media-dir` | `MEDIA_DIR` | `media` | Comma-separated roots the file picker may browse |
| `-render-bin` | `RENDER_BIN` | found on PATH | The `plex-pre-rolls` binary the render button executes |
| `-render-dir` | `RENDER_DIR` | `pre-roll-output/.ui-renders` | Scratch for UI-triggered renders |
| `-work-dir` | `WORK_DIR` | the process's own | Working directory renders run in |

The UI also reads the same `PLEX_*` variables as the renderer. With them it
shows real titles and artwork on the stage and can test a data source against
the live server; without them it shows placeholder data and says so.

**Everything optional degrades.** No Plex connection: placeholder data, and the
editor works normally. No media directory: the file picker explains that and
the path fields still accept anything typed. No render binary: the render
button is replaced by "Rendering unavailable". None of these stop you editing,
validating or saving a manifest.

**Rendering from the UI** writes the manifest to the render scratch directory
— never to the manifest directory the batch renderer globs — runs
`plex-pre-rolls` as a subprocess, streams its output into the page, and plays
the resulting mp4 inline. One render at a time.

**Saving is fail-closed and atomic**: an invalid manifest is never written, and
a valid one is written to a temp file and renamed over the target, so a batch
render never sees a half-written file. The previous contents are kept as
`<name>.yaml.bak`.
```

- [ ] **Step 6: Run the whole suite one last time**

Run:
```bash
go build ./... && go vet ./... && go test ./... && node --test internal/webui/static/
```
Expected: everything PASS. (`go test ./...` includes `internal/render`, which needs ImageMagick; if the toolchain is not installed locally, that package's build failure is pre-existing and unrelated — confirm with `git stash && go test ./internal/render/` if in doubt.)

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker-compose.yml README.md
git commit -m "docker: one combined image for the renderer and the editor"
```

---

## Retirement summary — how the old UI goes away

Nothing is deleted before its replacement works, and the app is usable after every task.

| Phase-1 surface | Replaced by | Deleted in |
| --- | --- | --- |
| `app.js` monolith | `util.js` / `state.js` / `api.js` / `sections.js` / `app.js` | Task 2 (split, no behaviour change) |
| Layouts card | Inspector: element properties + the Layout section | Task 8 |
| Scenes card | Timeline rail + the scene inspector | Task 10 |
| Data card | Inspector's data-source panel with descriptions and Test | Task 15 |
| General + Audio cards | Inspector's "Pre-roll settings" details | Task 15 |
| `sections.js` (whole file) | — | Task 15 |
| Permanent YAML column | YAML drawer behind a toolbar toggle | Task 6 |
| Standalone `preroll-ui` Docker stage | The combined `plex-pre-rolls` image | Task 19 |

## What is verified automatically, and what is not

**Automated, and genuinely load-bearing:**
- `node --test internal/webui/static/` — every rule mirrored from `render.go` (baselines, alignment, list stepping, cover/grid cropping, transparency), all hit-testing, snapping, drag and resize maths, the colour conversions, and that every static script parses. 25+ assertions, no browser.
- `go test ./internal/webui/` — every endpoint, every traversal attempt, the image proxy's allowlist, the render subprocess's four failure modes, and that `index.html` only loads scripts that exist.
- `go test -race ./internal/webui/` — the render job's concurrent read/write.
- `CGO_ENABLED=0 go build ./cmd/preroll-ui` plus a `go list -deps` grep — the constraint that makes the whole subprocess design worth having.

**Not automated, because no browser automation is paired with this environment:**
every pointer interaction, every dialog, and every visual result. Each task
that touches the DOM ends with a **Human check** naming exactly what to click
and what should happen. The mitigation is structural rather than procedural:
the geometry and hit-testing are pure functions in `geometry.js`, so the part
that would be hardest to eyeball is the part that is tested headlessly, and the
untested remainder is DOM plumbing whose failures are visible on the first
glance at the page.

## Self-review notes

- **Spec coverage:** all six explicit asks are mapped in the table at the top of this plan, and each has a task. The eight problems named in the brief map to: (1) Tasks 6, 8, 9; (2) Tasks 5, 7, 15; (3) Task 14; (4) Tasks 4, 13; (5) Task 12; (6) Tasks 16, 17; (7) Tasks 6, 8, 10 (one stage, one inspector, no bouncing); (8) Task 18.
- **Interface consistency:** `Geometry.moveTo`/`dragPatch`/`nudge` all return the same patch shape (`{x,y}` or `{x,startY}`). `renderAll()` means the same thing in every task after Task 15 (`renderTimeline` + `renderStage` + `renderInspector`). `selection` has exactly three fields — `sceneIndex`, `element`, `dataSource` — introduced in Task 2 and never renamed.
- **Deliberate omissions** (YAGNI, and each has a trigger for revisiting): no undo/redo — add it when somebody actually loses work to a drag; no multi-select — the DSL has no group operations to apply to one; no render queue — one job, one user, one machine; no font-metric fallback table — the browser's own metrics are used and the divergence is disclosed rather than modelled.
