import { aggregateAccount } from "./portfolio.js";
import {
  isCnAshareWeekdayShanghai,
  isPastCnAshareSnapshotFreezeTime,
} from "./market-hours.js";
import { isCnAshareTradingDayYmd } from "./exchange-calendar.js";
import { historyCalendarDaysDefault } from "./history-window.js";

/** YYYY-MM-DD，上海日历日 */
export function shanghaiTodayStr() {
  return new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
}

function buildShanghaiDayRange(numDays) {
  const tz = "Asia/Shanghai";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymdFromMs = (ms) => {
    const parts = Object.fromEntries(
      fmt
        .formatToParts(new Date(ms))
        .filter((x) => x.type !== "literal")
        .map((x) => [x.type, x.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  let ms = Date.now();
  const labels = [];
  for (let i = 0; i < numDays; i++) {
    labels.unshift(ymdFromMs(ms));
    ms -= 86400000;
  }
  return { start: labels[0], labels };
}

const SNAPSHOT_RETAIN_DAYS = 365;

export function pruneSnapshotDailyOlderThanDays(db, retainDays = SNAPSHOT_RETAIN_DAYS) {
  const today = shanghaiTodayStr();
  const [y, m, d] = today.split("-").map(Number);
  const cutoffUtc = Date.UTC(y, m - 1, d - retainDays);
  const cutoff = new Date(cutoffUtc).toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  db.prepare(`DELETE FROM snapshot_daily WHERE day < ?`).run(cutoff);
}

/**
 * 按上海「今天」写入/更新每个账户一行：总资产、持仓市值、持仓盈亏、已实现（占位 0）。
 * - 工作日且已过「盘后」快照冻结时刻（15:00 + max(延长拉价分钟, SNAPSHOT_FREEZE_DELAY…)）后：若当日已有记录则不再改写总资产/市值；若无记录则补一条。盈亏列仍会修补。
 * - 每次调用会删除早于 retainDays 的快照（默认保留 365 天）。
 */
export function upsertDailySnapshots(db) {
  pruneSnapshotDailyOlderThanDays(db, SNAPSHOT_RETAIN_DAYS);
  const day = shanghaiTodayStr();
  if (!isCnAshareTradingDayYmd(day)) return;
  const weekdayClosedFrozen =
    isCnAshareWeekdayShanghai() && isPastCnAshareSnapshotFreezeTime();

  const accounts = db.prepare("SELECT id FROM accounts ORDER BY id").all();
  const existsStmt = db.prepare(
    `SELECT 1 AS ok FROM snapshot_daily WHERE account_id = ? AND day = ? LIMIT 1`
  );
  const insert = db.prepare(`
    INSERT INTO snapshot_daily (account_id, day, total_assets, market_value, position_profit, realized_pnl, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, day) DO UPDATE SET
      total_assets = excluded.total_assets,
      market_value = excluded.market_value,
      position_profit = excluded.position_profit,
      realized_pnl = excluded.realized_pnl,
      updated_at = excluded.updated_at
  `);
  /** 收盘后已定格总资产/市值时仍补写盈亏列（迁移前写入的快照这两列为 0） */
  const patchPnlOnly = db.prepare(`
    UPDATE snapshot_daily SET
      position_profit = ?,
      realized_pnl = ?,
      updated_at = datetime('now')
    WHERE account_id = ? AND day = ?
  `);
  const tx = db.transaction(() => {
    for (const { id } of accounts) {
      const agg = aggregateAccount(db, id);
      if (!agg) continue;
      const pp = agg.summary.total_profit;
      const rp = agg.summary.realized_pnl_total;
      if (weekdayClosedFrozen && existsStmt.get(id, day)) {
        patchPnlOnly.run(pp, rp, id, day);
        continue;
      }
      insert.run(id, day, agg.summary.total_assets, agg.summary.market_value, pp, rp);
    }
  });
  tx();
}

/**
 * 拉曲线前同步最新一条快照的盈亏列（不改动总资产/市值）：
 * - 快照日 = 上海当日：始终写入当前持仓盈亏 + 账户已实现累计；
 * - 否则仅在持仓盈亏列仍为 0 时修补（应对非交易日未跑 upsert、迁移默认值等）。
 */
export function refreshLatestSnapshotPnlColumns(db) {
  const today = shanghaiTodayStr();
  const accounts = db.prepare("SELECT id FROM accounts ORDER BY id").all();
  const sel = db.prepare(
    `SELECT day, COALESCE(position_profit, 0) AS position_profit
     FROM snapshot_daily WHERE account_id = ? ORDER BY day DESC LIMIT 1`
  );
  const patch = db.prepare(`
    UPDATE snapshot_daily SET
      position_profit = ?,
      realized_pnl = ?,
      updated_at = datetime('now')
    WHERE account_id = ? AND day = ?
  `);
  for (const { id } of accounts) {
    const row = sel.get(id);
    if (!row) continue;
    const agg = aggregateAccount(db, id);
    if (!agg) continue;
    const sameDay = row.day === today;
    const pnlZero = Math.abs(Number(row.position_profit)) < 1e-6;
    if (!sameDay && !pnlZero) continue;
    patch.run(
      agg.summary.total_profit,
      agg.summary.realized_pnl_total,
      id,
      row.day
    );
  }
}

/**
 * 仅返回 snapshot_daily 里**真实存在**的行（不做向前填充），避免同一数值铺满多日造成误导。
 * 汇总曲线：按自然日对各账户 total_assets / market_value / position_profit / realized_pnl 求和。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} daysCount
 */
export function queryDailyCharts(db, daysCount) {
  refreshLatestSnapshotPnlColumns(db);
  const input = Number(daysCount);
  const base = Number.isFinite(input) ? input : historyCalendarDaysDefault();
  const n = Math.min(730, Math.max(3, Math.floor(base)));
  const { start, labels } = buildShanghaiDayRange(n);
  const endDay = labels[labels.length - 1];

  const totalRowsRaw = db
    .prepare(
      `SELECT day,
              ROUND(SUM(total_assets), 2) AS total_assets,
              ROUND(SUM(market_value), 2) AS market_value,
              ROUND(COALESCE(SUM(position_profit), 0), 2) AS position_profit,
              ROUND(COALESCE(SUM(realized_pnl), 0), 2) AS realized_pnl
       FROM snapshot_daily
       WHERE day >= ? AND day <= ?
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(start, endDay);
  const totalRows = totalRowsRaw.filter((r) => isCnAshareTradingDayYmd(r.day));

  const meta = db
    .prepare(`SELECT id, account_name FROM accounts ORDER BY id`)
    .all();

  const accStmt = db.prepare(
    `SELECT day, total_assets, market_value, position_profit, realized_pnl
     FROM snapshot_daily
     WHERE account_id = ? AND day >= ? AND day <= ?
     ORDER BY day ASC`
  );

  const accountsOut = meta.map(({ id, account_name }) => ({
    account_id: id,
    account_name,
    points: accStmt
      .all(id, start, endDay)
      .filter((r) => isCnAshareTradingDayYmd(r.day))
      .map((r) => ({
        day: r.day,
        total_assets: r.total_assets,
        market_value: r.market_value,
        position_profit: r.position_profit,
        realized_pnl: r.realized_pnl,
      })),
  }));

  const snapshot_first_day = totalRows[0]?.day ?? null;
  const snapshot_last_day =
    totalRows.length > 0 ? totalRows[totalRows.length - 1].day : null;

  return {
    days: n,
    labels,
    window_start: start,
    window_end: endDay,
    snapshot_first_day,
    snapshot_last_day,
    snapshot_points_total: totalRows.length,
    total: totalRows.map((r) => ({
      day: r.day,
      total_assets: r.total_assets,
      market_value: r.market_value,
      position_profit: r.position_profit,
      realized_pnl: r.realized_pnl,
    })),
    accounts: accountsOut,
  };
}
