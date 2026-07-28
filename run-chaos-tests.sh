#!/bin/bash

# Run chaos tests with options

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
    echo "🔍 Running Horizon transaction-history gap-injection chaos..."
    npx jest --testPathPattern="horizonGapChaos" --runInBand --coverage
    ;;
  *)
    echo "Running all tests..."
    npm test
    ;;
esac

echo "✅ Tests completed!"
echo ""
echo "Available scenarios:"
echo "  ./run-chaos-tests.sh gap      – Horizon transaction-history gap-injection"
echo "  ./run-chaos-tests.sh chaos    – All chaos tests"
echo "  ./run-chaos-tests.sh coverage – Full suite with coverage report"
echo "  ./run-chaos-tests.sh ci       – CI mode (coverage + fail-fast)"
