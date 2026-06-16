#!/usr/bin/env bash
set -euo pipefail

# Review Loop — Shell entry point for Codex plugin
# Phase 7 §3: Plugin Experience

usage() {
  echo "Usage: run-review-loop.sh <command> [args]"
  echo ""
  echo "Commands:"
  echo "  init                            Initialize review-loop in current project"
  echo "  providers list                  List available providers"
  echo "  providers test <provider>       Test a specific provider"
  echo "  start <request>                 Start a new review loop task"
  echo "  status [--json] [--watch]       Show current run status"
  echo "  resume                          Resume a blocked or interrupted run"
  echo "  cancel                          Cancel a running task"
  echo "  dashboard [--port N] [--no-open] Start local visual dashboard"
  echo ""
  echo "Examples:"
  echo "  run-review-loop.sh init"
  echo "  run-review-loop.sh start \"Add user authentication\""
  echo "  run-review-loop.sh status --watch"
  echo "  run-review-loop.sh dashboard --port 8080 --no-open"
  exit 1
}

# Check that review-loop is available
check_cli() {
  if ! command -v review-loop &>/dev/null; then
    echo "ERROR: 'review-loop' CLI is not installed or not in PATH."
    echo ""
    echo "Install it with:"
    echo "  npm install -g goal-review-loop"
    echo ""
    echo "Or run from source:"
    echo "  git clone <repo-url>"
    echo "  cd goal-review-loop"
    echo "  npm install"
    echo "  npm run build"
    echo "  npm link"
    exit 1
  fi
}

# Check that we're in a git repository
check_git() {
  if ! git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
    echo "ERROR: Not inside a git repository. Run 'git init' first."
    exit 1
  fi
}

# Print artifact summary
print_summary() {
  local project_root
  project_root=$(pwd)

  echo ""
  echo "=== Summary ==="
  echo "Project root: ${project_root}"
  echo "Artifacts: .agent/"

  if [ -f ".agent/state.json" ]; then
    local phase iteration max_iter
    phase=$(cat .agent/state.json | python3 -c "import sys, json; print(json.load(sys.stdin).get('phase', 'unknown'))" 2>/dev/null || echo "unknown")
    iteration=$(cat .agent/state.json | python3 -c "import sys, json; print(json.load(sys.stdin).get('iteration', '?'))" 2>/dev/null || echo "?")
    max_iter=$(cat .agent/state.json | python3 -c "import sys, json; print(json.load(sys.stdin).get('max_iterations', '?'))" 2>/dev/null || echo "?")

    echo "Phase: ${phase}"
    echo "Iteration: ${iteration} / ${max_iter}"

    local commit
    commit=$(cat .agent/state.json | python3 -c "import sys, json; print(json.load(sys.stdin).get('final_commit_sha', 'none'))" 2>/dev/null || echo "none")
    if [ "$commit" != "none" ] && [ -n "$commit" ]; then
      echo "Commit: ${commit}"
    fi

    local error
    error=$(cat .agent/state.json | python3 -c "import sys, json; print(json.load(sys.stdin).get('last_error', ''))" 2>/dev/null || echo "")
    if [ -n "$error" ] && [ "$error" != "null" ]; then
      echo "Error: ${error}"
    fi
  fi

  echo ""
  echo "Next step:"
  if [ -f ".agent/final-audit.md" ]; then
    local decision
    decision=$(grep -E "^decision:" .agent/final-audit.md 2>/dev/null | head -1 | cut -d: -f2- | tr -d ' ' || echo "unknown")
    case "$decision" in
      PASS)
        echo "  Run completed successfully. Review .agent/final-audit.md for details."
        ;;
      FAILED|BLOCKED)
        echo "  Run blocked or failed. Review .agent/audit-report.md and .agent/rework-instructions.md"
        echo "  Use 'review-loop resume' to retry after fixing issues."
        ;;
      *)
        echo "  Run completed. Review .agent/final-audit.md for details."
        ;;
    esac
  elif [ -f ".agent/state.json" ]; then
    local phase
    phase=$(cat .agent/state.json | python3 -c "import sys, json; print(json.load(sys.stdin).get('phase', 'unknown'))" 2>/dev/null || echo "unknown")
    case "$phase" in
      BLOCKED)
        echo "  Run is blocked. Review .agent/audit-report.md"
        echo "  Use 'review-loop resume' to retry."
        ;;
      PASSED)
        echo "  Run completed successfully."
        ;;
      *)
        echo "  Run in progress. Use 'review-loop status --watch' to monitor."
        ;;
    esac
  else
    echo "  Use 'review-loop status' to check current state."
  fi
}

# Main
if [ $# -lt 1 ]; then
  usage
fi

check_cli

COMMAND="${1}"
shift

case "${COMMAND}" in
  init)
    check_git
    echo "Running: review-loop init"
    review-loop init
    EXIT_CODE=$?
    print_summary
    exit ${EXIT_CODE}
    ;;

  providers)
    if [ $# -lt 1 ]; then
      echo "ERROR: Missing providers subcommand"
      usage
    fi

    SUBCOMMAND="${1}"
    shift

    case "${SUBCOMMAND}" in
      list)
        echo "Running: review-loop providers list"
        review-loop providers list
        EXIT_CODE=$?
        exit ${EXIT_CODE}
        ;;

      test)
        if [ $# -lt 1 ]; then
          echo "ERROR: Missing provider name"
          usage
        fi
        PROVIDER="${1}"
        echo "Running: review-loop providers test ${PROVIDER}"
        review-loop providers test "${PROVIDER}"
        EXIT_CODE=$?
        exit ${EXIT_CODE}
        ;;

      *)
        echo "ERROR: Unknown providers subcommand: ${SUBCOMMAND}"
        usage
        ;;
    esac
    ;;

  start)
    if [ $# -lt 1 ]; then
      echo "ERROR: Missing request"
      usage
    fi

    check_git

    REQUEST="${1}"

    # Initialize if needed
    if [ ! -f "review-loop.yaml" ]; then
      echo "Initializing review-loop..."
      review-loop init
    fi

    echo "Starting review loop with request: ${REQUEST}"
    echo "---"
    echo "Running: review-loop start --watch --request \"${REQUEST}\""

    review-loop start --watch --request "${REQUEST}"
    EXIT_CODE=$?

    echo "---"
    print_summary
    exit ${EXIT_CODE}
    ;;

  status)
    if [ $# -gt 0 ]; then
      echo "Running: review-loop status $*"
      review-loop status "$@"
    else
      echo "Running: review-loop status"
      review-loop status
    fi
    EXIT_CODE=$?
    print_summary
    exit ${EXIT_CODE}
    ;;

  resume)
    echo "Running: review-loop resume"
    review-loop resume
    EXIT_CODE=$?
    print_summary
    exit ${EXIT_CODE}
    ;;

  cancel)
    echo "Running: review-loop cancel"
    review-loop cancel
    EXIT_CODE=$?
    exit ${EXIT_CODE}
    ;;

  dashboard)
    if [ $# -gt 0 ]; then
      echo "Running: review-loop dashboard $*"
      review-loop dashboard "$@"
    else
      echo "Running: review-loop dashboard"
      review-loop dashboard
    fi
    EXIT_CODE=$?
    exit ${EXIT_CODE}
    ;;

  *)
    echo "ERROR: Unknown command: ${COMMAND}"
    usage
    ;;
esac
