//go:build !unix

package webui

import "os/exec"

// killProcessGroup is a no-op where there are no POSIX process groups: the
// default cancel (kill the renderer itself) still applies, and WaitDelay still
// frees the job slot. Grandchildren can outlive the deadline here; nobody has
// asked to run this on Windows, and a job-object implementation is a lot of
// machinery for a user who does not exist yet.
func killProcessGroup(cmd *exec.Cmd) {}
