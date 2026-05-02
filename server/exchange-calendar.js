/**
 * A 股沪深交易日（上海日历日）：周一～周五且非交易所公告休市日。
 * 休市表按上交所年度安排维护（与常见券商日历一致）；跨年需增补新表。
 * 参考：https://www.sse.com.cn/disclosure/dealinstruc/closed/
 */

const OFF = new Set();

const fmtSh = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
});

function addRange(y0, m0, d0, y1, m1, d1) {
  let ms = Date.UTC(y0, m0 - 1, d0, 12, 0, 0);
  const end = Date.UTC(y1, m1 - 1, d1, 12, 0, 0);
  for (; ms <= end; ms += 86400000) {
    OFF.add(fmtSh.format(new Date(ms)));
  }
}

// --- 2025（主要节假，与上交所公告大致对齐；边界以交易所为准）---
addRange(2025, 1, 1, 2025, 1, 1); // 元旦
addRange(2025, 1, 28, 2025, 2, 4); // 春节
addRange(2025, 4, 4, 2025, 4, 6); // 清明
addRange(2025, 5, 1, 2025, 5, 5); // 劳动节
addRange(2025, 5, 31, 2025, 6, 2); // 端午
addRange(2025, 10, 1, 2025, 10, 8); // 国庆中秋

// --- 2026（上证公告〔2025〕45 号 / 网站「2026年休市安排」）---
addRange(2026, 1, 1, 2026, 1, 3); // 元旦
addRange(2026, 2, 15, 2026, 2, 23); // 春节
addRange(2026, 4, 4, 2026, 4, 6); // 清明节
addRange(2026, 5, 1, 2026, 5, 5); // 劳动节
addRange(2026, 6, 19, 2026, 6, 21); // 端午节
addRange(2026, 9, 25, 2026, 9, 27); // 中秋节
addRange(2026, 10, 1, 2026, 10, 7); // 国庆节

// --- 2027（占位：仅元旦；其余待上交所发布后增补）---
addRange(2027, 1, 1, 2027, 1, 3);

/** 上海时区下该日历日是否为周六、周日 */
export function isWeekendShanghaiYmd(ymdStr) {
  const [y, m, d] = String(ymdStr)
    .split("-")
    .map((x) => Number(x));
  if (!y || !m || !d) return true;
  const ms = Date.UTC(y, m - 1, d, 4, 0, 0);
  const wd = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(ms));
  return wd === "Sat" || wd === "Sun";
}

/** 是否为 A 股交易日（可写入日 K 快照的日历日） */
export function isCnAshareTradingDayYmd(ymdStr) {
  const ymd = String(ymdStr).slice(0, 10);
  if (isWeekendShanghaiYmd(ymd)) return false;
  if (OFF.has(ymd)) return false;
  return true;
}
