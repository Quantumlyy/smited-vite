/**
 * Public entry point for `@quantumly-labs/smited-vite`.
 *
 * Re-exports exactly the two members the plugin's API surface contains:
 * the {@link smitedVite} factory and the {@link PluginOptions} type.
 * Everything else — the gRPC client, the trigger pipeline, the
 * generated protobuf code — is an implementation detail and stays
 * internal.
 */

export { smitedVite } from './plugin.js';
export type { PluginOptions } from './config.js';
