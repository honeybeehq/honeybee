const configured = Number(process.env.HIVE_TEST_TIME_SCALE);

export const TEST_TIME_SCALE = Number.isFinite(configured) && configured > 0 ? configured : 1;

export function scaledMs(ms: number): number {
  return Math.ceil(ms * TEST_TIME_SCALE);
}
