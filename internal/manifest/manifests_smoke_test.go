package manifest

import (
	"path/filepath"
	"testing"
)

// TestShippedManifestsAreValid parses and validates every manifest that ships
// with the repo (the named manifests plus the embedded default) so a broken
// example fails CI rather than at runtime in the container.
func TestShippedManifestsAreValid(t *testing.T) {
	globs := []string{
		"../../manifests/*.yaml",
		"../../cmd/plex-pre-rolls/default-manifest.yaml",
	}
	var paths []string
	for _, g := range globs {
		matches, err := filepath.Glob(g)
		if err != nil {
			t.Fatalf("glob %q: %v", g, err)
		}
		paths = append(paths, matches...)
	}
	if len(paths) == 0 {
		t.Fatal("no manifests found to validate")
	}
	for _, p := range paths {
		p := p
		t.Run(filepath.Base(p), func(t *testing.T) {
			if _, err := Load(p); err != nil {
				t.Errorf("%s: %v", p, err)
			}
		})
	}
}
