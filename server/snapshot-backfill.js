import {
  normalizeStockCode,
  guessSecidFromCode,
  fetchDailyKlineCloses,
} from "./market-quote.js";
import { shanghaiTodayStr } from "./snapshots.js";
import { isCnAshareTradingDayYmd } from "./exchange-calendar.js";
import { aggregateAccountForSnapshotDay } from "./portfolio.js";
import { historyCalendarDaysDefault } from "./history-window.js";

/** 最近 n 个自然日（上海日历），从早到晚 */
export function lastNDaysShanghaiOldestFirst(n) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  const days = Math.min(60, Math.max(2, Number(n) || historyCalendarDaysDefault()));
  const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    labels.push(fmt.format(new Date(Date.now() - i * 86400000)));
  }
  return labels;
}

export function subtractCalendarDaysFromYmd(ymdStr, deltaDays) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const u = Date.UTC(y, m - 1, d - deltaDays);
  return new Date(u).toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
}

export function ymdToCompact(ymdStr) {
  return String(ymdStr).replace(/-/g, "");
}

/**
 * 仅在「回填窗口内的日历日」上向前填充：某日无 K 则用上一日收盘价。
 * 不再用窗口**之前**任意历史 K 做 seed——否则 API 若未返回 4/17～4/22 的 bar，
 * 会把 2 月等更早收盘价误填到 4 月上旬，造成前几根市值全错、后面有数据后又正常的现象。
 */
export function forwardFillClosesOnCalendar(displayDaysOldestFirst, tradingMap) {
  let last = null;
  const out = new Map();
  for (const day of displayDaysOldestFirst) {
    const v = tradingMap.has(day) ? tradingMap.get(day) : null;
    if (v != null && Number.isFinite(v) && v > 0) {
      last = v;
      out.set(day, v);
    } else if (last != null) {
      out.set(day, last);
    } else {
      out.set(day, null);
    }
  }
  return out;
}

/**
 * 真实数据：当前持仓股数 × 该日日 K 收盘价 + 当前可用现金。
 * 只写入「早于上海当日」的日历日；当日快照交给 upsertDailySnapshots（现价/定时行情）。
 * 假设：回填区间内股数、现金与当前一致（未重演买卖）。
 */
export async function backfillSnapshotsFromHistoricalKlines(
  db,
  calendarDays = historyCalendarDaysDefault()
) {
  const tpl = (process.env.QUOTE_KLINE_URL || "").trim();
  if (!tpl) {
    return { skipped: true, reason: "QUOTE_KLINE_URL empty" };
  }

  const todayStr = shanghaiTodayStr();
  const displayDays = lastNDaysShanghaiOldestFirst(calendarDays);
  const historicalDays = displayDays.filter(
    (d) => d < todayStr && isCnAshareTradingDayYmd(d)
  );
  if (historicalDays.length === 0) {
    return {
      skipped: true,
      reason: "no_days_before_today_in_window",
      today: todayStr,
    };
  }

  const oldest = historicalDays[0];
  const newestHist = historicalDays[historicalDays.length - 1];
  const beg = ymdToCompact(subtractCalendarDaysFromYmd(oldest, 40));
  const end = ymdToCompact(newestHist);

  /** 仅用于按代码拉 K；逐账户市值在 aggregateAccountForSnapshotDay 内按账户重算 */
  const holdings = db
    .prepare(
      `SELECT account_id, stock_code, position, current_price
       FROM holdings WHERE position > 0`
    )
    .all();

  const codes = [
    ...new Set(
      holdings
        .map((h) => normalizeStockCode(h.stock_code))
        .filter(Boolean)
    ),
  ];

  const closeByCodeDay = new Map();
  const fetchErrors = [];
  const concurrency = 5;

  for (let off = 0; off < codes.length; off += concurrency) {
    const chunk = codes.slice(off, off + concurrency);
    await Promise.all(
      chunk.map(async (code) => {
        try {
          const secid = guessSecidFromCode(code);
          const trading = await fetchDailyKlineCloses(secid, beg, end);
          const filled = forwardFillClosesOnCalendar(historicalDays, trading);
          closeByCodeDay.set(code, filled);
        } catch (e) {
          fetchErrors.push({
            code,
            message: e.message || String(e),
          });
        }
      })
    );
  }

  const accounts = db
    .prepare(`SELECT id, available_cash FROM accounts ORDER BY id`)
    .all();

  const upsert = db.prepare(`
    INSERT INTO snapshot_daily (account_id, day, total_assets, market_value, position_profit, realized_pnl, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, day) DO UPDATE SET
      total_assets = excluded.total_assets,
      market_value = excluded.market_value,
      position_profit = excluded.position_profit,
      realized_pnl = excluded.realized_pnl,
      updated_at = excluded.updated_at
  `);

  let cells = 0;
  const tx = db.transaction(() => {
    for (const acc of accounts) {
      const id = Number(acc.id);
      for (const day of historicalDays) {
        const agg = aggregateAccountForSnapshotDay(db, id, (h) => {
          const code = normalizeStockCode(h.stock_code);
          if (!code) return Number(h.current_price);
          const dm = closeByCodeDay.get(code);
          const px = dm?.get(day);
          if (px != null && Number.isFinite(px) && px > 0) return px;
          return Number(h.current_price);
        });
        if (!agg) continue;
        upsert.run(
          id,
          day,
          agg.summary.total_assets,
          agg.summary.market_value,
          agg.summary.total_profit,
          0
        );
        cells++;
      }
    }
  });
  tx();

  return {
    ok: true,
    skipped: false,
    method:
      "与页面实时同一套汇总：逐账户 aggregate + 每持仓当日 K 收盘（无则现价）+ 该账户当前可用资金",
    today: todayStr,
    calendar_days_window: displayDays.length,
    historical_days: historicalDays,
    beg,
    end,
    upserts: cells,
    codes_ok: codes.length - fetchErrors.length,
    codes_failed: fetchErrors.length,
    fetch_errors: fetchErrors,
  };
}
