export const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random()}`;

/** Controlled clock — tests jump time instead of sleeping. */
export function testClock(start = 1_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
    get value() {
      return t;
    },
  };
}
