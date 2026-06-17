import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import {
  resolveProviderEnv,
  probeProxyPort,
  DEFAULT_CANDIDATE_PORTS,
  PROXY_ENV_KEYS,
  NO_PROXY_KEYS,
} from '../../src/providers/network-env.js';
import type { ProviderProfile, ProviderNetworkConfig } from '../../src/types.js';

function makeProfile(network?: ProviderNetworkConfig, env?: Record<string, string>): ProviderProfile {
  return {
    provider_id: 'test',
    display_name: 'Test Provider',
    execution_mode: 'cli',
    command_template: [],
    prompt_transport: 'stdin',
    permission_modes: [],
    transcript_mode: 'stdout_stderr',
    enabled: true,
    network,
    env,
  };
}

describe('resolveProviderEnv', () => {
  describe('inherit mode', () => {
    it('returns no modifications when network is undefined', async () => {
      const profile = makeProfile();
      const result = await resolveProviderEnv(profile);
      expect(result.env).toEqual({});
      expect(result.deleteEnv).toEqual([]);
    });

    it('returns no modifications when proxy_mode is inherit', async () => {
      const profile = makeProfile({ proxy_mode: 'inherit' });
      const result = await resolveProviderEnv(profile);
      expect(result.env).toEqual({});
      expect(result.deleteEnv).toEqual([]);
    });

    it('applies profile.env overlays in inherit mode', async () => {
      const profile = makeProfile(undefined, { MY_VAR: 'hello' });
      const result = await resolveProviderEnv(profile);
      expect(result.env).toEqual({ MY_VAR: 'hello' });
      expect(result.deleteEnv).toEqual([]);
    });
  });

  describe('none mode', () => {
    it('deletes all proxy env keys', async () => {
      const profile = makeProfile({ proxy_mode: 'none' });
      const result = await resolveProviderEnv(profile);
      expect(result.deleteEnv).toEqual([...PROXY_ENV_KEYS]);
    });

    it('does not include proxy keys in the overlay env', async () => {
      const profile = makeProfile({ proxy_mode: 'none' });
      const result = await resolveProviderEnv(profile);
      for (const key of PROXY_ENV_KEYS) {
        expect(result.env[key]).toBeUndefined();
      }
    });

    it('preserves NO_PROXY and no_proxy (not in deleteEnv)', async () => {
      const profile = makeProfile({ proxy_mode: 'none' });
      const result = await resolveProviderEnv(profile);
      for (const key of NO_PROXY_KEYS) {
        expect(result.deleteEnv).not.toContain(key);
      }
    });

    it('applies profile.env overlays', async () => {
      const profile = makeProfile({ proxy_mode: 'none' }, { CUSTOM_VAR: 'value' });
      const result = await resolveProviderEnv(profile);
      expect(result.env.CUSTOM_VAR).toBe('value');
    });
  });

  describe('custom mode', () => {
    it('sets both-case HTTP_PROXY and HTTPS_PROXY to proxy_url', async () => {
      const profile = makeProfile({ proxy_mode: 'custom', proxy_url: 'http://my-proxy:3128' });
      const result = await resolveProviderEnv(profile);
      expect(result.env.HTTP_PROXY).toBe('http://my-proxy:3128');
      expect(result.env.HTTPS_PROXY).toBe('http://my-proxy:3128');
      expect(result.env.http_proxy).toBe('http://my-proxy:3128');
      expect(result.env.https_proxy).toBe('http://my-proxy:3128');
      expect(result.deleteEnv).toEqual([]);
    });

    it('applies profile.env overlays on top of proxy vars', async () => {
      const profile = makeProfile(
        { proxy_mode: 'custom', proxy_url: 'http://my-proxy:3128' },
        { EXTRA: 'val' },
      );
      const result = await resolveProviderEnv(profile);
      expect(result.env.EXTRA).toBe('val');
      expect(result.env.HTTP_PROXY).toBe('http://my-proxy:3128');
    });

    it('profile.env can override proxy_url values', async () => {
      const profile = makeProfile(
        { proxy_mode: 'custom', proxy_url: 'http://my-proxy:3128' },
        { HTTP_PROXY: 'http://override:9999' },
      );
      const result = await resolveProviderEnv(profile);
      // profile.env is spread after proxy vars, so it overrides
      expect(result.env.HTTP_PROXY).toBe('http://override:9999');
    });
  });

  describe('auto mode', () => {
    it('falls back to none behavior when no ports are open', async () => {
      const profile = makeProfile({
        proxy_mode: 'auto',
        candidate_ports: [19999], // very unlikely to be open
      });
      const result = await resolveProviderEnv(profile);
      // Should behave like none mode
      expect(result.deleteEnv).toEqual([...PROXY_ENV_KEYS]);
    });

    it('sets proxy vars when a port is open', async () => {
      // Start a local server on an ephemeral port
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;

      try {
        const profile = makeProfile({
          proxy_mode: 'auto',
          candidate_ports: [port],
        });
        const result = await resolveProviderEnv(profile);
        expect(result.env.HTTP_PROXY).toBe(`http://127.0.0.1:${port}`);
        expect(result.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${port}`);
        expect(result.env.http_proxy).toBe(`http://127.0.0.1:${port}`);
        expect(result.env.https_proxy).toBe(`http://127.0.0.1:${port}`);
        expect(result.deleteEnv).toEqual([]);
      } finally {
        server.close();
      }
    });

    it('uses DEFAULT_CANDIDATE_PORTS when candidate_ports is omitted', async () => {
      const profile = makeProfile({ proxy_mode: 'auto' });
      // This test just verifies the function doesn't throw with default ports
      // and falls back to none (since default ports are unlikely open in CI)
      const result = await resolveProviderEnv(profile);
      // Should either set proxy vars (if a default port is open) or fall back to none
      expect(result).toBeDefined();
      if (result.deleteEnv.length > 0) {
        // Fell back to none
        expect(result.deleteEnv).toEqual([...PROXY_ENV_KEYS]);
      }
    });

    it('picks the first open port', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;

      try {
        const profile = makeProfile({
          proxy_mode: 'auto',
          candidate_ports: [19998, port, 19997], // second port is open
        });
        const result = await resolveProviderEnv(profile);
        expect(result.env.HTTP_PROXY).toBe(`http://127.0.0.1:${port}`);
      } finally {
        server.close();
      }
    });
  });

  describe('regression', () => {
    it('inherit mode produces no env changes (pre-8F behavior)', async () => {
      const profile = makeProfile();
      const result = await resolveProviderEnv(profile);
      // No overlay env, no deletions — identical to pre-8F behavior
      expect(Object.keys(result.env)).toHaveLength(0);
      expect(result.deleteEnv).toHaveLength(0);
    });
  });
});

