import { isCnAshareRegularSession } from "./market-hours.js";
import { fetchQuotesForCodes, normalizeStockCode } from "./market-quote.js";
import { upsertDailySnapshots, shanghaiTodayStr } from "./snapshots.js";
import {
  fetchPricesForCodesTushare,
  fetchPrevCloseForCodesTushare,
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

  const today = shanghaiTodayStr();

  const codeRows = db
    .prepare(
      `SELECT DISTINCT stock_code FROM holdings WHERE stock_code IS NOT NULL AND trim(stock_code) != ''`
    )
    .all();
  const codes = codeRows
    .map((r) => normalizeStockCode(r.stock_code))
    .filter(Boolean);

  let priceByCode = new Map();
  const prevCloseByCode = new Map();
  if (codes.length > 0) {
    if (useTushare) {
      priceByCode = await fetchPricesForCodesTushare(codes);
      // 昨收每日只需刷新一次：仅取今日还未记录昨收的代码，避免每 5 分钟重复打 daily
      const needPrev = db
        .prepare(
          `SELECT DISTINCT stock_code FROM holdings
           WHERE stock_code IS NOT NULL AND trim(stock_code) != ''
             AND (prev_close_day IS NULL OR prev_close_day != ?)`
        )
        .all(today)
        .map((r) => normalizeStockCode(r.stock_code))
        .filter(Boolean);
      if (needPrev.length) {
        const m = await fetchPrevCloseForCodesTushare(needPrev);
        for (const [c, pc] of m) prevCloseByCode.set(c, pc);
      }
    } else if (priceTpl) {
      // Yahoo/东财同一响应即含昨收，免额外请求
      const quotes = await fetchQuotesForCodes(codes, 6);
      for (const [code, q] of quotes) {
        if (q.price != null) priceByCode.set(code, q.price);
        if (q.prevClose != null) prevCloseByCode.set(code, q.prevClose);
      }
    }
  }

  let priceByName = null;
  if (syncUrl) {
    priceByName = await fetchNamePriceMapFromEnv();
  }

  const rows = db
    .prepare(
      `SELECT id, stock_name, stock_code, current_price, prev_close, prev_close_day FROM holdings`
    )
    .all();

  let updated = 0;
  let prevUpdated = 0;
  const tx = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE holdings SET current_price = ? WHERE id = ?`
    );
    const updPrev = db.prepare(
      `UPDATE holdings SET prev_close = ?, prev_close_day = ? WHERE id = ?`
    );
    for (const row of rows) {
      const code = normalizeStockCode(row.stock_code);

      let px = null;
      if (code && priceByCode.has(code)) {
        px = priceByCode.get(code);
      }
      if (px == null && priceByName) {
        px = priceByName.get(String(row.stock_name).trim()) ?? null;
      }
      if (px != null && Number.isFinite(px) && px > 0) {
        if (Math.abs(px - row.current_price) >= 1e-9) {
          upd.run(px, row.id);
          updated++;
        }
      }

      // 有新昨收就写：换日，或当日已存值但与最新昨收不一致（自愈历史错值）。
      // TuShare 路径只为「今日缺昨收」的代码取数，故 map 里无项的代码不会被改写，开销可控。
      const pc = code ? prevCloseByCode.get(code) : null;
      if (pc != null && pc > 0) {
        const stale =
          row.prev_close_day !== today ||
          row.prev_close == null ||
          Math.abs(Number(row.prev_close) - pc) >= 1e-9;
        if (stale) {
          updPrev.run(pc, today, row.id);
          prevUpdated++;
        }
      }
    }
  });
  tx();

  tryUpsertSnapshots(db);

  return {
    skipped: false,
    updated,
    prevUpdated,
    codesFetched: priceByCode.size,
    nameMapSize: priceByName ? priceByName.size : 0,
  };
}

export function startBuiltinQuoteScheduler(db, log) {
  const L = log || console.log;
  const intervalMs = 5 * 60 * 1000;
  const tick = async () => {
    if (!isCnAshareRegularSession()) return;
    try {
      const r = await runQuoteSync(db);
      if (r.skipped) {
        L.call(null, "[quote-sync] skipped:", r.reason || "");
        return;
      }
      L.call(
        null,
        "[quote-sync] tick",
        "updated_rows=" + r.updated,
        "price_by_code=" + r.codesFetched,
        "name_map=" + (r.nameMapSize ?? 0)
      );
    } catch (e) {
      (log || console.error).call(null, "[quote-sync] error:", e.message || e);
    }
  };
  const id = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(id);
}
