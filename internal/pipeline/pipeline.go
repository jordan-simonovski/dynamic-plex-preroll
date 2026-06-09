// Package pipeline assembles the final pre-roll video with ffmpeg. It is split
// into pure argument builders (easily unit-tested) and a thin Assembler that
// executes them, so the encoding logic can be verified without running ffmpeg.
//
// Every clip is normalized to identical video AND audio parameters before
// concatenation: image/render clips get a silent audio track so they remain
// concat-compatible with trailer clips that carry real audio.
package pipeline

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
)

// Spec is the normalized output format every clip is encoded to.
type Spec struct {
	Width      int
	Height     int
	FPS        int
	PixFmt     string
	VideoCodec string
	AudioCodec string
	SampleRate int
}

// DefaultSpec returns a sane H.264/AAC spec for the given geometry.
func DefaultSpec(width, height, fps int) Spec {
	return Spec{
		Width:      width,
		Height:     height,
		FPS:        fps,
		PixFmt:     "yuv420p",
		VideoCodec: "libx264",
		AudioCodec: "aac",
		SampleRate: 44100,
	}
}

func (s Spec) videoFilter() string {
	return fmt.Sprintf("scale=%d:%d,fps=%d,setsar=1", s.Width, s.Height, s.FPS)
}

func (s Spec) silentSource() string {
	return fmt.Sprintf("anullsrc=channel_layout=stereo:sample_rate=%d", s.SampleRate)
}

// ImageClipArgs builds ffmpeg args to turn a still image into a normalized
// clip of the given duration with a silent audio track.
func ImageClipArgs(spec Spec, image string, duration float64, out string) []string {
	d := num(duration)
	sr := strconv.Itoa(spec.SampleRate)
	return []string{
		"-y",
		"-f", "lavfi", "-t", d, "-i", spec.silentSource(),
		"-loop", "1", "-t", d, "-i", image,
		"-map", "1:v:0", "-map", "0:a:0",
		"-vf", spec.videoFilter(),
		"-pix_fmt", spec.PixFmt,
		"-c:v", spec.VideoCodec,
		"-c:a", spec.AudioCodec, "-ar", sr,
		"-t", d,
		out,
	}
}

// TrailerClipArgs builds ffmpeg args to trim and normalize a trailer source to
// a clip of the given duration. When withAudio is false the source audio is
// replaced by silence so the clip stays concat-compatible.
func TrailerClipArgs(spec Spec, src string, duration float64, withAudio bool, out string) []string {
	d := num(duration)
	sr := strconv.Itoa(spec.SampleRate)

	args := []string{"-y", "-t", d, "-i", src}
	if withAudio {
		args = append(args, "-map", "0:v:0", "-map", "0:a:0")
	} else {
		args = append(args,
			"-f", "lavfi", "-t", d, "-i", spec.silentSource(),
			"-map", "0:v:0", "-map", "1:a:0",
		)
	}
	args = append(args,
		"-vf", spec.videoFilter(),
		"-pix_fmt", spec.PixFmt,
		"-c:v", spec.VideoCodec,
		"-c:a", spec.AudioCodec, "-ar", sr,
		"-t", d,
		out,
	)
	return args
}

// OverlayTrailerClipArgs builds ffmpeg args to trim and normalize a trailer
// source and composite a full-frame overlay image (e.g. a rendered movie-title
// label) on top for the whole clip. The overlay is expected to already match the
// output geometry. Audio handling matches TrailerClipArgs.
func OverlayTrailerClipArgs(spec Spec, src, overlay string, duration float64, withAudio bool, out string) []string {
	d := num(duration)
	sr := strconv.Itoa(spec.SampleRate)

	args := []string{"-y", "-t", d, "-i", src, "-i", overlay}

	audioMap := "0:a:0"
	if !withAudio {
		args = append(args, "-f", "lavfi", "-t", d, "-i", spec.silentSource())
		audioMap = "2:a:0"
	}

	fc := fmt.Sprintf("[0:v]%s[base];[base][1:v]overlay=0:0[vout]", spec.videoFilter())
	args = append(args,
		"-filter_complex", fc,
		"-map", "[vout]", "-map", audioMap,
		"-pix_fmt", spec.PixFmt,
		"-c:v", spec.VideoCodec,
		"-c:a", spec.AudioCodec, "-ar", sr,
		"-t", d,
		out,
	)
	return args
}

