import type { SmitedClient } from '../client.js';
import type { ResolvedOptions } from '../config.js';
import type { Debouncer } from '../debounce.js';

/**
 * Tracks the last HMR update event so the logger.error wrapper can
 * decide whether an incoming error log is an HMR failure (recent
 * handleHotUpdate) or a regular compile error.
 */
export interface HmrState {
  lastFile: string;
  lastFileAt: number;
}

export function createHmrState(): HmrState {
  return { lastFile: '', lastFileAt: 0 };
}

/**
 * Window inside which an error log following a hot-update event is
 * attributed to the HMR pipeline rather than the compile pipeline.
 * Short on purpose — Vite's HMR loop is fast.
 */
const HMR_ERROR_WINDOW_MS = 100;

export function noteHmrUpdate(state: HmrState, file: string): void {
  state.lastFile = file;
  state.lastFileAt = Date.now();
}

/**
 * If a recent hot-update preceded this error, fire the HMR sensation
 * (debounced) and return `true` so the caller can skip the compile-
 * error path. Returns `false` otherwise.
 */
export function maybeFireAsHmrError(
  client: SmitedClient,
  debouncer: Debouncer,
  opts: ResolvedOptions,
  state: HmrState,
): boolean {
  if (state.lastFileAt === 0) return false;
  if (Date.now() - state.lastFileAt > HMR_ERROR_WINDOW_MS) return false;

  // Consume the marker so a single hot-update doesn't shadow every
  // subsequent error in this build session.
  state.lastFileAt = 0;

  const sensation = opts.sensations.hmrError;
  if (sensation === null) return true;
  if (!debouncer.try('hmr', opts.debounceMs.hmrError)) return true;
  void client.trigger(sensation, { clientTraceId: `hmr-${Date.now().toString(36)}` });
  return true;
}
