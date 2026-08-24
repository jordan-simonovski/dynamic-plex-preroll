# The only build system this repo has, and it exists for one reason: nothing
# ran the Node checks under internal/webui — ~4,900 lines of them — so they
# could rot silently. `make test` runs both suites.
.PHONY: test test-go test-js

test: test-go test-js

# ./... includes internal/render, which needs ImageMagick to build. Without it,
# use the CGO-free package list in the README's "Running tests" section.
test-go:
	go test ./...

# Node >= 22 does not expand a bare directory argument, so the glob is required.
# Quoted, so node expands it rather than the shell: node applies it per-file.
test-js:
	node --test 'internal/webui/*_test.js'
