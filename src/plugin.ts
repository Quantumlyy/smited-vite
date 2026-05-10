import type { LogErrorOptions, Logger, Plugin } from 'vite';
import { SmitedClient } from './client.js';
import {
  type PluginOptions,
  type ResolvedOptions,
  resolveOptions,
} from './config.js';
import { Debouncer } from './debounce.js';
import { createTaggedLogger, type TaggedLogger } from './logger.js';
import {
  classifyAndFire,
  createHmrState,
  type HmrState,
  maybeFireAsHmrError,
  maybeFireBuildSuccess,
  noteHmrUpdate,
} from './triggers/index.js';

/**
 * Marker stored on Vite's logger object so a single Vite session
 * doesn't end up with the logger.error method wrapped twice if the
 * plugin is registered more than once.
 */
const WRAPPED_MARKER = Symbol.for('@quantumly-labs/smited-vite/wrapped');

type WrappableLogger = Logger & { [WRAPPED_MARKER]?: true };

/**
 * Vite plugin factory.
 *
 * The plugin fires haptic sensations on the smited daemon in response
 * to compile errors, HMR errors, and long successful production
 * builds. With no options and no `SMITED_HOST` environment variable,
 * the plugin is a complete no-op — every hook short-circuits, no
 * network is touched, no logs appear. This is what makes the package
 * safe to commit to projects whose other contributors don't have
 * smited hardware.
 *
 * @example
 *   // vite.config.ts
 *   import { smitedVite } from '@quantumly-labs/smited-vite';
 *
 *   export default defineConfig({
 *     plugins: [smitedVite()],
 *   });
 *
 *   // shell rc (only the developer with hardware sets this)
 *   export SMITED_HOST=windows-rig.local:7777
 */
