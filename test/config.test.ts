import { describe, expect, test } from 'vitest';
import { resolveOptions } from '../src/config.js';

describe('resolveOptions', () => {
  describe('activation', () => {
    test('is inactive when no options and no env', () => {
      const r = resolveOptions(undefined, {});
      expect(r.active).toBe(false);
      expect(r.host).toBeUndefined();
    });

    test('is active when SMITED_HOST env is set', () => {
      const r = resolveOptions(undefined, { SMITED_HOST: 'rig.local:7777' });
      expect(r.active).toBe(true);
      expect(r.host).toBe('rig.local:7777');
    });

    test('is active when options.host is set even without env', () => {
      const r = resolveOptions({ host: 'rig.local:7777' }, {});
      expect(r.active).toBe(true);
      expect(r.host).toBe('rig.local:7777');
    });

    test('options.host overrides SMITED_HOST', () => {
      const r = resolveOptions(
        { host: 'opt.local:1' },
        { SMITED_HOST: 'env.local:2' },
      );
      expect(r.host).toBe('opt.local:1');
    });

    test('SMITED_DISABLE=1 makes plugin inactive even with host', () => {
      const r = resolveOptions(undefined, {
        SMITED_HOST: 'rig:1',
        SMITED_DISABLE: '1',
      });
      expect(r.active).toBe(false);
    });

    test('options.disabled=true makes plugin inactive even with host', () => {
      const r = resolveOptions({ host: 'rig:1', disabled: true }, {});
      expect(r.active).toBe(false);
    });

    test('options.disabled=false overrides SMITED_DISABLE=1', () => {
      const r = resolveOptions(
        { host: 'rig:1', disabled: false },
        { SMITED_DISABLE: '1' },
      );
      expect(r.active).toBe(true);
    });

    test('SMITED_DISABLE values other than "1" do not disable', () => {
      const r = resolveOptions(undefined, {
        SMITED_HOST: 'rig:1',
        SMITED_DISABLE: 'true',
      });
      expect(r.active).toBe(true);
    });
  });

  describe('backendId', () => {
    test('defaults to "mock-owo"', () => {
      const r = resolveOptions({ host: 'h:1' });
      expect(r.backendId).toBe('mock-owo');
    });

    test('reads from SMITED_BACKEND_ID', () => {
      const r = resolveOptions(undefined, {
        SMITED_HOST: 'h:1',
        SMITED_BACKEND_ID: 'real-owo',
      });
      expect(r.backendId).toBe('real-owo');
    });

    test('options.backendId overrides env', () => {
      const r = resolveOptions(
        { backendId: 'opt-owo' },
        { SMITED_HOST: 'h:1', SMITED_BACKEND_ID: 'env-owo' },
      );
      expect(r.backendId).toBe('opt-owo');
    });
  });

  describe('sensations', () => {
    test('uses spec defaults when nothing specified', () => {
      const r = resolveOptions({ host: 'h:1' });
      expect(r.sensations).toEqual({
        compileError: 'compile_error_mild',
        compileErrorSevere: 'compile_error_severe',
        hmrError: 'compile_error_mild',
        buildSuccess: 'deploy_success',
      });
    });

    test('options can override individual sensations', () => {
      const r = resolveOptions({
        host: 'h:1',
        sensations: { compileError: 'custom_zap' },
      });
      expect(r.sensations.compileError).toBe('custom_zap');
      expect(r.sensations.hmrError).toBe('compile_error_mild'); // default kept
    });

    test('null in options disables a specific sensation', () => {
      const r = resolveOptions({
        host: 'h:1',
        sensations: { hmrError: null },
      });
      expect(r.sensations.hmrError).toBeNull();
    });

    test('env overrides defaults for each sensation key', () => {
      const r = resolveOptions(undefined, {
        SMITED_HOST: 'h:1',
        SMITED_SENSATION_COMPILE_ERROR: 'env_compile',
        SMITED_SENSATION_COMPILE_ERROR_SEVERE: 'env_severe',
        SMITED_SENSATION_HMR_ERROR: 'env_hmr',
        SMITED_SENSATION_BUILD_SUCCESS: 'env_success',
      });
      expect(r.sensations).toEqual({
        compileError: 'env_compile',
        compileErrorSevere: 'env_severe',
        hmrError: 'env_hmr',
        buildSuccess: 'env_success',
      });
    });

    test('options beat env beat defaults', () => {
      const r = resolveOptions(
        { host: 'h:1', sensations: { compileError: 'opt_compile' } },
        { SMITED_SENSATION_COMPILE_ERROR: 'env_compile' },
      );
      expect(r.sensations.compileError).toBe('opt_compile');
    });
  });

  describe('debounceMs', () => {
    test('defaults are compile=500, hmr=300, success=0', () => {
      const r = resolveOptions({ host: 'h:1' });
      expect(r.debounceMs).toEqual({
        compileError: 500,
        hmrError: 300,
        buildSuccess: 0,
      });
    });

    test('options can override individual debounce windows', () => {
      const r = resolveOptions({
        host: 'h:1',
        debounceMs: { compileError: 1000 },
      });
      expect(r.debounceMs.compileError).toBe(1000);
      expect(r.debounceMs.hmrError).toBe(300);
    });
  });

  describe('buildSuccessMinDurationMs', () => {
    test('defaults to 30000', () => {
      const r = resolveOptions({ host: 'h:1' });
      expect(r.buildSuccessMinDurationMs).toBe(30000);
    });

    test('options override', () => {
      const r = resolveOptions({
        host: 'h:1',
        buildSuccessMinDurationMs: 5000,
      });
      expect(r.buildSuccessMinDurationMs).toBe(5000);
    });
  });
});
