package service

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	rdb "github.com/redis/go-redis/v9"

	pkgredis "e2eechat/pkg/redis"
)

func TestPadSeries(t *testing.T) {
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

	t.Run("fills gaps with zero and keeps chronological order", func(t *testing.T) {
		got := padSeries(map[string]int64{
			"2026-08-01": 5,
			"2026-08-03": 2,
		}, start, 4)

		want := []DailyCount{
			{Date: "2026-08-01", Count: 5},
			{Date: "2026-08-02", Count: 0},
			{Date: "2026-08-03", Count: 2},
			{Date: "2026-08-04", Count: 0},
		}
		if len(got) != len(want) {
			t.Fatalf("got %d points, want %d", len(got), len(want))
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("point %d = %+v, want %+v", i, got[i], want[i])
			}
		}
	})

	t.Run("empty result still yields a full window", func(t *testing.T) {
		got := padSeries(map[string]int64{}, start, trendDays)
		if len(got) != trendDays {
			t.Fatalf("got %d points, want %d", len(got), trendDays)
		}
		for _, p := range got {
			if p.Count != 0 {
				t.Errorf("%s = %d, want 0", p.Date, p.Count)
			}
		}
	})

	t.Run("ignores days outside the window", func(t *testing.T) {
		got := padSeries(map[string]int64{"2026-07-20": 99}, start, 3)
		for _, p := range got {
			if p.Count != 0 {
				t.Errorf("%s = %d, want 0 — out-of-window day leaked in", p.Date, p.Count)
			}
		}
	})

	t.Run("crosses a month boundary", func(t *testing.T) {
		got := padSeries(map[string]int64{"2026-09-01": 7},
			time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC), 4)
		if got[2].Date != "2026-09-01" || got[2].Count != 7 {
			t.Errorf("got %+v, want 2026-09-01 count 7", got[2])
		}
	})
}

func TestCountOnline(t *testing.T) {
	mr := miniredis.RunT(t)
	client := rdb.NewClient(&rdb.Options{Addr: mr.Addr()})
	svc := NewAdminService(nil, client) // These paths never touch the DB.
	ctx := context.Background()

	t.Run("no sessions", func(t *testing.T) {
		got, err := svc.countOnline(ctx)
		if err != nil {
			t.Fatalf("countOnline: %v", err)
		}
		if got != 0 {
			t.Errorf("got %d, want 0", got)
		}
	})

	t.Run("counts only presence keys", func(t *testing.T) {
		for _, id := range []string{"1234-ABCD", "5678-EFGH", "9012-IJKL"} {
			mr.Set(pkgredis.OnlineKey(id), "1")
		}
		// Other key families share the keyspace and must not be counted.
		mr.Set(pkgredis.OfflineKey("1234-ABCD"), "queued")
		mr.Set(pkgredis.SessionKey("sometoken"), "1234-ABCD")
		mr.Set(pkgredis.InviteCodeKey("abc123"), "1234-ABCD")

		got, err := svc.countOnline(ctx)
		if err != nil {
			t.Fatalf("countOnline: %v", err)
		}
		if got != 3 {
			t.Errorf("got %d, want 3", got)
		}
	})

	t.Run("counts past a single SCAN page", func(t *testing.T) {
		mr.FlushAll()
		const n = 1200 // Larger than the 500-key SCAN batch, so the cursor must loop.
		for i := 0; i < n; i++ {
			mr.Set(pkgredis.OnlineKey(string(rune('a'+i%26))+"-"+time.Duration(i).String()), "1")
		}
		got, err := svc.countOnline(ctx)
		if err != nil {
			t.Fatalf("countOnline: %v", err)
		}
		if got != n {
			t.Errorf("got %d, want %d", got, n)
		}
	})
}
