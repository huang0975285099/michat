# IronFist Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove disabled legacy settlement implementations that make static analysis fail, and add repeatable coverage for PvP matchmaking recovery behavior.

**Architecture:** Keep the authoritative service contract unchanged. Legacy entry points remain as small explicit rejection methods; unreachable historical transaction code is removed. Matching behavior is verified at the MySQL service boundary, while the frontend testable state transitions remain isolated from Vue rendering.

**Tech Stack:** Go, MySQL integration tests, Node test runner, Vue 3.

## Global Constraints

- Do not change published API response shapes or settlement rules.
- All database tests use the existing isolated MySQL database helper.
- No private keys or user credentials are stored in tests.

---

### Task 1: Remove unreachable legacy settlement code

**Files:**
- Modify: `backend/internal/service/fist.go`
- Modify: `backend/internal/service/ironfist.go`
- Test: `backend/internal/service/ironfist_settlement_test.go`

- [ ] Keep `ClaimPvEReward` returning `ErrLegacyPvEClaimDisabled`; remove only its unreachable historical transaction body.
- [ ] Keep `SettlePVP` returning `ErrLegacyPVPReportDisabled`; remove only its unreachable historical transaction body.
- [ ] Run `go test ./...` and `go vet ./...` from `backend`.

### Task 2: Verify matchmaking recovery contracts

**Files:**
- Modify: `backend/internal/service/ironfist_authority_integration_test.go`
- Test: `backend/internal/service/ironfist_authority_integration_test.go`

- [ ] Verify concurrent candidates can create only one match for a waiting player.
- [ ] Verify the waiting player receives a matched queue status containing room, game, and opponent data, which is the polling fallback contract.
- [ ] Run the integration test repeatedly and then run `go test ./...`.
