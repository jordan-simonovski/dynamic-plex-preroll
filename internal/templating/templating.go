// Package templating renders the Go text/template strings embedded in a
// manifest against a resolved data context. A single shared FuncMap keeps the
// helpers available to layouts, list items, and data-source parameters.
package templating

import (
	"fmt"
	"strings"
	"text/template"
	"unicode"
)

// FuncMap returns the helpers exposed to every template in a manifest.
func FuncMap() template.FuncMap {
	return template.FuncMap{
		"pluralize": pluralize,
		"upper":     strings.ToUpper,
		"lower":     strings.ToLower,
		"title":     titleCase,
		"truncate":  truncate,
	}
}

// Render compiles and executes a single template string against ctx. Missing
// map keys are an error so broken templates fail loudly instead of emitting
// "<no value>".
func Render(text string, ctx any) (string, error) {
	tmpl, err := template.New("manifest").
		Funcs(FuncMap()).
		Option("missingkey=error").
		Parse(text)
	if err != nil {
		return "", fmt.Errorf("parse template %q: %w", text, err)
	}

	var out strings.Builder
	if err := tmpl.Execute(&out, ctx); err != nil {
		return "", fmt.Errorf("execute template %q: %w", text, err)
	}
	return out.String(), nil
}

// RenderParams renders every value in a parameter map, returning a new map.
func RenderParams(params map[string]string, ctx any) (map[string]string, error) {
	if params == nil {
		return nil, nil
	}
	out := make(map[string]string, len(params))
	for key, value := range params {
		rendered, err := Render(value, ctx)
		if err != nil {
			return nil, fmt.Errorf("param %q: %w", key, err)
		}
		out[key] = rendered
	}
	return out, nil
}

// titleCase upper-cases the first letter of each whitespace-separated word.
func titleCase(s string) string {
	prevSpace := true
	return strings.Map(func(r rune) rune {
		if prevSpace && unicode.IsLetter(r) {
			prevSpace = false
			return unicode.ToUpper(r)
		}
		prevSpace = unicode.IsSpace(r)
		return r
	}, s)
}

// pluralize picks singular or plural based on n.
func pluralize(n int, singular, plural string) string {
	if n == 1 {
		return singular
	}
	return plural
}

// truncate shortens s to at most max runes, appending an ellipsis when cut.
func truncate(max int, s string) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 1 {
		return string(runes[:max])
	}
	return string(runes[:max-1]) + "\u2026"
}