// MontageBackgroundArgs builds ffmpeg args for a render scene whose backdrop is
// a muted, dimmed montage of trailer sources, with a transparent text overlay
// composited on top. tile "grid" plays up to four sources at once (2x2); any
// other tile value plays them back to back, each for an equal slice of duration.
// The result carries a silent audio track so it stays concat-compatible.
func MontageBackgroundArgs(spec Spec, srcs []string, overlay string, duration float64, tile string, dim float64, out string) []string {
	n := len(srcs)
	d := num(duration)
	sr := strconv.Itoa(spec.SampleRate)

	seg := d
	if tile == manifest.TileSequence && n > 0 {
		seg = num(duration / float64(n))
	}

	args := []string{"-y"}
	for _, s := range srcs {
		args = append(args, "-t", seg, "-i", s)
	}
	args = append(args, "-i", overlay)
	args = append(args, "-f", "lavfi", "-t", d, "-i", spec.silentSource())

	fc := montageFilter(spec, n, tile, dim) + fmt.Sprintf(";[bg][%d:v]overlay=0:0[vout]", n)
	args = append(args,
		"-filter_complex", fc,
		"-map", "[vout]", "-map", fmt.Sprintf("%d:a:0", n+1),
		"-pix_fmt", spec.PixFmt,
		"-c:v", spec.VideoCodec,
		"-c:a", spec.AudioCodec, "-ar", sr,
		"-t", d,
		out,
	)
	return args
}

// montageFilter builds the filtergraph that produces the dimmed background,
// labelled [bg]. Grid tiles up to four sources 2x2 (2x1 for two); any other
// tile concatenates full-frame sources. dim darkens via eq brightness (0..1).
func montageFilter(spec Spec, n int, tile string, dim float64) string {
	// Multiplicative luminance dim (k = fraction of brightness kept) so video
	// matches the image path's ModulateImage and a scene's dim reads the same in
	// both. Additive brightness offsets crushed the picture too hard.
	k := num(1 - clampDim(dim))
	dimf := fmt.Sprintf("colorchannelmixer=rr=%s:gg=%s:bb=%s", k, k, k)

	if tile != manifest.TileGrid || n <= 1 {
		var b strings.Builder
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, "[%d:v]scale=%d:%d,fps=%d,setsar=1[s%d];", i, spec.Width, spec.Height, spec.FPS, i)
		}
		if n <= 1 {
			fmt.Fprintf(&b, "[s0]%s[bg]", dimf)
			return b.String()
		}
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, "[s%d]", i)
		}
		fmt.Fprintf(&b, "concat=n=%d:v=1:a=0[m];[m]%s[bg]", n, dimf)
		return b.String()
	}

	cols, rows := 2, 2
	if n == 2 {
		rows = 1
	}
	tw, th := spec.Width/cols, spec.Height/rows

	var b strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "[%d:v]scale=%d:%d,fps=%d,setsar=1[s%d];", i, tw, th, spec.FPS, i)
	}
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "[s%d]", i)
	}
	fmt.Fprintf(&b, "xstack=inputs=%d:layout=%s:fill=black[m];[m]%s[bg]", n, xstackLayout(n), dimf)
	return b.String()
}

// clampDim bounds a dim amount to [0,1].
func clampDim(dim float64) float64 {
	if dim < 0 {
		return 0
	}
	if dim > 1 {
		return 1
	}
	return dim
}

