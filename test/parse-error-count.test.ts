import { describe, expect, test } from 'vitest';
import { parseErrorCount } from '../src/triggers/compile-error.js';

describe('parseErrorCount', () => {
  test('extracts the count from TypeScript "Found N errors"', () => {
    expect(parseErrorCount('Found 3 errors in 2 files.')).toBe(3);
  });

  test('handles "Found 1 error" (singular)', () => {
    expect(parseErrorCount('Found 1 error.')).toBe(1);
  });

  test('counts individual "error TS####" occurrences when no header is present', () => {
    const msg =
      'src/foo.ts(1,1): error TS2304: Cannot find name "x".\n' +
      'src/bar.ts(2,2): error TS2304: Cannot find name "y".';
    expect(parseErrorCount(msg)).toBe(2);
  });

  test('counts esbuild "X [ERROR]" lines', () => {
    const msg = 'X [ERROR] one\nsource:1:1\nX [ERROR] two\nsource:2:2';
    expect(parseErrorCount(msg)).toBe(2);
  });

  test('returns 1 when nothing matches', () => {
    expect(parseErrorCount('something exploded')).toBe(1);
  });

  test('returns 1 for an empty string', () => {
    expect(parseErrorCount('')).toBe(1);
  });

  test('prefers an explicit "Found N errors" over per-line counts', () => {
    const msg =
      'Found 9 errors in 3 files.\n' +
      'src/a.ts: error TS1.\n' +
      'src/b.ts: error TS2.';
    expect(parseErrorCount(msg)).toBe(9);
  });

  test('reads bare "N errors" totals (e.g. esbuild summary)', () => {
    expect(parseErrorCount('Build failed with 7 errors:')).toBe(7);
  });
});
