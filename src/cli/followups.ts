/**
 * Phase 10: `review-loop followups` subcommand.
 *
 *   review-loop followups list              Print .agent/followups.md
 *   review-loop followups close <index>     Mark the Nth open checkbox item closed
 *
 * The followups file is an append-only markdown log of checkbox items emitted
 * by the feedback dispatcher. `close` rewrites the file in place, converting the
 * Nth `- [ ]` to `- [x]`. Best-effort; never throws into the shell beyond a
 * clean error message.
 */
import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FOLLOWUPS_REL = '.agent/followups.md';

function followupsPath(projectRoot: string): string {
  return join(projectRoot, FOLLOWUPS_REL);
}

export function createFollowupsCommand(): Command {
  const cmd = new Command('followups');
  cmd.description('Manage Phase 10 followup tasks (.agent/followups.md)');

  cmd
    .command('list')
    .description('List open followup items')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action((options) => {
      const abs = followupsPath(options.projectRoot);
      if (!existsSync(abs)) {
        console.log('(no followups file — .agent/followups.md not found)');
        return;
      }
      const content = readFileSync(abs, 'utf8');
      const openItems = extractOpenItems(content);
      if (openItems.length === 0) {
        console.log('(no open followup items)');
        return;
      }
      console.log(`Open followup items (${openItems.length}):\n`);
      openItems.forEach((item, i) => {
        console.log(`  [${i + 1}] ${item}`);
      });
      console.log('\nFull log: .agent/followups.md');
    });

  cmd
    .command('close <index>')
    .description('Mark the Nth open followup item as closed (1-based index from `list`)')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action((indexStr: string, options) => {
      const abs = followupsPath(options.projectRoot);
      if (!existsSync(abs)) {
        console.error('No followups file found.');
        process.exitCode = 1;
        return;
      }
      const idx = Number.parseInt(indexStr, 10);
      if (!Number.isInteger(idx) || idx < 1) {
        console.error(`Invalid index: ${indexStr} (expected a positive integer)`);
        process.exitCode = 1;
        return;
      }
      const content = readFileSync(abs, 'utf8');
      const lines = content.split('\n');
      let openCount = 0;
      let closedAny = false;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*- \[)( )(\].*)$/);
        if (m) {
          openCount += 1;
          if (openCount === idx) {
            lines[i] = `${m[1]}x${m[3]}`;
            closedAny = true;
            break;
          }
        }
      }
      if (!closedAny) {
        console.error(`No open item at index ${idx} (found ${openCount} open items).`);
        process.exitCode = 1;
        return;
      }
      writeFileSync(abs, lines.join('\n'), 'utf8');
      console.log(`Closed followup item ${idx}.`);
    });

  return cmd;
}

/** Extract the text of every `- [ ]` checkbox item (open items). */
export function extractOpenItems(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*- \[ \] (.*)$/);
    if (m) items.push(m[1].trim());
  }
  return items;
}
