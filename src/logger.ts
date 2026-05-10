import type { Logger } from 'vite';

/**
 * Tagged wrapper around Vite's logger.
 *
 * The plugin uses `info` exactly once — for the startup "active" line —
 * and routes every other observation through `debug`. `debug` is silent
 * unless the `DEBUG` environment variable mentions `smited`, matching
 * the conventional debug-namespace pattern. This keeps the plugin
 * invisible during normal builds and chatty under `DEBUG=smited*`.
 */
export interface TaggedLogger {
  info(message: string): void;
  debug(message: string): void;
}

const TAG = '[smited-vite]';

/**
 * Wrap a Vite `Logger` so its output gets the `[smited-vite]` prefix
 * and a debug channel that respects `process.env.DEBUG`.
 */
export function createTaggedLogger(base: Logger): TaggedLogger {
  return {
    info(message: string): void {
      base.info(`${TAG} ${message}`);
    },
    debug(message: string): void {
      if (!isDebugEnabled()) return;
      base.info(`${TAG} [debug] ${message}`);
    },
  };
}

function isDebugEnabled(): boolean {
  const raw = process.env.DEBUG;
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return raw.toLowerCase().includes('smited');
}
