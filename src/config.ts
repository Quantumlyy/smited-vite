/**
 * User-facing configuration for the smited Vite plugin.
 *
 * Every field is optional. The defining trait of the plugin is that
 * `smitedVite()` with no arguments and no environment variables is a
 * complete no-op — see {@link PluginOptions.host} for the activation
 * contract.
 */
export interface PluginOptions {
  /**
   * smited daemon `host:port`, e.g. `"windows-rig.local:7777"`. When
   * unset, falls back to the `SMITED_HOST` environment variable. When
   * neither source provides a value, the plugin is a complete no-op:
   * no listeners are registered, no network calls are made, no logs
   * are emitted.
   */
  host?: string;

  /**
   * Backend id to target. Defaults to `"mock-owo"` for safety — the
   * mock backend is always present on a running daemon, and pointing
   * at it accidentally on a hardware-equipped daemon does nothing
   * scary. **The mock backend accepts triggers but produces no haptic
   * output**, so you must override this (here or via the
   * `SMITED_BACKEND_ID` environment variable) to point at your real
   * hardware backend if you actually want to feel anything.
   */
  backendId?: string;

  /**
   * Sensation library names to fire for each event class. Each entry
   * is the registered sensation's `name` field on the daemon. Set any
   * to `null` to disable that event class entirely.
   */
  sensations?: {
    /** Default: `"compile_error_mild"`. */
    compileError?: string | null;
    /** Default: `"compile_error_severe"`. Fires when an error event reports more than 5 errors. */
    compileErrorSevere?: string | null;
    /** Default: `"compile_error_mild"`. Fires for HMR update failures. */
    hmrError?: string | null;
    /** Default: `"deploy_success"`. Fires only when a successful production build exceeds {@link buildSuccessMinDurationMs}. */
    buildSuccess?: string | null;
  };

  /**
   * Debounce window per event class (ms). Prevents zap-spam during
   * rapid editing. Defaults: `compileError=500`, `hmrError=300`,
   * `buildSuccess=0`.
   */
  debounceMs?: {
    compileError?: number;
    hmrError?: number;
    buildSuccess?: number;
  };

  /**
   * Build duration threshold above which a successful production
   * build fires the success sensation. Defaults to `30000` (30s).
   * Prevents celebrating trivial builds.
   */
  buildSuccessMinDurationMs?: number;

  /**
   * Disable the plugin even if `SMITED_HOST` is set. Useful for
   * one-off "build this without zapping me" runs via
   * `SMITED_DISABLE=1 npm run build`.
   */
  disabled?: boolean;
}

/**
 * Resolved configuration consumed internally by the plugin. All fields
 * are required (with the exception of `host`, which is undefined when
 * `active` is false).
 */
export interface ResolvedOptions {
  active: boolean;
  host: string | undefined;
  backendId: string;
  sensations: {
    compileError: string | null;
    compileErrorSevere: string | null;
    hmrError: string | null;
    buildSuccess: string | null;
  };
  debounceMs: {
    compileError: number;
    hmrError: number;
    buildSuccess: number;
  };
  buildSuccessMinDurationMs: number;
}

const DEFAULT_SENSATIONS = {
  compileError: 'compile_error_mild',
  compileErrorSevere: 'compile_error_severe',
  hmrError: 'compile_error_mild',
  buildSuccess: 'deploy_success',
} as const;

const DEFAULT_DEBOUNCE_MS = {
  compileError: 500,
  hmrError: 300,
  buildSuccess: 0,
} as const;

const DEFAULT_BUILD_SUCCESS_MIN_DURATION_MS = 30_000;

const SENSATION_ENV_KEYS = {
  compileError: 'SMITED_SENSATION_COMPILE_ERROR',
  compileErrorSevere: 'SMITED_SENSATION_COMPILE_ERROR_SEVERE',
  hmrError: 'SMITED_SENSATION_HMR_ERROR',
  buildSuccess: 'SMITED_SENSATION_BUILD_SUCCESS',
} as const;

type EnvLike = Record<string, string | undefined>;

/**
 * Merge precedence: `options` > environment variables > built-in defaults.
 *
 * The `disabled` flag and the absence of a host both result in
 * `active === false`. The plugin's hooks short-circuit on `!active`,
 * which is what makes the package safe to commit to projects whose
 * developers don't share the author's hardware.
 */
export function resolveOptions(
  options?: PluginOptions,
  env: EnvLike = process.env,
): ResolvedOptions {
  const host = options?.host ?? env.SMITED_HOST ?? undefined;
  const disabled = options?.disabled ?? env.SMITED_DISABLE === '1';
  const active = !disabled && typeof host === 'string' && host.length > 0;

  const backendId =
    options?.backendId ?? env.SMITED_BACKEND_ID ?? 'mock-owo';

  const sensations = {
    compileError: pickSensation(options?.sensations?.compileError, env, 'compileError'),
    compileErrorSevere: pickSensation(
      options?.sensations?.compileErrorSevere,
      env,
      'compileErrorSevere',
    ),
    hmrError: pickSensation(options?.sensations?.hmrError, env, 'hmrError'),
    buildSuccess: pickSensation(options?.sensations?.buildSuccess, env, 'buildSuccess'),
  };

  const debounceMs = {
    compileError: options?.debounceMs?.compileError ?? DEFAULT_DEBOUNCE_MS.compileError,
    hmrError: options?.debounceMs?.hmrError ?? DEFAULT_DEBOUNCE_MS.hmrError,
    buildSuccess: options?.debounceMs?.buildSuccess ?? DEFAULT_DEBOUNCE_MS.buildSuccess,
  };

  const buildSuccessMinDurationMs =
    options?.buildSuccessMinDurationMs ?? DEFAULT_BUILD_SUCCESS_MIN_DURATION_MS;

  return {
    active,
    host: active ? host : undefined,
    backendId,
    sensations,
    debounceMs,
    buildSuccessMinDurationMs,
  };
}

function pickSensation(
  fromOptions: string | null | undefined,
  env: EnvLike,
  key: keyof typeof DEFAULT_SENSATIONS,
): string | null {
  if (fromOptions === null) return null;
  if (typeof fromOptions === 'string') return fromOptions;
  const fromEnv = env[SENSATION_ENV_KEYS[key]];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return DEFAULT_SENSATIONS[key];
}
