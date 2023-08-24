package configmanager

import (
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

type Config struct {
	PlexURL         string `envconfig:"PLEX_URL" required:"true"`
	PlexToken       Secret `envconfig:"PLEX_TOKEN" required:"true"`
	MaxItems        int    `envconfig:"MAX_ITEMS" required:"true"`
	PeriodInterval  Period `envconfig:"PERIOD_INTERVAL" required:"true"`
	MovieSectionId  string `envconfig:"MOVIE_SECTION_ID" required:"true"`
	TVShowSectionId string `envconfig:"TV_SHOW_SECTION_ID" required:"true"`
}

// MustReadConfig Returns a shallow copy of application configuration. Panics if the configuration is invalid.
func MustReadConfig() Config {
	conf := &Config{}
	if err := envconfig.Process(envVarPrefix, conf); err != nil {
		panic(err)
	}
	return *conf
}
