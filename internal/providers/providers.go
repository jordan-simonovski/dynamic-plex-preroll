// Package providers defines the data-source abstraction for the pre-roll DSL.
// A Provider turns a manifest data source's parameters into a list of content
// items; providers are registered by name (e.g. "plex.top") and referenced
// from the manifest. Extensibility lives here: add a provider, write a
// manifest, no engine changes required.
package providers

import (
	"context"
	"fmt"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/content"
)

// Provider resolves a named data source into content items.
type Provider interface {
	Fetch(ctx context.Context, params map[string]string) (content.Items, error)
}

// Registry maps provider names to implementations.
type Registry struct {
	byName map[string]Provider
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{byName: make(map[string]Provider)}
}

// Register adds a provider under name, overwriting any existing entry.
func (r *Registry) Register(name string, p Provider) {
	r.byName[name] = p
}

// Has reports whether a provider is registered.
func (r *Registry) Has(name string) bool {
	_, ok := r.byName[name]
	return ok
}

// Fetch resolves the named provider and runs it.
func (r *Registry) Fetch(ctx context.Context, name string, params map[string]string) (content.Items, error) {
	p, ok := r.byName[name]
	if !ok {
		return nil, fmt.Errorf("providers: unknown provider %q", name)
	}
	return p.Fetch(ctx, params)
}
