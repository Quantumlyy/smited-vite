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

function fakeResolvedConfig(command: 'build' | 'serve' = 'build'): ResolvedConfig {
  return {
    command,
    mode: 'production',
    logger: silentLogger(),
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

  test('long successful production build fires the build_success sensation', async () => {
    const plugin = smitedVite({ buildSuccessMinDurationMs: 10 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await new Promise((r) => setTimeout(r, 25));
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    await waitForServer(server, 1);

    expect(server.received[0]?.sensation).toEqual({
      case: 'sensationName',
      value: 'deploy_success',
    });
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
  });

  test('quick successful build does not fire build_success', async () => {
    const plugin = smitedVite({ buildSuccessMinDurationMs: 30_000 });
    const resolved = fakeResolvedConfig('build');
    await activate(plugin, resolved);

    (plugin.buildStart as () => unknown).call({});
    await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
    // Give triggers a chance to fail to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toHaveLength(0);
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => unknown).call({});
    }
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
