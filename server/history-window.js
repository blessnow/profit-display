/**
 * 日 K 回填与「资产曲线」查询共用：近若干上海自然日（含今日方向由调用方决定）。
 * 默认 14（约两周），可用环境变量覆盖。
 */
export function historyCalendarDaysDefault() {
  const raw = process.env.SNAPSHOT_HISTORY_CALENDAR_DAYS;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 3 && n <= 60) return Math.floor(n);
  return 14;
}
