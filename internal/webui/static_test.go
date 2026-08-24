package webui

import (
	"io/fs"
	"regexp"
	"strings"
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
		if strings.HasSuffix(m[1], ".test.js") {
			t.Errorf("index.html must not load the Node test file %q", m[1])
		}
	}
}
