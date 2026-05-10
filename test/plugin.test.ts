import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedConfig, HmrContext, ModuleNode, Logger, ViteDevServer } from 'vite';
import { smitedVite } from '../src/index.js';
import { startFakeServer, type FakeServer } from './fixtures/fake-smited-server.js';

const ENV_VARS_TO_SCRUB = [
  'SMITED_HOST',
  'SMITED_BACKEND_ID',
  'SMITED_DISABLE',
  'SMITED_SENSATION_COMPILE_ERROR',
  'SMITED_SENSATION_COMPILE_ERROR_SEVERE',
  'SMITED_SENSATION_HMR_ERROR',
  'SMITED_SENSATION_BUILD_SUCCESS',
];

function silentLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    warnOnce: vi.fn(),
    error: vi.fn(),
    clearScreen: vi.fn(),
    hasErrorLogged: () => false,
    hasWarned: false,
  } as unknown as Logger;
}

function fakeResolvedConfig(
  command: 'build' | 'serve' = 'build',
  opts: { watch?: boolean } = {},
): ResolvedConfig {
  return {
    command,
    mode: 'production',
    logger: silentLogger(),
    build: { watch: opts.watch === true ? {} : null },
  } as unknown as ResolvedConfig;
}

function fakeHmrContext(file = '/proj/src/foo.ts'): HmrContext {
  return {
    file,
    timestamp: Date.now(),
    modules: [] as ModuleNode[],
    read: async () => '',
    server: {} as ViteDevServer,
  };
}

/**
 * Plugin hooks like `closeBundle` and `writeBundle` use Vite's object
 * form (`{ order, handler }`) for explicit ordering. Tests need the
 * underlying handler to invoke directly with `.call({})`.
 */
function getCloseBundleHandler(plugin: ReturnType<typeof smitedVite>): (...args: unknown[]) => unknown {
  const cb = plugin.closeBundle;
  if (typeof cb === 'function') return cb as (...args: unknown[]) => unknown;
  if (cb && typeof cb === 'object' && typeof cb.handler === 'function') {
    return cb.handler as (...args: unknown[]) => unknown;
  }
  throw new Error('plugin.closeBundle is not a function or hook object');
}

function getWriteBundleHandler(plugin: ReturnType<typeof smitedVite>): (...args: unknown[]) => unknown {
  const wb = plugin.writeBundle;
  if (typeof wb === 'function') return wb as (...args: unknown[]) => unknown;
  if (wb && typeof wb === 'object' && typeof wb.handler === 'function') {
    return wb.handler as (...args: unknown[]) => unknown;
  }
  throw new Error('plugin.writeBundle is not a function or hook object');
}

async function activate(plugin: ReturnType<typeof smitedVite>, resolved: ResolvedConfig) {
  const env: { command: 'build' | 'serve'; mode: string } = {
    command: resolved.command,
    mode: resolved.mode,
  };
  await (plugin.config as (
    cfg: unknown,
    env: { command: 'build' | 'serve'; mode: string },
  ) => unknown)({}, env);
  await (plugin.configResolved as (c: ResolvedConfig) => unknown)(resolved);
}

/**
 * The plugin's triggers are fire-and-forget; we await a tick after a
 * hook to give the in-flight gRPC promise a chance to land on the
 * fake server.
 */
