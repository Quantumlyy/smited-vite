import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  TriggerErrorCode,
  TriggerResponseSchema,
} from '../gen/ts/smited/v1/smited_pb.js';
import { SmitedClient } from '../src/client.js';
import { createTaggedLogger } from '../src/logger.js';
import { startFakeServer, type FakeServer } from './fixtures/fake-smited-server.js';

function silentVite() {
  return {
    info: () => {},
    warn: () => {},
    warnOnce: () => {},
    error: () => {},
    clearScreen: () => {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
}

describe('SmitedClient', () => {
  let server: FakeServer;
  let client: SmitedClient;

  afterEach(async () => {
    client?.close();
    await server?.stop();
  });

  describe('trigger()', () => {
    test('returns true when the daemon accepts the trigger', async () => {
      server = await startFakeServer();
      client = new SmitedClient(server.address, 'mock-owo', createTaggedLogger(silentVite() as never));

      const ok = await client.trigger('compile_error_mild');
      expect(ok).toBe(true);
      expect(server.received).toHaveLength(1);
      expect(server.received[0]?.backendId).toBe('mock-owo');
      expect(server.received[0]?.sensation).toEqual({
        case: 'sensationName',
        value: 'compile_error_mild',
      });
    });

    test('echoes the supplied client_trace_id', async () => {
      server = await startFakeServer();
      client = new SmitedClient(server.address, 'mock-owo', createTaggedLogger(silentVite() as never));

      await client.trigger('foo', { clientTraceId: 'abc-123' });
      expect(server.received[0]?.clientTraceId).toBe('abc-123');
    });

    test('generates a fresh client_trace_id when none supplied', async () => {
      server = await startFakeServer();
      client = new SmitedClient(server.address, 'mock-owo', createTaggedLogger(silentVite() as never));

      await client.trigger('foo');
      const id = server.received[0]?.clientTraceId ?? '';
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    });

    test('passes intensityScale when supplied', async () => {
      server = await startFakeServer();
      client = new SmitedClient(server.address, 'mock-owo', createTaggedLogger(silentVite() as never));

      await client.trigger('foo', { intensityScale: 50 });
      expect(server.received[0]?.intensityScale).toBe(50);
    });

    test('returns false when the daemon rejects the trigger', async () => {
      server = await startFakeServer({
        triggerHandler: () =>
          create(TriggerResponseSchema, {
            accepted: false,
            error: {
              code: TriggerErrorCode.SENSATION_NOT_FOUND,
              message: 'unknown sensation',
              field: 'sensation_name',
            },
          }),
      });
      client = new SmitedClient(server.address, 'mock-owo', createTaggedLogger(silentVite() as never));

      const ok = await client.trigger('does_not_exist');
      expect(ok).toBe(false);
    });

    test('returns false on transport error (server stopped)', async () => {
      server = await startFakeServer();
      const addr = server.address;
      await server.stop();
      // Reassign to a stopped sentinel so afterEach doesn't double-close.
      server = { address: addr, received: [], stop: async () => {} };

      client = new SmitedClient(addr, 'mock-owo', createTaggedLogger(silentVite() as never));
      const ok = await client.trigger('whatever');
      expect(ok).toBe(false);
    });
  });

  describe('healthCheck()', () => {
    test('returns a summary on success', async () => {
      server = await startFakeServer();
      client = new SmitedClient(server.address, 'mock-owo', createTaggedLogger(silentVite() as never));

      const summary = await client.healthCheck();
      expect(summary).not.toBeNull();
      expect(summary?.daemonRunning).toBe(true);
      expect(summary?.version).toBe('fake-0');
      expect(summary?.backends).toEqual([
        { id: 'mock-owo', status: 'READY' },
      ]);
    });

    test('returns null on transport error', async () => {
      server = await startFakeServer();
      const addr = server.address;
      await server.stop();
      server = { address: addr, received: [], stop: async () => {} };

      client = new SmitedClient(addr, 'mock-owo', createTaggedLogger(silentVite() as never));
      const summary = await client.healthCheck();
      expect(summary).toBeNull();
    });
  });
});
