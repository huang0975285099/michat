package handler

import (
	"strings"
	"testing"
)

func TestSanitizeRobotContent(t *testing.T) {
	input := `<h2>Hello</h2><p><strong>Robot</strong><script>alert(1)</script><img src="/api/robot/media/0123456789abcdef0123456789abcdef.png" onerror="alert(2)"><img src="javascript:alert(3)"><a href="javascript:alert(4)">bad</a></p>`
	got := sanitizeRobotContent(input)
	for _, want := range []string{"<h2>Hello</h2>", "<strong>Robot</strong>", `src="/api/robot/media/0123456789abcdef0123456789abcdef.png"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	for _, bad := range []string{"<script", "alert(", "onerror", "javascript:"} {
		if strings.Contains(got, bad) {
			t.Errorf("unsafe %q in %q", bad, got)
		}
	}
}

func TestRobotMediaType(t *testing.T) {
	if ext, mime := robotMediaType([]byte("\x00\x00\x00\x18ftypisom")); ext != "mp4" || mime != "video/mp4" {
		t.Fatalf("mp4: %q %q", ext, mime)
	}
	if ext, _ := robotMediaType([]byte("<html>bad</html>")); ext != "" {
		t.Fatalf("HTML accepted as %q", ext)
	}
}
