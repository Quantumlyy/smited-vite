import type { SmitedClient } from '../client.js';
import type { ResolvedOptions } from '../config.js';
import type { Debouncer } from '../debounce.js';

/**
 * Best-effort error count extraction. We try, in order:
 *
 * 1. The TypeScript "Found N errors" header (also "Found 1 error").
 * 2. A bare "N errors" / "N error" total (e.g. esbuild's summary).
 * 3. Per-line markers: `error TS####:` (TypeScript) and `[ERROR]` (esbuild).
 *
 * If none match, fall back to 1 — the spec says default to the mild
 * sensation when parsing fails, and 1 is the count that maps to mild.
 */
export function parseErrorCount(message: string): number {
  if (message.length === 0) return 1;

  const found = /Found\s+(\d+)\s+errors?\b/i.exec(message);
  if (found?.[1] !== undefined) return Number.parseInt(found[1], 10);

  const total = /\b(\d+)\s+errors?\b/i.exec(message);
  if (total?.[1] !== undefined) return Number.parseInt(total[1], 10);

  const tsCount = (message.match(/\berror TS\d+:/g) ?? []).length;
  const esbuildCount = (message.match(/\[ERROR\]/g) ?? []).length;
  const max = Math.max(tsCount, esbuildCount);
  return max > 0 ? max : 1;
}

/**
 * Classify an observed error event by count and fire the appropriate
 * sensation (debounced). Counts of 6+ trigger the severe sensation;
 * counts of 1-5 trigger the mild one. A null sensation in the resolved
 * options for the chosen class means "skip this event class entirely".
 */
export function classifyAndFire(
  client: SmitedClient,
  debouncer: Debouncer,
  opts: ResolvedOptions,
  message: string,
): void {
  const count = parseErrorCount(message);
  const sensation =
    count >= 6 ? opts.sensations.compileErrorSevere : opts.sensations.compileError;
  if (sensation === null) return;
  if (!debouncer.try('compile', opts.debounceMs.compileError)) return;
  void client.trigger(sensation, { clientTraceId: traceId('ce') });
}

function traceId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}
