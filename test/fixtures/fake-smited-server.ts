import { createServer, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { create } from '@bufbuild/protobuf';
import { type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import {
  BackendStatus,
  HealthResponseSchema,
  SmitedService,
  type TriggerRequest,
  TriggerResponseSchema,
  type HealthResponse,
  type TriggerResponse,
} from '../../gen/ts/smited/v1/smited_pb.js';

/**
 * Test fixture: an in-process h2c gRPC server speaking the smited
 * protocol. Tests inject custom handlers per-call, or fall back to the
 * sensible defaults (Trigger → accepted, Health → daemon up with the
 * mock-owo backend present).
 */
export interface FakeServerOptions {
  /** Override the Trigger handler. Default returns `{accepted: true}`. */
  triggerHandler?: (req: TriggerRequest) => TriggerResponse;
  /** Override the Health handler. Default returns a healthy daemon with mock-owo. */
  healthHandler?: () => HealthResponse;
}

export interface FakeServer {
  /** Loopback host:port the client should target. */
  address: string;
  /** Every TriggerRequest the server has received, in order. */
  received: TriggerRequest[];
  /** Tear down the server. Awaits the underlying close. */
  stop(): Promise<void>;
}

/**
 * Start an h2c HTTP/2 server bound to an ephemeral loopback port and
 * return a handle once it's listening. Caller is responsible for
 * `stop()` in an afterEach.
 */
export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const received: TriggerRequest[] = [];

  const triggerHandler =
    options.triggerHandler ??
    ((_req: TriggerRequest): TriggerResponse =>
      create(TriggerResponseSchema, {
        accepted: true,
        sensationId: 'fake-sensation-1',
      }));

  const healthHandler =
    options.healthHandler ??
    ((): HealthResponse =>
      create(HealthResponseSchema, {
        daemonRunning: true,
        version: 'fake-0',
        backends: [
          {
            id: 'mock-owo',
            kind: 'mock',
            displayName: 'Mock OWO',
            status: BackendStatus.READY,
            capabilities: [],
          },
        ],
      }));

  const routes = (router: ConnectRouter) => {
    router.service(SmitedService, {
      trigger(req: TriggerRequest) {
        received.push(req);
        return triggerHandler(req);
      },
      health() {
        return healthHandler();
      },
      // Methods we don't exercise — provide stubs so the router
      // accepts the service registration.
      listBackends: () => ({ backends: [] }),
      describeBackend: () => ({}),
      stop: () => ({ stoppedCount: 0 }),
      listSensations: () => ({ sensations: [] }),
      registerSensation: () => ({ registered: true, error: '' }),
      unregisterSensation: () => ({ unregistered: true }),
      // Streaming RPC: yield nothing, so the client's read returns immediately.
      async *subscribeEvents() {
        // empty
      },
    });
  };

  const handler = connectNodeAdapter({ routes });
  const server: Http2Server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addrInfo = server.address() as AddressInfo;
  const address = `127.0.0.1:${addrInfo.port}`;

  return {
    address,
    received,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
