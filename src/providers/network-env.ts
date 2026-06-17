/**
 * Phase 8F: Per-provider network/proxy environment resolver.
 *
 * Computes the child-process environment from the parent env and the
 * provider's network config, WITHOUT mutating the parent env.
 */

import net from 'node:net';
import type { ProviderNetworkConfig, ProviderProfile } from '../types.js';

/** Default ports to probe in auto mode. */
export const DEFAULT_CANDIDATE_PORTS: readonly number[] = [
  7890, 7897, 7899, 1080, 1087, 8080,
];

/** Proxy-related environment variable keys (both cases). */
export const PROXY_ENV_KEYS: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

/** NO_PROXY keys that must be preserved. */
export const NO_PROXY_KEYS: readonly string[] = [
  'NO_PROXY',
  'no_proxy',
];

/**
 * Result of resolving provider environment.
 * - `env`: overlay map to apply on top of process.env
 * - `deleteEnv`: keys to delete from the copied process.env
 */
export interface ResolvedProviderEnv {
  env: Record<string, string>;
  deleteEnv: string[];
}

/**
 * Probe whether a TCP port is open on 127.0.0.1.
 * Returns true if the port accepts a connection within the timeout.
 */
export async function probeProxyPort(
  port: number,
  timeoutMs: number = 200,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Resolve the provider child-process environment based on the network config.
 *
 * This function does NOT mutate any external state. It returns an overlay map
 * (`env`) and a list of keys to delete (`deleteEnv`) that the process
 * runner should apply after copying `process.env`.
 *
 * @param profile - The resolved provider profile (may have network config).
 * @returns Overlay env and keys to delete.
 */
export async function resolveProviderEnv(
  profile: ProviderProfile,
): Promise<ResolvedProviderEnv> {
  const network = profile.network;

  // No network config or inherit → no modifications
  if (!network || network.proxy_mode === 'inherit') {
    return {
      env: { ...(profile.env ?? {}) },
      deleteEnv: [],
    };
  }

  if (network.proxy_mode === 'none') {
    return resolveNoneMode(profile);
  }

  if (network.proxy_mode === 'auto') {
    return resolveAutoMode(profile, network);
  }

  if (network.proxy_mode === 'custom') {
    return resolveCustomMode(profile, network);
  }

  // Fallback (should not happen due to type system)
  return {
    env: { ...(profile.env ?? {}) },
    deleteEnv: [],
  };
}

/**
 * none mode: unset all proxy vars, preserve NO_PROXY, apply profile.env.
 */
function resolveNoneMode(
  profile: ProviderProfile,
): ResolvedProviderEnv {
  const env: Record<string, string> = { ...(profile.env ?? {}) };
  const deleteEnv: string[] = [...PROXY_ENV_KEYS];
  return { env, deleteEnv };
}

/**
 * auto mode: probe candidate_ports; if open, set proxy vars; else fall back to none.
 */
async function resolveAutoMode(
  profile: ProviderProfile,
  network: ProviderNetworkConfig,
): Promise<ResolvedProviderEnv> {
  const ports = network.candidate_ports ?? DEFAULT_CANDIDATE_PORTS;

  for (const port of ports) {
    const isOpen = await probeProxyPort(port);
    if (isOpen) {
      const proxyUrl = `http://127.0.0.1:${port}`;
      const env: Record<string, string> = {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        ...(profile.env ?? {}),
      };
      return { env, deleteEnv: [] };
    }
  }

  // No open port found — fall back to none behavior
  return resolveNoneMode(profile);
}

/**
 * custom mode: set both-case HTTP_PROXY/HTTPS_PROXY to proxy_url.
 */
function resolveCustomMode(
  profile: ProviderProfile,
  network: ProviderNetworkConfig,
): ResolvedProviderEnv {
  const proxyUrl = network.proxy_url ?? '';
  const env: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ...(profile.env ?? {}),
  };
  return { env, deleteEnv: [] };
}
