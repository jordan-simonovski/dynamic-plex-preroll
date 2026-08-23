# Pre-roll Config UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web UI for building pre-roll manifests: form-based editing of every DSL feature, live YAML preview with validation errors, and load/save/delete against the manifest directory.

**Architecture:** A new pure-Go HTTP server (`cmd/preroll-ui` + `internal/webui`) serves an embedded vanilla-JS single page. The browser holds the manifest as a plain JS object shaped exactly like the DSL's JSON form and POSTs it to the server on every edit; because **JSON is valid YAML**, the server feeds the body straight through the existing `manifest` package (strict `KnownFields` decode + `Validate`) and returns canonical YAML plus a validation-error list. All conversion and validation logic therefore lives in already-tested Go code; the frontend is only forms and state.

**Tech Stack:** Go 1.26 stdlib (`net/http` 1.22+ method routing, `embed`), `gopkg.in/yaml.v3` (already a dependency), vanilla HTML/CSS/JS with no build step, no CDN, no new dependencies of any kind.

**Model assignment:** Each task carries a **Model:** line. Opus for tasks that set architecture or patterns (API surface, frontend state model, first complex editor); Sonnet for tasks that follow an established pattern (metadata tables, wiring, docs, editors cloning an existing section's shape).

## Global Constraints

- Go version: `go 1.26` (from go.mod). No new Go module dependencies — stdlib + existing `gopkg.in/yaml.v3` only.
- No JS build step, no npm, no CDN assets. Plain `<script src>` files served from `embed.FS`.
- `cmd/preroll-ui` MUST build with `CGO_ENABLED=0` (it must never import `imagick`, `render`, `engine`, or `pipeline`).
- Default listen address `:8382`; overridable via `UI_ADDR` env or `-addr` flag. Manifest directory via `MANIFEST_DIR` env or `-manifest-dir` flag, default `manifests`.
- Saves are fail-closed: an invalid manifest is never written to the manifest directory (batch renders read that directory).
- Manifest filenames from the client are untrusted input: must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(yaml|yml)$` and never escape `MANIFEST_DIR`.
- YAML emitted by the server must round-trip: `Parse(ToYAML(p))` yields a struct `reflect.DeepEqual` to `p`.
- Do NOT surface `Scene.Transition` in the UI — the field exists in the DSL but is consumed nowhere in the engine (verified by grep). Keep it in the Go structs (existing manifests use it) but build no form control for it.
- Tests: std `testing` package only, table tests where natural (match existing `internal/manifest` test style). No testify.
- Commit after every task with the message given in the task.

## File Structure

```
cmd/preroll-ui/main.go               (create) pure-Go entry point: flags/env → webui.Server → ListenAndServe
internal/webui/webui.go              (create) HTTP API (convert/list/get/save/delete) + embedded static serving
internal/webui/webui_test.go         (create) httptest coverage of every endpoint incl. path-traversal rejection
internal/webui/static/index.html     (create) page shell: editor column + YAML preview column
internal/webui/static/style.css      (create) dark design system (tokens, cards, fields, buttons)
internal/webui/static/app.js         (create) state object, path-binding helpers, section renderers, convert loop
internal/webui/static/providers.js   (create) provider/param metadata + template-variable hints (mirrors internal/providers/plex)
internal/manifest/manifest.go        (modify) json tags, yaml omitempty, Decode(), ToYAML()
internal/manifest/validate.go        (modify) extract Problems() []string from Validate()
internal/manifest/manifest_test.go   (modify) round-trip, JSON-input, Problems tests
Dockerfile                           (modify) new preroll-ui target
docker-compose.yml                   (modify) new preroll-ui service on 8382
README.md                            (modify, Task 9) Config UI section
```

---

### Task 1: Manifest package — JSON tags, canonical YAML output, structured errors

**Model:** Sonnet — mechanical tag/refactor work against exact instructions.

**Files:**
- Modify: `internal/manifest/manifest.go`
- Modify: `internal/manifest/validate.go`
- Test: `internal/manifest/manifest_test.go`

**Interfaces:**
- Consumes: existing `Parse([]byte) (*Preroll, error)` and `(*Preroll).Validate() error`.
- Produces (Task 2 relies on these exact signatures):
  - `func Decode(raw []byte) (*Preroll, error)` — strict KnownFields decode, NO validation.
  - `func (p *Preroll) ToYAML() ([]byte, error)` — canonical YAML.
  - `func (p *Preroll) Problems() []string` — every validation problem as its own string; empty slice means valid.
  - All struct fields carry matching lowercase `json` tags (so `encoding/json` and the browser use the same key names as the YAML tags).

- [ ] **Step 1: Write the failing tests**

Append to `internal/manifest/manifest_test.go`:

```go
// A complete manifest exercising every DSL feature, used for round-trip tests.
const roundTripFixture = `
name: fixture
resolution: 1920x1080
fps: 24
output: output/fixture.mp4
length: 16
audio:
  file: media/track.mp3
  mode: soundtrack
  start: 25
  fadeOut: { start: 11, duration: 5 }
data:
  topMovies:
    provider: plex.top
    params: { type: movie, section: "1", limit: "5", trailers: "true" }
layouts:
  main:
    background: { color: none }
    font: media/font.ttf
    elements:
      - { type: text, x: 96, y: 150, size: 96, color: white, align: center, text: "Top Movies", lineHeight: 100 }
      - { type: list, x: 96, startY: 320, stepY: 96, size: 56, color: white, source: topMovies, item: "{{ .Rank }}. {{ .Name }}" }
scenes:
  - { kind: image, file: media/intro.png, duration: 3 }
  - kind: render
    layout: main
    duration: 8
    vars: { Title: "Hello" }
    background: { source: topMovies, mode: trailers, tile: grid, dim: 0.35, limit: 4 }
  - { kind: clips, source: topMovies, perClip: 4, label: main }
`

func TestToYAMLRoundTrip(t *testing.T) {
	p, err := Parse([]byte(roundTripFixture))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	out, err := p.ToYAML()
	if err != nil {
		t.Fatalf("ToYAML: %v", err)
	}
	p2, err := Parse(out)
	if err != nil {
		t.Fatalf("re-parse emitted YAML: %v\n%s", err, out)
	}
	if !reflect.DeepEqual(p, p2) {
		t.Fatalf("round trip changed the manifest:\nfirst:  %+v\nsecond: %+v", p, p2)
	}
}

// JSON is a subset of YAML, so the strict decoder must accept a JSON body
// verbatim — this is what the web UI posts.
func TestDecodeAcceptsJSON(t *testing.T) {
	body := []byte(`{"name":"j","resolution":"1920x1080","fps":24,"output":"o.mp4",` +
		`"scenes":[{"kind":"image","file":"a.png","duration":3}]}`)
	p, err := Decode(body)
	if err != nil {
		t.Fatalf("Decode(json): %v", err)
	}
	if p.Name != "j" || p.FPS != 24 || len(p.Scenes) != 1 {
		t.Fatalf("decoded wrong values: %+v", p)
	}
}

func TestDecodeRejectsUnknownFields(t *testing.T) {
	if _, err := Decode([]byte(`{"name":"x","bogus":1}`)); err == nil {
		t.Fatal("expected unknown-field error, got nil")
	}
}

func TestDecodeSkipsValidation(t *testing.T) {
	// Invalid manifest (no fps, no scenes) must still decode.
	p, err := Decode([]byte(`{"name":"draft"}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(p.Problems()) == 0 {
		t.Fatal("expected problems for a draft manifest, got none")
	}
}

func TestProblemsMatchesValidate(t *testing.T) {
	p := &Preroll{} // everything missing
	problems := p.Problems()
	if len(problems) == 0 {
		t.Fatal("expected problems for empty manifest")
	}
	err := p.Validate()
	if err == nil {
		t.Fatal("expected Validate error for empty manifest")
	}
	for _, prob := range problems {
		if !strings.Contains(err.Error(), prob) {
			t.Fatalf("problem %q missing from Validate error %q", prob, err)
		}
	}
}
```

Add `"reflect"` to the test file's imports if not present (`"strings"` is likely already imported; check).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manifest/`
Expected: FAIL — `undefined: Decode`, `p.ToYAML undefined`, `p.Problems undefined`.

- [ ] **Step 3: Implement**

In `internal/manifest/manifest.go`:

3a. Add `json` tags and yaml `omitempty` to every struct field. Full replacement listing (keep existing doc comments untouched above each type):

```go
type Preroll struct {
	Name       string                `yaml:"name,omitempty" json:"name,omitempty"`
	Resolution string                `yaml:"resolution,omitempty" json:"resolution,omitempty"`
	FPS        int                   `yaml:"fps,omitempty" json:"fps,omitempty"`
	Output     string                `yaml:"output,omitempty" json:"output,omitempty"`
	Length     float64               `yaml:"length,omitempty" json:"length,omitempty"`
	Audio      Audio                 `yaml:"audio,omitempty" json:"audio,omitzero"`
	Data       map[string]DataSource `yaml:"data,omitempty" json:"data,omitempty"`
	Layouts    map[string]Layout     `yaml:"layouts,omitempty" json:"layouts,omitempty"`
	Scenes     []Scene               `yaml:"scenes,omitempty" json:"scenes,omitempty"`
}

type Audio struct {
	File    string   `yaml:"file,omitempty" json:"file,omitempty"`
	Mode    string   `yaml:"mode,omitempty" json:"mode,omitempty"`
	Start   float64  `yaml:"start,omitempty" json:"start,omitempty"`
	FadeOut *FadeOut `yaml:"fadeOut,omitempty" json:"fadeOut,omitempty"`
}

type FadeOut struct {
	Start    float64 `yaml:"start,omitempty" json:"start,omitempty"`
	Duration float64 `yaml:"duration,omitempty" json:"duration,omitempty"`
}

type DataSource struct {
	Provider string            `yaml:"provider,omitempty" json:"provider,omitempty"`
	Params   map[string]string `yaml:"params,omitempty" json:"params,omitempty"`
}

type Layout struct {
	Background Background `yaml:"background,omitempty" json:"background,omitzero"`
	Font       string     `yaml:"font,omitempty" json:"font,omitempty"`
	Elements   []Element  `yaml:"elements,omitempty" json:"elements,omitempty"`
}

type Background struct {
	Color string `yaml:"color,omitempty" json:"color,omitempty"`
	Image string `yaml:"image,omitempty" json:"image,omitempty"`
}

type Element struct {
	Type       string  `yaml:"type,omitempty" json:"type,omitempty"`
	X          float64 `yaml:"x,omitempty" json:"x,omitempty"`
	Y          float64 `yaml:"y,omitempty" json:"y,omitempty"`
	Size       float64 `yaml:"size,omitempty" json:"size,omitempty"`
	Color      string  `yaml:"color,omitempty" json:"color,omitempty"`
	Align      string  `yaml:"align,omitempty" json:"align,omitempty"`
	Text       string  `yaml:"text,omitempty" json:"text,omitempty"`
	LineHeight float64 `yaml:"lineHeight,omitempty" json:"lineHeight,omitempty"`
	Source     string  `yaml:"source,omitempty" json:"source,omitempty"`
	StartY     float64 `yaml:"startY,omitempty" json:"startY,omitempty"`
	StepY      float64 `yaml:"stepY,omitempty" json:"stepY,omitempty"`
	Item       string  `yaml:"item,omitempty" json:"item,omitempty"`
}

type Scene struct {
	Kind       string            `yaml:"kind,omitempty" json:"kind,omitempty"`
	File       string            `yaml:"file,omitempty" json:"file,omitempty"`
	Duration   float64           `yaml:"duration,omitempty" json:"duration,omitempty"`
	Layout     string            `yaml:"layout,omitempty" json:"layout,omitempty"`
	Vars       map[string]string `yaml:"vars,omitempty" json:"vars,omitempty"`
	Source     string            `yaml:"source,omitempty" json:"source,omitempty"`
	PerClip    float64           `yaml:"perClip,omitempty" json:"perClip,omitempty"`
	Transition string            `yaml:"transition,omitempty" json:"transition,omitempty"`
	Label      string            `yaml:"label,omitempty" json:"label,omitempty"`
	Background *SceneBackground  `yaml:"background,omitempty" json:"background,omitempty"`
}

type SceneBackground struct {
	Source string  `yaml:"source,omitempty" json:"source,omitempty"`
	Mode   string  `yaml:"mode,omitempty" json:"mode,omitempty"`
	Tile   string  `yaml:"tile,omitempty" json:"tile,omitempty"`
	Dim    float64 `yaml:"dim,omitempty" json:"dim,omitempty"`
	Limit  int     `yaml:"limit,omitempty" json:"limit,omitempty"`
}
```

Note `json:"audio,omitzero"` / `json:"background,omitzero"` on the two value-struct fields (Go 1.24+ `omitzero`; plain json `omitempty` does not omit zero structs).

3b. Split `Parse` into `Decode` + validation and add `ToYAML`:

```go
// Decode parses a manifest from bytes without validating it. Unknown fields
// are rejected so typos fail loudly. JSON bodies are accepted too: JSON is a
// subset of YAML, which is how the web UI posts manifests.
func Decode(raw []byte) (*Preroll, error) {
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)
	var p Preroll
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	return &p, nil
}

// Parse decodes and validates a manifest from bytes.
func Parse(raw []byte) (*Preroll, error) {
	p, err := Decode(raw)
	if err != nil {
		return nil, err
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return p, nil
}

// ToYAML marshals the manifest to its canonical YAML form. Zero-valued fields
// are omitted, so a manifest built up field-by-field in the UI emits only what
// was actually set.
func (p *Preroll) ToYAML() ([]byte, error) {
	return yaml.Marshal(p)
}
```

3c. In `internal/manifest/validate.go`, extract `Problems`. `Validate`'s body currently builds `errs []string` via a local `add` closure; move that whole body into `Problems` and have `Validate` wrap it:

```go
// Problems returns every structural and referential problem in the manifest,
// one string each. An empty slice means the manifest is valid.
func (p *Preroll) Problems() []string {
	var errs []string
	add := func(format string, args ...any) {
		errs = append(errs, fmt.Sprintf(format, args...))
	}

	// ... existing Validate body between the `add` definition and the final
	// `if len(errs) > 0` block, unchanged ...

	return errs
}

// Validate checks structural and referential integrity. It fails closed: any
// unknown kind, dangling reference, or nonsensical value is an error.
func (p *Preroll) Validate() error {
	if errs := p.Problems(); len(errs) > 0 {
		return fmt.Errorf("invalid manifest:\n  - %s", strings.Join(errs, "\n  - "))
	}
	return nil
}
```

- [ ] **Step 4: Run all tests**

Run: `go test ./internal/manifest/ ./internal/...`
Expected: PASS everywhere, including the existing `manifests_smoke_test.go` (which parses every file under `manifests/` — proves the tag changes didn't break real manifests). Note: `go build ./...` will fail on imagick-dependent packages if ImageMagick isn't installed locally — that's pre-existing; `go vet ./internal/manifest/` and the manifest tests are the gate here.

- [ ] **Step 5: Commit**

```bash
git add internal/manifest/
git commit -m "manifest: json tags, omitempty, Decode/ToYAML/Problems for the config UI"
```

---

### Task 2: `internal/webui` — HTTP API with tests

**Model:** Opus — this fixes the API contract every later task builds on.

**Files:**
- Create: `internal/webui/webui.go`
- Create: `internal/webui/static/index.html` (placeholder so `go:embed` compiles; Task 4 replaces it)
- Test: `internal/webui/webui_test.go`

**Interfaces:**
- Consumes: `manifest.Decode`, `manifest.Parse`, `(*Preroll).ToYAML()`, `(*Preroll).Problems()` from Task 1.
- Produces (Tasks 3–8 rely on these):
  - `type Server struct { ManifestDir string }` with `func (s *Server) Handler() http.Handler`.
  - `POST /api/convert` — body: manifest as JSON. Response `200 {"yaml": "<string>", "errors": ["<string>", ...]}`. A body that fails to decode returns `200` with empty `yaml` and the decode error as the single entry in `errors` (the UI shows it in the same error pane). `errors` is always a non-null array.
  - `GET /api/manifests` — `200 ["a.yaml","b.yaml"]` sorted basenames (always an array, `[]` when empty).
  - `GET /api/manifests/{name}` — `200` manifest as JSON; `400` bad name; `404` missing; `422` file exists but won't parse.
  - `PUT /api/manifests/{name}` — body: manifest as JSON; validates strictly, writes canonical YAML; `200 {"name":"x.yaml"}`; `422` invalid manifest (body = the multi-line validate error text); `400` bad name.
  - `DELETE /api/manifests/{name}` — `200` on success, `400`/`404` accordingly.
  - `GET /` and any non-`/api` path — embedded static files.

- [ ] **Step 1: Create the placeholder static file**

`internal/webui/static/index.html`:

```html
<!doctype html><title>Pre-roll Studio</title><p>UI lands in Task 4.</p>
```

- [ ] **Step 2: Write the failing tests**

`internal/webui/webui_test.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validJSON = `{"name":"t","resolution":"1920x1080","fps":24,"output":"output/t.mp4",` +
	`"scenes":[{"kind":"image","file":"a.png","duration":3}]}`

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	ts := httptest.NewServer((&Server{ManifestDir: dir}).Handler())
	t.Cleanup(ts.Close)
	return ts, dir
}

func do(t *testing.T, method, url, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestConvertValid(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "POST", ts.URL+"/api/convert", validJSON)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var out struct {
		YAML   string   `json:"yaml"`
		Errors []string `json:"errors"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", out.Errors)
	}
	if !strings.Contains(out.YAML, "name: t") || !strings.Contains(out.YAML, "kind: image") {
		t.Fatalf("yaml missing expected content:\n%s", out.YAML)
	}
}

func TestConvertReportsProblems(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "POST", ts.URL+"/api/convert", `{"name":"draft"}`)
	var out struct {
		YAML   string   `json:"yaml"`
		Errors []string `json:"errors"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	if len(out.Errors) == 0 {
		t.Fatal("expected validation errors for a draft manifest")
	}
	if out.YAML == "" {
		t.Fatal("draft manifests must still preview their YAML")
	}
}

func TestConvertBadBody(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "POST", ts.URL+"/api/convert", `{"bogus": true}`)
	var out struct {
		Errors []string `json:"errors"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode != 200 || len(out.Errors) == 0 {
		t.Fatalf("want 200 with decode error, got %d %v", res.StatusCode, out.Errors)
	}
}

func TestSaveThenListGetDelete(t *testing.T) {
	ts, dir := newTestServer(t)

	if res := do(t, "PUT", ts.URL+"/api/manifests/t.yaml", validJSON); res.StatusCode != 200 {
		t.Fatalf("save: status %d", res.StatusCode)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "t.yaml"))
	if err != nil {
		t.Fatalf("saved file: %v", err)
	}
	if !strings.Contains(string(raw), "name: t") {
		t.Fatalf("file is not YAML:\n%s", raw)
	}

	res := do(t, "GET", ts.URL+"/api/manifests", "")
	var names []string
	json.NewDecoder(res.Body).Decode(&names)
	if len(names) != 1 || names[0] != "t.yaml" {
		t.Fatalf("list: %v", names)
	}

	res = do(t, "GET", ts.URL+"/api/manifests/t.yaml", "")
	var m map[string]any
	json.NewDecoder(res.Body).Decode(&m)
	if m["name"] != "t" {
		t.Fatalf("get: %v", m)
	}

	if res := do(t, "DELETE", ts.URL+"/api/manifests/t.yaml", ""); res.StatusCode != 200 {
		t.Fatalf("delete: status %d", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "t.yaml")); !os.IsNotExist(err) {
		t.Fatal("file still exists after delete")
	}
}

func TestSaveRejectsInvalidManifest(t *testing.T) {
	ts, dir := newTestServer(t)
	res := do(t, "PUT", ts.URL+"/api/manifests/bad.yaml", `{"name":"bad"}`)
	if res.StatusCode != 422 {
		t.Fatalf("want 422, got %d", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "bad.yaml")); !os.IsNotExist(err) {
		t.Fatal("invalid manifest was written to disk")
	}
}

func TestBadNamesRejected(t *testing.T) {
	ts, _ := newTestServer(t)
	// 400 = our name check; 404 = the mux refusing an encoded slash. Either
	// way the request must never reach the filesystem with a bad name.
	for _, name := range []string{"..%2Fescape.yaml", "no-extension", ".hidden.yaml", "sub%2Fdir.yaml"} {
		res := do(t, "GET", ts.URL+"/api/manifests/"+name, "")
		if res.StatusCode != 400 && res.StatusCode != 404 {
			t.Errorf("name %q: want 400 or 404, got %d", name, res.StatusCode)
		}
	}
}

func TestGetMissing404(t *testing.T) {
	ts, _ := newTestServer(t)
	if res := do(t, "GET", ts.URL+"/api/manifests/nope.yaml", ""); res.StatusCode != 404 {
		t.Fatalf("want 404, got %d", res.StatusCode)
	}
}

func TestStaticServed(t *testing.T) {
	ts, _ := newTestServer(t)
	res := do(t, "GET", ts.URL+"/", "")
	if res.StatusCode != 200 {
		t.Fatalf("static index: status %d", res.StatusCode)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./internal/webui/`
Expected: FAIL — package won't compile (`webui.go` missing).

- [ ] **Step 4: Implement `internal/webui/webui.go`**

```go
// Package webui serves the pre-roll config UI: an embedded single-page editor
// plus a small JSON API over the manifest package. The browser posts manifests
// as JSON; JSON is a subset of YAML, so the strict manifest decoder consumes
// the body directly and all validation stays in one place.
package webui

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
)

//go:embed all:static
var staticFS embed.FS

// maxBody caps request bodies; manifests are a few KB, so 1MB is generous.
const maxBody = 1 << 20

// nameRE is the only shape a client-supplied manifest filename may take. It
// forbids path separators and leading dots, confining every file operation to
// ManifestDir.
var nameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(yaml|yml)$`)

// Server is the config UI's HTTP server. ManifestDir is where manifests are
// listed, loaded, saved, and deleted.
type Server struct {
	ManifestDir string
}

// Handler returns the full route table: the JSON API under /api and the
// embedded static UI everywhere else.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/convert", s.convert)
	mux.HandleFunc("GET /api/manifests", s.list)
	mux.HandleFunc("GET /api/manifests/{name}", s.get)
	mux.HandleFunc("PUT /api/manifests/{name}", s.save)
	mux.HandleFunc("DELETE /api/manifests/{name}", s.remove)
	staticRoot, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err) // embedded tree is fixed at compile time
	}
	mux.Handle("GET /", http.FileServerFS(staticRoot))
	return mux
}

type convertResponse struct {
	YAML   string   `json:"yaml"`
	Errors []string `json:"errors"`
}

func (s *Server) convert(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	p, err := manifest.Decode(body)
	if err != nil {
		writeJSON(w, http.StatusOK, convertResponse{Errors: []string{err.Error()}})
		return
	}
	out, err := p.ToYAML()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	problems := p.Problems()
	if problems == nil {
		problems = []string{}
	}
	writeJSON(w, http.StatusOK, convertResponse{YAML: string(out), Errors: problems})
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	names := []string{}
	for _, pattern := range []string{"*.yaml", "*.yml"} {
		matches, err := filepath.Glob(filepath.Join(s.ManifestDir, pattern))
		if err != nil {
			httpError(w, http.StatusInternalServerError, err)
			return
		}
		for _, m := range matches {
			names = append(names, filepath.Base(m))
		}
	}
	sort.Strings(names)
	writeJSON(w, http.StatusOK, names)
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	path, err := s.manifestPath(r.PathValue("name"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusNotFound, err)
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	p, err := manifest.Decode(raw)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) save(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	path, err := s.manifestPath(name)
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	// Parse (decode + validate): an invalid manifest must never land in the
	// directory the batch renderer reads.
	p, err := manifest.Parse(body)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, err)
		return
	}
	out, err := p.ToYAML()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(path, out, 0o644); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}

func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	path, err := s.manifestPath(r.PathValue("name"))
	if err != nil {
		httpError(w, http.StatusBadRequest, err)
		return
	}
	if err := os.Remove(path); errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusNotFound, err)
		return
	} else if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"deleted": r.PathValue("name")})
}

// manifestPath validates a client-supplied filename and joins it onto
// ManifestDir. Anything not matching nameRE is rejected, so no client input
// can name a path outside the directory.
func (s *Server) manifestPath(name string) (string, error) {
	if !nameRE.MatchString(name) {
		return "", fmt.Errorf("invalid manifest name %q", name)
	}
	return filepath.Join(s.ManifestDir, name), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, err error) {
	http.Error(w, err.Error(), status)
}
```

- [ ] **Step 5: Run tests**

Run: `go test ./internal/webui/ ./internal/manifest/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/
git commit -m "webui: JSON API for manifest convert/list/get/save/delete"
```

---

### Task 3: `cmd/preroll-ui` entry point + Docker wiring

**Model:** Sonnet — small wiring task with an exact spec.

**Files:**
- Create: `cmd/preroll-ui/main.go`
- Modify: `Dockerfile` (new target at the end)
- Modify: `docker-compose.yml` (new service)

**Interfaces:**
- Consumes: `webui.Server` / `Handler()` from Task 2.
- Produces: `preroll-ui` binary; Docker service `preroll-ui` on host port 8382 with `./manifests` mounted.

- [ ] **Step 1: Write `cmd/preroll-ui/main.go`**

```go
// Command preroll-ui serves the pre-roll config UI: a browser-based editor
// that builds manifests and saves them into the manifest directory the batch
// renderer reads. Pure Go — no ImageMagick/ffmpeg needed, so it builds and
// runs anywhere with CGO_ENABLED=0.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/webui"
)

func main() {
	addr := flag.String("addr", envOr("UI_ADDR", ":8382"), "listen address")
	dir := flag.String("manifest-dir", envOr("MANIFEST_DIR", "manifests"), "directory manifests are read from and saved to")
	flag.Parse()

	if err := os.MkdirAll(*dir, 0o755); err != nil {
		log.Fatalf("manifest dir: %v", err)
	}
	srv := &webui.Server{ManifestDir: *dir}
	log.Printf("pre-roll config UI listening on %s (manifests in %s)", *addr, *dir)
	log.Fatal(http.ListenAndServe(*addr, srv.Handler()))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

- [ ] **Step 2: Verify it builds pure-Go and serves**

Run: `CGO_ENABLED=0 go build -o /tmp/preroll-ui ./cmd/preroll-ui`
Expected: builds cleanly (proves no imagick/CGO leaked into the import graph).

Run: `MANIFEST_DIR=manifests /tmp/preroll-ui & sleep 1 && curl -s localhost:8382/api/manifests && curl -s -o /dev/null -w '%{http_code}\n' localhost:8382/ && kill %1`
Expected: a JSON array listing the repo's manifests (e.g. `["collections.yaml",...]`) and `200`.

- [ ] **Step 3: Add the Docker target**

Append to `Dockerfile` (mirrors the existing `plex-token` pure-Go pattern):

```dockerfile
# ---- preroll-ui: browser-based manifest editor --------------------------------
# Pure-Go HTTP server; no ImageMagick/ffmpeg, so this stays small and fast.
FROM golang:1.26 AS preroll-ui

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /usr/local/bin/preroll-ui ./cmd/preroll-ui

ENTRYPOINT ["preroll-ui"]
```

- [ ] **Step 4: Add the compose service**

In `docker-compose.yml`, add under `services:`:

```yaml
  preroll-ui:
    build:
      context: .
      target: preroll-ui
    ports:
      - "8382:8382"
    volumes:
      - ./manifests:/build/manifests
    environment:
      - MANIFEST_DIR=/build/manifests
```

- [ ] **Step 5: Verify the container**

Run: `docker compose build preroll-ui && docker compose up -d preroll-ui && sleep 2 && curl -s localhost:8382/api/manifests && docker compose down`
Expected: JSON array of manifest names. (If Docker is unavailable in the environment, note it and rely on Step 2's local check.)

- [ ] **Step 6: Commit**

```bash
git add cmd/preroll-ui/ Dockerfile docker-compose.yml
git commit -m "preroll-ui: serve the config UI via cmd/preroll-ui and docker compose"
```

---

### Task 4: Frontend shell — design system, state model, live YAML preview, General + Audio sections

**Model:** Opus — establishes the state/binding/render patterns every later frontend task copies.

**Files:**
- Modify: `internal/webui/static/index.html` (replace placeholder)
- Create: `internal/webui/static/style.css`
- Create: `internal/webui/static/app.js`

**Interfaces:**
- Consumes: `POST /api/convert` from Task 2.
- Produces (Tasks 5–8 rely on these exact names, all defined in `app.js`):
  - `state` — mutable manifest object; `emptyManifest()` — its initial shape.
  - `setPath(obj, path, value)` / `getPath(obj, path)` — dot-path access (`"scenes.0.duration"`, `"data.top.params.limit"`).
  - `esc(s)`, `field(label, inputHTML, hint)`, `textInput(path, value, opts)`, `numInput(path, value, opts)`, `select(path, value, options, opts)` — HTML builders. Every generated control carries `data-path`; numeric ones also `data-type="number"|"int"`; selects that change form shape carry `data-rerender` (see below).
  - `actions` — object; section renderers register `actions["verb"] = (dataset) => {...}` handlers, fired by delegated clicks on any `[data-action]` element inside `#editor`.
  - Delegated `change` handling: an input with `data-rename="<mapPath>" data-old="<key>"` renames a key inside the map at `mapPath` on blur (via `renameKey`); an element with `data-rerender="<hook>"` runs `rerenderHooks[hook]` (if registered) then `renderAll()`. The generic mechanism is fully implemented in this task; Tasks 5 and 7 only add entries to `rerenderHooks` (`"provider"`, `"scene-kind"`).
  - `renameKey(mapPath, oldKey, newKey)`, `retargetSource(oldKey, newKey)`, `retargetLayout(oldKey, newKey)`, `uniqueKey(map, base)`.
  - `scheduleConvert()` (debounced) and `convert()` (immediate POST + preview update).
  - `renderAll()`; stub functions `renderData()`, `renderLayouts()`, `renderScenes()`, `renderToolbar()` with empty bodies for later tasks to replace.
  - `flash(msg, isError)` — status toast in the top bar.
  - CSS classes later tasks reuse: `card`, `subcard`, `subcard-head`, `name-input`, `grid2`, `field`, `check`, `kv`, `btn`, `ghost`, `danger`, `muted`, `empty`, `chips`.

- [ ] **Step 1: Replace `internal/webui/static/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pre-roll Studio</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="topbar">
  <h1>Pre-roll <span>Studio</span></h1>
  <div class="topbar-actions" id="manifest-actions"></div>
  <span id="status"></span>
</header>
<main class="split">
  <div class="editor" id="editor">
    <section class="card" id="section-general"></section>
    <section class="card" id="section-audio"></section>
    <section class="card" id="section-data"></section>
    <section class="card" id="section-layouts"></section>
    <section class="card" id="section-scenes"></section>
  </div>
  <aside class="preview">
    <div class="preview-head">
      <h2>manifest.yaml</h2>
      <button id="copy-yaml" class="btn ghost">Copy</button>
    </div>
    <ul id="errors" class="errors"></ul>
    <pre id="yaml"><code></code></pre>
  </aside>
</main>
<script src="providers.js"></script>
<script src="app.js"></script>
</body>
</html>
```

Note: `providers.js` is created in Task 5; until then add a one-line placeholder file `// provider metadata lands in Task 5` so the page loads without a 404.

- [ ] **Step 2: Create `internal/webui/static/style.css`**

```css
/* Pre-roll Studio — dark, quiet, Plex-gold accents. */
:root {
  --bg: #0e1013;
  --panel: #15181d;
  --panel-2: #1b1f26;
  --border: #262b34;
  --text: #e8eaf0;
  --muted: #8b93a4;
  --accent: #e5a00d;      /* Plex gold */
  --accent-dim: #6b5209;
  --danger: #e5534b;
  --radius: 10px;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
}

.topbar {
  display: flex; align-items: center; gap: 16px;
  padding: 10px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 10;
}
.topbar h1 { font-size: 16px; margin: 0; letter-spacing: .3px; }
.topbar h1 span { color: var(--accent); }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
#status { color: var(--muted); font-size: 13px; }
#status.error { color: var(--danger); }

.split {
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(360px, 560px);
  gap: 20px;
  padding: 20px;
  max-width: 1500px;
  margin: 0 auto;
  align-items: start;
}
@media (max-width: 980px) { .split { grid-template-columns: 1fr; } }

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-bottom: 16px;
}
.card h2 { margin: 0 0 4px; font-size: 14px; text-transform: uppercase; letter-spacing: .8px; color: var(--accent); }
.card h3 { margin: 14px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); }

.subcard {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin: 10px 0;
}
.subcard-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.subcard-head .name-input { flex: 1; font-weight: 600; }
.subcard-head .spacer { flex: 1; }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
@media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }

.field { display: flex; flex-direction: column; gap: 3px; }
.field > span { font-size: 12px; color: var(--muted); }
.field small { color: var(--muted); font-size: 11px; }
.check { display: flex; gap: 8px; align-items: center; margin: 10px 0 4px; color: var(--muted); }

input, select, textarea {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 9px;
  font: inherit;
  width: 100%;
}
textarea { font-family: var(--mono); resize: vertical; min-height: 54px; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent-dim); }
input[type="range"] { padding: 0; accent-color: var(--accent); }
input[type="checkbox"] { width: auto; }

.btn {
  background: var(--accent);
  color: #14100a;
  border: none; border-radius: 6px;
  padding: 7px 14px;
  font: inherit; font-weight: 600;
  cursor: pointer;
  width: auto;
}
.btn:hover { filter: brightness(1.1); }
.btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); font-weight: 400; }
.btn.ghost:hover { border-color: var(--muted); }
.btn.danger { color: var(--danger); }

.kv { display: grid; grid-template-columns: 1fr 1.4fr auto; gap: 6px; margin: 4px 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.chips code {
  font-family: var(--mono); font-size: 11px;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 999px; padding: 2px 8px; color: var(--muted);
}
.muted { color: var(--muted); font-size: 12px; margin: 4px 0 10px; }
.empty { color: var(--muted); font-style: italic; }

.preview { position: sticky; top: 72px; }
.preview-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.preview-head h2 { margin: 0; font-size: 13px; font-family: var(--mono); color: var(--muted); }
.errors { list-style: none; margin: 0 0 8px; padding: 0; }
.errors li {
  color: #f0b9b5; background: rgba(229, 83, 75, .12);
  border: 1px solid rgba(229, 83, 75, .35);
  border-radius: 6px; padding: 6px 10px; margin-bottom: 6px; font-size: 12px;
}
#yaml {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  margin: 0;
  overflow-x: auto;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.55;
  min-height: 300px; max-height: calc(100vh - 190px); overflow-y: auto;
  white-space: pre;
}
```

- [ ] **Step 3: Create `internal/webui/static/app.js`**

```js
"use strict";

const $ = (sel) => document.querySelector(sel);

// ---- state -----------------------------------------------------------------
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
    ` value="${value ?? 0}" step="${opts.step ?? "any"}"` + (opts.min != null ? ` min="${opts.min}"` : "") + `>`;
}
function select(path, value, options, opts = {}) {
  const body = options.map((o) =>
    `<option value="${esc(o)}"${o === value ? " selected" : ""}>` +
    `${esc(o === "" ? (opts.emptyLabel ?? "(none)") : o)}</option>`).join("");
  const rerender = opts.rerender ? ` data-rerender="${esc(opts.rerender)}"` : "";
  const extra = opts.attrs ?? "";
  return `<select data-path="${esc(path)}"${rerender} ${extra}>${body}</select>`;
}

// ---- key renames (data sources, layouts, param/var maps) -------------------
function uniqueKey(map, base) {
  if (!map[base]) return base;
  let i = 2;
  while (map[`${base}${i}`]) i++;
  return `${base}${i}`;
}
function renameKey(mapPath, oldKey, newKey) {
  const map = getPath(state, mapPath);
  if (!newKey || newKey === oldKey || map[newKey] !== undefined) {
    renderAll(); // reject: restore the old name in the input
    return;
  }
  const rebuilt = {};
  for (const [k, v] of Object.entries(map)) rebuilt[k === oldKey ? newKey : k] = v;
  setPath(state, mapPath, rebuilt);
  if (mapPath === "data") retargetSource(oldKey, newKey);
  if (mapPath === "layouts") retargetLayout(oldKey, newKey);
  renderAll();
  scheduleConvert();
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

// ---- server round-trip -----------------------------------------------------
let convertTimer = null;
function scheduleConvert() {
  clearTimeout(convertTimer);
  convertTimer = setTimeout(convert, 300);
}
async function convert() {
  let out;
  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    out = await res.json();
  } catch (err) {
    out = { yaml: "", errors: [`server unreachable: ${err.message}`] };
  }
  $("#yaml code").textContent = out.yaml || "";
  const list = $("#errors");
  list.innerHTML = "";
  for (const e of out.errors || []) {
    const li = document.createElement("li");
    li.textContent = e;
    list.appendChild(li);
  }
}

// ---- status toast ----------------------------------------------------------
let flashTimer = null;
function flash(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ""; }, 4000);
}

// ---- sections --------------------------------------------------------------
function deriveOutput(name) {
  return name ? `output/${name}.mp4` : "";
}

function renderGeneral() {
  $("#section-general").innerHTML = `
    <h2>General</h2>
    <div class="grid2">
      ${field("Name", textInput("name", state.name, { placeholder: "my-preroll" }),
        "Letters, digits, dots, dashes — it becomes the filename")}
      ${field("Output file", textInput("output", state.output, { placeholder: "output/my-preroll.mp4" }))}
      ${field("Resolution", select("resolution", state.resolution,
        ["1920x1080", "3840x2160", "1280x720"]))}
      ${field("FPS", numInput("fps", state.fps, { int: true, min: 1 }))}
      ${field("Length (s)", numInput("length", state.length, { min: 0 }),
        "0 lets the scenes decide the total length")}
    </div>`;
}

function renderAudio() {
  const a = state.audio;
  $("#section-audio").innerHTML = `
    <h2>Audio</h2>
    <div class="grid2">
      ${field("Soundtrack file", textInput("audio.file", a.file, { placeholder: "media/common/track.mp3" }),
        "Leave empty for no soundtrack")}
      ${field("Mode", select("audio.mode", a.mode, ["soundtrack", "original", "mix"]),
        "soundtrack: music only · original: clip audio · mix: both")}
      ${field("Start offset (s)", numInput("audio.start", a.start, { min: 0 }),
        "Seek into the track — drop in on the hook, not the intro")}
    </div>
    <label class="check"><input type="checkbox" id="fade-toggle"${a.fadeOut ? " checked" : ""}> Fade out at the end</label>
    ${a.fadeOut ? `<div class="grid2">
      ${field("Fade starts at (s)", numInput("audio.fadeOut.start", a.fadeOut.start, { min: 0 }))}
      ${field("Fade duration (s)", numInput("audio.fadeOut.duration", a.fadeOut.duration, { min: 0 }))}
    </div>` : ""}`;
  $("#fade-toggle").onchange = (e) => {
    state.audio.fadeOut = e.target.checked ? { start: 0, duration: 2 } : null;
    renderAudio();
    scheduleConvert();
  };
}

// Replaced by later tasks.
function renderData() {}
function renderLayouts() {}
function renderScenes() {}
function renderToolbar() {}

function renderAll() {
  renderGeneral();
  renderAudio();
  renderData();
  renderLayouts();
  renderScenes();
}

// ---- delegated events ------------------------------------------------------
const actions = {}; // sections register handlers: actions["add-data"] = (dataset) => {...}

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

// rerenderHooks: selects that change the form's shape declare
// data-rerender="<hook>"; a hook may reset dependent state before re-render.
// Later tasks add entries ("provider", "scene-kind").
const rerenderHooks = {};

$("#editor").addEventListener("change", (e) => {
  const t = e.target;
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
renderAll();
renderToolbar();
convert();
```

Also create placeholder `internal/webui/static/providers.js`:

```js
// Provider metadata lands in Task 5.
```

- [ ] **Step 4: Verify**

Run: `go test ./internal/webui/ && go run ./cmd/preroll-ui &` then:
- `curl -s localhost:8382/style.css | head -3` → the CSS tokens.
- `curl -s -X POST localhost:8382/api/convert -d '{"name":"x","resolution":"1920x1080","fps":24,"output":"output/x.mp4","audio":{"file":"","mode":"soundtrack","start":0,"fadeOut":null},"data":{},"layouts":{},"scenes":[]}'` → JSON with `yaml` starting `name: x` and an `errors` entry about scenes being required. This is exactly the shape `emptyManifest()` (plus a name) posts — it proves the state contract.
- In a browser at `localhost:8382`: type a name → output auto-fills, YAML pane updates within ~300ms, error pane lists "at least one scene is required"; toggle Fade out → fade fields appear and `fadeOut:` shows in YAML. Kill the server after.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: frontend shell with live YAML preview, general and audio sections"
```

---

### Task 5: Provider metadata + Data Sources editor

**Model:** Sonnet — a metadata table transcribed from the provider code plus a section renderer following Task 4's pattern.

**Files:**
- Modify: `internal/webui/static/providers.js` (replace placeholder)
- Modify: `internal/webui/static/app.js` (replace `renderData` stub; register actions and the `provider` rerender hook)

**Interfaces:**
- Consumes: `field/textInput/select/esc/uniqueKey/actions/rerenderHooks/renameKey/state` from Task 4.
- Produces: globals `PROVIDERS`, `TEMPLATE_VARS`, `ITEM_FIELDS`, `TEMPLATE_FUNCS` (Task 6 uses the last three); working `renderData()`; state shape `state.data[name] = { provider, params }` (Tasks 6–7 read `Object.keys(state.data)` for source dropdowns).

- [ ] **Step 1: Write `internal/webui/static/providers.js`**

Metadata mirrors `internal/providers/plex/plex.go` and `discover.go` — every param those providers read, nothing more:

```js
"use strict";

// Provider metadata drives the data-source forms: which params exist, what
// they mean, and sensible defaults. Mirrors internal/providers/plex — keep in
// sync when providers change.
const PROVIDERS = {
  "plex.top": {
    hint: "Most-viewed items in a library section over a period.",
    params: {
      type:     { options: ["", "movie", "show"], hint: "Item type" },
      section:  { hint: "Library section ID", default: "{{ .MovieSectionId }}" },
      period:   { options: ["", "DAY", "WEEK", "MONTH", "YEAR"], hint: "Viewed-within window", default: "{{ .PeriodInterval }}" },
      limit:    { hint: "Max items", default: "5" },
      trailers: { options: ["", "true"], hint: "Also resolve each item's trailer URL (feeds trailer backgrounds)" },
    },
  },
  "plex.unwatched": {
    hint: "Unwatched items in a library section.",
    params: {
      section: { hint: "Library section ID (required)", default: "{{ .MovieSectionId }}" },
      type:    { options: ["", "movie", "show", "season", "episode"], hint: "Item type" },
      sort:    { hint: "Plex sort, e.g. addedAt:desc" },
      limit:   { hint: "Max items" },
    },
  },
  "plex.trailers": {
    hint: "A streamable trailer for each item in a section.",
    params: {
      section: { hint: "Library section ID (required)", default: "{{ .MovieSectionId }}" },
      filter:  { options: ["", "unwatched"], hint: "Restrict candidates" },
      type:    { options: ["", "movie", "show"], hint: "Item type (default movie)" },
      sort:    { hint: "Plex sort, e.g. addedAt:desc" },
      limit:   { hint: "Max candidate items" },
    },
  },
  "plex.section": {
    hint: "General listing of a library section; extra filters pass straight through to Plex.",
    extra: true,
    params: {
      section:   { hint: "Library section ID (required)", default: "{{ .MovieSectionId }}" },
      type:      { options: ["", "movie", "show", "season", "episode"], hint: "Item type" },
      sort:      { hint: "Plex sort, e.g. addedAt:desc, random" },
      limit:     { hint: "Max items" },
      unwatched: { options: ["", "true"], hint: "Only unwatched items" },
      random:    { options: ["", "true"], hint: "Shuffle a 200-item pool, then trim to limit" },
      trailers:  { options: ["", "true"], hint: "Also resolve each item's trailer URL" },
    },
  },
  "plex.collections": {
    hint: "The collections in a section (item count exposed as Views).",
    params: {
      section: { hint: "Library section ID (required)", default: "{{ .MovieSectionId }}" },
      sort:    { hint: "Plex sort" },
      limit:   { hint: "Max collections" },
    },
  },
  "plex.watchlist": {
    hint: "Your Plex Discover watchlist, optionally matched against the local library.",
    params: {
      filter:    { options: ["", "all", "available", "released"], hint: "Watchlist filter (default all)" },
      type:      { options: ["", "movie", "show"], hint: "Item type" },
      sort:      { hint: "Discover sort" },
      limit:     { hint: "Max items" },
      inLibrary: { options: ["", "true", "false"], hint: "true: only items in your library · false: only items not in it" },
      trailers:  { options: ["", "true"], hint: "Resolve trailers for library-matched items" },
    },
  },
  "plex.trending": {
    hint: "The trending row from Plex Discover home.",
    params: {
      type:      { options: ["", "movie", "show"], hint: "Item type" },
      limit:     { hint: "Max items" },
      inLibrary: { options: ["", "true", "false"], hint: "true: only items in your library · false: only items not in it" },
      trailers:  { options: ["", "true"], hint: "Resolve trailers for library-matched items" },
    },
  },
};

// Variables the renderer injects into every template string (see
// cmd/plex-pre-rolls/main.go vars map) and the fields each list item exposes.
const TEMPLATE_VARS = ["{{ .Period }}", "{{ .PeriodInterval }}", "{{ .MovieSectionId }}", "{{ .TVShowSectionId }}", "{{ .MaxItems }}"];
const ITEM_FIELDS = ["{{ .Name }}", "{{ .Rank }}", "{{ .Views }}"];
const TEMPLATE_FUNCS = ["upper", "lower", "title", "pluralize", "truncate N"];
```

- [ ] **Step 2: Replace the `renderData` stub in `app.js`**

Delete the `function renderData() {}` stub and add:

```js
function defaultParams(provider) {
  const params = {};
  for (const [key, p] of Object.entries(PROVIDERS[provider].params))
    if (p.default) params[key] = p.default;
  return params;
}

function renderData() {
  const cards = Object.entries(state.data).map(([name, ds]) => dataCard(name, ds)).join("");
  $("#section-data").innerHTML = `
    <h2>Data sources</h2>
    <p class="muted">Named feeds of Plex items. Lists, clip scenes and backgrounds pull from these by name.</p>
    ${cards || `<p class="empty">No data sources yet.</p>`}
    <button class="btn" data-action="add-data">+ Add data source</button>`;
}

function dataCard(name, ds) {
  const meta = PROVIDERS[ds.provider] || { params: {} };
  const rows = Object.entries(meta.params).map(([key, p]) => {
    const path = `data.${name}.params.${key}`;
    const val = ds.params?.[key] ?? "";
    const input = p.options ? select(path, val, p.options) : textInput(path, val, { placeholder: p.default || "" });
    return field(key, input, p.hint);
  }).join("");
  return `<div class="subcard">
    <div class="subcard-head">
      <input type="text" class="name-input" data-rename="data" data-old="${esc(name)}" value="${esc(name)}">
      <button class="btn ghost danger" data-action="remove-data" data-name="${esc(name)}">Remove</button>
    </div>
    ${field("Provider",
      select(`data.${name}.provider`, ds.provider, Object.keys(PROVIDERS),
        { rerender: "provider", attrs: `data-ds="${esc(name)}"` }),
      meta.hint)}
    <div class="grid2">${rows}</div>
    ${meta.extra ? extraParamRows(name, ds, meta) : ""}
  </div>`;
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
    <p class="muted">Passed straight through as query filters, e.g. decade=1990, year>>=2000.</p>
    ${rows}
    <button class="btn ghost" data-action="add-param" data-ds="${esc(name)}">+ Add filter</button>`;
}

actions["add-data"] = () => {
  const name = uniqueKey(state.data, "source");
  state.data[name] = { provider: "plex.top", params: defaultParams("plex.top") };
  renderAll();
};
actions["remove-data"] = (d) => { delete state.data[d.name]; renderAll(); };
actions["add-param"] = (d) => {
  const ds = state.data[d.ds];
  ds.params[uniqueKey(ds.params, "filter")] = "";
  renderData();
};
actions["remove-param"] = (d) => { delete state.data[d.ds].params[d.key]; renderData(); };

// Switching provider resets params to that provider's defaults — stale keys
// would otherwise leak through plex.section's passthrough as bogus filters.
rerenderHooks["provider"] = (dataset) => {
  const ds = state.data[dataset.ds];
  ds.params = defaultParams(ds.provider);
};
```

- [ ] **Step 3: Verify**

Run: `go run ./cmd/preroll-ui &` then in the browser at `localhost:8382`:
- Add a data source → card appears named `source`, provider `plex.top`, section/period/limit prefilled with template defaults; YAML pane shows the `data:` block with those params.
- Switch provider to `plex.section` → params reset to its defaults, "Extra Plex filters" section appears; add a filter `decade` = `1990` → appears under `params:` in the YAML.
- Rename the source (blur the name field) → YAML key renames.
- Scripted check of the contract:
  `curl -s -X POST localhost:8382/api/convert -d '{"name":"x","resolution":"1920x1080","fps":24,"output":"o.mp4","data":{"top":{"provider":"plex.top","params":{"limit":"5"}}},"scenes":[{"kind":"image","file":"a.png","duration":3}]}' | grep -o 'plex.top'` → `plex.top`.

Kill the server.

- [ ] **Step 4: Commit**

```bash
git add internal/webui/static/
git commit -m "webui: provider metadata and data sources editor"
```

---

### Task 6: Layouts editor

**Model:** Opus — the most intricate form (nested elements, two element types, template hints); sets the pattern Task 7 copies.

**Files:**
- Modify: `internal/webui/static/app.js` (replace `renderLayouts` stub; register actions)

**Interfaces:**
- Consumes: helpers from Task 4; `Object.keys(state.data)` and `TEMPLATE_VARS`/`ITEM_FIELDS`/`TEMPLATE_FUNCS` from Task 5.
- Produces: working `renderLayouts()`; state shape `state.layouts[name] = { background: {color, image}, font, elements: [...] }` — Task 7 reads `Object.keys(state.layouts)` for layout/label dropdowns.

- [ ] **Step 1: Replace the `renderLayouts` stub**

```js
function renderLayouts() {
  const cards = Object.entries(state.layouts).map(([name, l]) => layoutCard(name, l)).join("");
  $("#section-layouts").innerHTML = `
    <h2>Layouts</h2>
    <p class="muted">Reusable rendered frames: a background plus text and list elements. Render scenes draw one; clip scenes can overlay one as a per-item label.</p>
    ${cards || `<p class="empty">No layouts yet.</p>`}
    <button class="btn" data-action="add-layout">+ Add layout</button>`;
}

function layoutCard(name, l) {
  const base = `layouts.${name}`;
  const els = (l.elements || []).map((el, i) => elementCard(name, el, i)).join("");
  return `<div class="subcard">
    <div class="subcard-head">
      <input type="text" class="name-input" data-rename="layouts" data-old="${esc(name)}" value="${esc(name)}">
      <button class="btn ghost danger" data-action="remove-layout" data-name="${esc(name)}">Remove</button>
    </div>
    <div class="grid2">
      ${field("Font file", textInput(`${base}.font`, l.font, { placeholder: "media/common/MyFont.ttf" }))}
      ${field("Background color", textInput(`${base}.background.color`, l.background?.color, { placeholder: "black, #101010, none" }),
        `Use "none" for transparent — required for clip labels and scenes with a dynamic background`)}
      ${field("Background image", textInput(`${base}.background.image`, l.background?.image, { placeholder: "media/common/bg.png" }),
        "Wins over color when set")}
    </div>
    <h3>Elements</h3>
    ${els || `<p class="empty">No elements — a layout needs at least one.</p>`}
    <button class="btn ghost" data-action="add-element" data-layout="${esc(name)}" data-kind="text">+ Text</button>
    <button class="btn ghost" data-action="add-element" data-layout="${esc(name)}" data-kind="list">+ List</button>
  </div>`;
}

function templateChips(items) {
  return `<div class="chips">${items.map((c) => `<code>${esc(c)}</code>`).join("")}</div>`;
}

function elementCard(layoutName, el, i) {
  const base = `layouts.${layoutName}.elements.${i}`;
  const head = `<div class="subcard-head">
    <strong>${esc(el.type)}</strong><span class="spacer"></span>
    <button class="btn ghost danger" data-action="remove-element" data-layout="${esc(layoutName)}" data-index="${i}">×</button>
  </div>`;
  if (el.type === "list") {
    return `<div class="subcard">${head}
      <div class="grid2">
        ${field("Data source", select(`${base}.source`, el.source, Object.keys(state.data)), "Which feed this list iterates")}
        ${field("Item template", textInput(`${base}.item`, el.item, { placeholder: "{{ .Rank }}. {{ .Name }}" }))}
        ${field("X", numInput(`${base}.x`, el.x))}
        ${field("First row Y", numInput(`${base}.startY`, el.startY))}
        ${field("Row spacing", numInput(`${base}.stepY`, el.stepY))}
        ${field("Font size", numInput(`${base}.size`, el.size))}
        ${field("Color", textInput(`${base}.color`, el.color, { placeholder: "white" }))}
        ${field("Align", select(`${base}.align`, el.align ?? "", ["", "left", "center", "right"], { emptyLabel: "left (default)" }))}
      </div>
      ${templateChips([...ITEM_FIELDS, ...TEMPLATE_FUNCS.map((f) => `{{ ${f} ... }}`)])}
    </div>`;
  }
  return `<div class="subcard">${head}
    <div class="grid2">
      ${field("Text", `<textarea data-path="${esc(base)}.text">${esc(el.text)}</textarea>`,
        "Newlines stack; templates like {{ upper .Period }} work here")}
      ${field("Color", textInput(`${base}.color`, el.color, { placeholder: "white" }))}
      ${field("X", numInput(`${base}.x`, el.x))}
      ${field("Y", numInput(`${base}.y`, el.y))}
      ${field("Font size", numInput(`${base}.size`, el.size))}
      ${field("Align", select(`${base}.align`, el.align ?? "", ["", "left", "center", "right"], { emptyLabel: "left (default)" }))}
      ${field("Line height", numInput(`${base}.lineHeight`, el.lineHeight ?? 0), "0 = single line")}
    </div>
    ${templateChips(TEMPLATE_VARS)}
  </div>`;
}

actions["add-layout"] = () => {
  const name = uniqueKey(state.layouts, "layout");
  state.layouts[name] = {
    background: { color: "black", image: "" },
    font: "",
    elements: [{ type: "text", text: "Title", x: 96, y: 150, size: 96, color: "white" }],
  };
  renderAll();
};
actions["remove-layout"] = (d) => { delete state.layouts[d.name]; renderAll(); };
actions["add-element"] = (d) => {
  const els = state.layouts[d.layout].elements;
  els.push(d.kind === "list"
    ? { type: "list", source: Object.keys(state.data)[0] || "", item: "{{ .Rank }}. {{ .Name }}",
        x: 96, startY: 320, stepY: 96, size: 56, color: "white" }
    : { type: "text", text: "Text", x: 96, y: 150, size: 64, color: "white" });
  renderLayouts();
};
actions["remove-element"] = (d) => {
  state.layouts[d.layout].elements.splice(+d.index, 1);
  renderLayouts();
};
```

- [ ] **Step 2: Verify**

Run: `go run ./cmd/preroll-ui &`, browser at `localhost:8382`:
- Add a data source, then a layout → card with a starter title element; YAML shows `layouts:` with the element.
- Add a list element → source dropdown offers the data source; YAML shows `type: list` with `startY`/`stepY`/`item`.
- Rename the data source → the list element's `source:` in the YAML follows (retargeting).
- Add a second layout, remove it; remove an element — YAML tracks each change.
- Scripted contract check:
  `curl -s -X POST localhost:8382/api/convert -d '{"name":"x","resolution":"1920x1080","fps":24,"output":"o.mp4","data":{"top":{"provider":"plex.top","params":{}}},"layouts":{"main":{"background":{"color":"black","image":""},"font":"","elements":[{"type":"list","source":"top","item":"{{ .Name }}","x":96,"startY":320,"stepY":96,"size":56,"color":"white"}]}},"scenes":[{"kind":"render","layout":"main","duration":5}]}' | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["errors"]==[], d["errors"]; assert "startY: 320" in d["yaml"]; print("ok")'` → `ok`.

Kill the server.

- [ ] **Step 3: Commit**

```bash
git add internal/webui/static/app.js
git commit -m "webui: layouts editor with text and list elements"
```

---

### Task 7: Scenes editor (timeline)

**Model:** Sonnet — clones the card pattern from Tasks 5–6 against an exact field spec.

**Files:**
- Modify: `internal/webui/static/app.js` (replace `renderScenes` stub; register actions and the `scene-kind` rerender hook)

**Interfaces:**
- Consumes: helpers from Task 4; `Object.keys(state.data)` / `Object.keys(state.layouts)` for dropdowns.
- Produces: working `renderScenes()`; state shape `state.scenes[i]` per kind as below. Do NOT render a control for `transition` (dead DSL field — see Global Constraints).

- [ ] **Step 1: Replace the `renderScenes` stub**

```js
function sceneDefaults(kind) {
  const first = (map) => Object.keys(map)[0] || "";
  return {
    image:  { kind: "image", file: "", duration: 4 },
    render: { kind: "render", layout: first(state.layouts), duration: 6, vars: {}, background: null },
    clips:  { kind: "clips", source: first(state.data), perClip: 4, label: "" },
  }[kind];
}

function renderScenes() {
  const cards = state.scenes.map((sc, i) => sceneCard(sc, i)).join("");
  $("#section-scenes").innerHTML = `
    <h2>Scenes</h2>
    <p class="muted">The timeline — played top to bottom.</p>
    ${cards || `<p class="empty">No scenes yet — a pre-roll needs at least one.</p>`}
    <button class="btn" data-action="add-scene" data-kind="render">+ Rendered frame</button>
    <button class="btn ghost" data-action="add-scene" data-kind="clips">+ Clip montage</button>
    <button class="btn ghost" data-action="add-scene" data-kind="image">+ Still image</button>`;
}

function sceneCard(sc, i) {
  const base = `scenes.${i}`;
  const head = `<div class="subcard-head">
    <strong>#${i + 1}</strong>
    ${select(`${base}.kind`, sc.kind, ["image", "render", "clips"],
      { rerender: "scene-kind", attrs: `data-index="${i}"` })}
    <span class="spacer"></span>
    <button class="btn ghost" data-action="move-scene" data-index="${i}" data-dir="-1">↑</button>
    <button class="btn ghost" data-action="move-scene" data-index="${i}" data-dir="1">↓</button>
    <button class="btn ghost danger" data-action="remove-scene" data-index="${i}">×</button>
  </div>`;
  return `<div class="subcard">${head}${sceneFields(sc, i, base)}</div>`;
}

function sceneFields(sc, i, base) {
  if (sc.kind === "image") {
    return `<div class="grid2">
      ${field("Image file", textInput(`${base}.file`, sc.file, { placeholder: "media/common/intro.png" }))}
      ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}
    </div>`;
  }
  if (sc.kind === "clips") {
    return `<div class="grid2">
      ${field("Data source", select(`${base}.source`, sc.source, Object.keys(state.data)),
        "Items need trailer/media URLs — e.g. plex.trailers, or trailers: true")}
      ${field("Seconds per clip", numInput(`${base}.perClip`, sc.perClip, { min: 0 }))}
      ${field("Label layout", select(`${base}.label`, sc.label ?? "", ["", ...Object.keys(state.layouts)], { emptyLabel: "(no label)" }),
        "Overlaid per clip with that item's Name/Rank in scope — use a transparent background")}
    </div>`;
  }
  // render
  const bg = sc.background;
  return `<div class="grid2">
      ${field("Layout", select(`${base}.layout`, sc.layout, Object.keys(state.layouts)))}
      ${field("Duration (s)", numInput(`${base}.duration`, sc.duration, { min: 0 }))}
    </div>
    ${varRows(sc, i, base)}
    <label class="check"><input type="checkbox" data-action-toggle="scene-bg" data-index="${i}"${bg ? " checked" : ""}> Dynamic background</label>
    ${bg ? `<div class="grid2">
      ${field("Source", select(`${base}.background.source`, bg.source, Object.keys(state.data)))}
      ${field("Mode", select(`${base}.background.mode`, bg.mode, ["art", "poster", "trailers"]),
        "art/poster: still images · trailers: muted video montage")}
      ${field("Tile", select(`${base}.background.tile`, bg.tile ?? "", ["", "cover", "grid", "sequence"], { emptyLabel: "cover (default)" }),
        "grid: up to 4 items 2×2 · sequence: trailers back to back")}
      ${field("Dim", `<input type="range" data-path="${esc(base)}.background.dim" data-type="number" min="0" max="1" step="0.05" value="${bg.dim ?? 0}">`,
        "0 = untouched, 1 = black — keeps overlaid text legible")}
      ${field("Item limit", numInput(`${base}.background.limit`, bg.limit ?? 0, { int: true, min: 0 }), "0 = all")}
    </div>` : ""}`;
}

// Vars feed extra template variables into the scene's layout, so one layout
// serves many scenes with different text.
function varRows(sc, i, base) {
  const vars = sc.vars || {};
  const rows = Object.entries(vars).map(([k, v]) => `<div class="kv">
    <input type="text" data-rename="${esc(base)}.vars" data-old="${esc(k)}" value="${esc(k)}">
    <input type="text" data-path="${esc(base)}.vars.${esc(k)}" value="${esc(v)}">
    <button class="btn ghost danger" data-action="remove-var" data-index="${i}" data-key="${esc(k)}">×</button>
  </div>`).join("");
  return `<h3>Template variables</h3>${rows}
    <button class="btn ghost" data-action="add-var" data-index="${i}">+ Add variable</button>`;
}

actions["add-scene"] = (d) => { state.scenes.push(sceneDefaults(d.kind)); renderScenes(); };
actions["remove-scene"] = (d) => { state.scenes.splice(+d.index, 1); renderScenes(); };
actions["move-scene"] = (d) => {
  const i = +d.index, j = i + +d.dir;
  if (j < 0 || j >= state.scenes.length) return;
  [state.scenes[i], state.scenes[j]] = [state.scenes[j], state.scenes[i]];
  renderScenes();
};
actions["add-var"] = (d) => {
  const sc = state.scenes[+d.index];
  sc.vars = sc.vars || {};
  sc.vars[uniqueKey(sc.vars, "Var")] = "";
  renderScenes();
};
actions["remove-var"] = (d) => { delete state.scenes[+d.index].vars[d.key]; renderScenes(); };

// Changing kind swaps the scene for that kind's defaults — stale fields from
// the old kind (file on a render scene, layout on clips) must not linger.
rerenderHooks["scene-kind"] = (dataset) => {
  state.scenes[+dataset.index] = sceneDefaults(state.scenes[+dataset.index].kind);
};
```

Also add the background-toggle wiring to the delegated `change` listener in `app.js` (extend the existing handler; checkboxes fire `change`, not `input`):

```js
  if (t.dataset.actionToggle === "scene-bg") {
    const sc = state.scenes[+t.dataset.index];
    sc.background = t.checked
      ? { source: Object.keys(state.data)[0] || "", mode: "art", tile: "", dim: 0.35, limit: 0 }
      : null;
    renderScenes();
    scheduleConvert();
    return;
  }
```

(Place it at the top of the `change` handler, before the rename/rerender branches.)

- [ ] **Step 2: Verify**

Run: `go run ./cmd/preroll-ui &`, browser:
- Build a full manifest: data source → layout → rendered scene. Error pane goes empty; YAML matches the shape of `manifests/top-movies-trailer-wall.yaml`.
- Toggle "Dynamic background" → sub-form appears; set mode `trailers`, tile `grid`, dim `0.35` → YAML `background: {source, mode: trailers, tile: grid, dim: 0.35}`.
- Add a clips scene, reorder with ↑/↓ → YAML scene order follows.
- Switch a scene's kind → fields swap wholesale, no stale keys in YAML.
- Scripted contract check (full three-scene manifest through convert):
  `curl -s -X POST localhost:8382/api/convert -d '{"name":"x","resolution":"1920x1080","fps":24,"output":"o.mp4","data":{"top":{"provider":"plex.top","params":{}}},"layouts":{"main":{"background":{"color":"none"},"elements":[{"type":"text","text":"Hi","x":96,"y":150,"size":96,"color":"white"}]}},"scenes":[{"kind":"image","file":"a.png","duration":3},{"kind":"render","layout":"main","duration":6,"vars":{},"background":{"source":"top","mode":"trailers","tile":"grid","dim":0.35,"limit":0}},{"kind":"clips","source":"top","perClip":4,"label":""}]}' | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["errors"]==[], d["errors"]; print("ok")'` → `ok`.

Kill the server.

- [ ] **Step 3: Commit**

```bash
git add internal/webui/static/app.js
git commit -m "webui: scenes timeline editor with dynamic backgrounds and vars"
```

---

### Task 8: Manifest browser — load, save, delete

**Model:** Sonnet — straightforward fetch wiring against the tested API.

**Files:**
- Modify: `internal/webui/static/app.js` (replace `renderToolbar` stub)

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/manifests[...]` from Task 2; `state`, `emptyManifest`, `renderAll`, `convert`, `flash` from Task 4.
- Produces: working `renderToolbar()`; `normalize(m)` that fills structural gaps in server JSON (omitted-empty fields) so renderers never see `undefined` containers.

- [ ] **Step 1: Replace the `renderToolbar` stub**

```js
async function renderToolbar() {
  let names = [];
  try {
    names = await (await fetch("/api/manifests")).json();
  } catch { /* server list is a convenience; the editor still works */ }
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
    state = emptyManifest();
    $("#manifest-picker").value = "";
    renderAll();
    convert();
  };
  $("#btn-save").onclick = saveManifest;
  $("#btn-delete").onclick = deleteManifest;
}

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

async function loadManifest(name) {
  const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`);
  if (!res.ok) {
    flash(`Could not load ${name}: ${await res.text()}`, true);
    return;
  }
  state = normalize(await res.json());
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
  const res = await fetch(`/api/manifests/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    flash(`Not saved: ${await res.text()}`, true);
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
  const res = await fetch(`/api/manifests/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) {
    flash(`Not deleted: ${await res.text()}`, true);
    return;
  }
  flash(`Deleted ${name}`);
  state = emptyManifest();
  renderAll();
  convert();
  renderToolbar();
}
```

- [ ] **Step 2: Verify against a scratch manifest dir**

Run: `cp -r manifests /tmp/ui-manifests && MANIFEST_DIR=/tmp/ui-manifests go run ./cmd/preroll-ui &` (scratch copy — the repo's manifests stay untouched), then in the browser:
- Picker lists every repo manifest. Open `top-movies-trailer-wall.yaml` → all sections populate (audio + fade, data source with params, layout with text + list elements, render scene with trailers background) and the error pane is empty.
- Change the name to `ui-test`, Save → flash confirms, picker now contains `ui-test.yaml`; `cat /tmp/ui-manifests/ui-test.yaml` is clean YAML.
- Confirm the round trip end-to-end: `go run ./cmd/... ` is not needed — instead run `go test ./internal/manifest/` plus `python3 - <<'EOF'` … or simplest: `curl -s localhost:8382/api/manifests/ui-test.yaml | curl -s -X POST localhost:8382/api/convert -d @- | python3 -c 'import json,sys; assert json.load(sys.stdin)["errors"]==[]; print("ok")'` → `ok`.
- Delete `ui-test.yaml` → file gone, editor resets.

Kill the server.

- [ ] **Step 3: Commit**

```bash
git add internal/webui/static/app.js
git commit -m "webui: open/save/delete manifests from the toolbar"
```

---

### Task 9: Documentation + final QA sweep

**Model:** Sonnet.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Config UI section to README.md**

Place it after the existing setup/usage docs (adapt heading level to the file's structure):

```markdown
## Config UI

A browser-based editor for building manifests without hand-writing YAML.

```bash
docker compose up -d preroll-ui   # http://localhost:8382
# or locally (pure Go, no ImageMagick needed):
go run ./cmd/preroll-ui -manifest-dir manifests
```

The editor covers the whole DSL — data sources (with per-provider parameter
hints), layouts, the scene timeline, and audio — and shows the generated YAML
live with validation errors as you type. **Save** writes the manifest into the
manifest directory, so the next render run (`docker compose run plex-pre-roll`
with `MANIFEST_DIR` set) picks it up. Saves are strict: an invalid manifest is
refused rather than written.

The UI has no auth — it can read, write and delete files in `MANIFEST_DIR`.
Keep it on your LAN; don't expose port 8382 to the internet.
```

- [ ] **Step 2: Full-suite check**

Run: `go test ./internal/... && CGO_ENABLED=0 go build ./cmd/preroll-ui && gofmt -l internal/webui cmd/preroll-ui`
Expected: tests pass, build clean, `gofmt` prints nothing.

- [ ] **Step 3: Manual QA checklist (run in the browser, fix anything that fails before committing)**

Start: `cp -r manifests /tmp/ui-qa && MANIFEST_DIR=/tmp/ui-qa go run ./cmd/preroll-ui`

1. Open every one of the 13 repo manifests via the picker — each must load with an empty error pane (they're all valid).
2. From "New", build the trailer-wall manifest from scratch (data source `plex.top` + trailers, layout with title + list, one render scene with trailers/grid background, audio with fade) — diff the YAML pane against `manifests/top-movies-trailer-wall.yaml`; keys and values must match (map ordering may differ).
3. Rename a data source used by a scene background, a list element, and a clips scene — all three references must follow.
4. Save with an empty name → friendly flash, no request. Save with a name containing a space → server 400 surfaces in the flash.
5. Narrow the window below 980px — the preview drops below the editor, nothing overflows.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: config UI usage"
```

---

## Deliberately out of scope (add later if wanted)

- **Render/preview button** — rendering needs the ImageMagick/ffmpeg toolchain and minutes of wall time; the existing `docker compose run plex-pre-roll` flow already covers it. Add a render-trigger endpoint only if round-tripping to the terminal proves annoying.
- **`transition` field** — declared in the DSL, consumed nowhere in the engine. Wire the engine first, then the UI.
- **Media/font file pickers** — the server could enumerate a media dir for dropdowns; plain text paths with placeholders are fine until then.
- **Draft saves** — saves are valid-only because `MANIFEST_DIR` is a render input. If drafts are wanted, add a separate drafts dir, not a validity bypass.
- **Auth** — the UI is LAN-only by assumption (documented in README). Add basic auth before ever exposing it.
