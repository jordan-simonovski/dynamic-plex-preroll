package configmanager

import "testing"

func TestPeriodIsValid(t *testing.T) {
	valid := []Period{PeriodDay, PeriodWeek, PeriodMonth, PeriodYear}
	for _, p := range valid {
		if !p.IsValid() {
			t.Errorf("Period %q: IsValid() = false, want true", p)
		}
	}

	for _, p := range []Period{"", "day", "DECADE", "0"} {
		if p.IsValid() {
			t.Errorf("Period %q: IsValid() = true, want false", p)
		}
	}
}

func TestPeriodToInt(t *testing.T) {
	cases := map[Period]int{
		PeriodDay:   1,
		PeriodWeek:  7,
		PeriodMonth: 30,
		PeriodYear:  365,
		"":          0,
		"garbage":   0,
	}
	for p, want := range cases {
		if got := p.ToInt(); got != want {
			t.Errorf("Period %q: ToInt() = %d, want %d", p, got, want)
		}
	}
}

func TestPeriodToString(t *testing.T) {
	cases := map[Period]string{
		PeriodDay:   "Day",
		PeriodWeek:  "Week",
		PeriodMonth: "Month",
		PeriodYear:  "Year",
		"":          "All Time",
		"garbage":   "All Time",
	}
	for p, want := range cases {
		if got := p.ToString(); got != want {
			t.Errorf("Period %q: ToString() = %q, want %q", p, got, want)
		}
	}
}

func TestSecretStringHidesValue(t *testing.T) {
	s := Secret("super-secret-token")
	if got := s.String(); got != "****" {
		t.Errorf("Secret.String() = %q, want %q (token must not leak)", got, "****")
	}
}

func TestMustReadConfig(t *testing.T) {
	t.Setenv("PLEX_URL", "http://localhost:32400")
	t.Setenv("PLEX_TOKEN", "token")
	t.Setenv("MAX_ITEMS", "5")
	t.Setenv("PERIOD_INTERVAL", "MONTH")
	t.Setenv("MOVIE_SECTION_ID", "1")
	t.Setenv("TV_SHOW_SECTION_ID", "2")

	conf := MustReadConfig()

	if conf.PlexURL != "http://localhost:32400" {
		t.Errorf("PlexURL = %q", conf.PlexURL)
	}
	if conf.MaxItems != 5 {
		t.Errorf("MaxItems = %d, want 5", conf.MaxItems)
	}
	if conf.PeriodInterval != PeriodMonth {
		t.Errorf("PeriodInterval = %q, want %q", conf.PeriodInterval, PeriodMonth)
	}
}
