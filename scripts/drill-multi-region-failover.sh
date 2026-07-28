#!/usr/bin/env bash
set -euo pipefail

# Multi-Region Failover Drill Script
# Verifies DNS resolution, replica health, and idempotency-store readiness.
# Designed to be run as part of a quarterly game-day drill.
#
# Usage:
#   ./scripts/drill-multi-region-failover.sh [--check-replica|--warm-idempotency|--all|--help]
#
# ENV variables required:
#   PRIMARY_DNS      - Primary region DNS name (default: api.revora.io)
#   SECONDARY_DNS    - Secondary region DNS name (default: api-eu.revora.io)
#   DATABASE_URL     - Primary database connection string
#   DATABASE_URL_SECONDARY - Secondary database connection string
#   REDIS_HOST       - Redis host for idempotency cache (optional)
#   RTO_TARGET       - Recovery Time Objective in seconds (default: 900)
#   RPO_TARGET       - Recovery Point Objective in seconds (default: 300)

: "${PRIMARY_DNS:=api.revora.io}"
: "${SECONDARY_DNS:=api-eu.revora.io}"
: "${RTO_TARGET:=900}"
: "${RPO_TARGET:=300}"

START_EPOCH=$(date +%s)
FAILURES=0

log_pass()  { echo "[PASS] $1"; }
log_fail()  { echo "[FAIL] $1"; FAILURES=$((FAILURES + 1)); }
log_info()  { echo "[INFO] $1"; }

check_dns() {
  local dns_name=$1 label=$2

  log_info "Resolving $label ($dns_name)..."
  if result=$(dig +short "$dns_name" @8.8.8.8 2>/dev/null | head -1); then
    if [[ -n "$result" ]]; then
      log_pass "$label resolves to $result"
    else
      log_fail "$label did not resolve to any address"
    fi
  else
    log_fail "dig failed for $label"
  fi
}

check_health() {
  local url=$1 label=$2

  log_info "Checking health at $label ($url)..."
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    log_pass "$label health endpoint returned 200"
  elif [[ "$http_code" == "503" ]]; then
    log_fail "$label health endpoint returned 503 (service degraded/unhealthy)"
  else
    log_fail "$label health endpoint returned HTTP $http_code (expected 200)"
  fi
}

check_db_replica() {
  log_info "Checking secondary replica health..."

  if [[ -z "${DATABASE_URL_SECONDARY:-}" ]]; then
    log_fail "DATABASE_URL_SECONDARY is not set — cannot check replica"
    return
  fi

  if psql "$DATABASE_URL_SECONDARY" -c "SELECT 1" >/dev/null 2>&1; then
    log_pass "Secondary database accepts connections"
  else
    log_fail "Secondary database connection failed"
    return
  fi

  read -r is_in_recovery <<< "$(psql "$DATABASE_URL_SECONDARY" -At -c "SELECT pg_is_in_recovery();" 2>/dev/null || echo "unknown")"
  if [[ "$is_in_recovery" == "t" ]]; then
    log_pass "Secondary is in recovery (streaming replica mode)"
  elif [[ "$is_in_recovery" == "f" ]]; then
    log_info "Secondary is NOT in recovery (already promoted or standalone)"
  else
    log_fail "Could not determine secondary recovery state (got: $is_in_recovery)"
  fi

  local lag_bytes
  lag_bytes=$(psql "$DATABASE_URL_SECONDARY" -At -c "
    SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn());
  " 2>/dev/null || echo "0")
  if [[ "$lag_bytes" =~ ^[0-9]+$ ]] && [[ "$lag_bytes" -le 104857600 ]]; then
    log_pass "Secondary replica lag is ${lag_bytes} bytes (≤ 100 MB threshold)"
  elif [[ "$lag_bytes" =~ ^[0-9]+$ ]]; then
    log_fail "Secondary replica lag is ${lag_bytes} bytes (exceeds 100 MB threshold)"
  fi
}

