#!/bin/bash

# Add test scripts to package.json
if command -v jq &> /dev/null; then
  # Use jq to update package.json
  tmp=$(mktemp)
  jq '.scripts.test = "jest --coverage" | .scripts["test:watch"] = "jest --watch" | .scripts["test:chaos"] = "jest --testPathPattern=chaos" | .scripts["test:ci"] = "jest --coverage --ci"' package.json > "$tmp" && mv "$tmp" package.json
  echo "✅ Updated package.json with test scripts"
else
  echo "⚠️  jq not found. Please manually add test scripts to package.json"
  echo "Add these to package.json scripts:"
  echo '  "test": "jest --coverage",'
  echo '  "test:watch": "jest --watch",'
  echo '  "test:chaos": "jest --testPathPattern=chaos",'
  echo '  "test:ci": "jest --coverage --ci"'
fi
