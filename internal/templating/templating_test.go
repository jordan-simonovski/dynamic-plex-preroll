package templating

import (
	"strings"
	"testing"
)

func TestRenderBasic(t *testing.T) {
	out, err := Render("Top Stuff of the {{ .Period }}", map[string]any{"Period": "Month"})
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if out != "Top Stuff of the Month" {
		t.Errorf("got %q", out)
	}
}

func TestRenderFuncs(t *testing.T) {
	cases := []struct {
		tmpl string
		ctx  any
		want string
	}{
		{`{{ pluralize .N "view" "views" }}`, map[string]any{"N": 1}, "view"},
		{`{{ pluralize .N "view" "views" }}`, map[string]any{"N": 3}, "views"},
		{`{{ upper .S }}`, map[string]any{"S": "hi"}, "HI"},
		{`{{ lower .S }}`, map[string]any{"S": "HI"}, "hi"},
		{`{{ title .S }}`, map[string]any{"S": "the wire"}, "The Wire"},
		{`{{ truncate 5 .S }}`, map[string]any{"S": "abcdefgh"}, "abcd\u2026"},
		{`{{ truncate 5 .S }}`, map[string]any{"S": "abc"}, "abc"},
	}
	for _, c := range cases {
		got, err := Render(c.tmpl, c.ctx)
		if err != nil {
			t.Errorf("Render(%q) error: %v", c.tmpl, err)
			continue
		}
		if got != c.want {
			t.Errorf("Render(%q) = %q, want %q", c.tmpl, got, c.want)
		}
	}
}

func TestRenderMissingKeyIsError(t *testing.T) {
	if _, err := Render("{{ .Nope }}", map[string]any{}); err == nil {
		t.Fatal("expected error on missing key, got nil")
	}
}

func TestRenderListItem(t *testing.T) {
	item := map[string]any{"Rank": 2, "Name": "Heat", "Views": 1}
	out, err := Render(`{{ .Rank }}. {{ .Name }} - {{ .Views }} {{ pluralize .Views "view" "views" }}`, item)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if out != "2. Heat - 1 view" {
		t.Errorf("got %q", out)
	}
}

func TestRenderParams(t *testing.T) {
	params := map[string]string{"section": "{{ .Section }}", "limit": "5"}
	out, err := RenderParams(params, map[string]any{"Section": "1"})
	if err != nil {
		t.Fatalf("RenderParams error: %v", err)
	}
	if out["section"] != "1" || out["limit"] != "5" {
		t.Errorf("got %v", out)
	}
}

func TestRenderParamsNil(t *testing.T) {
	out, err := RenderParams(nil, nil)
	if err != nil || out != nil {
		t.Errorf("RenderParams(nil) = %v, %v", out, err)
	}
}

func TestRenderParamsPropagatesError(t *testing.T) {
	_, err := RenderParams(map[string]string{"x": "{{ .Missing }}"}, map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "x") {
		t.Errorf("expected param-scoped error, got %v", err)
	}
}
