import type { SmitedClient } from '../client.js';
import type { ResolvedOptions } from '../config.js';
import type { Debouncer } from '../debounce.js';

/**
 * Fire the build-success sensation only if every gate is met:
 * - Vite is in production-build mode (caller passes the cached command).
 * - The build took longer than the configured threshold.
 * - The user hasn't disabled the sensation by setting it to `null`.
 *
 * The duration gate is what prevents zapping for trivial builds — a
 * 200ms incremental build doesn't deserve celebration, a 90-second
 * cold build does.
 */
export function maybeFireBuildSuccess(
  client: SmitedClient,
  debouncer: Debouncer,
  opts: ResolvedOptions,
  startTimestamp: number,
  command: 'build' | 'serve',
): void {
  if (command !== 'build') return;
  if (startTimestamp === 0) return;
  const duration = Date.now() - startTimestamp;
  if (duration < opts.buildSuccessMinDurationMs) return;
  const sensation = opts.sensations.buildSuccess;
  if (sensation === null) return;
  if (!debouncer.try('build', opts.debounceMs.buildSuccess)) return;
  void client.trigger(sensation, { clientTraceId: `bs-${Date.now().toString(36)}` });
}
