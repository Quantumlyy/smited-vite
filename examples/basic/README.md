# `examples/basic`

The smallest possible Vite project that exercises `smited-vite`.
Used during development as an end-to-end smoke test:

1. With `SMITED_HOST` **unset** the build behaves identically to a
   stock Vite project — no startup line, no network, no logs.
2. With `SMITED_HOST` set the plugin logs `[smited-vite] active, ...`
   and (if a daemon is reachable) fires sensations on errors and
   long successful builds.

## Run

```sh
# in the repo root, build the plugin once so the file: link below resolves:
npm run build

# then in this directory:
cd examples/basic
npm install
npm run build              # silent; smited-vite is inert
SMITED_HOST=127.0.0.1:7777 npm run build   # active; harmless if no daemon
```

The plugin must never break a build because the daemon is
unreachable, so the second command also exits 0 even when nothing
is listening on port 7777 — it just logs the active line and moves on.