async function waitForServer(server: FakeServer, expected: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (server.received.length < expected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${expected} trigger(s); got ${server.received.length}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('smitedVite plugin lifecycle', () => {
  let savedEnv: Record<string, string | undefined>;
  let server: FakeServer;

  beforeEach(async () => {
    savedEnv = {};
    for (const k of ENV_VARS_TO_SCRUB) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    server = await startFakeServer();
    process.env.SMITED_HOST = server.address;
  });

  afterEach(async () => {
    await server.stop();
    // Tests install process.once('beforeExit', ...) handlers; clean them up
    // so they don't leak across tests or fire spuriously when vitest exits.
    process.removeAllListeners('beforeExit');
    for (const k of ENV_VARS_TO_SCRUB) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('configResolved logs the active line and probes health', async () => {
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig();
    await activate(plugin, resolved);
    expect(resolved.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[smited-vite] active'),
    );
    await getCloseBundleHandler(plugin).call({});
  });

  test('buildEnd with a generic error fires compile_error_mild', async () => {
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig();
    await activate(plugin, resolved);

    await (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('TS broke'));
    await waitForServer(server, 1);

    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'compile_error_mild',
    });
    await getCloseBundleHandler(plugin).call({});
  });

  test('buildEnd with "Found 7 errors" fires the severe sensation', async () => {
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig();
    await activate(plugin, resolved);

    await (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('Found 7 errors in 3 files.'));
    await waitForServer(server, 1);

    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'compile_error_severe',
    });
    await getCloseBundleHandler(plugin).call({});
  });

  test('handleHotUpdate followed by logger.error fires hmrError, not compile', async () => {
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig('serve');
    // Use a distinctive HMR sensation so we can tell them apart.
    process.env.SMITED_SENSATION_HMR_ERROR = 'hmr_zap';
    process.env.SMITED_SENSATION_COMPILE_ERROR = 'compile_zap';
    await activate(plugin, resolved);

    await (plugin.handleHotUpdate as (ctx: HmrContext) => unknown)(fakeHmrContext());
    // The wrapped logger.error is what triggers the dispatch in dev mode.
    (resolved.logger.error as (msg: string) => void)('boom');
    await waitForServer(server, 1);

    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'hmr_zap',
    });
    await getCloseBundleHandler(plugin).call({});
  });

  test('logger.error without a recent hot-update fires the compile sensation', async () => {
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig('serve');
    await activate(plugin, resolved);

    (resolved.logger.error as (msg: string) => void)('Found 2 errors in 1 file.');
    await waitForServer(server, 1);

    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'compile_error_mild',
    });
    await getCloseBundleHandler(plugin).call({});
  });

  test('long successful production build fires build_success on process beforeExit', async () => {
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    // closeBundle returns without firing — closeBundle hooks run in
    // parallel in Rollup, so we must defer past the entire bundle.close.
    await getCloseBundleHandler(plugin).call({});
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(0);

    // process.beforeExit is the actual success boundary: Vite calls
    // process.exit(1) on failure, so beforeExit only fires on a clean
    // exit regardless of plugin closeBundle ordering.
    process.emit('beforeExit', 0);
    await waitForServer(server, 1);

    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'deploy_success',
    });
  });

  test('regression: build_success does NOT fire if writeBundle never runs (output phase failed)', async () => {
    // First reproduced bug: a plugin throwing in generateBundle would
    // trigger deploy_success even though the build ultimately failed.
    // After the fix, success only fires when wroteBundle is true at
    // closeBundle time. If the output phase never reached writeBundle,
    // wroteBundle stays false and we stay silent.
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    // Skip writeBundle — simulates generateBundle / writeBundle failure.
    await getCloseBundleHandler(plugin).call({});
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(0);
  });

  test('regression: build_success does NOT fire when an error has been logged via logger.error', async () => {
    // Multi-output failure case: output 1 writes successfully, output 2's
    // hook throws and Vite logs the failure via logger.error before
    // closeBundle fires. The wrapped logger.error sets errorObserved=true,
    // so the beforeExit handler's success fire is gated off.
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({}); // output 1 succeeded

    // Output 2 fails: Vite catches and logs via logger.error
    // (which is wrapped). This both fires a compile_error trigger AND
    // sets errorObserved so success won't fire on beforeExit.
    (resolved.logger.error as (msg: string) => void)('Found 1 error in output');
    await waitForServer(server, 1);

    await getCloseBundleHandler(plugin).call({});
    process.emit('beforeExit', 0);
    await new Promise((r) => setTimeout(r, 100));

    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'compile_error_mild',
    });
  });

  test('regression: beforeExit handler is removed when errorObserved transitions true', async () => {
    // Programmatic vite.build() users: our closeBundle installs a
    // beforeExit handler. If the wrapped logger.error fires later
    // (Vite logging a closeBundle plugin failure), errorObserved
    // becomes true. We must actively de-register the listener so the
    // host process draining naturally — long after the failure — can't
    // fire deploy_success.
    const before = process.listenerCount('beforeExit');
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    await getCloseBundleHandler(plugin).call({});
    expect(process.listenerCount('beforeExit')).toBe(before + 1);

    (resolved.logger.error as (msg: string) => void)('plugin foo: closeBundle threw');
    await waitForServer(server, 1); // compile_error

    // The handler must be gone now, not still queued.
    expect(process.listenerCount('beforeExit')).toBe(before);

    // Even if the host's process drain fires beforeExit later, no
    // success should land.
    process.emit('beforeExit', 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.sensation.value).toBe('compile_error_mild');
  });

  test('regression: buildStart removes a stale beforeExit handler from a previous run', async () => {
    // Defensive: if a plugin instance is somehow reused for a second
    // build (or buildStart fires unexpectedly), the previous run's
    // beforeExit handler must be removed so it doesn't fire on the
    // wrong client / state later.
    const before = process.listenerCount('beforeExit');
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    await getCloseBundleHandler(plugin).call({});
    expect(process.listenerCount('beforeExit')).toBe(before + 1);

    // A second buildStart on the same instance should clear the stale
    // handler from the first run.
    (plugin.buildStart as () => unknown).call({});
    expect(process.listenerCount('beforeExit')).toBe(before);
  });

  test('regression: handler skips success when host has set process.exitCode != 0', async () => {
    // A programmatic host that catches a Vite rejection may set
    // process.exitCode = 1 without going through the wrapped logger.
    // The handler treats a non-zero exitCode as a failure signal.
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    await getCloseBundleHandler(plugin).call({});

    const previousExitCode = process.exitCode;
    process.exitCode = 1;
    try {
      process.emit('beforeExit', 1);
      await new Promise((r) => setTimeout(r, 100));
      expect(server.received).toHaveLength(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test('regression: build_success does NOT fire if a later closeBundle plugin throws after ours', async () => {
    // closeBundle hooks run in PARALLEL in Rollup — being ordered last
    // doesn't help, because parallel siblings may still be running when
    // our hook returns. The fix is to defer success past Vite's process
    // exit decision: Vite calls process.exit(1) on a failed build (which
    // skips beforeExit), and lets the process exit naturally on success
    // (which fires beforeExit). So beforeExit is the actual success
    // boundary.
    //
    // This test simulates the failure path: our closeBundle returns,
    // then Vite logs the later plugin's failure via logger.error, then
    // our beforeExit handler runs and (correctly) skips success because
    // errorObserved is now true.
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    await getCloseBundleHandler(plugin).call({});

    // Later plugin's closeBundle throws → Vite logs it AFTER bundle.close.
    (resolved.logger.error as (msg: string) => void)(
      'Plugin foo: Error in closeBundle',
    );
    await waitForServer(server, 1); // compile_error_mild fires

    // Now Vite would normally process.exit(1), which skips beforeExit
    // entirely. We simulate that the right way by simply NOT emitting
    // beforeExit here — and verifying nothing else fires.
    await new Promise((r) => setTimeout(r, 100));
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.sensation.value).toBe('compile_error_mild');
  });

  test('build_success fires only once across multiple writeBundle calls', async () => {
    // SSR builds (and other multi-output configurations) call writeBundle
    // once per output. Success should still fire exactly once per build,
    // since closeBundle runs once and beforeExit fires once.
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    await getWriteBundleHandler(plugin).call({});
    await getWriteBundleHandler(plugin).call({});
    await getCloseBundleHandler(plugin).call({});
    process.emit('beforeExit', 0);
    await waitForServer(server, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(1);
  });

  test('regression: vite build --watch keeps firing triggers across cycles', async () => {
    // vite build --watch reuses the same plugin instance: configResolved
    // runs once, but buildStart/buildEnd/closeBundle fire per cycle. If
    // closeBundle aborts/nulls the client, every cycle past the first
    // sees a dead session (or null) and triggers stop landing.
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build', { watch: true });
    await activate(plugin, resolved);

    // Cycle 1
    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    await getCloseBundleHandler(plugin).call({});
    await waitForServer(server, 1);
    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'deploy_success',
    });

    // Cycle 2: buildStart resets per-cycle state, the live client
    // should still be wired up, the trigger should land.
    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('Found 3 errors in 2 files.'));
    await getCloseBundleHandler(plugin).call({});
    await waitForServer(server, 2);
    expect(server.received[1]?.sensation).toEqual({
      case: 'sensationName',
      value: 'compile_error_mild',
    });

    // Cycle 3: success again on a successful rebuild.
    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    await getCloseBundleHandler(plugin).call({});
    await waitForServer(server, 3);
    expect(server.received[2]?.sensation).toEqual({
      case: 'sensationName',
      value: 'deploy_success',
    });

    // Tear down explicitly via closeWatcher (the watch-shutdown hook).
    if (typeof plugin.closeWatcher === 'function') {
      await (plugin.closeWatcher as () => unknown).call({});
    }
  });

  test('regression: compile-error trigger from buildEnd lands even when closeBundle immediately follows', async () => {
    // Failed-build sequence: buildEnd(err) fires the compile-error
    // trigger fire-and-forget, then closeBundle aborts the h2c session.
    // closeBundle must await any in-flight triggers before aborting,
    // or the trigger gets cancelled before reaching the daemon.
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    await (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('TS broke'));
    await getCloseBundleHandler(plugin).call({});

    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'compile_error_mild',
    });
  });

  test('quick successful build does not fire build_success', async () => {
    const plugin = smitedVite({ buildSuccessMinDurationMs: 30_000 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await getWriteBundleHandler(plugin).call({});
    await getCloseBundleHandler(plugin).call({});
    process.emit('beforeExit', 0);
    // Give triggers a chance to fail to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(0);
  });

  test('debouncer suppresses repeat compile-error within window', async () => {
    const plugin = smitedVite({ debounceMs: { compileError: 1000 } });
    const resolved = fakeResolvedConfig();
    await activate(plugin, resolved);

    await (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('boom 1'));
    await waitForServer(server, 1);
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('boom 2'));
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(1);
    await getCloseBundleHandler(plugin).call({});
  });

  test('null sensation in options skips that event class', async () => {
    const plugin = smitedVite({
      sensations: { compileError: null, compileErrorSevere: null },
    });
    const resolved = fakeResolvedConfig();
    await activate(plugin, resolved);

    await (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('boom'));
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(0);
    await getCloseBundleHandler(plugin).call({});
  });
});
