import { create } from '@bufbuild/protobuf';
import { type Client, createClient } from '@connectrpc/connect';
import { createGrpcTransport, Http2SessionManager } from '@connectrpc/connect-node';
import {
  BackendStatus,
  HealthRequestSchema,
  SmitedService,
  TriggerErrorCode,
  TriggerRequestSchema,
} from '../gen/ts/smited/v1/smited_pb.js';
import type { TaggedLogger } from './logger.js';

/**
 * Reduced summary of the daemon's health response — what the plugin
 * actually consumes. The full HealthResponse from the wire is
 * intentionally not exposed; consumers don't need to know about
 * timestamps, capabilities, or generated types.
 */
export interface HealthSummary {
  daemonRunning: boolean;
  version: string;
  backends: Array<{ id: string; status: keyof typeof BackendStatus }>;
}

/**
 * Thin wrapper around the generated `SmitedService` client.
 *
 * Every method is best-effort: transport errors, daemon-side
 * rejections, and the daemon being down are logged at debug and
 * swallowed. The plugin must NEVER break a build because the daemon
 * is unreachable, so this class never throws.
 */
export class SmitedClient {
  readonly #logger: TaggedLogger;
  readonly #backendId: string;
  readonly #client: Client<typeof SmitedService>;
  readonly #sessionManager: Http2SessionManager;

  constructor(host: string, backendId: string, logger: TaggedLogger) {
    this.#logger = logger;
    this.#backendId = backendId;
    // h2c: cleartext HTTP/2. Owning the session manager explicitly lets
    // close() abort the underlying connection from closeBundle so the
    // build process exits cleanly without waiting for the default
    // 15-minute idle timeout.
    const baseUrl = `http://${host}`;
    this.#sessionManager = new Http2SessionManager(baseUrl, {
      idleConnectionTimeoutMs: 5_000,
    });
    const transport = createGrpcTransport({
      baseUrl,
      sessionManager: this.#sessionManager,
    });
    this.#client = createClient(SmitedService, transport);
  }

  /**
   * Fire a registered sensation by name on the configured backend.
   * Returns `true` iff the daemon accepted the trigger; returns
   * `false` on transport error, on `accepted=false`, or on any other
   * failure path. Never throws.
   */
  async trigger(
    sensationName: string,
    options: { intensityScale?: number; clientTraceId?: string } = {},
  ): Promise<boolean> {
    try {
      const req = create(TriggerRequestSchema, {
        backendId: this.#backendId,
        sensation: { case: 'sensationName', value: sensationName },
        clientTraceId: options.clientTraceId ?? generateTraceId(),
        ...(options.intensityScale !== undefined
          ? { intensityScale: options.intensityScale }
          : {}),
      });
      const res = await this.#client.trigger(req);
      if (!res.accepted) {
        const code = res.error
          ? (TriggerErrorCode[res.error.code] ?? `code=${res.error.code}`)
          : 'UNSPECIFIED';
        const msg = res.error?.message ?? '';
        this.#logger.debug(`trigger rejected: ${code} ${msg}`.trim());
        return false;
      }
      return true;
    } catch (err) {
      this.#logger.debug(`trigger transport error: ${describeError(err)}`);
      return false;
    }
  }

  /**
   * One-shot health probe. Returns a small summary on success or
   * `null` on any failure. Logged at debug; the plugin runs whether
   * the daemon answers or not — it may come up later in the session.
   */
  async healthCheck(): Promise<HealthSummary | null> {
    try {
      const res = await this.#client.health(create(HealthRequestSchema, {}));
      return {
        daemonRunning: res.daemonRunning,
        version: res.version,
        backends: res.backends.map((b) => ({
          id: b.id,
          status: (BackendStatus[b.status] ?? 'UNSPECIFIED') as keyof typeof BackendStatus,
        })),
      };
    } catch (err) {
      this.#logger.debug(`health transport error: ${describeError(err)}`);
      return null;
    }
  }

  /**
   * Tear down the underlying h2c session so Node can exit. Safe to
   * call multiple times — `abort` on an already-closed session is a
   * no-op.
   */
  close(): void {
    try {
      this.#sessionManager.abort();
    } catch {
      // Defensive: if the manager throws on a stale state, swallow.
    }
  }
}

/**
 * Smited daemon enforces ^[a-zA-Z0-9_-]*$ on client_trace_id, with a
 * 128-char cap. UUID with hyphens stripped fits comfortably.
 */
function generateTraceId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return uuid.replace(/-/g, '');
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
