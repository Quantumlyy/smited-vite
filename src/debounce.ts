/**
 * Leading-edge debouncer keyed by event class. The first call for a given
 * key always fires; subsequent calls within `windowMs` of the last fire
 * are suppressed. The window is measured from the *fire* time, not the
 * most recent attempt — a flurry of suppressed calls cannot extend it.
 *
 * Used by the plugin to keep haptic triggers from firing on every
 * keystroke during a typo cascade.
 */
export class Debouncer {
  readonly #last = new Map<string, number>();

  /**
   * Returns `true` if the caller should proceed (fire the trigger).
   * Returns `false` if a previous fire for the same key occurred less
   * than `windowMs` ago. A `windowMs` of 0 (or any non-positive value)
   * disables debouncing for the call.
   */
  try(key: string, windowMs: number): boolean {
    if (windowMs <= 0) return true;
    const now = Date.now();
    const last = this.#last.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    this.#last.set(key, now);
    return true;
  }
}
