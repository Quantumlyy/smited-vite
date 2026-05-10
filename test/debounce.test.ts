import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Debouncer } from '../src/debounce.js';

describe('Debouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('first call for a key returns true', () => {
    const d = new Debouncer();
    expect(d.try('compile', 500)).toBe(true);
  });

  test('second call within the window returns false', () => {
    const d = new Debouncer();
    d.try('compile', 500);
    vi.advanceTimersByTime(100);
    expect(d.try('compile', 500)).toBe(false);
  });

  test('call after the window elapses returns true', () => {
    const d = new Debouncer();
    d.try('compile', 500);
    vi.advanceTimersByTime(500);
    expect(d.try('compile', 500)).toBe(true);
  });

  test('windowMs of 0 always returns true', () => {
    const d = new Debouncer();
    expect(d.try('build', 0)).toBe(true);
    expect(d.try('build', 0)).toBe(true);
    expect(d.try('build', 0)).toBe(true);
  });

  test('different keys are independent', () => {
    const d = new Debouncer();
    expect(d.try('compile', 500)).toBe(true);
    expect(d.try('hmr', 500)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(d.try('compile', 500)).toBe(false);
    expect(d.try('hmr', 500)).toBe(false);
  });

  test('a previously-suppressed call does not extend the window', () => {
    const d = new Debouncer();
    d.try('compile', 500);
    vi.advanceTimersByTime(400);
    d.try('compile', 500); // suppressed
    vi.advanceTimersByTime(100); // 500ms total since first fire
    expect(d.try('compile', 500)).toBe(true);
  });
});
