---
schema_version: 1
run_id: phase3-dev
iteration: 5
author_role: developer
title: "F-315R1 Scope Guard Fix + F-312R1 Smoke Report (Run 5)"
status: COMPLETED
date: 2026-06-13
---

# F-315R1 — Scope Guard Dependency Cache Exclusion (Untracked Only)

## Finding

F-315R1: The initial F-315 fix excluded all files matching `DEPENDENCY_CACHE_PATTERNS`
regardless of tracking status. A tracked-and-modified `.pnp.cjs` or
`.yarn/plugins/...` would bypass `allowed_changes` and yield `passed: true` — a
scope validation bypass.

## Root Cause

`checkScope()` used only path-pattern matching (`matchesPattern(filePath, DEPENDENCY_CACHE_PATTERNS)`)
without checking `file.status` or `file.tracked`. This meant:
- A committed `.pnp.cjs` modified by Developer → excluded → `passed: true` (bypass)
- A committed `.yarn/plugins/@yarnpkg/plugin-interactive-tools.cjs` modified → excluded → bypass
- `.yarn/**` was too broad — it covered `.yarn/releases/`, `.yarn/patches/`, `.yarn/plugins/`
  which are tracked project source in Yarn repos

## Fix Applied

### 1. Guard condition: untracked-only exclusion

```typescript
// Before (F-315):
if (matchesPattern(filePath, DEPENDENCY_CACHE_PATTERNS)) {

// After (F-315R1):
if (file.status === 'untracked' && file.tracked === false && matchesPattern(filePath, DEPENDENCY_CACHE_PATTERNS)) {
```

Tracked dependency files must now pass `allowed_changes` like any other file.

### 2. Narrowed patterns

```typescript
// Before (F-315):
const DEPENDENCY_CACHE_PATTERNS = [
  'node_modules/**',
  '.pnpm-store/**',
  '.yarn/**',          // ← too broad
  '.pnp.cjs',          // ← tracked project source
  '.pnp.loader.mjs',   // ← tracked project source
];

// After (F-315R1):
const DEPENDENCY_CACHE_PATTERNS = [
  'node_modules/**',
  '.pnpm-store/**',
  '.yarn/cache/**',        // explicit cache dir
  '.yarn/unplugged/**',    // explicit cache dir
  '.yarn/install-state.gz', // explicit cache file
];
```

Removed: `.yarn/**`, `.pnp.cjs`, `.pnp.loader.mjs` — these are tracked project
source in Yarn PnP repos and must not be blanket-excluded.

## Regression Tests (9 F-315R1 tests, replaced 7 F-315 tests)

| # | Scenario | Expected |
|---|---|---|
| 1 | Untracked `node_modules/.vite/vitest/results.json` | Excluded, `passed: true` |
| 2 | Tracked `node_modules/my-pkg/index.js` modified | Denied `outside_allowed_changes` |
| 3 | Tracked `.pnp.cjs` modified | Denied `outside_allowed_changes` |
| 4 | Tracked `.yarn/plugins/...` modified | Denied `outside_allowed_changes` |
| 5 | Untracked `.yarn/cache/**`, `.pnpm-store/**`, `.yarn/unplugged/**`, `.yarn/install-state.gz` | Excluded |
| 6 | Business files outside `allowed_changes` | Denied |
| 7 | Developer forging `.agent/evidence` | Denied `system_protected` |
| 8 | Developer modifying `.agent/GOAL.md` + `.agent/state.json` | Denied `system_protected` |
| 9 | Mixed: untracked cache excluded + tracked cache denied + business denied | Correct classification |

## Engineering Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| `npm run lint` | ✅ PASS (0 warnings) |
| `npm run build` | ✅ PASS |
| `npm test` | ✅ 526 passed (28 files) |
| `npm pack --dry-run` | ✅ 120 files, 113.6 kB |

## F-312R1 Smoke Test — Run 5

**FULL CHAIN COMPLETE: Planner ✅ Developer ✅ Auditor ✅ FINALIZING ✅**

| Item | Value |
|---|---|
| Run ID | `20260613160600-0s08po` |
| Temp repo | `/tmp/f312r1-smoke-20260613-090451` |
| All roles | Claude Sonnet via `claude -p --model sonnet` |
| Phase | **FINALIZING** |
| Audit decision | **PASS** |

| Role | Result | Detail |
|---|---|---|
| Planner | ✅ | Valid plan.md + GOAL.md |
| Developer | ✅ | Correct `hello.js`, `npm test` ran once, handoff COMPLETED |
| Scope guard | ✅ | `passed: true`, `denied: []`, `excluded_dependency_cache: []` |
| Auditor | ✅ | PASS — all 5 success criteria met |
| Final phase | **FINALIZING** | Not committed (Phase 5) |

### Scope Report (Run 5)

```json
{
  "schema_version": 2,
  "passed": true,
  "allowed": [".agent/developer-handoff.md", "src/hello.js", "src/hello.test.js"],
  "excluded_orchestrator_owned": [/* 17 orchestrator files */],
  "excluded_dependency_cache": [],
  "denied": [],
  "warnings": []
}
```

## What Was Proven

- ✅ **Full Planner → Developer → Auditor → FINALIZING chain** with real model.
- ✅ **F-315R1**: Untracked `node_modules/.vite/**` excluded; tracked `.pnp.cjs` / `.yarn/plugins/` still denied.
- ✅ **F-315R1**: No scope validation bypass for tracked dependency files.
- ✅ **SF-2/SF-3/SF-4**: All prior fixes still effective.
- ✅ SC-15: macOS Trial now PASS.
