package pipeline

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
)

// Runner executes a command. It is injectable so the Assembler can be tested
// without invoking ffmpeg.
type Runner func(ctx context.Context, name string, args []string) error

// Assembler turns clip specs into encoded files using ffmpeg.
type Assembler struct {
	Spec Spec
	Run  Runner
}

// NewAssembler returns an Assembler that shells out to the real ffmpeg.
func NewAssembler(spec Spec) *Assembler {
	return &Assembler{Spec: spec, Run: ExecRunner}
}

func (a *Assembler) run(ctx context.Context, args []string) error {
	runner := a.Run
	if runner == nil {
		runner = ExecRunner
	}
	return runner(ctx, "ffmpeg", args)
}

// ImageClip encodes a still image into a normalized clip.
func (a *Assembler) ImageClip(ctx context.Context, image, out string, duration float64) error {
	return a.run(ctx, ImageClipArgs(a.Spec, image, duration, out))
}

// TrailerClip trims and normalizes a trailer source into a clip.
func (a *Assembler) TrailerClip(ctx context.Context, src, out string, duration float64, withAudio bool) error {
	return a.run(ctx, TrailerClipArgs(a.Spec, src, duration, withAudio, out))
}

// OverlayTrailerClip trims and normalizes a trailer source and composites a
// full-frame overlay image on top.
func (a *Assembler) OverlayTrailerClip(ctx context.Context, src, overlay, out string, duration float64, withAudio bool) error {
	return a.run(ctx, OverlayTrailerClipArgs(a.Spec, src, overlay, duration, withAudio, out))
}

// MontageBackground builds a render scene over a muted, dimmed trailer montage
// with the text overlay composited on top.
func (a *Assembler) MontageBackground(ctx context.Context, srcs []string, overlay, out string, duration float64, tile string, dim float64) error {
	return a.run(ctx, MontageBackgroundArgs(a.Spec, srcs, overlay, duration, tile, dim, out))
}

// Concat concatenates the clips listed in listFile.
func (a *Assembler) Concat(ctx context.Context, listFile, out string) error {
	return a.run(ctx, ConcatArgs(a.Spec, listFile, out))
}

// Mux applies the soundtrack and length cap to the concatenated video.
func (a *Assembler) Mux(ctx context.Context, video string, audio manifest.Audio, length float64, out string) error {
	return a.run(ctx, MuxArgs(a.Spec, video, audio, length, out))
}

// ExecRunner runs the command and surfaces ffmpeg's stderr on failure.
func ExecRunner(ctx context.Context, name string, args []string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w\n%s", name, strings.Join(args, " "), err, stderr.String())
	}
	return nil
}
