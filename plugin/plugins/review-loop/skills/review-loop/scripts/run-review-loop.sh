#!/usr/bin/env bash
set -euo pipefail

# Review Loop — Shell entry point for Codex plugin
# Usage: run-review-loop.sh "<user request>"

REQUEST="${1:?Usage: run-review-loop.sh \"<request>\"}"

# Check that review-loop is available
if ! command -v review-loop &>/dev/null; then
  echo "ERROR: 'review-loop' CLI is not installed or not in PATH."
  echo "Install it with: npm install -g goal-review-loop"
  exit 1
fi

# Check that we're in a git repository
if ! git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  echo "ERROR: Not inside a git repository. Run 'git init' first."
  exit 1
fi

# Initialize review-loop if needed
if [ ! -f "review-loop.yaml" ]; then
  echo "Initializing review-loop..."
  review-loop init
fi

echo "Starting review loop with request: ${REQUEST}"
echo "---"

# Run with --watch for progress display
review-loop start --watch --request "${REQUEST}"
EXIT_CODE=$?

echo "---"
echo "Review loop finished with exit code: ${EXIT_CODE}"

# Print final state
if [ -f ".agent/state.json" ]; then
  echo ""
  echo "Final state:"
  cat .agent/state.json | python3 -c "
import sys, json
s = json.load(sys.stdin)
print(f\"  Phase: {s.get('phase', 'unknown')}\")
print(f\"  Iteration: {s.get('iteration', '?')} / {s.get('max_iterations', '?')}\")
print(f\"  Commit: {s.get('final_commit_sha', 'none')}\")
print(f\"  Error: {s.get('last_error', 'none')}\")
" 2>/dev/null || cat .agent/state.json
fi

exit ${EXIT_CODE}
