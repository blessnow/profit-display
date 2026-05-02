/**
 * A 股常规交易时段（上海时区）：工作日 9:30–11:30、13:00–15:00
 * 不含节假日休市表，仅按周一～周五判断。
 */
export function isCnAshareRegularSession(date = new Date()) {
  const wd = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(date);
  if (wd === "Sat" || wd === "Sun") return false;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const H = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const M = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const t = H * 60 + M;
  const openM = 9 * 60 + 30;
  const closeAm = 11 * 60 + 30;
  const openPm = 13 * 60;
  const closePm = 15 * 60;
  return (t >= openM && t <= closeAm) || (t >= openPm && t <= closePm);
}

/** 上海日历下的周一至周五 */
export function isCnAshareWeekdayShanghai(date = new Date()) {
  const wd = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(date);
  return wd !== "Sat" && wd !== "Sun";
}

/**
 * 常规交易日下午收盘时刻（15:00 上海）及之后：当日曲线视为收盘定格。
 * 周末/holiday 不按此项冻结（由定时行情是否在交易时段决定要不要频繁刷新）。
 */
export function isPastCnAshareRegularClose(date = new Date()) {
  if (!isCnAshareWeekdayShanghai(date)) return false;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const H = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const M = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const t = H * 60 + M;
  const closePm = 15 * 60;
  return t >= closePm;
}
