package migrations

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

type migrationProbe struct {
	mu          sync.Mutex
	applied     map[string]bool
	executed    map[string]int
	failVersion string
	denyLock    bool
}

type migrationProbeConnector struct{ probe *migrationProbe }

func (connector migrationProbeConnector) Connect(context.Context) (driver.Conn, error) {
	return &migrationProbeConnection{probe: connector.probe}, nil
}
func (connector migrationProbeConnector) Driver() driver.Driver { return migrationProbeDriver{} }

type migrationProbeDriver struct{}

func (migrationProbeDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use connector")
}

type migrationProbeConnection struct {
	probe       *migrationProbe
	pending     []string
	transaction bool
}

func (connection *migrationProbeConnection) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (connection *migrationProbeConnection) Close() error { return nil }
func (connection *migrationProbeConnection) Begin() (driver.Tx, error) {
	connection.transaction = true
	connection.pending = nil
	return connection, nil
}
func (connection *migrationProbeConnection) Commit() error {
	connection.probe.mu.Lock()
	defer connection.probe.mu.Unlock()
	for _, version := range connection.pending {
		connection.probe.applied[version] = true
	}
	connection.pending = nil
	connection.transaction = false
	return nil
}
func (connection *migrationProbeConnection) Rollback() error {
	connection.pending = nil
	connection.transaction = false
	return nil
}
func (connection *migrationProbeConnection) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	probe := connection.probe
	probe.mu.Lock()
	defer probe.mu.Unlock()
	probe.executed[query]++
	if strings.HasPrefix(query, "INSERT INTO schema_migrations") {
		version := args[0].Value.(string)
		if probe.failVersion == version {
			probe.failVersion = ""
			return nil, errors.New("simulated version write failure")
		}
		if connection.transaction {
			connection.pending = append(connection.pending, version)
		} else {
			probe.applied[version] = true
		}
	} else if strings.HasPrefix(query, "INSERT IGNORE INTO group_message_reads") || strings.HasPrefix(query, "UPDATE group_members SET muted_until") {
		if !connection.transaction {
			return nil, errors.New("backfill ran outside transaction")
		}
	}
	return driver.RowsAffected(1), nil
}
func (connection *migrationProbeConnection) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	probe := connection.probe
	probe.mu.Lock()
	defer probe.mu.Unlock()
	var value int64 = 1
	if strings.Contains(query, "GET_LOCK") && probe.denyLock {
		value = 0
	}
	if strings.Contains(query, "SELECT EXISTS") {
		value = 0
		if probe.applied[args[0].Value.(string)] {
			value = 1
		}
	}
	return &migrationProbeRows{value: value}, nil
}

type migrationProbeRows struct {
	value int64
	read  bool
}

func (*migrationProbeRows) Columns() []string { return []string{"value"} }
func (*migrationProbeRows) Close() error      { return nil }
func (rows *migrationProbeRows) Next(values []driver.Value) error {
	if rows.read {
		return io.EOF
	}
	rows.read = true
	values[0] = rows.value
	return nil
}
func probeMigrations(t *testing.T) (*sql.DB, *migrationProbe) {
	t.Helper()
	probe := &migrationProbe{applied: make(map[string]bool), executed: make(map[string]int)}
	db := sql.OpenDB(migrationProbeConnector{probe})
	t.Cleanup(func() { db.Close() })
	return db, probe
}
func countMigrationStatements(probe *migrationProbe, prefix string) int {
	total := 0
	for query, count := range probe.executed {
		if strings.HasPrefix(query, prefix) {
			total += count
		}
	}
	return total
}

func TestMigrationVersionsSkipBackfillsOnSecondStartup(t *testing.T) {
	db, probe := probeMigrations(t)
	if err := AutoMigrate(db); err != nil {
		t.Fatal(err)
	}
	if len(probe.applied) != 32 {
		t.Fatalf("recorded %d migration versions", len(probe.applied))
	}
	if err := AutoMigrate(db); err != nil {
		t.Fatal(err)
	}
	if countMigrationStatements(probe, "INSERT IGNORE INTO group_message_reads") != 1 {
		t.Fatal("035 backfill was repeated")
	}
	if countMigrationStatements(probe, "UPDATE group_members SET muted_until") != 2 {
		t.Fatal("036 backfill was repeated")
	}
}

func TestFailedMigrationVersionIsRetriedWithoutReplayingCompletedVersions(t *testing.T) {
	db, probe := probeMigrations(t)
	probe.failVersion = "036_permanent_group_mutes"
	if err := AutoMigrate(db); err == nil {
		t.Fatal("expected version write failure")
	}
	if probe.applied["036_permanent_group_mutes"] {
		t.Fatal("failed migration was marked complete")
	}
	if !probe.applied["035_group_message_reads"] {
		t.Fatal("completed migration was not recorded")
	}
	if err := AutoMigrate(db); err != nil {
		t.Fatal(err)
	}
	if countMigrationStatements(probe, "INSERT IGNORE INTO group_message_reads") != 1 {
		t.Fatal("completed 035 migration was replayed")
	}
	if !probe.applied["036_permanent_group_mutes"] {
		t.Fatal("failed migration was not retried")
	}
}

func TestUnavailableMigrationLockPreventsAllWrites(t *testing.T) {
	db, probe := probeMigrations(t)
	probe.denyLock = true
	if err := AutoMigrate(db); err == nil {
		t.Fatal("missing migration lock accepted")
	}
	if len(probe.executed) != 0 {
		t.Fatal("migration wrote without owning its lock")
	}
}
