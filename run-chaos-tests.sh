#!/bin/bash
# Chaos test runner for Revora-Backend.
#
# Issue #706 — Horizon transaction-history gap-injection scenario:
#   ./run-chaos-tests.sh gap
#
# The gap scenario is deterministic per seed (see buildDeterministicGaps /
# seededRandom) and asserts that gap detection emits `ingest.cursor.paused`
# (fatal) and halts cursor advancement rather than skipping records.

set -e

echo "🔥 Running Horizon Chaos Tests..."

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

# Install Jest if not present
if ! npm list jest &> /dev/null; then
  echo "📦 Installing Jest..."
  npm install --save-dev jest @types/jest ts-jest @types/node
fi

# Run tests with different options
case "$1" in
  watch)
    echo "👀 Running tests in watch mode..."
    npm run test:watch
    ;;
  coverage)
    echo "📊 Running tests with coverage..."
    npm run test:coverage
    ;;
  ci)
    echo "🤖 Running tests in CI mode..."
    npm run test:ci
    ;;
  chaos)
    echo "🌀 Running chaos tests only..."
    npm run test:chaos
    ;;
  gap)
    echo "🔍 Running Horizon transaction-history gap-injection chaos (#706)..."
    npx jest src/__tests__/chaos/horizonGapChaos.test.ts --runInBand --forceExit
    ;;
  *)
    echo "Running all tests..."
    npm test
    ;;
esac

echo "✅ Tests completed!"
echo ""
echo "Available scenarios:"
echo "  ./run-chaos-tests.sh gap      – Horizon transaction-history gap-injection (#706)"
echo "  ./run-chaos-tests.sh chaos    – All chaos tests"
echo "  ./run-chaos-tests.sh coverage – Full suite with coverage report"
echo "  ./run-chaos-tests.sh ci       – CI mode (coverage + fail-fast)"
