package content

import "testing"

func TestItemLabel(t *testing.T) {
	cases := []struct {
		name string
		item Item
		rank int
		want string
	}{
		{"plural views", Item{Name: "The Wire", Views: 3}, 1, "1. The Wire - 3 views"},
		{"singular view", Item{Name: "Heat", Views: 1}, 2, "2. Heat - 1 view"},
		{"zero views is plural", Item{Name: "Obscure Film", Views: 0}, 5, "5. Obscure Film - 0 views"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.item.Label(tc.rank); got != tc.want {
				t.Errorf("Label(%d) = %q, want %q", tc.rank, got, tc.want)
			}
		})
	}
}
