import { normalizeStockCode } from "./market-quote.js";

/**
 * 6 位 A 股代码 → TuShare ts_code（沪 .SH / 深 .SZ；北交所等未单独处理）
 */
export function codeToTsCode(code6) {
  const c = normalizeStockCode(code6);
  if (!c) return null;
  const suf = c.startsWith("6") ? ".SH" : ".SZ";
  return `${c}${suf}`;
}

function rowsFromTushareData(data) {
  if (!data || !Array.isArray(data.items)) return [];
  const fields = data.fields || [];
  return data.items.map((row) => {
    const o = {};
    for (let i = 0; i < fields.length; i++) o[fields[i]] = row[i];
    return o;
  });
}

/** 上海日历 YYYYMMDD */
function shanghaiYYYYMMDDCompact(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  })
    .format(date)
    .replace(/-/g, "");
}

function tusharePostBase() {
  return (
    (process.env.TUSHARE_HTTP_URL || "").trim() ||
    (process.env.TUSHARE_HTTP || "").trim() ||
    (process.env.TUSHARE_API_URL || "").trim() ||
    "https://api.tushare.pro"
  ).replace(/\/+$/, "");
}

/**
 * TuShare Pro HTTP：POST JSON（与 Python pro_api 一致）。
 */
export async function tushareCall(apiName, params, fields) {
  const token = (process.env.TUSHARE_TOKEN || "").trim();
  if (!token) throw new Error("TUSHARE_TOKEN empty");

  const base = tusharePostBase();
  const res = await fetch(base, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      api_name: apiName,
      token,
      params: params || {},
      fields: fields || "",
    }),
  });
  if (!res.ok) throw new Error(`Tushare HTTP ${res.status}`);
  const body = await res.json();
  if (Number(body.code) !== 0) {
    throw new Error(body.msg || `Tushare code ${body.code}`);
  }
  return body.data;
}

/** 最近 N 个自然日（上海日历）的区间，用于 daily 取最新收盘 */
function dailyDateRangeCompact() {
  const days = Math.min(
    60,
    Math.max(
      7,
      Number(process.env.TUSHARE_DAILY_LOOKBACK_DAYS) || 20
    )
  );
  const end = shanghaiYYYYMMDDCompact();
  const start = shanghaiYYYYMMDDCompact(
    new Date(Date.now() - days * 86400000)
  );
  return { start, end };
}

async function fetchCloseViaDaily(tsCode) {
  const { start, end } = dailyDateRangeCompact();
  const data = await tushareCall(
    "daily",
    { ts_code: tsCode, start_date: start, end_date: end },
    "trade_date,close"
  );
  const rows = rowsFromTushareData(data);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const close = Number(last.close);
  return Number.isFinite(close) && close > 0 ? close : null;
}

async function fetchViaRtK(uniq, chunkSize) {
  const map = new Map();
  const n = Math.max(10, Math.min(200, chunkSize));

  for (let off = 0; off < uniq.length; off += n) {
    const chunk = uniq.slice(off, off + n);
    const tsList = chunk.map(codeToTsCode).filter(Boolean);
    if (!tsList.length) continue;

    const data = await tushareCall(
      "rt_k",
      { ts_code: tsList.join(",") },
      "ts_code,close,trade_time"
    );
    for (const r of rowsFromTushareData(data)) {
      const code = normalizeStockCode(r.ts_code);
      const close = Number(r.close);
      if (code && Number.isFinite(close) && close > 0) map.set(code, close);
    }
  }
  return map;
}

/**
 * 优先 rt_k（当日）；若自建网关 rt_k 恒为空（常见），再按代码调 daily 取区间内最新收盘。
 * TUSHARE_SKIP_RT_K=1 跳过 rt_k，直接 daily（省一次空请求）。
 */
export async function fetchPricesForCodesTushare(codes, chunkSize = 80) {
  const uniq = [...new Set(codes.map(normalizeStockCode).filter(Boolean))];
  let map = new Map();

  const skipRtK = process.env.TUSHARE_SKIP_RT_K === "1";
  if (!skipRtK) {
    map = await fetchViaRtK(uniq, chunkSize);
  }

  const missing = uniq.filter((c) => !map.has(c));
  if (missing.length === 0) return map;

  console.warn(
    `[tushare] filling ${missing.length}/${uniq.length} codes via daily (rt_k empty or skipped; 自建网关常如此)`
  );

  const rawConc = Number(process.env.TUSHARE_DAILY_CONCURRENCY);
  const concurrency = Number.isFinite(rawConc)
    ? Math.min(16, Math.max(1, Math.floor(rawConc)))
    : 6;

  for (let i = 0; i < missing.length; i += concurrency) {
    const batch = missing.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (code6) => {
        const ts = codeToTsCode(code6);
        if (!ts) return;
        try {
          const px = await fetchCloseViaDaily(ts);
          if (px != null) map.set(code6, px);
        } catch (e) {
          console.warn("[tushare] daily failed", code6, e.message || e);
        }
      })
    );
  }

  return map;
}

export function isTushareQuoteEnabled() {
  return !!(process.env.TUSHARE_TOKEN || "").trim();
}
