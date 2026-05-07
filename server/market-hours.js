/**
 * A 股常规交易时段（上海时区）：工作日 9:30–11:30、13:00–15:00；
 * 内置定时拉价仅在此时返回 true。下午段可按 env 延长若干分钟，便于数据源落到收盘价后再写入。
 * `QUOTE_SESSION_EXTEND_MIN_AFTER_1500`：相对 15:00 的延后分钟数，0～60，默认 15。
 *
 * 日快照「冻结市值」在交易所收盘（15:00）之后再延后：`SNAPSHOT_FREEZE_DELAY_MIN_AFTER_1500`
 *（默认未设置时等于延长拉价分钟；若单独加大，则盘后再晚一刻冻结）。不会早于拉价结束。
 */
function cnAshareExtendMinAfter1500() {
  const raw = Number(process.env.QUOTE_SESSION_EXTEND_MIN_AFTER_1500);
  return Number.isFinite(raw)
    ? Math.min(60, Math.max(0, Math.floor(raw)))
    : 15;
}

function cnAsharePmQuoteSessionEndMinuteOfDay() {
  return 15 * 60 + cnAshareExtendMinAfter1500();
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
  const openM = 9 * 60 + 30;
  const closeAm = 11 * 60 + 30;
  const openPm = 13 * 60;
  const closePmQuote = cnAsharePmQuoteSessionEndMinuteOfDay();
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