export function smitedVite(options?: PluginOptions): Plugin {
  let resolved: ResolvedOptions | undefined;
  let logger: TaggedLogger | undefined;
  let client: SmitedClient | null = null;
  const debouncer = new Debouncer();
  const hmrState: HmrState = createHmrState();
  let buildStartedAt = 0;
  /** Set in writeBundle. Required for success firing in closeBundle. */
  let wroteBundle = false;
  /**
   * Set when any error is seen during the current build — either
   * `buildEnd(err)` (input phase) or the wrapped `logger.error` (any
   * phase). Vite logs failures via `logger.error` before calling
   * `bundle.close()` (which fires our `closeBundle`), so this flag is
   * reliably true at success-decision time when the build ultimately
   * exits non-zero.
   */
  let errorObserved = false;
  let command: 'build' | 'serve' = 'serve';
  /**
   * `vite build --watch` reuses the same plugin instance across
   * rebuilds: configResolved runs once, but buildStart/buildEnd/
   * closeBundle fire per cycle. In watch mode we must not abort the
   * h2c session in closeBundle or every cycle past the first dies.
   * The session is torn down in closeWatcher instead, which Rollup
   * fires when the watcher itself is closed.
   */
  let isWatchMode = false;

  /**
   * Brief window to await in-flight triggers before tearing down the
   * h2c session. Tuned short enough to be invisible against a slow
   * build, long enough for a healthy local-network unary call to
   * complete.
   */
  const TRIGGER_DEADLINE_MS = 250;

  const safeRun = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger?.debug(`${label}: ${describeError(err)}`);
    }
  };

  return {
    name: 'smited-vite',

    config() {
      resolved = resolveOptions(options);
    },

    configResolved(viteConfig) {
      if (resolved === undefined || !resolved.active) return;
      command = viteConfig.command;
      // build.watch is a WatcherOptions object when --watch is in use,
      // null otherwise. Cast through unknown because our Vite types
      // are typed loosely in tests.
      isWatchMode =
        command === 'build' &&
        (viteConfig as unknown as { build?: { watch?: unknown } }).build?.watch != null;
      const tagged = createTaggedLogger(viteConfig.logger);
      logger = tagged;
      tagged.info(
        `active, host=${resolved.host ?? '<unknown>'}, backend=${resolved.backendId}`,
      );
      const c = new SmitedClient(resolved.host ?? '', resolved.backendId, tagged);
      client = c;
      void c
        .healthCheck()
        .then((summary) => {
          if (summary === null) {
            tagged.debug('health: daemon unreachable (will continue, may come up later)');
          } else {
            tagged.debug(
              `health: ok, version=${summary.version}, backends=${summary.backends.length}`,
            );
          }
        })
        .catch(() => {
          // healthCheck never throws; this is here for completeness only.
        });

      wrapLoggerError(viteConfig.logger as WrappableLogger, () => ({
        client: c,
        debouncer,
        opts: resolved!,
        hmrState,
        markErrorObserved: () => {
          errorObserved = true;
        },
      }));
    },

    buildStart() {
      if (resolved?.active !== true) return;
      buildStartedAt = Date.now();
      wroteBundle = false;
      errorObserved = false;
    },

    buildEnd(err) {
      // Note: deliberately does NOT fire build_success here. buildEnd
      // runs at the end of the *input* phase — output hooks like
      // generateBundle and writeBundle are still ahead, and any of
      // them can fail. Firing success here means a later output-phase
      // failure would produce both a false success AND a compile-error
      // sensation. Success is fired from closeBundle instead, gated on
      // wroteBundle && !errorObserved.
      const r = resolved;
      const c = client;
      if (r?.active !== true || c === null) return;
      safeRun('buildEnd', () => {
        if (err !== undefined && err !== null) {
          errorObserved = true;
          const message = typeof err.message === 'string' ? err.message : String(err);
          classifyAndFire(c, debouncer, r, message);
        }
      });
    },

    writeBundle() {
      // writeBundle runs once per output. We just record that at least
      // one output wrote successfully — the success trigger itself
      // doesn't fire here because Rollup may have more outputs after
      // this one, and any of them could fail. closeBundle is the only
      // hook that runs after the entire output phase.
      if (resolved?.active !== true) return;
      wroteBundle = true;
    },

    handleHotUpdate(ctx) {
      if (resolved?.active !== true) return;
      safeRun('handleHotUpdate', () => noteHmrUpdate(hmrState, ctx.file));
      return undefined;
    },

    async closeBundle() {
      const r = resolved;
      const c = client;
      if (r?.active !== true || c === null) return;
      // Fire build_success only when the entire output phase actually
      // wrote (wroteBundle) and no error was observed (errorObserved).
      // Vite logs failures via logger.error before bundle.close, so
      // errorObserved is true at this point in the failed-build case.
      if (wroteBundle && !errorObserved && command === 'build') {
        safeRun('closeBundle:success', () => {
          // void: the trigger gets tracked in client's in-flight set
          // and we await it via flush() below.
          void maybeFireBuildSuccess(c, debouncer, r, buildStartedAt, command);
        });
      }
      // Wait briefly for any in-flight triggers (success here, plus
      // the compile-error trigger from buildEnd(err) on failed builds)
      // to land before continuing. Without this, fire-and-forget
      // triggers get cancelled when we abort the session below.
      await c.flush(TRIGGER_DEADLINE_MS);
      // In watch mode the same plugin instance services every cycle —
      // closing the session here would silently kill all later cycles.
      // The session is torn down in closeWatcher (or by the http2
      // session manager's idle timeout) instead.
      if (isWatchMode) return;
      safeRun('closeBundle', () => c.close());
      client = null;
    },

    async closeWatcher() {
      // Fires when Vite (Rollup) shuts down the watcher in
      // `vite build --watch`. Tear down the session that closeBundle
      // intentionally left alive across cycles.
      const c = client;
      if (c === null) return;
      await c.flush(TRIGGER_DEADLINE_MS);
      safeRun('closeWatcher', () => c.close());
      client = null;
    },
  };
}

/**
 * Wrap the Vite logger's `error` method so we observe every error log
 * during dev (the dev server pipes TS / esbuild / plugin errors here).
 * Idempotent: a marker symbol on the logger object prevents
 * double-wrapping when the plugin is instantiated twice in the same
 * Vite session.
 */
function wrapLoggerError(
  base: WrappableLogger,
  context: () => {
    client: SmitedClient;
    debouncer: Debouncer;
    opts: ResolvedOptions;
    hmrState: HmrState;
    markErrorObserved: () => void;
  },
): void {
  if (base[WRAPPED_MARKER] === true) return;
  base[WRAPPED_MARKER] = true;
  const original = base.error.bind(base);
  base.error = (msg: string, opts?: LogErrorOptions) => {
    try {
      const { client, debouncer, opts: resolved, hmrState, markErrorObserved } = context();
      // Mark *before* dispatch so closeBundle gates correctly even if
      // the dispatch itself throws (it shouldn't, but defensively).
      markErrorObserved();
      const message = typeof msg === 'string' ? msg : String(msg);
      const handledAsHmr = maybeFireAsHmrError(client, debouncer, resolved, hmrState);
      if (!handledAsHmr) {
        classifyAndFire(client, debouncer, resolved, message);
      }
    } catch {
      // Defensive: never let our hook break Vite's error reporting.
    }
    original(msg, opts);
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
