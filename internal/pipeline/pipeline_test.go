package pipeline

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/jordan-simonovski/dynamic-plex-preroll/internal/manifest"
)

func spec() Spec { return DefaultSpec(1920, 1080, 24) }

func assertArgs(t *testing.T, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("args mismatch\n got: %v\nwant: %v", got, want)
	}
}

func TestImageClipArgs(t *testing.T) {
	got := ImageClipArgs(spec(), "in.png", 2, "out.mp4")
	want := []string{
		"-y",
		"-f", "lavfi", "-t", "2", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-loop", "1", "-t", "2", "-i", "in.png",
		"-map", "1:v:0", "-map", "0:a:0",
		"-vf", "scale=1920:1080,fps=24,setsar=1",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264",
		"-c:a", "aac", "-ar", "44100",
		"-t", "2",
		"out.mp4",
	}
	assertArgs(t, got, want)
}

func TestTrailerClipArgsWithAudio(t *testing.T) {
	got := TrailerClipArgs(spec(), "http://plex/trailer", 6, true, "clip.mp4")
	want := []string{
		"-y", "-t", "6", "-i", "http://plex/trailer",
		"-map", "0:v:0", "-map", "0:a:0",
		"-vf", "scale=1920:1080,fps=24,setsar=1",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264",
		"-c:a", "aac", "-ar", "44100",
		"-t", "6",
		"clip.mp4",
	}
	assertArgs(t, got, want)
}

func TestTrailerClipArgsSilent(t *testing.T) {
	got := TrailerClipArgs(spec(), "src.mp4", 6, false, "clip.mp4")
	want := []string{
		"-y", "-t", "6", "-i", "src.mp4",
		"-f", "lavfi", "-t", "6", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-map", "0:v:0", "-map", "1:a:0",
		"-vf", "scale=1920:1080,fps=24,setsar=1",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264",
		"-c:a", "aac", "-ar", "44100",
		"-t", "6",
		"clip.mp4",
	}
	assertArgs(t, got, want)
}

func TestOverlayTrailerClipArgsWithAudio(t *testing.T) {
	got := OverlayTrailerClipArgs(spec(), "http://plex/trailer", "label.png", 8, true, "clip.mp4")
	want := []string{
		"-y", "-t", "8", "-i", "http://plex/trailer", "-i", "label.png",
		"-filter_complex", "[0:v]scale=1920:1080,fps=24,setsar=1[base];[base][1:v]overlay=0:0[vout]",
		"-map", "[vout]", "-map", "0:a:0",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264",
		"-c:a", "aac", "-ar", "44100",
		"-t", "8",
		"clip.mp4",
	}
	assertArgs(t, got, want)
}

func TestOverlayTrailerClipArgsSilent(t *testing.T) {
	got := OverlayTrailerClipArgs(spec(), "src.mp4", "label.png", 8, false, "clip.mp4")
	want := []string{
		"-y", "-t", "8", "-i", "src.mp4", "-i", "label.png",
		"-f", "lavfi", "-t", "8", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-filter_complex", "[0:v]scale=1920:1080,fps=24,setsar=1[base];[base][1:v]overlay=0:0[vout]",
		"-map", "[vout]", "-map", "2:a:0",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264",
		"-c:a", "aac", "-ar", "44100",
		"-t", "8",
		"clip.mp4",
	}
	assertArgs(t, got, want)
}

func TestMontageBackgroundArgsGrid(t *testing.T) {
	got := MontageBackgroundArgs(spec(), []string{"a", "b"}, "text.png", 8, "grid", 0.4, "clip.mp4")
	fc := "[0:v]scale=960:1080,fps=24,setsar=1[s0];[1:v]scale=960:1080,fps=24,setsar=1[s1];" +
		"[s0][s1]xstack=inputs=2:layout=0_0|w0_0:fill=black[m];[m]colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];" +
		"[bg][2:v]overlay=0:0[vout]"
	want := []string{
		"-y",
		"-t", "8", "-i", "a",
		"-t", "8", "-i", "b",
		"-i", "text.png",
		"-f", "lavfi", "-t", "8", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-filter_complex", fc,
		"-map", "[vout]", "-map", "3:a:0",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264",
		"-c:a", "aac", "-ar", "44100",
		"-t", "8",
		"clip.mp4",
	}
	assertArgs(t, got, want)
}

func TestMontageBackgroundArgsSequence(t *testing.T) {
	got := MontageBackgroundArgs(spec(), []string{"a", "b"}, "text.png", 8, "sequence", 0.4, "clip.mp4")
	fc := "[0:v]scale=1920:1080,fps=24,setsar=1[s0];[1:v]scale=1920:1080,fps=24,setsar=1[s1];" +
		"[s0][s1]concat=n=2:v=1:a=0[m];[m]colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];" +
		"[bg][2:v]overlay=0:0[vout]"
	want := []string{
		"-y",
		"-t", "4", "-i", "a",
		"-t", "4", "-i", "b",
		"-i", "text.png",
		"-f", "lavfi", "-t", "8", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-filter_complex", fc,
		"-map", "[vout]", "-map", "3:a:0",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264",
		"-c:a", "aac", "-ar", "44100",
		"-t", "8",
		"clip.mp4",
	}
	assertArgs(t, got, want)
}

