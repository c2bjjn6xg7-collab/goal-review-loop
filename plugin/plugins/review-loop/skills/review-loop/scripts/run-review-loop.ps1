#!/usr/bin/env pwsh
# Review Loop — PowerShell entry point for Codex plugin
# Phase 7 §3: Plugin Experience

param(
    [Parameter(Position=0)]
    [string]$Command,

    [Parameter(ValueFromRemainingArguments)]
    [string[]]$Args
)

function Usage {
    Write-Host "Usage: run-review-loop.ps1 <command> [args]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  init                            Initialize review-loop in current project"
    Write-Host "  providers list                  List available providers"
    Write-Host "  providers test <provider>       Test a specific provider"
    Write-Host "  start <request>                 Start a new review loop task"
    Write-Host "  status [--json] [--watch]       Show current run status"
    Write-Host "  resume                          Resume a blocked or interrupted run"
    Write-Host "  cancel                          Cancel a running task"
    Write-Host "  dashboard [--port N] [--no-open] Start local visual dashboard"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  run-review-loop.ps1 init"
    Write-Host "  run-review-loop.ps1 start 'Add user authentication'"
    Write-Host "  run-review-loop.ps1 status --watch"
    Write-Host "  run-review-loop.ps1 dashboard --port 8080 --no-open"
    exit 1
}

function Check-Cli {
    if (-not (Get-Command review-loop -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: 'review-loop' CLI is not installed or not in PATH."
        Write-Host ""
        Write-Host "Install it with:"
        Write-Host "  npm install -g goal-review-loop"
        Write-Host ""
        Write-Host "Or run from source:"
        Write-Host "  git clone <repo-url>"
        Write-Host "  cd goal-review-loop"
        Write-Host "  npm install"
        Write-Host "  npm run build"
        Write-Host "  npm link"
        exit 1
    }
}

function Check-Git {
    try {
        git rev-parse --is-inside-work-tree 2>$null | Out-Null
    } catch {
        Write-Host "ERROR: Not inside a git repository. Run 'git init' first."
        exit 1
    }
}

function Print-Summary {
    $projectRoot = Get-Location

    Write-Host ""
    Write-Host "=== Summary ==="
    Write-Host "Project root: $projectRoot"
    Write-Host "Artifacts: .agent/"

    if (Test-Path ".agent/state.json") {
        try {
            $state = Get-Content ".agent/state.json" | ConvertFrom-Json
            Write-Host "Phase: $($state.phase)"
            Write-Host "Iteration: $($state.iteration) / $($state.max_iterations)"

            if ($state.final_commit_sha) {
                Write-Host "Commit: $($state.final_commit_sha)"
            }

            if ($state.last_error) {
                Write-Host "Error: $($state.last_error)"
            }
        } catch {
            # Ignore parse errors
        }
    }

    Write-Host ""
    Write-Host "Next step:"

    if (Test-Path ".agent/final-audit.md") {
        try {
            $decision = (Select-String -Path ".agent/final-audit.md" -Pattern "^decision:" | Select-Object -First 1).Line.Split(':')[1].Trim()

            switch ($decision) {
                "PASS" {
                    Write-Host "  Run completed successfully. Review .agent/final-audit.md for details."
                }
                { $_ -in @("FAILED", "BLOCKED") } {
                    Write-Host "  Run blocked or failed. Review .agent/audit-report.md and .agent/rework-instructions.md"
                    Write-Host "  Use 'review-loop resume' to retry after fixing issues."
                }
                default {
                    Write-Host "  Run completed. Review .agent/final-audit.md for details."
                }
            }
        } catch {
            Write-Host "  Run completed. Review .agent/final-audit.md for details."
        }
    } elseif (Test-Path ".agent/state.json") {
        try {
            $state = Get-Content ".agent/state.json" | ConvertFrom-Json

            switch ($state.phase) {
                "BLOCKED" {
                    Write-Host "  Run is blocked. Review .agent/audit-report.md"
                    Write-Host "  Use 'review-loop resume' to retry."
                }
                "PASSED" {
                    Write-Host "  Run completed successfully."
                }
                default {
                    Write-Host "  Run in progress. Use 'review-loop status --watch' to monitor."
                }
            }
        } catch {
            Write-Host "  Use 'review-loop status' to check current state."
        }
    } else {
        Write-Host "  Use 'review-loop status' to check current state."
    }
}

# Main
if (-not $Command) {
    Usage
}

Check-Cli

switch ($Command) {
    "init" {
        Check-Git
        Write-Host "Running: review-loop init"
        & review-loop init
        $exitCode = $LASTEXITCODE
        Print-Summary
        exit $exitCode
    }

    "providers" {
        if ($Args.Count -lt 1) {
            Write-Host "ERROR: Missing providers subcommand"
            Usage
        }

        $subCommand = $Args[0]

        switch ($subCommand) {
            "list" {
                Write-Host "Running: review-loop providers list"
                & review-loop providers list
                exit $LASTEXITCODE
            }

            "test" {
                if ($Args.Count -lt 2) {
                    Write-Host "ERROR: Missing provider name"
                    Usage
                }
                $provider = $Args[1]
                Write-Host "Running: review-loop providers test $provider"
                & review-loop providers test $provider
                exit $LASTEXITCODE
            }

            default {
                Write-Host "ERROR: Unknown providers subcommand: $subCommand"
                Usage
            }
        }
    }

    "start" {
        if ($Args.Count -lt 1) {
            Write-Host "ERROR: Missing request"
            Usage
        }

        Check-Git

        $request = $Args[0]

        # Initialize if needed
        if (-not (Test-Path "review-loop.yaml")) {
            Write-Host "Initializing review-loop..."
            & review-loop init
        }

        Write-Host "Starting review loop with request: $request"
        Write-Host "---"
        Write-Host "Running: review-loop start --watch --request `"$request`""

        & review-loop start --watch --request $request
        $exitCode = $LASTEXITCODE

        Write-Host "---"
        Print-Summary
        exit $exitCode
    }

    "status" {
        if ($Args.Count -gt 0) {
            Write-Host "Running: review-loop status $($Args -join ' ')"
            & review-loop status @Args
        } else {
            Write-Host "Running: review-loop status"
            & review-loop status
        }
        $exitCode = $LASTEXITCODE
        Print-Summary
        exit $exitCode
    }

    "resume" {
        Write-Host "Running: review-loop resume"
        & review-loop resume
        $exitCode = $LASTEXITCODE
        Print-Summary
        exit $exitCode
    }

    "cancel" {
        Write-Host "Running: review-loop cancel"
        & review-loop cancel
        exit $LASTEXITCODE
    }

    "dashboard" {
        if ($Args.Count -gt 0) {
            Write-Host "Running: review-loop dashboard $($Args -join ' ')"
            & review-loop dashboard @Args
        } else {
            Write-Host "Running: review-loop dashboard"
            & review-loop dashboard
        }
        exit $LASTEXITCODE
    }

    default {
        Write-Host "ERROR: Unknown command: $Command"
        Usage
    }
}