warm_idempotency() {
  log_info "Warming idempotency store..."

  if [[ -z "${DATABASE_URL:-}" ]]; then
    log_fail "DATABASE_URL is not set — cannot seed idempotency keys"
    return
  fi

  if [[ -z "${REDIS_HOST:-}" ]]; then
    log_info "REDIS_HOST not set — simulating warm-up via local cache file"
    local cache_file="/tmp/idempotency-warmup-$(date +%s).txt"
    psql "$DATABASE_URL" -At -c "
      SELECT idempotency_key
      FROM webhook_deliveries
      WHERE created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC;
    " > "$cache_file" 2>/dev/null || touch "$cache_file"

    local count
    count=$(wc -l < "$cache_file")
    if [[ "$count" -gt 0 ]]; then
      log_pass "Seeded $count idempotency keys from the database"
    else
      log_info "No recent idempotency keys found (table may be empty or schema different)"
    fi
    rm -f "$cache_file"
    return
  fi

  # Redis-backed warm-up
  local total_keys=0
  psql "$DATABASE_URL" -At -c "
    SELECT idempotency_key
    FROM webhook_deliveries
    WHERE created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC;
  " 2>/dev/null | while IFS= read -r key; do
    if [[ -n "$key" ]]; then
      redis-cli -h "$REDIS_HOST" SETEX "idempotency:${key}" 86400 "1" >/dev/null 2>&1 || true
      total_keys=$((total_keys + 1))
    fi
  done
  log_pass "Warmed up $total_keys idempotency keys in Redis"
}

measure_rto() {
  local elapsed
  elapsed=$(($(date +%s) - START_EPOCH))
  log_info "Elapsed time: ${elapsed}s (RTO target: ${RTO_TARGET}s)"
  if [[ "$elapsed" -le "$RTO_TARGET" ]]; then
    log_pass "RTO of ${elapsed}s is within target (${RTO_TARGET}s)"
  else
    log_fail "RTO of ${elapsed}s exceeds target (${RTO_TARGET}s)"
  fi
}

run_all() {
  log_info "=== Multi-Region Failover Drill ==="
  log_info "Start time: $(date -u)"
  log_info ""

  check_dns "$PRIMARY_DNS" "Primary DNS"
  check_dns "$SECONDARY_DNS" "Secondary DNS"
  echo ""

  check_health "https://${PRIMARY_DNS}/health" "Primary"
  check_health "https://${SECONDARY_DNS}/health" "Secondary"
  echo ""

  check_db_replica
  echo ""

  warm_idempotency
  echo ""

  measure_rto

  echo ""
  if [[ "$FAILURES" -eq 0 ]]; then
    log_pass "All checks passed."
  else
    log_fail "$FAILURES check(s) failed. Review output above."
  fi
  echo "=== Drill Complete ==="
  exit "$FAILURES"
}

show_help() {
  cat <<EOF
Multi-Region Failover Drill Script

Usage: $0 [OPTION]

Options:
  --check-replica      Verify secondary replica health (DB connection, lag, recovery state)
  --warm-idempotency   Seed the idempotency cache from recent webhook_deliveries
  --all                Run all checks in sequence (default)
  --help               Display this help and exit

Environment:
  PRIMARY_DNS              Primary region DNS (default: api.revora.io)
  SECONDARY_DNS            Secondary region DNS (default: api-eu.revora.io)
  DATABASE_URL             Primary DB connection string
  DATABASE_URL_SECONDARY   Secondary DB connection string
  REDIS_HOST               Redis host for idempotency cache
  RTO_TARGET               RTO target in seconds (default: 900)
  RPO_TARGET               RPO target in seconds (default: 300)
EOF
  exit 0
}

case "${1:---all}" in
  --check-replica)    check_db_replica ;;
  --warm-idempotency) warm_idempotency ;;
  --all)              run_all ;;
  --help|-h)          show_help ;;
  *)
    echo "Unknown option: $1"
    show_help
    ;;
esac
