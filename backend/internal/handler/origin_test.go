package handler

import "testing"

func TestIsLocalDevOrigin(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		want   bool
	}{
		{name: "electron file scheme", origin: "file://", want: true},
		{name: "capacitor scheme", origin: "capacitor://localhost", want: true},
		{name: "tauri scheme (macos/linux)", origin: "tauri://localhost", want: true},
		{name: "tauri host (windows)", origin: "http://tauri.localhost", want: true},
		{name: "tauri host over https", origin: "https://tauri.localhost", want: true},
		{name: "quasar dev server", origin: "http://localhost:9999", want: true},
		{name: "loopback ipv4", origin: "http://127.0.0.1:8888", want: true},
		{name: "loopback ipv6", origin: "http://[::1]:8888", want: true},

		{name: "public site is not a dev origin", origin: "https://m.yzs88.com", want: false},
		{name: "empty origin", origin: "", want: false},
		// Suffix-matching a host would let these through; the check is exact for that reason.
		{name: "localhost suffix bypass", origin: "https://localhost.evil.com", want: false},
		{name: "tauri localhost suffix bypass", origin: "https://tauri.localhost.evil.com", want: false},
		{name: "tauri host as prefix bypass", origin: "https://eviltauri.localhost", want: false},
		{name: "non http scheme", origin: "ftp://localhost", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsLocalDevOrigin(tt.origin); got != tt.want {
				t.Errorf("IsLocalDevOrigin(%q) = %v, want %v", tt.origin, got, tt.want)
			}
		})
	}
}
