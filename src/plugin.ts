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
  let buildSuccessFired = false;
  let command: 'build' | 'serve' = 'serve';

  /**
   * Brief window to await the success trigger so the gRPC call has a
   * chance to land before closeBundle aborts the h2c session. Tuned
   * short enough to be invisible against a slow build, long enough for
   * a unary call on a healthy local-network daemon.
   */
  const SUCCESS_TRIGGER_DEADLINE_MS = 250;

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
      }));
    },

    buildStart() {
      if (resolved?.active !== true) return;
      buildStartedAt = Date.now();
      buildSuccessFired = false;
    },

    buildEnd(err) {
      // Note: deliberately does NOT fire build_success here. buildEnd
      // runs at the end of the *input* phase — output hooks like
      // generateBundle and writeBundle are still ahead, and any of
      // them can fail. Firing success here means a later output-phase
      // failure would produce both a false success AND a compile-error
      // sensation. Success is fired from writeBundle instead.
      const r = resolved;
      const c = client;
      if (r?.active !== true || c === null) return;
      safeRun('buildEnd', () => {
        if (err !== undefined && err !== null) {
          const message = typeof err.message === 'string' ? err.message : String(err);
          classifyAndFire(c, debouncer, r, message);
        }
      });
    },

    async writeBundle() {
      const r = resolved;
      const c = client;
      if (r?.active !== true || c === null) return;
      if (buildSuccessFired) return;
      buildSuccessFired = true;
      const trigger = maybeFireBuildSuccess(c, debouncer, r, buildStartedAt, command);
      if (trigger === null) return;
      // Race the gRPC unary call against a short deadline so a slow
      // daemon can't visibly slow the build, but a healthy one has
      // time to ack before closeBundle tears down the h2c session.
      await Promise.race([
        trigger,
        new Promise<void>((resolve) => setTimeout(resolve, SUCCESS_TRIGGER_DEADLINE_MS)),
      ]);
    },

    handleHotUpdate(ctx) {
      if (resolved?.active !== true) return;
      safeRun('handleHotUpdate', () => noteHmrUpdate(hmrState, ctx.file));
      return undefined;
    },

    closeBundle() {
      if (resolved?.active !== true || client === null) return;
      const c = client;
      safeRun('closeBundle', () => c.close());
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
  },
): void {
  if (base[WRAPPED_MARKER] === true) return;
  base[WRAPPED_MARKER] = true;
  const original = base.error.bind(base);
  base.error = (msg: string, opts?: LogErrorOptions) => {
    try {
      const { client, debouncer, opts: resolved, hmrState } = context();
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
