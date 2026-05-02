/**
 * 行情 URL 全部由环境变量模板注入，业务代码不写死外部域名。
 * QUOTE_SUGGEST_URL: 含 {{q}}，返回联想列表（兼容东方财富 suggest JSON）
 * QUOTE_PRICE_URL: 含 {{secid}}，返回最新价（兼容东方财富 qt/stock/get，用 f43/100）
 * QUOTE_KLINE_URL: 含 {{secid}} {{beg}} {{end}}（YYYYMMDD），日 K（收盘价用于历史市值回填）
 */

const defaultHeaders = () => {
  const ua =
    (process.env.QUOTE_HTTP_USER_AGENT || "").trim() ||
    "Mozilla/5.0 (compatible; positions-dashboard/1.0)";
  const h = { Accept: "application/json", "User-Agent": ua };
  const auth = (process.env.QUOTE_SYNC_AUTH_HEADER || "").trim();
  if (auth) h.Authorization = auth;
  return h;
};

export function expandTemplate(tpl, vars) {
  let s = String(tpl);
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi");
    s = s.replace(re, encodeURIComponent(String(v)));
  }
  return s;
}

export function normalizeStockCode(raw) {
  if (raw == null || raw === "") return null;
  const m = String(raw).match(/(\d{6})/);
  return m ? m[1] : null;
}

/** 沪深 A 常见规则：6 开头沪 1，其余深 0（不含北交所细分） */
export function guessSecidFromCode(code6) {
  const c = normalizeStockCode(code6);
  if (!c) return null;
  const mkt = c.startsWith("6") ? "1" : "0";
  return `${mkt}.${c}`;
}

export async function fetchJson(url) {
  const res = await fetch(url, { headers: defaultHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 解析东方财富 suggest/get */
export function parseEastmoneySuggest(body) {
  const data = body?.QuotationCodeTable?.Data;
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const row of data) {
    const code = normalizeStockCode(row.Code || row.UnifiedCode);
    const name = row.Name ? String(row.Name).trim() : "";
    const secid =
      row.QuoteID != null && String(row.QuoteID).includes(".")
        ? String(row.QuoteID).trim()
        : code
          ? guessSecidFromCode(code)
          : null;
    if (!code || !name) continue;
    out.push({ code, name, secid });
  }
  return out;
}

/** 东方财富 qt/stock/get data.f43 一般为「分」或×100 的整数 */
export function parseEastmoneyF43(f43) {
  const n = Number(f43);
  if (!Number.isFinite(n)) return null;
  return Math.round(n) / 100;
}

export async function fetchPriceBySecid(secid, urlTemplate) {
  if (!urlTemplate || !String(urlTemplate).includes("{{secid}}")) return null;
  const url = expandTemplate(urlTemplate, { secid });
  const body = await fetchJson(url);
  const f43 = body?.data?.f43;
  return parseEastmoneyF43(f43);
}

export async function suggestStocks(query) {
  const q = String(query || "").trim();
  if (!q) return { items: [] };
  const tpl = (process.env.QUOTE_SUGGEST_URL || "").trim();
  if (!tpl || !tpl.includes("{{q}}")) return { items: [] };

  const url = expandTemplate(tpl, { q });
  const body = await fetchJson(url);
  let items = parseEastmoneySuggest(body).slice(0, 16);

  const priceTpl = (process.env.QUOTE_PRICE_URL || "").trim();
  if (priceTpl.includes("{{secid}}") && items.length) {
    const limit = Math.min(8, items.length);
    const chunk = items.slice(0, limit);
    const priced = await Promise.all(
      chunk.map(async (it) => {
        const px = await fetchPriceBySecid(it.secid, priceTpl).catch(() => null);
        return { ...it, price: px };
      })
    );
    items = [...priced, ...items.slice(limit)];
  }
  return { items };
}

/** 按 6 位代码批量拉取最新价（分批并发） */
export async function fetchPricesForCodes(codes, concurrency = 6) {
  const priceTpl = (process.env.QUOTE_PRICE_URL || "").trim();
  if (!priceTpl || !priceTpl.includes("{{secid}}")) {
    return new Map();
  }
  const uniq = [...new Set(codes.map(normalizeStockCode).filter(Boolean))];
  const map = new Map();
  const n = Math.max(1, Math.min(concurrency, 12));
  for (let off = 0; off < uniq.length; off += n) {
    const batch = uniq.slice(off, off + n);
    await Promise.all(
      batch.map(async (code) => {
        const secid = guessSecidFromCode(code);
        const px = await fetchPriceBySecid(secid, priceTpl).catch(() => null);
        if (px != null && px > 0) map.set(code, px);
      })
    );
  }
  return map;
}

/** 东方财富日 K：klines 每项「日期,开盘,收盘,…」，收盘为第三列 */
export function parseEastmoneyDailyKlines(body) {
  const lines = body?.data?.klines;
  if (!Array.isArray(lines)) return new Map();
  const m = new Map();
  for (const line of lines) {
    const parts = String(line).split(",");
    const day = parts[0];
    const close = Number(parts[2]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!Number.isFinite(close) || close <= 0) continue;
    m.set(day, close);
  }
  return m;
}

/** beg/end 为 YYYYMMDD；模板须含 {{secid}}，且包含 {{beg}}、{{end}} */
export async function fetchDailyKlineCloses(secid, begCompact, endCompact) {
  const tpl = (process.env.QUOTE_KLINE_URL || "").trim();
  if (!tpl.includes("{{secid}}")) {
    throw new Error("QUOTE_KLINE_URL 未配置或缺少 {{secid}}");
  }
  const url = expandTemplate(tpl, {
    secid,
    beg: begCompact,
    end: endCompact,
  });
  const body = await fetchJson(url);
  return parseEastmoneyDailyKlines(body);
}
