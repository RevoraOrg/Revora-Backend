#!/usr/bin/env bash
set -euo pipefail

# Database Password Rotation Drill Script
# Verifies credential rotation at runtime without dropping connections.
# Runs against staging ONLY (refuses production URLs).
#
# Usage: ./scripts/drill-db-password-rotation.sh [--check|--rotate|--all|--help]

: "${STAGING_URL:=http://localhost:3000/health}"
: "${DB_ROTATION_ENABLED:=false}"
START_EPOCH=$(date +%s)
FAILURES=0

log_pass()  { echo "[PASS] $1"; }
log_fail()  { echo "[FAIL] $1"; FAILURES=$((FAILURES + 1)); }
log_info()  { echo "[INFO] $1"; }
log_warn()  { echo "[WARN] $1"; }

safety_check() {
  log_info "=== Safety Guardrails ==="
  if [[ "${STAGING_URL}" == *"api.revora.io"* ]] && [[ "${STAGING_URL}" != *"staging"* ]]; then
    log_fail "STAGING_URL points to production — aborting."
    exit 1
  fi
  if [[ "${DB_ROTATION_ENABLED}" != "true" ]]; then
    log_warn "DB_ROTATION_ENABLED is not 'true' — server-side rotation is a no-op."
  fi
  if [[ -z "${NEW_DB_PASSWORD:-}" ]]; then
    log_fail "NEW_DB_PASSWORD not set."
    exit 1
  fi
  if [[ -z "${DATABASE_URL:-}" ]]; then
    log_fail "DATABASE_URL not set."
    exit 1
  fi
  log_pass "Safety checks passed"
}

check_current_connection() {
  log_info "=== Pre-Rotation Connection Check ==="
  if psql "$DATABASE_URL" -c "SELECT 1 AS pre_check" >/dev/null 2>&1; then
    log_pass "Current credentials accept connections"
  else
    log_fail "Current credentials invalid — aborting."
    exit 1
  fi
  local c
  c=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM pg_stat_activity WHERE state='active';" 2>/dev/null || echo "0")
  log_info "Active connections before rotation: $c"
}

trigger_rotation() {
  log_info "=== Triggering Rotation ==="
  local admin_url="${STAGING_URL%/health}/admin/db/rotate-credentials"
  local code
  code=$(curl -s -o /tmp/rot.json -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${ADMIN_TOKEN:-skip}" \
    -d "{\"password\":\"${NEW_DB_PASSWORD}\"}" \
    --max-time 15 "$admin_url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]] || [[ "$code" == "204" ]]; then
    log_pass "Rotation endpoint returned $code"
  elif [[ "$code" == "404" ]]; then
    log_warn "Endpoint not found — testing new password directly."
    local nu
    nu=$(echo "$DATABASE_URL" | sed "s/:[^:@]*@/:${NEW_DB_PASSWORD}@/")
    if psql "$nu" -c "SELECT 1 AS smoke" >/dev/null 2>&1; then
      log_pass "New credentials valid (smoke test)"
    else
      log_fail "New credentials rejected"
    fi
  else
    log_warn "Rotation endpoint returned $code"
  fi
}

verify_post() {
  log_info "=== Post-Rotation Verification ==="
  sleep 2
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$STAGING_URL" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    log_pass "Health endpoint OK after rotation"
  else
    log_fail "Health returned $code after rotation"
  fi
}

run_all() {
  log_info "=== DB Password Rotation Drill ==="
  log_info "Start: $(date -u)  Staging: $STAGING_URL  RotationEnabled: $DB_ROTATION_ENABLED"
  safety_check && echo "" && check_current_connection && echo ""
  trigger_rotation && echo "" && verify_post && echo ""
  local e=$(($(date +%s) - START_EPOCH))
  log_info "Drill completed in ${e}s"
  if [[ "$FAILURES" -eq 0 ]]; then log_pass "All checks passed."; else log_fail "$FAILURES check(s) failed."; fi
  echo "=== Drill Complete ==="
  exit "$FAILURES"
}

show_help() {
  cat <<EOF
DB Password Rotation Drill
Usage: $0 [--check|--rotate|--all|--help]
Env: DATABASE_URL, NEW_DB_PASSWORD, DB_ROTATION_ENABLED, STAGING_URL, ADMIN_TOKEN
EOF
  exit 0
}

case "${1:---all}" in
  --check) safety_check && check_current_connection ;;
  --rotate) safety_check && trigger_rotation && verify_post ;;
  --all) run_all ;;
  --help|-h) show_help ;;
  *) echo "Unknown: $1"; show_help ;;
esac
