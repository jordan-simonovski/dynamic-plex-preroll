//go:build unix

package webui

import (
	"os/exec"
	"syscall"
)

// killProcessGroup makes the deadline actually reclaim the machine. The
// renderer spawns ffmpeg, and exec.CommandContext's default cancel signals
// only the process it started — so a timed-out render leaves an ffmpeg behind
// with nothing left that can kill it, one per timeout, forever. Putting the
// child in its own process group and signalling the whole group at cancel
// time is the only thing that reaches the grandchildren.
func killProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// Negative pid = the whole group. Fall back to the process itself if
		// setpgid somehow did not take.
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}
