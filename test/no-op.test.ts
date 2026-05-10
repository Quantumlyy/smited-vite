import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedConfig, HmrContext, ModuleNode, ViteDevServer } from 'vite';
import { smitedVite } from '../src/index.js';

/**
 * The "safe to commit" promise: with no options and no SMITED_HOST
 * environment variable, the plugin must be a complete no-op. This file
 * is the line of defence behind that promise.
 *
 * Strategy: instead of spying on `node:http2` (vitest can't spy on
 * ESM module namespaces), we assert that the plugin's "active" branch
 * was never entered. That branch is the only place a SmitedClient is
 * constructed, the only place `logger.info` fires, and the only place
 * `logger.error` is wrapped. If none of those side-effects occur, no
 * network operation could possibly take place — the SmitedClient
 * (and therefore every Http2SessionManager) only exists inside that
 * branch.
 */

const ENV_VARS_TO_SCRUB = [
  'SMITED_HOST',
  'SMITED_BACKEND_ID',
  'SMITED_DISABLE',
  'SMITED_SENSATION_COMPILE_ERROR',
  'SMITED_SENSATION_COMPILE_ERROR_SEVERE',
  'SMITED_SENSATION_HMR_ERROR',
  'SMITED_SENSATION_BUILD_SUCCESS',
];

interface SilentLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  warnOnce: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  clearScreen: ReturnType<typeof vi.fn>;
  hasErrorLogged: () => boolean;
  hasWarned: boolean;
}

function silentLogger(): SilentLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    warnOnce: vi.fn(),
    error: vi.fn(),
    clearScreen: vi.fn(),
    hasErrorLogged: () => false,
    hasWarned: false,
  };
}

function fakeResolvedConfig(
  command: 'build' | 'serve' = 'build',
): ResolvedConfig & { logger: SilentLogger } {
  return {
    command,
    mode: 'production',
    logger: silentLogger(),
  } as unknown as ResolvedConfig & { logger: SilentLogger };
}

function fakeHmrContext(file = '/tmp/foo.ts'): HmrContext {
  return {
    file,
    timestamp: Date.now(),
    modules: [] as ModuleNode[],
    read: async () => '',
    server: {} as ViteDevServer,
  };
}

function getCloseBundleHandler(
  plugin: ReturnType<typeof smitedVite>,
): (...args: unknown[]) => unknown {
  const cb = plugin.closeBundle;
  if (typeof cb === 'function') return cb as (...args: unknown[]) => unknown;
  if (cb && typeof cb === 'object' && typeof cb.handler === 'function') {
    return cb.handler as (...args: unknown[]) => unknown;
  }
  throw new Error('plugin.closeBundle is not a function or hook object');
}

async function driveAll(
  plugin: ReturnType<typeof smitedVite>,
  resolved: ResolvedConfig,
): Promise<void> {
  const env: { command: 'build'; mode: string } = { command: 'build', mode: 'production' };
  await (plugin.config as (
    cfg: unknown,
    env: { command: 'build' | 'serve'; mode: string },
  ) => unknown)({}, env);
  await (plugin.configResolved as (c: ResolvedConfig) => unknown)(resolved);
  await (plugin.buildStart as () => unknown).call({});
  await (plugin.buildEnd as (err?: Error) => unknown).call({}, undefined);
  await (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('boom'));
  await (plugin.handleHotUpdate as (ctx: HmrContext) => unknown)(fakeHmrContext());
  await getCloseBundleHandler(plugin).call({});
}

function expectInert(
  resolved: ResolvedConfig & { logger: SilentLogger },
  originalErrorRef: SilentLogger['error'],
): void {
  // No "active" line, no warnings, no errors.
  expect(resolved.logger.info).not.toHaveBeenCalled();
  expect(resolved.logger.warn).not.toHaveBeenCalled();
  expect(resolved.logger.error).toBe(originalErrorRef);
  // Wrapping logger.error replaces the reference; an unchanged ref
  // proves the wrap never ran. The wrap is the only path that
  // constructs a SmitedClient (and hence an h2c session manager).
}

describe('no-op safety', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_VARS_TO_SCRUB) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_VARS_TO_SCRUB) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('no options and no env: every hook is a no-op', async () => {
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig();
    const originalErrorRef = resolved.logger.error;

    await expect(driveAll(plugin, resolved)).resolves.not.toThrow();
    expectInert(resolved, originalErrorRef);
  });

  test('options.disabled=true beats SMITED_HOST', async () => {
    process.env.SMITED_HOST = '127.0.0.1:1';
    const plugin = smitedVite({ disabled: true });
    const resolved = fakeResolvedConfig();
    const originalErrorRef = resolved.logger.error;

    await expect(driveAll(plugin, resolved)).resolves.not.toThrow();
    expectInert(resolved, originalErrorRef);
  });

  test('SMITED_DISABLE=1 disables even when SMITED_HOST is set', async () => {
    process.env.SMITED_HOST = '127.0.0.1:1';
    process.env.SMITED_DISABLE = '1';
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig();
    const originalErrorRef = resolved.logger.error;

    await expect(driveAll(plugin, resolved)).resolves.not.toThrow();
    expectInert(resolved, originalErrorRef);
  });

  test('inactive plugin still survives buildEnd with a thrown error param', async () => {
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig();
    await (plugin.config as (cfg: unknown, env: { command: 'build'; mode: string }) => unknown)(
      {},
      { command: 'build', mode: 'production' },
    );
    await (plugin.configResolved as (c: ResolvedConfig) => unknown)(resolved);
    // buildEnd with an error must not network, must not throw.
    expect(() =>
      (plugin.buildEnd as (err?: Error) => unknown).call({}, new Error('boom')),
    ).not.toThrow();
    expect(resolved.logger.error).not.toHaveBeenCalled();
  });

  test('inactive plugin in dev mode handles hot updates without effect', async () => {
    const plugin = smitedVite();
    const resolved = fakeResolvedConfig('serve');
    const originalErrorRef = resolved.logger.error;
    await driveAll(plugin, resolved);
    expectInert(resolved, originalErrorRef);
  });
});