describe('probeProxyPort', () => {
  it('returns true for an open port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as net.AddressInfo;
    const port = addr.port;

    try {
      const result = await probeProxyPort(port);
      expect(result).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns false for a closed port', async () => {
    const result = await probeProxyPort(19999);
    expect(result).toBe(false);
  });

  it('respects custom timeout', async () => {
    const start = Date.now();
    await probeProxyPort(19999, 50);
    const elapsed = Date.now() - start;
    // Should be roughly within the timeout (allow some overhead)
    expect(elapsed).toBeLessThan(500);
  });
});

describe('DEFAULT_CANDIDATE_PORTS', () => {
  it('contains expected default ports', () => {
    expect(DEFAULT_CANDIDATE_PORTS).toEqual([7890, 7897, 7899, 1080, 1087, 8080]);
  });
});

describe('PROXY_ENV_KEYS', () => {
  it('contains both-case variants of proxy env vars', () => {
    expect(PROXY_ENV_KEYS).toContain('HTTP_PROXY');
    expect(PROXY_ENV_KEYS).toContain('HTTPS_PROXY');
    expect(PROXY_ENV_KEYS).toContain('ALL_PROXY');
    expect(PROXY_ENV_KEYS).toContain('http_proxy');
    expect(PROXY_ENV_KEYS).toContain('https_proxy');
    expect(PROXY_ENV_KEYS).toContain('all_proxy');
  });
});
