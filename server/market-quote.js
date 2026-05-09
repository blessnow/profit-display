/**
 * 行情 URL 全部由环境变量模板注入，业务代码不写死外部域名。
 * QUOTE_SUGGEST_URL: 含 {{q}}，返回联想列表（兼容东方财富 suggest JSON）
 * QUOTE_PRICE_URL 二选一：
 *   - 东财：含 {{secid}}（如 1.600519），解析 data.f43
 *   - Yahoo v8 chart：含 {{symbol}}（如 600519.SS），解析 chart.result[0].meta.regularMarketPrice
 * QUOTE_KLINE_URL 二选一：
 *   - 东财：{{secid}} {{beg}} {{end}}（YYYYMMDD）
 *   - Yahoo v8 chart：{{symbol}} {{period1}} {{period2}}（Unix 秒，上海日历日起讫由服务端从 beg/end 换算）
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

/** Yahoo Finance：沪 .SS，深 .SZ（常见 A 股；不含北交所） */
export function codeToYahooSymbol(code6) {
  const c = normalizeStockCode(code6);
  if (!c) return null;
  return c.startsWith("6") ? `${c}.SS` : `${c}.SZ`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** YYYYMMDD → 该日 00:00 上海 → Unix 秒 */
export function yyyymmddCompactToUnixPeriod1(begCompact) {
  const s = String(begCompact);
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  return Math.floor(
    new Date(`${y}-${pad2(mo)}-${pad2(d)}T00:00:00+08:00`).getTime() / 1000
  );
}

/** YYYYMMDD → 该日 23:59:59 上海 → Unix 秒 */
export function yyyymmddCompactToUnixPeriod2End(endCompact) {
  const s = String(endCompact);
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  return Math.floor(
    new Date(`${y}-${pad2(mo)}-${pad2(d)}T23:59:59+08:00`).getTime() / 1000
  );
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

/** Yahoo v8 chart：meta.regularMarketPrice */
export function parseYahooChartMetaPrice(body) {
  const meta = body?.chart?.result?.[0]?.meta;
  const px = meta?.regularMarketPrice;
  if (!Number.isFinite(Number(px)) || Number(px) <= 0) return null;
  return Number(px);
}

export async function fetchPriceByYahooSymbol(symbol, urlTemplate) {
  if (!urlTemplate || !String(urlTemplate).includes("{{symbol}}")) return null;
  const url = expandTemplate(urlTemplate, { symbol });
  const body = await fetchJson(url);
  return parseYahooChartMetaPrice(body);
}

export async function suggestStocks(query) {
  const q = String(query || "").trim();
  if (!q) return { items: [] };
  const tpl = (process.env.QUOTE_SUGGEST_URL || "").trim();
  if (!tpl || !tpl.includes("{{q}}")) return { items: [] };

  async function fetchSuggestBody(input) {
    const url = expandTemplate(tpl, { q: input });
    return fetchJson(url);
  }

  let body = await fetchSuggestBody(q);
  let items = parseEastmoneySuggest(body).slice(0, 16);
  // 东财 type=14：两字母拼音常被美股/板块占位，补一次「+s」常见能落到 A 股（如 hb→hbs→和邦生物）
  if (
    items.length === 0 &&
    /^[A-Za-z]{2}$/.test(q) &&
    tpl.includes("eastmoney.com")
  ) {
    body = await fetchSuggestBody(q + "s").catch(() => body);
    items = parseEastmoneySuggest(body).slice(0, 16);
  }

  const priceTpl = (process.env.QUOTE_PRICE_URL || "").trim();
  if (priceTpl.includes("{{symbol}}") && items.length) {
    const limit = Math.min(8, items.length);
    const chunk = items.slice(0, limit);
    const priced = await Promise.all(
      chunk.map(async (it) => {
        const sym = codeToYahooSymbol(it.code);
        const px = sym
          ? await fetchPriceByYahooSymbol(sym, priceTpl).catch(() => null)
          : null;
        return { ...it, price: px };
      })
    );
    items = [...priced, ...items.slice(limit)];
  } else if (priceTpl.includes("{{secid}}") && items.length) {
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
  const useSym = priceTpl.includes("{{symbol}}");
  const useSec = priceTpl.includes("{{secid}}");
  if (!priceTpl || (!useSym && !useSec)) {
    return new Map();
  }
  const uniq = [...new Set(codes.map(normalizeStockCode).filter(Boolean))];
  const map = new Map();
  const n = Math.max(1, Math.min(concurrency, 12));
  for (let off = 0; off < uniq.length; off += n) {
    const batch = uniq.slice(off, off + n);
    await Promise.all(
      batch.map(async (code) => {
        let px = null;
        if (useSym) {
          const sym = codeToYahooSymbol(code);
          if (sym)
            px = await fetchPriceByYahooSymbol(sym, priceTpl).catch(() => null);
        } else {
          const secid = guessSecidFromCode(code);
          px = await fetchPriceBySecid(secid, priceTpl).catch(() => null);
        }
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

/** Yahoo v8 chart：timestamp + indicators.quote[0].close → 上海日历日 YYYY-MM-DD */
export function parseYahooChartClosesByDay(body) {
  const result = body?.chart?.result?.[0];
  if (!result) return new Map();
  const ts = result.timestamp;
  const closes = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) return new Map();
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  const m = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(Number(c)) || Number(c) <= 0) continue;
    const day = fmt.format(new Date(ts[i] * 1000));
    m.set(day, Number(c));
  }
  return m;
}

/**
 * @param code6 六位代码（或可从其中解析出 6 位）
 * @param begCompact endCompact YYYYMMDD
 */
export async function fetchDailyKlineCloses(code6, begCompact, endCompact) {
  const tpl = (process.env.QUOTE_KLINE_URL || "").trim();
  const code = normalizeStockCode(code6);
  if (!code) throw new Error("无效股票代码");

  if (
    tpl.includes("{{symbol}}") &&
    tpl.includes("{{period1}}") &&
    tpl.includes("{{period2}}")
  ) {
    const symbol = codeToYahooSymbol(code);
    if (!symbol) throw new Error("无效股票代码");
    const period1 = yyyymmddCompactToUnixPeriod1(begCompact);
    const period2 = yyyymmddCompactToUnixPeriod2End(endCompact);
    const url = expandTemplate(tpl, {
      symbol,
      period1: String(period1),
      period2: String(period2),
    });
    const body = await fetchJson(url);
    return parseYahooChartClosesByDay(body);
  }

  if (
    tpl.includes("{{secid}}") &&
    tpl.includes("{{beg}}") &&
    tpl.includes("{{end}}")
  ) {
    const secid = guessSecidFromCode(code);
    if (!secid) throw new Error("无效股票代码");
    const url = expandTemplate(tpl, {
      secid,
      beg: begCompact,
      end: endCompact,
    });
    const body = await fetchJson(url);
    return parseEastmoneyDailyKlines(body);
  }

  throw new Error(
    "QUOTE_KLINE_URL：东财需 {{secid}}{{beg}}{{end}}；Yahoo 需 {{symbol}}{{period1}}{{period2}}"
  );
}
