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

/**
 * TuShare Pro HTTP：与 Python pro_api 一致，POST JSON。
 * TUSHARE_TOKEN：必填；TUSHARE_HTTP_URL：可选，默认 https://api.tushare.pro（可填自建/代理根地址）。
 */
export async function tushareCall(apiName, params, fields) {
  const token = (process.env.TUSHARE_TOKEN || "").trim();
  if (!token) throw new Error("TUSHARE_TOKEN empty");

  let base = (process.env.TUSHARE_HTTP_URL || "https://api.tushare.pro")
    .trim()
    .replace(/\/+$/, "");
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

/**
 * 使用 rt_k（当日实时日线）批量取现价，close 为最新价。
 * 单次 ts_code 可逗号拼接多只股票（与官方文档一致）。
 */
export async function fetchPricesForCodesTushare(codes, chunkSize = 80) {
  const uniq = [...new Set(codes.map(normalizeStockCode).filter(Boolean))];
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

export function isTushareQuoteEnabled() {
  return !!(process.env.TUSHARE_TOKEN || "").trim();
}
