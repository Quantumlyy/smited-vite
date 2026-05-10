import type { SmitedClient } from '../client.js';
import type { ResolvedOptions } from '../config.js';
import type { Debouncer } from '../debounce.js';

/**
 * Fire the build-success sensation if every gate is met:
 * - Vite is in production-build mode (caller passes the cached command).
 * - The build took longer than the configured threshold.
 * - The user hasn't disabled the sensation by setting it to `null`.
 *
 * Returns the in-flight trigger promise when fired (so the caller can
 * await it briefly before tearing down the h2c session), or `null` when
 * a gate skipped the trigger. Promise resolves to `true` on accepted,
 * `false` on any failure path — never throws.
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
): Promise<boolean> | null {
  if (command !== 'build') return null;
  if (startTimestamp === 0) return null;
  const duration = Date.now() - startTimestamp;
  if (duration < opts.buildSuccessMinDurationMs) return null;
  const sensation = opts.sensations.buildSuccess;
  if (sensation === null) return null;
  if (!debouncer.try('build', opts.debounceMs.buildSuccess)) return null;
  return client.trigger(sensation, { clientTraceId: `bs-${Date.now().toString(36)}` });
}
