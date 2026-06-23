/**
 * review-loop clean — remove stale run artifacts so a fresh run can start.
 *
 * Safe to run anytime: only deletes re-creatable runtime state files.
 * Does NOT touch events.jsonl (that gets auto-archived by the orchestrator),
 * transcripts, history, or any tracked source files.
 */
import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

export function createCleanCommand(): Command {
  const cmd = new Command('clean');
  cmd
    .description('Remove stale run artifacts (state.json, run.lock, cancel-request, worktrees)')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .option('--dry-run', 'Show what would be cleaned without deleting')
    .action((options) => {
      const agentDir = join(resolve(options.projectRoot), '.agent');
      const dryRun = options.dryRun ?? false;

      const targets: { path: string; label: string }[] = [
        { path: join(agentDir, 'state.json'), label: 'state.json (run state)' },
        { path: join(agentDir, 'run.lock'), label: 'run.lock (lock file)' },
        { path: join(agentDir, 'cancel-request.json'), label: 'cancel-request.json' },
      ];

      // Worktrees directory
      const worktreesDir = join(agentDir, 'worktrees');
      if (existsSync(worktreesDir)) {
        targets.push({ path: worktreesDir, label: 'worktrees/ (parallel worker worktrees)' });
      }

      const existing = targets.filter((t) => existsSync(t.path));

      if (existing.length === 0) {
        console.log('Nothing to clean — no stale run artifacts found.');
        return;
      }

      console.log(dryRun ? 'Would remove:' : 'Removing:');
      for (const t of existing) {
        console.log(`  ${t.label}`);
      }

      if (dryRun) {
        console.log('\n(dry run — nothing was deleted)');
        return;
      }

      for (const t of existing) {
        try {
          rmSync(t.path, { recursive: true, force: true });
        } catch (err) {
          console.error(`  Warning: could not remove ${t.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Prune stale git worktree registrations
      try {
        execSync('git worktree prune', { cwd: resolve(options.projectRoot), stdio: 'pipe' });
      } catch {
        // git may not be available or no worktrees to prune
      }

      console.log(`\nCleaned ${existing.length} item(s). Ready for a fresh run.`);
    });

  return cmd;
}