// xstackLayout returns the xstack tile positions for up to four inputs.
func xstackLayout(n int) string {
	pos := []string{"0_0", "w0_0", "0_h0", "w0_h0"}
	if n > len(pos) {
		n = len(pos)
	}
	return strings.Join(pos[:n], "|")
}

// ConcatArgs builds ffmpeg args to concatenate normalized clips listed in
// listFile, re-encoding for timestamp safety across heterogeneous sources.
func ConcatArgs(spec Spec, listFile, out string) []string {
	return []string{
		"-y",
		"-f", "concat", "-safe", "0", "-i", listFile,
		"-vf", spec.videoFilter(),
		"-pix_fmt", spec.PixFmt,
		"-c:v", spec.VideoCodec,
		"-c:a", spec.AudioCodec, "-ar", strconv.Itoa(spec.SampleRate),
		out,
	}
}

// MuxArgs builds ffmpeg args to apply the soundtrack to the concatenated video
// according to audio.Mode, then cap the total length.
func MuxArgs(spec Spec, video string, audio manifest.Audio, length float64, out string) []string {
	args := []string{"-y", "-i", video}

	// Without a soundtrack file there is nothing to mux; keep concatenated audio.
	mode := audio.Mode
	if audio.File == "" {
		mode = manifest.AudioOriginal
	}

	switch mode {
	case manifest.AudioOriginal:
		args = append(args, "-c", "copy")

	case manifest.AudioMix:
		args = append(args, audioInput(audio)...)
		args = append(args,
			"-filter_complex", mixFilter(audio),
			"-map", "0:v:0", "-map", "[aout]",
			"-c:v", "copy", "-c:a", spec.AudioCodec,
		)

	default: // soundtrack (and unset)
		args = append(args, audioInput(audio)...)
		args = append(args,
			"-map", "0:v:0", "-map", "1:a:0",
			"-c:v", "copy", "-c:a", spec.AudioCodec,
		)
		if fade := audio.FadeOut; fade != nil {
			args = append(args, "-af", fmt.Sprintf("afade=t=out:st=%s:d=%s", num(fade.Start), num(fade.Duration)))
		}
	}

	if length > 0 {
		args = append(args, "-t", num(length))
	}
	args = append(args, "-shortest", out)
	return args
}

// mixFilter builds the amix filtergraph for mix mode. The soundtrack ([1:a]) is
// optionally faded out first, so a manifest can run the bed under an intro and
// drop it once clip audio takes over. normalize=0 keeps each input at its own
// level rather than halving everything when a second input is present.
func mixFilter(audio manifest.Audio) string {
	bed := "[1:a]"
	prefix := ""
	if fade := audio.FadeOut; fade != nil {
		prefix = fmt.Sprintf("[1:a]afade=t=out:st=%s:d=%s[bed];", num(fade.Start), num(fade.Duration))
		bed = "[bed]"
	}
	return fmt.Sprintf("%s[0:a]%samix=inputs=2:duration=first:normalize=0[aout]", prefix, bed)
}

// audioInput builds the soundtrack input args, seeking into the track when
// audio.Start is set. Input-side seeking (-ss before -i) is fast and resets
// the stream timeline to zero, so afade offsets stay output-relative.
func audioInput(audio manifest.Audio) []string {
	if audio.Start > 0 {
		return []string{"-ss", num(audio.Start), "-i", audio.File}
	}
	return []string{"-i", audio.File}
}

// WriteConcatList writes an ffconcat list file referencing the given clip
// paths in order. Paths should be absolute; single quotes are escaped.
func WriteConcatList(path string, clipPaths []string) error {
	var b strings.Builder
	b.WriteString("ffconcat version 1.0\n")
	for _, clip := range clipPaths {
		b.WriteString("file '")
		b.WriteString(strings.ReplaceAll(clip, "'", `'\''`))
		b.WriteString("'\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return fmt.Errorf("pipeline: write concat list: %w", err)
	}
	return nil
}

func num(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
