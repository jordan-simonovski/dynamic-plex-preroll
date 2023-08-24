package configmanager

import (
	"github.com/kelseyhightower/envconfig"
)

const envVarPrefix = ""

type Secret string

func (s Secret) String() string {
	return "****"
}

type Config struct {
	PlexToken       Secret `envconfig"PLEX_TOKEN" required:"true"`
	PlexURL         string `envconfig:"PLEX_URL" required:"true"`
	MaxItems        int    `envconfig:"MAX_ITEMS" required:"true"`
	PeriodDays      int    `envconfig:"PERIOD_DAYS" required:"true"`
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
