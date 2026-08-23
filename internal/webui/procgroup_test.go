//go:build unix

package webui

import (
	"encoding/json"
	"fmt"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The renderer runs ffmpeg. Killing only the process exec.CommandContext
// started leaves that grandchild alive with nothing able to reach it — one
// orphan per timeout, on a job allowed to run for 20 minutes. The stub stands
// in for ffmpeg: a background child that survives its parent unless the whole
// process group is signalled. It reports its own pid through the renderer's
// stdout (which the job log captures), and liveness is then asked of the
// kernel with signal 0 — no sentinel file, so nothing here depends on what an
// orphaned process is allowed to write.
func TestRenderTimeoutKillsGrandchildren(t *testing.T) {
	// The background child's own output goes to /dev/null: holding the stdout
	// pipe would make this a test of WaitDelay instead. `exec` in the
	// foreground half is why the shell itself is not a second stray.
	ts, s := renderServer(t, "#!/bin/sh\nsleep 60 >/dev/null 2>&1 &\necho \"grandchild $!\"\nexec sleep 60\n")
	s.RenderTimeout = 200 * time.Millisecond

	res := do(t, "POST", ts.URL+"/api/render", validJSON)
	var started struct {
		ID string `json:"id"`
	}
	json.NewDecoder(res.Body).Decode(&started)
	out := waitForJob(t, ts, started.ID)
	if out["state"] != "failed" {
		t.Fatalf("want a timed-out render, got %+v", out)
	}

	log, _ := out["log"].(string)
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(log), "grandchild %d", &pid); err != nil {
		t.Fatalf("stub did not report its background child's pid, log was %q", log)
	}
	time.Sleep(200 * time.Millisecond) // let the kill land and the orphan be reaped
	if err := syscall.Kill(pid, 0); err == nil {
		syscall.Kill(pid, syscall.SIGKILL) // do not leak it out of the test either
		t.Fatal("a process the renderer spawned outlived the deadline: the timeout must kill the process group, not just the renderer")
	}
}
