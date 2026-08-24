package configmanager

import (
	"fmt"
	"strings"

	"github.com/kelseyhightower/envconfig"
)

const envVarPrefix = ""

type Secret string

func (s Secret) String() string {
	return "****"
}

type Period string

const (
	PeriodDay   Period = "DAY"
	PeriodWeek  Period = "WEEK"
	PeriodMonth Period = "MONTH"
	PeriodYear  Period = "YEAR"
)

func (period Period) IsValid() bool {
	switch period {
	case PeriodDay, PeriodWeek, PeriodMonth, PeriodYear:
		return true
	default:
		return false
	}
}

func (period Period) ToInt() int {
	switch period {
	case PeriodDay:
		return 1
	case PeriodWeek:
		return 7
	case PeriodMonth:
		return 30
	case PeriodYear:
		return 365
	default:
		return 0
	}
}

func (period Period) ToString() string {
	switch period {
	case PeriodDay:
		return "Day"
	case PeriodWeek:
		return "Week"
	case PeriodMonth:
		return "Month"
	case PeriodYear:
		return "Year"
	default:
		return "All Time"
	}
}

type PrerollMode string

const (
	PrerollRandom   PrerollMode = "random"
	PrerollSequence PrerollMode = "sequence"
)

// Separator maps the mode to Plex's pre-roll list syntax: "," plays one entry
// at random per play, ";" plays entries in sequence.
func (mode PrerollMode) Separator() (string, error) {
	switch PrerollMode(strings.ToLower(string(mode))) {
	case PrerollRandom:
		return ",", nil
	case PrerollSequence:
		return ";", nil
	default:
		return "", fmt.Errorf("invalid PLEX_PREROLL_MODE %q (want %q or %q)", mode, PrerollRandom, PrerollSequence)
	}
}

type Config struct {
	PlexURL         string `envconfig:"PLEX_URL" required:"true"`
	PlexToken       Secret `envconfig:"PLEX_TOKEN" required:"true"`
	MaxItems        int    `envconfig:"MAX_ITEMS" required:"true"`
	PeriodInterval  Period `envconfig:"PERIOD_INTERVAL" required:"true"`
	MovieSectionId  string `envconfig:"MOVIE_SECTION_ID" required:"true"`
	TVShowSectionId string `envconfig:"TV_SHOW_SECTION_ID" required:"true"`
	Debug           bool   `envconfig:"DEBUG" default:"false"`
	// PlexInsecure skips TLS certificate verification. Plex serves a
	// *.plex.direct cert with no IP SAN, so connecting to a bare IP over HTTPS
	// fails verification. Enable only on a trusted network.
	PlexInsecure bool `envconfig:"PLEX_INSECURE" default:"false"`
	// SetPreroll appends rendered outputs to the server's pre-roll preference
	// (CinemaTrailersPrerollID) after a fully successful run. Requires
	// PrerollServerDir and a token belonging to the server owner.
	SetPreroll bool `envconfig:"PLEX_SET_PREROLL" default:"false"`
	// PrerollServerDir is the output directory as the Plex server process
	// sees it (e.g. the mount of pre-roll-output/ inside the Plex container).
	PrerollServerDir string `envconfig:"PLEX_PREROLL_SERVER_DIR" default:""`
	// PrerollMode picks the list separator when the preference starts empty:
	// "random" (comma) or "sequence" (semicolon). An existing preference keeps
	// its separator.
	PrerollMode PrerollMode `envconfig:"PLEX_PREROLL_MODE" default:"random"`
}

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
