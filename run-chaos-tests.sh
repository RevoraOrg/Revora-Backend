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
  *)
    echo "Running all tests..."
    npm test
    ;;
esac

echo "✅ Tests completed!"
