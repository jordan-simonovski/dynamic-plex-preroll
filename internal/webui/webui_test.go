package webui

import (
	"encoding/json"
	"io"
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
	// A sentinel manifest sits beside ManifestDir: a working traversal would
	// read or overwrite it, so its content is the real assertion.
	parent := t.TempDir()
	outside := filepath.Join(parent, "escape.yaml")
	if err := os.WriteFile(outside, []byte("name: sentinel\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(parent, "manifests")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer((&Server{ManifestDir: dir}).Handler())
	t.Cleanup(ts.Close)

	// 400 = our name check; 404 = the mux refusing an encoded slash. Either
	// way the request must never reach the filesystem with a bad name.
	names := []string{
		"..%2Fescape.yaml", "no-extension", ".hidden.yaml", "sub%2Fdir.yaml",
		"..%252Fescape.yaml", "%2e%2e%2fescape.yaml",
	}
	for _, name := range names {
		for _, method := range []string{"GET", "PUT", "DELETE"} {
			res := do(t, method, ts.URL+"/api/manifests/"+name, validJSON)
			if res.StatusCode != 400 && res.StatusCode != 404 {
				t.Errorf("%s %q: want 400 or 404, got %d", method, name, res.StatusCode)
			}
			body, _ := io.ReadAll(res.Body)
			if strings.Contains(string(body), "sentinel") {
				t.Errorf("%s %q: leaked a file outside ManifestDir", method, name)
			}
		}
	}

	// The sentinel is untouched: not deleted, not overwritten.
	raw, err := os.ReadFile(outside)
	if err != nil {
		t.Fatalf("sentinel gone: %v", err)
	}
	if string(raw) != "name: sentinel\n" {
		t.Fatalf("sentinel overwritten:\n%s", raw)
	}
	// Nothing was created inside ManifestDir either.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("bad names created files: %v", entries)
	}
}

func TestGetMissing404(t *testing.T) {
	ts, _ := newTestServer(t)
	if res := do(t, "GET", ts.URL+"/api/manifests/nope.yaml", ""); res.StatusCode != 404 {
		t.Fatalf("want 404, got %d", res.StatusCode)
	}
}

func TestGetUnparseable422(t *testing.T) {
	ts, dir := newTestServer(t)
	// Not malformed YAML syntax, but a field the Preroll struct doesn't
	// declare: with KnownFields(true) that's just as fatal to Decode, and
	// makes the test's intent (schema mismatch, not a syntax slip) obvious.
	bad := "name: t\nbogus_field: true\n"
	if err := os.WriteFile(filepath.Join(dir, "bad.yaml"), []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	res := do(t, "GET", ts.URL+"/api/manifests/bad.yaml", "")
	if res.StatusCode != 422 {
		t.Fatalf("want 422, got %d", res.StatusCode)
	}
}

func TestDeleteMissing404(t *testing.T) {
	ts, _ := newTestServer(t)
	if res := do(t, "DELETE", ts.URL+"/api/manifests/nope.yaml", ""); res.StatusCode != 404 {
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
