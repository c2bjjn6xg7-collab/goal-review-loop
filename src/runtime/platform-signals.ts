/**
 * Windows emulates SIGTERM by unconditionally terminating the target process,
 * so it cannot be used for the orchestrator's graceful cancellation path.
 */
export function supportsGracefulSigterm(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}
