/**
 * 内置定时拉价时段（上海时区、工作日）：默认 09:10–11:30、13:00–15:50。
 * （覆盖集合竞价起至收盘后延长段；午休 11:30–13:00 不拉。）
 * 可用环境变量覆盖（24h HH:MM）：
 *   QUOTE_SYNC_AM_START QUOTE_SYNC_AM_END QUOTE_SYNC_PM_START QUOTE_SYNC_PM_END
 *
 * 日快照「冻结市值」仍以交易所 15:00 为基准，见 `SNAPSHOT_FREEZE_DELAY_MIN_AFTER_1500` 等（与拉价窗口独立）。
 *
 * `QUOTE_SESSION_EXTEND_MIN_AFTER_1500`：快照冻结等（15:00 后延长分钟，见 cnAshareSnapshotFreezeStartMinuteOfDay）。
 */
function minuteOfDayFromEnv(key, defaultHour, defaultMinute) {
  const raw = (process.env[key] || "").trim();
  if (!raw) return defaultHour * 60 + defaultMinute;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return defaultHour * 60 + defaultMinute;
  const H = Number(m[1]);
  const M = Number(m[2]);
  if (!Number.isFinite(H) || !Number.isFinite(M)) return defaultHour * 60 + defaultMinute;
  return H * 60 + M;
}
function cnAshareExtendMinAfter1500() {
  const raw = Number(process.env.QUOTE_SESSION_EXTEND_MIN_AFTER_1500);
  return Number.isFinite(raw)
    ? Math.min(60, Math.max(0, Math.floor(raw)))
    : 15;
}

/** 上海当日分钟数：收盘 15:00 之后再过多久开始冻结快照（取 max(拉价延长, 本项)） */
function cnAshareSnapshotFreezeStartMinuteOfDay() {
  const extend = cnAshareExtendMinAfter1500();
  const raw = Number(process.env.SNAPSHOT_FREEZE_DELAY_MIN_AFTER_1500);
  const freezeOpt = Number.isFinite(raw)
    ? Math.min(120, Math.max(0, Math.floor(raw)))
    : extend;
  const afterCloseMin = Math.max(extend, freezeOpt);
  return 15 * 60 + afterCloseMin;
}

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
  const openM = minuteOfDayFromEnv("QUOTE_SYNC_AM_START", 9, 10);
  const closeAm = minuteOfDayFromEnv("QUOTE_SYNC_AM_END", 11, 30);
  const openPm = minuteOfDayFromEnv("QUOTE_SYNC_PM_START", 13, 0);
  const closePmQuote = minuteOfDayFromEnv("QUOTE_SYNC_PM_END", 15, 50);
  return (t >= openM && t <= closeAm) || (t >= openPm && t <= closePmQuote);
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

/**
 * 已超过「盘后」快照冻结时刻：交易所 15:00 收盘之后，再经过
 * max(QUOTE_SESSION_EXTEND_MIN_AFTER_1500, SNAPSHOT_FREEZE_DELAY_MIN_AFTER_1500) 分钟。
 * 在此前仍可整行更新当日快照（与定时拉价延长段重叠或更晚）。
 */
export function isPastCnAshareSnapshotFreezeTime(date = new Date()) {
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
  return t > cnAshareSnapshotFreezeStartMinuteOfDay();
}