func TestConcatArgs(t *testing.T) {
	got := ConcatArgs(spec(), "list.txt", "out.mp4")
	want := []string{
		"-y", "-f", "concat", "-safe", "0", "-i", "list.txt",
		"-vf", "scale=1920:1080,fps=24,setsar=1",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264",
		"-c:a", "aac", "-ar", "44100",
		"out.mp4",
	}
	assertArgs(t, got, want)
}

func TestMuxArgsSoundtrackWithFade(t *testing.T) {
	audio := manifest.Audio{File: "song.mp3", Mode: manifest.AudioSoundtrack, FadeOut: &manifest.FadeOut{Start: 20, Duration: 5}}
	got := MuxArgs(spec(), "v.mp4", audio, 25, "out.mp4")
	want := []string{
		"-y", "-i", "v.mp4",
		"-i", "song.mp3",
		"-map", "0:v:0", "-map", "1:a:0",
		"-c:v", "copy", "-c:a", "aac",
		"-af", "afade=t=out:st=20:d=5",
		"-t", "25",
		"-shortest", "out.mp4",
	}
	assertArgs(t, got, want)
}

func TestMuxArgsSoundtrackWithStartSeek(t *testing.T) {
	audio := manifest.Audio{File: "song.mp3", Mode: manifest.AudioSoundtrack, Start: 33, FadeOut: &manifest.FadeOut{Start: 20, Duration: 5}}
	got := MuxArgs(spec(), "v.mp4", audio, 25, "out.mp4")
	want := []string{
		"-y", "-i", "v.mp4",
		"-ss", "33", "-i", "song.mp3",
		"-map", "0:v:0", "-map", "1:a:0",
		"-c:v", "copy", "-c:a", "aac",
		"-af", "afade=t=out:st=20:d=5",
		"-t", "25",
		"-shortest", "out.mp4",
	}
	assertArgs(t, got, want)
}

func TestMuxArgsMixWithStartSeek(t *testing.T) {
	audio := manifest.Audio{File: "s.mp3", Mode: manifest.AudioMix, Start: 12}
	got := MuxArgs(spec(), "v.mp4", audio, 0, "out.mp4")
	want := []string{
		"-y", "-i", "v.mp4",
		"-ss", "12", "-i", "s.mp3",
		"-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[aout]",
		"-map", "0:v:0", "-map", "[aout]",
		"-c:v", "copy", "-c:a", "aac",
		"-shortest", "out.mp4",
	}
	assertArgs(t, got, want)
}

func TestMuxArgsMixWithFadeOut(t *testing.T) {
	audio := manifest.Audio{File: "s.mp3", Mode: manifest.AudioMix, Start: 12, FadeOut: &manifest.FadeOut{Start: 3, Duration: 2}}
	got := MuxArgs(spec(), "v.mp4", audio, 0, "out.mp4")
	want := []string{
		"-y", "-i", "v.mp4",
		"-ss", "12", "-i", "s.mp3",
		"-filter_complex", "[1:a]afade=t=out:st=3:d=2[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[aout]",
		"-map", "0:v:0", "-map", "[aout]",
		"-c:v", "copy", "-c:a", "aac",
		"-shortest", "out.mp4",
	}
	assertArgs(t, got, want)
}

func TestMuxArgsOriginalNoCap(t *testing.T) {
	got := MuxArgs(spec(), "v.mp4", manifest.Audio{Mode: manifest.AudioOriginal}, 0, "out.mp4")
	want := []string{"-y", "-i", "v.mp4", "-c", "copy", "-shortest", "out.mp4"}
	assertArgs(t, got, want)
}

func TestMuxArgsEmptyFileFallsBackToCopy(t *testing.T) {
	// soundtrack mode but no file -> behave as original (copy)
	got := MuxArgs(spec(), "v.mp4", manifest.Audio{Mode: manifest.AudioSoundtrack}, 10, "out.mp4")
	want := []string{"-y", "-i", "v.mp4", "-c", "copy", "-t", "10", "-shortest", "out.mp4"}
	assertArgs(t, got, want)
}

func TestMuxArgsMix(t *testing.T) {
	got := MuxArgs(spec(), "v.mp4", manifest.Audio{File: "s.mp3", Mode: manifest.AudioMix}, 0, "out.mp4")
	want := []string{
		"-y", "-i", "v.mp4",
		"-i", "s.mp3",
		"-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[aout]",
		"-map", "0:v:0", "-map", "[aout]",
		"-c:v", "copy", "-c:a", "aac",
		"-shortest", "out.mp4",
	}
	assertArgs(t, got, want)
}

func TestWriteConcatList(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "list.txt")
	if err := WriteConcatList(path, []string{"/tmp/a.mp4", "/tmp/b's.mp4"}); err != nil {
		t.Fatalf("WriteConcatList: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "ffconcat version 1.0\nfile '/tmp/a.mp4'\nfile '/tmp/b'\\''s.mp4'\n"
	if string(data) != want {
		t.Errorf("concat list:\n got %q\nwant %q", string(data), want)
	}
}

func TestAssemblerUsesInjectedRunner(t *testing.T) {
	var got []string
	asm := &Assembler{Spec: spec(), Run: func(_ context.Context, name string, args []string) error {
		if name != "ffmpeg" {
			t.Errorf("runner name = %q, want ffmpeg", name)
		}
		got = args
		return nil
	}}
	if err := asm.ImageClip(context.Background(), "in.png", "out.mp4", 2); err != nil {
		t.Fatalf("ImageClip: %v", err)
	}
	assertArgs(t, got, ImageClipArgs(spec(), "in.png", 2, "out.mp4"))
}
