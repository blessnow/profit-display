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
  return {
    ...h,
    market_value: mv,
    profit,
    profit_pct: profitPct,
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
      `SELECT id, account_id, stock_name, stock_code, position, available, cost_price, current_price
       FROM holdings WHERE account_id = ? ORDER BY stock_name`
    )
    .all(accountId);
  return buildAggregatedAccountView(acc, rows);
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
      `SELECT id, account_id, stock_name, stock_code, position, available, cost_price, current_price
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
