import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTaggedLogger, type TaggedLogger } from '../src/logger.js';
import type { Logger } from 'vite';

function fakeViteLogger(): Logger & { _calls: { info: string[]; warn: string[]; error: string[] } } {
  const calls = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  return {
    info: (msg: string) => calls.info.push(msg),
    warn: (msg: string) => calls.warn.push(msg),
    warnOnce: (msg: string) => calls.warn.push(msg),
    error: (msg: string) => calls.error.push(msg),
    clearScreen: () => {},
    hasErrorLogged: () => false,
    hasWarned: false,
    _calls: calls,
  } as Logger & { _calls: typeof calls };
}

describe('createTaggedLogger', () => {
  let originalDebug: string | undefined;

  beforeEach(() => {
    originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;
  });

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
  });

  test('info routes to base.info with [smited-vite] tag', () => {
    const base = fakeViteLogger();
    const tagged: TaggedLogger = createTaggedLogger(base);
    tagged.info('active');
    expect(base._calls.info).toEqual(['[smited-vite] active']);
  });

  test('debug is silent when DEBUG env does not include "smited"', () => {
    const base = fakeViteLogger();
    const tagged = createTaggedLogger(base);
    tagged.debug('something happened');
    expect(base._calls.info).toEqual([]);
    expect(base._calls.warn).toEqual([]);
    expect(base._calls.error).toEqual([]);
  });

  test('debug routes to base.info with [debug] tag when DEBUG=smited', () => {
    process.env.DEBUG = 'smited';
    const base = fakeViteLogger();
    const tagged = createTaggedLogger(base);
    tagged.debug('something happened');
    expect(base._calls.info).toEqual(['[smited-vite] [debug] something happened']);
  });

  test('debug also fires when DEBUG contains "smited" as a substring', () => {
    process.env.DEBUG = 'foo,smited:*,bar';
    const base = fakeViteLogger();
    const tagged = createTaggedLogger(base);
    tagged.debug('hi');
    expect(base._calls.info).toEqual(['[smited-vite] [debug] hi']);
  });
});
