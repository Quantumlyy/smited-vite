# `@quantumly-labs/smited-vite`

A Vite plugin that fires haptic sensations on build errors via the
[smited](https://github.com/Quantumlyy/smited) daemon. TypeScript
compile errors zap you. HMR failures zap you. Long successful
production builds tap you on the shoulder.

## Safe to commit

The plugin is **a complete no-op** unless `SMITED_HOST` is set. With
no environment variable and no options, calling `smitedVite()`:

- registers no listeners
- makes no network calls
- prints nothing
- has zero observable effect on the build

This means you can drop `smitedVite()` into a project's
`vite.config.ts` and ship the plugin in the build. Reviewers without
[smited](https://github.com/Quantumlyy/smited) hardware see no
difference. Only the developer with `SMITED_HOST=...` in their shell
rc gets the haptic feedback.

## 30-second install

```sh
npm install -D @quantumly-labs/smited-vite
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { smitedVite } from '@quantumly-labs/smited-vite';

export default defineConfig({
  plugins: [smitedVite()],
});
```

```sh
# only the developer with hardware sets this:
export SMITED_HOST=windows-rig.local:7777
```

That's it. Run `vite build` or `vite dev`; if `SMITED_HOST` is set
and a smited daemon is reachable, errors fire sensations.

## Configuration

### Plugin options

```ts
smitedVite({
  // Daemon host:port. Defaults to SMITED_HOST env var. Absence = no-op.
  host: 'windows-rig.local:7777',

  // Backend id to target. Defaults to "mock-owo".
  backendId: 'mock-owo',

  // Sensation library names. Set to null to disable a specific event class.
  sensations: {
    compileError: 'compile_error_mild',         // 1-5 errors
    compileErrorSevere: 'compile_error_severe', // 6+ errors
    hmrError: 'compile_error_mild',             // HMR update failure
    buildSuccess: 'deploy_success',             // long successful prod build
  },

  // Debounce windows (ms). Prevents zap-spam during rapid editing.
  debounceMs: {
    compileError: 500,
    hmrError: 300,
    buildSuccess: 0,
  },

  // Successful production builds shorter than this are not celebrated (ms).
  buildSuccessMinDurationMs: 30_000,

  // Force-disable even if SMITED_HOST is set.
  disabled: false,
});
```

### Environment variables

Per-developer overrides — no need to edit `vite.config.ts`:

| Variable | Purpose | Default |
|---|---|---|
| `SMITED_HOST` | Daemon `host:port`. **Absent = no-op.** | _(unset)_ |
| `SMITED_BACKEND_ID` | Target backend id | `mock-owo` |
| `SMITED_DISABLE` | Set to `1` to force-disable | _(unset)_ |
| `SMITED_SENSATION_COMPILE_ERROR` | Override compile-error sensation | `compile_error_mild` |
| `SMITED_SENSATION_COMPILE_ERROR_SEVERE` | Override severe sensation | `compile_error_severe` |
| `SMITED_SENSATION_HMR_ERROR` | Override HMR error sensation | `compile_error_mild` |
| `SMITED_SENSATION_BUILD_SUCCESS` | Override build-success sensation | `deploy_success` |

Precedence: plugin options > environment variables > built-in defaults.

## Event types

| Event | Sensation key | Triggered when |
|---|---|---|
| Compile error (mild) | `compileError` | 1-5 errors in a single error event |
| Compile error (severe) | `compileErrorSevere` | 6+ errors in a single event |
| HMR error | `hmrError` | A Vite error log within 100ms of a hot update |
| Build success | `buildSuccess` | `vite build` succeeds and took longer than `buildSuccessMinDurationMs` |

The plugin parses TypeScript's `Found N errors` header, esbuild's
`X [ERROR]` lines, and bare `N errors` totals to determine the
mild-vs-severe split. If parsing fails, it defaults to mild.

## Troubleshooting

**Verify the plugin is active.** When `SMITED_HOST` is set, you'll
see one info line at startup:

```
[smited-vite] active, host=windows-rig.local:7777, backend=mock-owo
```

If the line is missing, the plugin thinks it's inactive — check
`SMITED_HOST`, `SMITED_DISABLE`, and `disabled: true` in plugin
options.

**Verify the daemon is reachable.**

```sh
grpcurl -plaintext "$SMITED_HOST" list
# expect: smited.v1.SmitedService
```

**Disable temporarily without editing config.**

```sh
SMITED_DISABLE=1 npm run build
```

**See what the plugin is doing under the hood.** Set `DEBUG` to
include `smited` and the plugin emits debug lines through Vite's
logger:

```sh
DEBUG=smited npm run build
```

## Internals

- **Schema:** [`buf.build/quantumly-labs/smited`](https://buf.build/quantumly-labs/smited) — pinned to `v0.1.0`.
- **Wire:** standard gRPC over h2c via `@connectrpc/connect-node`.
- **Bundle:** ESM-only, ~96 KB, no CJS support.
- **Peer:** Vite 7 or 8.
- **Engines:** Node 22+.

## License

MIT — see [LICENSE](./LICENSE).
