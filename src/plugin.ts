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
   * `process.beforeExit` listener registered by closeBundle for
   * one-shot builds. Held in a Set so afterEach-style teardown can
   * de-register it without leaking listeners across plugin instances.
   * Closes the client and fires success only when beforeExit fires —
   * Vite calls process.exit(1) on a failed build, which skips
   * beforeExit, so this is the only event that means "the entire
   * build truly succeeded" regardless of plugin closeBundle ordering.
   */
  let beforeExitListener: ((code: number) => void) | null = null;

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

  /**
   * De-register the pending beforeExit handler if any. Safe to call
   * even when no handler is installed. Used by every code path that
   * learns the build won't (or shouldn't) fire success — `errorObserved`
   * transitions, a fresh `buildStart`, and the handler's own teardown.
   */
  const removeBeforeExitListener = (): void => {
    if (beforeExitListener === null) return;
    process.removeListener('beforeExit', beforeExitListener);
    beforeExitListener = null;
  };

  /**
   * Mark the current build as failed and discard the pending success
   * fire. The wrapped `logger.error` and `buildEnd(err)` both call
   * this so a programmatic `vite.build()` host that catches a rejection
   * doesn't get a stale `deploy_success` haptic when the host process
   * later drains naturally.
   */
  const noteBuildFailed = (): void => {
    errorObserved = true;
    removeBeforeExitListener();
  };

  return {
    name: 'smited-vite',
    // Run in Vite's 'post' plugin group so we're invoked after most
    // user / framework plugins for closeBundle ordering. Combined with
    // `closeBundle.order: 'post'` below this puts our hook as late as
    // Vite/Rollup ordering can guarantee — but closeBundle is parallel,
    // so we still defer success past beforeExit for the strong fix.
    enforce: 'post',

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
        markErrorObserved: noteBuildFailed,
      }));
    },

    buildStart() {
      if (resolved?.active !== true) return;
      // Defensive: clear a beforeExit handler from any previous run on
      // this plugin instance. In the normal CLI lifecycle there is at
      // most one build per instance, but programmatic users (or a
      // future Vite that reuses plugins) shouldn't get a stale handler
      // from a previous cycle firing on a fresh build's state.
      removeBeforeExitListener();
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
          noteBuildFailed();
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

    closeBundle: {
      // `order: 'post'` plus the plugin-level `enforce: 'post'` puts us
      // last among closeBundle hooks, but Rollup invokes closeBundle in
      // PARALLEL — being last in invocation order doesn't wait for
      // earlier siblings to finish their async work. The only reliable
      // success boundary is `process.beforeExit`, which fires only
      // when Vite did not call `process.exit(1)` on failure.
      order: 'post',
      async handler() {
        const r = resolved;
        const c = client;
        if (r?.active !== true || c === null) return;
        // Flush in-flight triggers (compile-error from buildEnd(err))
        // before anything else might cancel them.
        await c.flush(TRIGGER_DEADLINE_MS);
        // In watch mode, the same plugin instance services every cycle.
        // We can't use beforeExit (it only fires once per process), so
        // we defer one tick via setImmediate and check errorObserved.
        // This is best-effort: a parallel closeBundle that throws AFTER
        // setImmediate fires can still produce a false success.
        // Documented limitation; one-shot builds get the strong fix.
        if (isWatchMode) {
          if (wroteBundle && command === 'build') {
            scheduleWatchSuccessCheck(c, r);
          }
          return;
        }
        // One-shot build. Defer success past the rest of bundle.close()
        // and Vite's error handling by listening for beforeExit.
        if (wroteBundle && command === 'build') {
          installBeforeExitFire(c, r);
          return;
        }
        // No success path needed (dev mode, or wroteBundle never set).
        // Close immediately.
        safeRun('closeBundle', () => c.close());
        client = null;
      },
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

  function scheduleWatchSuccessCheck(c: SmitedClient, r: ResolvedOptions): void {
    setImmediate(() => {
      // errorObserved may have become true between our closeBundle
      // returning and this microtask running (e.g., a parallel
      // closeBundle threw and Vite logged it via logger.error).
      if (errorObserved) return;
      const live = client;
      if (live !== c || live === null) return;
      void maybeFireBuildSuccess(live, debouncer, r, buildStartedAt, command);
    });
  }

  function installBeforeExitFire(c: SmitedClient, r: ResolvedOptions): void {
    if (beforeExitListener !== null) return;
    const handler = (): void => {
      beforeExitListener = null;
      try {
        // Two failure signals to gate against:
        //  - errorObserved: set by wrapped logger.error / buildEnd(err)
        //  - process.exitCode != 0: a host (programmatic Vite caller)
        //    has indicated the process is exiting non-zero, even if
        //    the failure didn't go through Vite's wrapped logger.
        // The latter doesn't catch every silent failure (a host that
        // catches and ignores will leave exitCode untouched), but it
        // bounds the surface area for the documented limitation.
        const hostFailed =
          typeof process.exitCode === 'number' && process.exitCode !== 0;
        if (errorObserved || hostFailed) {
          c.close();
          if (client === c) client = null;
          return;
        }
        const trigger = maybeFireBuildSuccess(
          c,
          debouncer,
          r,
          buildStartedAt,
          command,
        );
        if (trigger === null) {
          c.close();
          if (client === c) client = null;
          return;
        }
        // Schedule trigger + a deadline timer. Both keep the event
        // loop alive; whichever wins lets us close cleanly. beforeExit
        // may be re-emitted after this work completes, but our handler
        // is already removed via the once() registration.
        void Promise.race([
          trigger,
          new Promise<void>((resolve) => setTimeout(resolve, TRIGGER_DEADLINE_MS)),
        ]).finally(() => {
          c.close();
          if (client === c) client = null;
        });
      } catch {
        // Defensive: a beforeExit listener throwing would leave the
        // process in an awkward state. Swallow and let Vite exit.
      }
    };
    beforeExitListener = handler;
    process.once('beforeExit', handler);
  }
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
