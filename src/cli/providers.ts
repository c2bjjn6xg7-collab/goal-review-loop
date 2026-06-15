import { Command } from 'commander';
import path from 'path';
import { loadConfigWithDefaults } from '../artifacts/config.js';
import { createProviderRegistry } from '../providers/provider-registry.js';

export function createProvidersCommand(): Command {
  const providers = new Command('providers')
    .description('Manage Developer Provider Profiles');

  providers
    .command('list')
    .description('List all registered Provider Profiles')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action(async (opts: { projectRoot: string }) => {
      const projectRoot = path.resolve(opts.projectRoot);
      const config = await loadConfigWithDefaults(projectRoot);
      const registry = createProviderRegistry(config);
      const all = registry.list();

      if (all.length === 0) {
        console.log('No providers registered.');
        return;
      }

      console.log('Provider Profiles:');
      console.log('');
      console.log(padRight('ID', 15) + padRight('Name', 25) + padRight('Enabled', 10) + padRight('Transport', 15) + 'Command');
      console.log('-'.repeat(90));
      for (const p of all) {
        const cmd = p.command_template.length > 0
          ? p.command_template.slice(0, 3).join(' ') + (p.command_template.length > 3 ? '...' : '')
          : '(none)';
        console.log(
          padRight(p.provider_id, 15)
          + padRight(p.display_name, 25)
          + padRight(String(p.enabled), 10)
          + padRight(p.prompt_transport, 15)
          + cmd,
        );
      }
    });

  providers
    .command('test <provider_id>')
    .description('Run health check for a Provider')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action(async (providerId: string, opts: { projectRoot: string }) => {
      const projectRoot = path.resolve(opts.projectRoot);
      const config = await loadConfigWithDefaults(projectRoot);
      const registry = createProviderRegistry(config);
      const profile = registry.resolve(providerId);

      if (!profile) {
        console.error(`Provider "${providerId}" not found.`);
        process.exit(1);
      }

      if (!profile.health_check || profile.health_check.length === 0) {
        console.log(`Provider "${providerId}" has no health check configured.`);
        process.exit(0);
      }

      console.log(`Testing provider "${providerId}" (${profile.health_check.join(' ')})...`);
      const result = registry.healthCheck(providerId);

      if (result.available) {
        console.log(`✅ PASS (${result.duration_ms}ms): ${result.output}`);
      } else {
        console.error(`❌ FAIL (${result.duration_ms}ms): ${result.output}`);
        process.exit(1);
      }
    });

  return providers;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s + ' ' : s + ' '.repeat(len - s.length);
}
