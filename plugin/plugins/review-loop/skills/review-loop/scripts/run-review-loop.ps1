# Review Loop — PowerShell entry point for Codex plugin
# Usage: .\run-review-loop.ps1 -Request "<user request>"

param(
    [Parameter(Mandatory=$true)]
    [string]$Request
)

$ErrorActionPreference = "Stop"

# Check that review-loop is available
try {
    $null = Get-Command review-loop -ErrorAction Stop
} catch {
    Write-Error "ERROR: 'review-loop' CLI is not installed or not in PATH. Install with: npm install -g goal-review-loop"
    exit 1
}

# Check that we're in a git repository
try {
    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) { throw }
} catch {
    Write-Error "ERROR: Not inside a git repository. Run 'git init' first."
    exit 1
}

# Initialize review-loop if needed
if (-not (Test-Path "review-loop.yaml")) {
    Write-Host "Initializing review-loop..."
    review-loop init
}

Write-Host "Starting review loop with request: $Request"
Write-Host "---"

# Run with --watch for progress display
review-loop start --watch --request $Request
$ExitCode = $LASTEXITCODE

Write-Host "---"
Write-Host "Review loop finished with exit code: $ExitCode"

# Print final state
if (Test-Path ".agent\state.json") {
    Write-Host ""
    Write-Host "Final state:"
    try {
        $state = Get-Content ".agent\state.json" | ConvertFrom-Json
        Write-Host "  Phase: $($state.phase)"
        Write-Host "  Iteration: $($state.iteration) / $($state.max_iterations)"
        Write-Host "  Commit: $($state.final_commit_sha)"
        Write-Host "  Error: $($state.last_error)"
    } catch {
        Get-Content ".agent\state.json"
    }
}

exit $ExitCode
