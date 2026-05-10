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
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
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
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
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
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
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
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
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
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
  });

  test('long successful production build fires build_success in closeBundle', async () => {
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    // writeBundle alone does not fire — Rollup may run more outputs after.
    await (plugin.writeBundle as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(0);

    // closeBundle is the only hook that runs after the entire output phase.
    await (plugin.closeBundle as () => unknown).call({});
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
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(0);
  });

  test('regression: build_success does NOT fire when an error has been logged via logger.error', async () => {
    // Multi-output failure case: output 1 writes successfully, output 2's
    // hook throws and Vite logs the failure via logger.error before
    // closeBundle fires. The wrapped logger.error sets errorObserved=true,
    // so closeBundle's success fire is gated off.
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await (plugin.writeBundle as () => unknown).call({}); // output 1 succeeded

    // Output 2 fails: Vite catches and logs via logger.error
    // (which is wrapped). This both fires a compile_error trigger AND
    // sets errorObserved so success won't fire below.
    (resolved.logger.error as (msg: string) => void)('Found 1 error in output');
    await waitForServer(server, 1);

    await (plugin.closeBundle as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 50));

    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'compile_error_mild',
    });
    // Specifically, no deploy_success in the received list.
    expect(
      server.received.find(
        (r) => r.sensation.case === 'sensationName' && r.sensation.value === 'deploy_success',
      ),
    ).toBeUndefined();
  });

  test('build_success fires only once across multiple writeBundle calls', async () => {
    // SSR builds (and other multi-output configurations) call writeBundle
    // once per output. Success should still fire exactly once per build,
    // since closeBundle runs once at the very end.
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await (plugin.writeBundle as () => unknown).call({});
    await (plugin.writeBundle as () => unknown).call({});
    await (plugin.writeBundle as () => unknown).call({});
    await (plugin.closeBundle as () => unknown).call({});
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
    await (plugin.writeBundle as () => unknown).call({});
    await (plugin.closeBundle as () => unknown).call({});
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
    await (plugin.closeBundle as () => unknown).call({});
    await waitForServer(server, 2);
    expect(server.received[1]?.sensation).toEqual({
      case: 'sensationName',
      value: 'compile_error_mild',
    });

    // Cycle 3: success again on a successful rebuild.
    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await (plugin.writeBundle as () => unknown).call({});
    await (plugin.closeBundle as () => unknown).call({});
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
    await (plugin.closeBundle as () => unknown).call({});

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
    await (plugin.writeBundle as () => unknown).call({});
    await (plugin.closeBundle as () => unknown).call({});
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
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
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
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
  });
});
