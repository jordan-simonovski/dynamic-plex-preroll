package ffmpegclient

import (
	"bytes"
	"os/exec"
)

func ConcatenateImagesToVideo() (string, string, error) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd := exec.Command("ffmpeg", "-y", "-i", "media/as-preroll-1.ffconcat", "-i", "media/default-template/vano-adult-swim.mp3", "-t", "25", "-vcodec", "libx264", "-acodec", "aac", "-pix_fmt", "yuv420p", "raw.mp4")
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

func AddVideoFilters() (string, string, error) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	//ffmpeg -i raw.mp4 -af "afade=t=out:st=20:d=5" out.mp4
	cmd := exec.Command("ffmpeg", "-y", "-i", "raw.mp4", "-af", "afade=t=out:st=20:d=5", "-vcodec", "libx264", "-acodec", "aac", "-pix_fmt", "yuv420p", "output/out.mp4")
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}
