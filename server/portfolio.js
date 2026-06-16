/** 市值：与常见券商一致按股数×现价再四舍五入到分 */
export function marketValueForHolding(position, currentPrice) {
  return Math.round(position * currentPrice * 100) / 100;
}

export function holdingDerived(h) {
  const mv = marketValueForHolding(h.position, h.current_price);
  const costBase = h.position * h.cost_price;
  const profit = Math.round((mv - costBase) * 100) / 100;
  const profitPct =
    costBase > 0 ? Math.round((profit / costBase) * 100000) / 1000 : 0;
  // 今日收益（单只）= 持仓 ×（现价 − 昨收）；昨收缺失时为 null（前端显示「—」）
  const prevClose = Number(h.prev_close);
  const hasPrev = Number.isFinite(prevClose) && prevClose > 0;
  const dayProfit = hasPrev
    ? Math.round(h.position * (h.current_price - prevClose) * 100) / 100
    : null;
  const dayProfitPct = hasPrev
    ? Math.round(((h.current_price - prevClose) / prevClose) * 10000) / 100
    : null;
  return {
    ...h,
    market_value: mv,
    profit,
    profit_pct: profitPct,
    day_profit: dayProfit,
    day_profit_pct: dayProfitPct,
  };
}

function buildAggregatedAccountView(acc, rowsForDerived) {
  const holdings = rowsForDerived.map((r) => holdingDerived(r));
  const marketValue = Math.round(
    holdings.reduce((s, h) => s + h.market_value, 0) * 100
  ) / 100;
  const totalProfit = Math.round(
    holdings.reduce((s, h) => s + h.profit, 0) * 100
  ) / 100;
  const totalAssets = Math.round((marketValue + acc.available_cash) * 100) / 100;
  const positionRatio =
    totalAssets > 0
      ? Math.round((marketValue / totalAssets) * 1000) / 10
      : null;
  const realizedTotal = Math.round(
    (Number(acc.realized_pnl_total) || 0) * 100
  ) / 100;
  const cumulativePnl =
    Math.round((realizedTotal + totalProfit) * 100) / 100;
  return {
    id: acc.id,
    broker: acc.broker,
    account_name: acc.account_name,
    account_type: acc.account_type,
    position_ratio: positionRatio,
    summary: {
      total_assets: totalAssets,
      total_profit: totalProfit,
      realized_pnl_total: realizedTotal,
      cumulative_pnl: cumulativePnl,
      daily_profit: acc.daily_profit,
      daily_profit_pct: acc.daily_profit_pct,
      market_value: marketValue,
      available_cash: acc.available_cash,
      withdrawable_cash: acc.withdrawable_cash,
    },
    holdings,
  };
}

/** YYYY-MM-DD，上海日历日（与 snapshots.js 一致，避免循环依赖故本地实现） */
function shanghaiTodayStr() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

/**
 * 上一交易日（严格早于 today）该账户快照的累计收益基准。
 * cumulative = 持仓浮动(position_profit) + 已实现累计(realized_pnl)。
 * 入金/出金不计入这两列，故以此做基准算「今日收益」可天然剔除现金流影响。
 */
function prevDaySnapshotBaseline(db, accountId, today) {
  const row = db
    .prepare(
      `SELECT total_assets, position_profit, realized_pnl
       FROM snapshot_daily
       WHERE account_id = ? AND day < ?
       ORDER BY day DESC LIMIT 1`
    )
    .get(accountId, today);
  if (!row) return null;
  return {
    total_assets: Number(row.total_assets) || 0,
    cumulative:
      (Number(row.position_profit) || 0) + (Number(row.realized_pnl) || 0),
  };
}

/**
 * 用上一交易日快照做基准动态计算「今日收益」并写回 view.summary：
 *   daily_profit     = 今日累计收益 − 上一交易日累计收益
 *   daily_profit_pct = daily_profit / 上一交易日总资产 × 100
 * 无上一交易日快照（如首日）时保留账户里原有的种子值。
 */
function applyDailyProfit(db, accountId, view) {
  const prev = prevDaySnapshotBaseline(db, accountId, shanghaiTodayStr());
  if (!prev) return;
  const dp =
    Math.round((view.summary.cumulative_pnl - prev.cumulative) * 100) / 100;
  view.summary.daily_profit = dp;
  view.summary.daily_profit_pct =
    prev.total_assets > 0
      ? Math.round((dp / prev.total_assets) * 10000) / 100
      : null;
}

export function aggregateAccount(db, accountId) {
  const acc = db
    .prepare(
      `SELECT id, broker, account_name, account_type, position_ratio,
              available_cash, withdrawable_cash, daily_profit, daily_profit_pct,
              realized_pnl_total
       FROM accounts WHERE id = ?`
    )
    .get(accountId);
  if (!acc) return null;
  const rows = db
    .prepare(
      `SELECT id, account_id, stock_name, stock_code, position, available, cost_price, current_price, prev_close
       FROM holdings WHERE account_id = ? ORDER BY stock_name`
    )
    .all(accountId);
  const view = buildAggregatedAccountView(acc, rows);
  applyDailyProfit(db, accountId, view);
  return view;
}

/**
 * 与 aggregateAccount 同一套市值/盈亏/总资产公式，按账户独立计算；
 * 每只持仓的计价用 getPriceForHolding(row)（历史回填时为该自然日日 K 收盘等「当日价」）。
 */
export function aggregateAccountForSnapshotDay(db, accountId, getPriceForHolding) {
  const acc = db
    .prepare(
      `SELECT id, broker, account_name, account_type, position_ratio,
              available_cash, withdrawable_cash, daily_profit, daily_profit_pct,
              realized_pnl_total
       FROM accounts WHERE id = ?`
    )
    .get(accountId);
  if (!acc) return null;
  const rows = db
    .prepare(
      `SELECT id, account_id, stock_name, stock_code, position, available, cost_price, current_price, prev_close
       FROM holdings WHERE account_id = ? ORDER BY stock_name`
    )
    .all(accountId);
  const rowsEff = rows.map((r) => {
    let px = Number(getPriceForHolding(r));
    if (!Number.isFinite(px) || px <= 0) px = Number(r.current_price);
    return { ...r, current_price: px };
  });
  return buildAggregatedAccountView(acc, rowsEff);
}
