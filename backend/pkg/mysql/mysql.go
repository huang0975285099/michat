package mysql

import (
	"database/sql"
	"fmt"
	"time"

	driver "github.com/go-sql-driver/mysql"
)

func New(dsn string) (*sql.DB, error) {
	if err := ensureDatabase(dsn); err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("mysql open: %w", err)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(time.Hour)
	if err = db.Ping(); err != nil {
		return nil, fmt.Errorf("mysql ping: %w", err)
	}
	return db, nil
}

// ensureDatabase 连接 MySQL（不指定库名），自动创建数据库。
func ensureDatabase(dsn string) error {
	cfg, err := driver.ParseDSN(dsn)
	if err != nil {
		return fmt.Errorf("parse dsn: %w", err)
	}
	dbName := cfg.DBName
	cfg.DBName = ""

	tmp, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return fmt.Errorf("mysql open (no db): %w", err)
	}
	defer tmp.Close()

	_, err = tmp.Exec(fmt.Sprintf(
		"CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", dbName,
	))
	if err != nil {
		return fmt.Errorf("create database: %w", err)
	}
	return nil
}
