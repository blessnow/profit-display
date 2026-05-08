import { isCnAshareRegularSession } from "./market-hours.js";
import { fetchPricesForCodes, normalizeStockCode } from "./market-quote.js";
import { upsertDailySnapshots } from "./snapshots.js";
import {
  fetchPricesForCodesTushare,
  isTushareQuoteEnabled,
} from "./tushare-quote.js";

async function fetchNamePriceMapFromEnv() {
  const url = (process.env.QUOTE_SYNC_URL || "").trim();
  if (!url) return null;

  const headers = { Accept: "application/json" };
  const auth = (process.env.QUOTE_SYNC_AUTH_HEADER || "").trim();
  if (auth) headers.Authorization = auth;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`QUOTE_SYNC HTTP ${res.status}`);
  }
  const body = await res.json();
  const raw =
    body && typeof body.prices === "object" && body.prices !== null
      ? body.prices
      : body;
  if (!raw || typeof raw !== "object") {
    throw new Error("QUOTE_SYNC: JSON 须为对象或含 prices 对象");
  }

  const prices = new Map();
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k).trim();
    const px = Number(v);
    if (name && Number.isFinite(px) && px > 0) prices.set(name, px);
  }
  return prices;
}

/**
 * 1) 若配置了 QUOTE_PRICE_URL：按持仓 stock_code（6 位）拉最新价并更新
 * 2) 若配置了 QUOTE_SYNC_URL：按股票名称 JSON 映射补充/覆盖（可选）
 */
function tryUpsertSnapshots(db) {
  try {
    upsertDailySnapshots(db);
  } catch (_) {
    /* 快照失败不影响行情同步 */
  }
}

export async function runQuoteSync(db) {
  if (process.env.QUOTE_SYNC_DISABLED === "1") {
    tryUpsertSnapshots(db);
    return { skipped: true, reason: "QUOTE_SYNC_DISABLED" };
  }

  const priceTpl = (process.env.QUOTE_PRICE_URL || "").trim();
  const syncUrl = (process.env.QUOTE_SYNC_URL || "").trim();
  const useTushare = isTushareQuoteEnabled();

  if (!priceTpl && !syncUrl && !useTushare) {
    tryUpsertSnapshots(db);
    return {
      skipped: true,
      reason: "no quote source (set TUSHARE_TOKEN and/or QUOTE_PRICE_URL / QUOTE_SYNC_URL)",
    };
  }

  const codeRows = db
    .prepare(
      `SELECT DISTINCT stock_code FROM holdings WHERE stock_code IS NOT NULL AND trim(stock_code) != ''`
    )
    .all();
  const codes = codeRows
    .map((r) => normalizeStockCode(r.stock_code))
    .filter(Boolean);

  let priceByCode = new Map();
  if (codes.length > 0) {
    if (useTushare) {
      priceByCode = await fetchPricesForCodesTushare(codes);
    } else if (priceTpl) {
      priceByCode = await fetchPricesForCodes(codes, 6);
    }
  }

  let priceByName = null;
  if (syncUrl) {
    priceByName = await fetchNamePriceMapFromEnv();
  }

  const rows = db
    .prepare(`SELECT id, stock_name, stock_code, current_price FROM holdings`)
    .all();

  let updated = 0;
  const tx = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE holdings SET current_price = ? WHERE id = ?`
    );
    for (const row of rows) {
      let px = null;
      const code = normalizeStockCode(row.stock_code);
      if (code && priceByCode.has(code)) {
        px = priceByCode.get(code);
      }
      if (px == null && priceByName) {
        px = priceByName.get(String(row.stock_name).trim()) ?? null;
      }
      if (px == null || !Number.isFinite(px) || px <= 0) continue;
      if (Math.abs(px - row.current_price) < 1e-9) continue;
      upd.run(px, row.id);
      updated++;
    }
  });
  tx();

  tryUpsertSnapshots(db);

  return {
    skipped: false,
    updated,
    codesFetched: priceByCode.size,
    nameMapSize: priceByName ? priceByName.size : 0,
  };
}

export function startBuiltinQuoteScheduler(db, log) {
  const intervalMs = 5 * 60 * 1000;
  const tick = async () => {
    if (!isCnAshareRegularSession()) return;
    try {
      const r = await runQuoteSync(db);
      if (!r.skipped && r.updated > 0) {
        (log || console.log).call(
          null,
          "[quote-sync] updated",
          r.updated,
          "rows"
        );
      }
    } catch (e) {
      (log || console.error).call(null, "[quote-sync]", e.message || e);
    }
  };
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}
