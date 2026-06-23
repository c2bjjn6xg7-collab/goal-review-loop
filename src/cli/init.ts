/**
 * CLI `init` command — initializes project configuration and .agent/ directory.
 * Design doc §4.1
 */
import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import { generateSampleConfig } from '../artifacts/config.js';
import { getBundledTemplatesDir } from '../agents/prompt-builder.js';

export function initCommand(): Command {
  const cmd = new Command('init');

  cmd
    .description('Initialize project configuration and .agent/ directory')
    .option('--init-git', 'Allow git init if not a git repository')
    .action(async (options: { initGit?: boolean }) => {
      const projectRoot = process.cwd();

      try {
        await executeInit(projectRoot, options);
        console.log('✓ Goal Review Loop initialized successfully.');
        console.log();
        console.log('Next steps:');
        console.log('  1. Configure your AI agents (default uses codex for planner/auditor):');
        console.log('     review-loop config agents                          # view current config');
        console.log('     review-loop config agents --set planner=opencode/ownplan/deepseekv4pro');
        console.log('     review-loop config agents --set developer=claude');
        console.log('  2. Review and commit review-loop.yaml and .gitignore changes');
        console.log('  3. Ensure working tree is clean');
        console.log('  4. Run: review-loop start --request "your task" --parallel');
      } catch (err) {
        console.error(`✗ Init failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}

/**
 * Execute the init logic.
 */
export async function executeInit(
  projectRoot: string,
  options: { initGit?: boolean },
): Promise<void> {
  // 1. Check if current directory is a git repository
  const gitDir = path.join(projectRoot, '.git');
  const isGitRepo = await fs.pathExists(gitDir);

  if (!isGitRepo) {
    if (options.initGit) {
      const { execFileSync } = await import('child_process');
      execFileSync('git', ['init'], { cwd: projectRoot });
      console.log('  Initialized git repository.');
    } else {
      throw new Error(
        'Not a git repository. Use --init-git to initialize one, or run from a git project root.',
      );
    }
  }

  // 2. Create review-loop.yaml if it doesn't exist
  const configPath = path.join(projectRoot, 'review-loop.yaml');
  if (!(await fs.pathExists(configPath))) {
    const sampleConfig = generateSampleConfig();
    await fs.writeFile(configPath, sampleConfig, 'utf8');
    console.log('  Created review-loop.yaml (sample configuration).');
  } else {
    console.log('  review-loop.yaml already exists — skipping.');
  }

  // 3. Initialize .agent/ directory structure
  const store = new ArtifactStore(projectRoot);
  await store.init();
  console.log('  Created .agent/ directory structure.');

  // 4. Update .gitignore with local-only artifact entries
  await store.updateGitignore();
  console.log('  Updated .gitignore with local runtime file rules.');

  // 5. Copy prompt templates to project (if prompts/ doesn't exist)
  const promptsDir = path.join(projectRoot, 'prompts');
  if (!(await fs.pathExists(promptsDir))) {
    const bundledDir = getBundledTemplatesDir();
    if (await fs.pathExists(bundledDir)) {
      await fs.copy(bundledDir, promptsDir);
      console.log('  Created prompts/ directory with default templates.');
    } else {
      console.log('  ⚠ No bundled prompt templates found — you may need to create prompts/ manually.');
    }
  } else {
    console.log('  prompts/ directory already exists — skipping template copy.');
  }

  // 6. Check that local-only files are not already tracked by Git
  if (isGitRepo) {
    await checkLocalFilesNotTracked(projectRoot);
  }

  // 7. F-704: Check provider availability and warn
  await checkProviderAvailability();
}

/**
 * F-704: Check if default provider CLIs are available on the system.
 * Warns the user if the default config references tools that aren't installed.
 */
async function checkProviderAvailability(): Promise<void> {
  const { execFileSync } = await import('child_process');

  const providers = [
    { name: 'claude', role: 'Developer', installHint: 'https://docs.anthropic.com/en/docs/claude-code' },
    { name: 'codex', role: 'Planner/Auditor/Final Auditor', installHint: 'https://platform.openai.com/docs/codex' },
  ];

  const missing: Array<{ name: string; role: string; installHint: string }> = [];

  for (const provider of providers) {
    try {
      execFileSync(provider.name, ['--version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
    } catch {
      missing.push(provider);
    }
  }

  if (missing.length > 0) {
    console.log();
    console.log('  ⚠ Provider availability check:');
    for (const m of missing) {
      console.log(`    - "${m.name}" not found in PATH (used as ${m.role})`);
      console.log(`      Install: ${m.installHint}`);
      console.log(`      Or configure an alternative provider in review-loop.yaml`);
    }
    console.log();
    console.log('  The default review-loop.yaml uses these tools. If you use a different');
    console.log('  AI coding CLI, update the agents section in review-loop.yaml or use');
    console.log('  the providers configuration block. See: review-loop providers list');
  } else {
    console.log('  ✓ All default providers available (claude, codex).');
  }
}

/**
 * Check that local-only artifact files are not already tracked by Git.
 * Design doc §4.1: "若 .agent/state.json 等本地运行文件已经被 Git 跟踪，则停止并提示迁移"
 */
async function checkLocalFilesNotTracked(
  projectRoot: string,
): Promise<void> {
  const { execFileSync } = await import('child_process');
  const localFiles = [
    '.agent/state.json',
    '.agent/run.lock',
    '.agent/iteration-log.md',
    '.agent/progress.json',
    '.agent/progress.md',
    '.agent/verification/',
    '.agent/evidence/',
    '.agent/history/',
    '.agent/debug/',
    '.agent/transcripts/',
  ];

  const trackedFiles: string[] = [];

  for (const file of localFiles) {
    try {
      // git ls-files checks if a path is tracked
      const result = execFileSync('git', ['ls-files', '--error-unmatch', file], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.trim()) {
        trackedFiles.push(file);
      }
    } catch {
      // Not tracked — this is expected and good
    }
  }

  if (trackedFiles.length > 0) {
    throw new Error(
      `The following local runtime files are already tracked by Git and must be removed from tracking:\n`
      + trackedFiles.map((f) => `  - ${f}`).join('\n')
      + '\n\nRun: git rm --cached <file> for each, then commit.',
    );
  }
}
