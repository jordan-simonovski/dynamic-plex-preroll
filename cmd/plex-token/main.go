// Command plex-token signs in to plex.tv and prints a Plex auth token.
//
// Usage:
//
//	go run ./cmd/plex-token -login you@example.com
//	go run ./cmd/plex-token -login you@example.com -code 123456   # if 2FA is on
//
// The token is written to stdout; prompts and errors go to stderr, so you can
// pipe it straight into your environment:
//
//	echo "PLEX_TOKEN=\"$(go run ./cmd/plex-token -login you@example.com)\""
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"golang.org/x/term"
)

const signinURL = "https://plex.tv/api/v2/users/signin"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	login := flag.String("login", "", "Plex account email or username")
	code := flag.String("code", "", "two-factor verification code (only if 2FA is enabled)")
	flag.Parse()

	if strings.TrimSpace(*login) == "" {
		return fmt.Errorf("-login is required")
	}

	password, err := readPassword()
	if err != nil {
		return err
	}
	if password == "" {
		return fmt.Errorf("password is required")
	}

	token, err := signin(*login, password, *code)
	if err != nil {
		return err
	}

	fmt.Println(token)
	return nil
}

// readPassword prompts for a password without echoing it to the terminal.
func readPassword() (string, error) {
	fmt.Fprint(os.Stderr, "Plex password: ")
	raw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", fmt.Errorf("read password: %w", err)
	}
	return string(raw), nil
}

// signin exchanges credentials for a Plex auth token.
func signin(login, password, code string) (string, error) {
	form := url.Values{}
	form.Set("login", login)
	form.Set("password", password)
	if code != "" {
		form.Set("verificationCode", code)
	}

	req, err := http.NewRequest(http.MethodPost, signinURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// Plex rejects sign-in without a stable client identifier.
	req.Header.Set("X-Plex-Client-Identifier", clientIdentifier())
	req.Header.Set("X-Plex-Product", "dynamic-plex-preroll")
	req.Header.Set("X-Plex-Version", "1")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	var decoded struct {
		AuthToken string `json:"authToken"`
		Errors    []struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return "", fmt.Errorf("plex: decode response (status %d): %w", resp.StatusCode, err)
	}

	if len(decoded.Errors) > 0 {
		e := decoded.Errors[0]
		if e.Code == 1029 {
			return "", fmt.Errorf("plex: 2FA required, re-run with -code <verification-code>")
		}
		return "", fmt.Errorf("plex: %s (code %d)", e.Message, e.Code)
	}
	if decoded.AuthToken == "" {
		return "", fmt.Errorf("plex: no token in response (status %d)", resp.StatusCode)
	}
	return decoded.AuthToken, nil
}

// clientIdentifier returns a random per-run identifier. Plex registers this as
// a device; a one-shot CLI doesn't need a persistent one.
func clientIdentifier() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "dynamic-plex-preroll-token-util"
	}
	return hex.EncodeToString(b)
}
