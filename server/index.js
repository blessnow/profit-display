import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { openDb, seedFromJson, defaultJsonPath } from "./db.js";
import { aggregateAccount } from "./portfolio.js";
import { basicAuthMiddleware, getAdminCredentials } from "./auth.js";
import { runQuoteSync, startBuiltinQuoteScheduler } from "./quote-sync.js";
import { normalizeStockCode, suggestStocks } from "./market-quote.js";
import {
  upsertDailySnapshots,
  queryDailyCharts,
} from "./snapshots.js";
import { backfillSnapshotsFromHistoricalKlines } from "./snapshot-backfill.js";
import { historyCalendarDaysDefault } from "./history-window.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");

(() => {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const key = s.slice(0, i).trim();
    let val = s.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

/** 启动/排查：不写完整 URL，只写是否配置与模板占位符（Railway Variables 是否生效） */
function logQuoteEnvDiagnostics() {
  const k = (process.env.QUOTE_KLINE_URL || "").trim();
  const p = (process.env.QUOTE_PRICE_URL || "").trim();
  const sy = (process.env.QUOTE_SYNC_URL || "").trim();
  console.log(
    "[env] QUOTE_KLINE_URL:",
    k
      ? `set len=${k.length} tmpl={{symbol}}:${k.includes(
          "{{symbol}}"
        )} {{period1}}:${k.includes("{{period1}}")} {{secid}}:${k.includes(
          "{{secid}}"
        )}`
      : "EMPTY → POST 日K刷新会 skipped"
  );
  console.log(
    "[env] QUOTE_PRICE_URL:",
    p
      ? `set len=${p.length} {{symbol}}:${p.includes(
          "{{symbol}}"
        )} {{secid}}:${p.includes("{{secid}}")}`
      : "EMPTY"
  );
  console.log("[env] QUOTE_SYNC_URL:", sy ? `set len=${sy.length}` : "empty");
  const tsTok = (process.env.TUSHARE_TOKEN || "").trim();
  const tsUrl = (
    (process.env.TUSHARE_HTTP_URL || "").trim() ||
    (process.env.TUSHARE_HTTP || "").trim() ||
    (process.env.TUSHARE_API_URL || "").trim()
  );
  console.log(
    "[env] TUSHARE:",
    tsTok
      ? `token len=${tsTok.length} http len=${tsUrl ? tsUrl.length : "default api.tushare.pro"} skip_rt_k=${process.env.TUSHARE_SKIP_RT_K === "1" ? "1" : "0"} (rt_k 空时自动 daily)`
      : "empty → 现价不用 TuShare（可配 TUSHARE_TOKEN）"
  );
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(basicAuthMiddleware());

const db = openDb();

function ensureSeeded() {
  const n = db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c;
  if (n === 0) {
    const p = process.env.SEED_JSON_PATH || defaultJsonPath();
    if (fs.existsSync(p)) {
      seedFromJson(db, p);
      console.log("Seeded database from", p);
    }
  }
}

ensureSeeded();

(async function bootstrapHistoricalSnapshots() {
  try {
    if ((process.env.QUOTE_KLINE_URL || "").trim()) {
      const r = await backfillSnapshotsFromHistoricalKlines(
        db,
        historyCalendarDaysDefault()
      );
      if (r.ok && !r.skipped) {
        console.log(
          "[snapshot] 日K回填完成（早于今日）",
          r.historical_days?.length ?? 0,
          "天·账户快照格子",
          r.upserts ?? 0,
          "·代码",
          r.codes_ok ?? 0,
          "/",
          (r.codes_ok ?? 0) + (r.codes_failed ?? 0)
        );
        if (r.codes_failed > 0 && r.fetch_errors?.length) {
          const sample = r.fetch_errors
            .slice(0, 5)
            .map((e) => `${e.code}: ${e.message}`)
            .join(" | ");
          console.warn(
            "[snapshot] 日K 请求失败（历史曲线会退回用现价，多日数值相同）·示例:",
            sample
          );
        }
      }
    }
  } catch (e) {
    console.warn("[snapshot] 日K回填失败:", e.message || e);
  }
  try {
    upsertDailySnapshots(db);
  } catch (_) {}
})();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/suggest", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const data = await suggestStocks(q);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
});

app.get("/api/accounts", (_req, res) => {
  const ids = db.prepare("SELECT id FROM accounts ORDER BY id").all();
  const list = ids.map((row) => aggregateAccount(db, row.id));
  res.json({ accounts: list });
});

app.get("/api/accounts/:id", (req, res) => {
  const id = Number(req.params.id);
  const acc = aggregateAccount(db, id);
  if (!acc) return res.status(404).json({ error: "账户不存在" });
  res.json(acc);
});

/** 新建空账户（无持仓）；可用/可取现金可初值，之后用成交、入出金调整 */
app.post("/api/accounts", (req, res) => {
  const {
    broker,
    account_name,
    account_type,
    available_cash,
    withdrawable_cash,
  } = req.body || {};
  const name = String(account_name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "请填写账户名称" });
  }
  const brokerStr = broker != null ? String(broker).trim() : "";
  const typeRaw = account_type != null ? String(account_type).trim() : "";
  const typeStr = typeRaw ? typeRaw : null;
  const cash =
    available_cash != null && available_cash !== ""
      ? Number(available_cash)
      : 0;
  if (!Number.isFinite(cash) || cash < 0) {
    return res.status(400).json({ error: "可用资金须为非负数" });
  }
  let wdc = null;
  if (
    withdrawable_cash != null &&
    withdrawable_cash !== "" &&
    String(withdrawable_cash).trim() !== ""
  ) {
    wdc = Number(withdrawable_cash);
    if (!Number.isFinite(wdc) || wdc < 0) {
      return res.status(400).json({ error: "可取资金须为非负数" });
    }
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO accounts (broker, account_name, account_type, position_ratio, available_cash, withdrawable_cash, daily_profit, daily_profit_pct, realized_pnl_total)
         VALUES (?, ?, ?, NULL, ?, ?, 0, NULL, 0)`
      )
      .run(brokerStr, name, typeStr, cash, wdc);
    const id = Number(info.lastInsertRowid);
    try {
      upsertDailySnapshots(db);
    } catch (_) {}
    res.status(201).json(aggregateAccount(db, id));
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("UNIQUE") || e?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "账户名称已存在，请换一个" });
    }
    throw e;
  }
});

/** 日线快照曲线：总资产 + 持仓市值（上海日历日） */
app.get("/api/charts/daily", (req, res) => {
  try {
    upsertDailySnapshots(db);
  } catch (_) {}
  const days = Number(req.query.days);
  res.json(
    queryDailyCharts(
      db,
      Number.isFinite(days) ? days : historyCalendarDaysDefault()
    )
  );
});

/** 更新现价；可选 stock_code（6 位） */
app.patch("/api/holdings/:id", (req, res) => {
  const id = Number(req.params.id);
  const { current_price, stock_code } = req.body || {};
  const row = db.prepare("SELECT * FROM holdings WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "持仓不存在" });

  if (stock_code !== undefined) {
    const c =
      stock_code === "" || stock_code === null
        ? null
        : normalizeStockCode(stock_code);
    db.prepare("UPDATE holdings SET stock_code = ? WHERE id = ?").run(c, id);
  }

  if (current_price != null) {
    if (Number(current_price) <= 0) {
      return res.status(400).json({ error: "current_price 须为正数" });
    }
    db.prepare("UPDATE holdings SET current_price = ? WHERE id = ?").run(
      Number(current_price),
      id
    );
  }

  try {
    upsertDailySnapshots(db);
  } catch (_) {}
  res.json(aggregateAccount(db, row.account_id));
});

/** 直接改持仓数量与成本、现价、代码（用于纠错，现金不变） */
app.put("/api/holdings/:id", (req, res) => {
  const id = Number(req.params.id);
  const { position, cost_price, current_price, available, stock_code } =
    req.body || {};
  const row = db.prepare("SELECT * FROM holdings WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "持仓不存在" });
  const pos =
    position != null ? Math.floor(Number(position)) : row.position;
  if (pos < 0) return res.status(400).json({ error: "数量不能为负" });
  const cp = current_price != null ? Number(current_price) : row.current_price;
  const co = cost_price != null ? Number(cost_price) : row.cost_price;
  const av =
    available != null ? Math.floor(Number(available)) : pos;
  const sc =
    stock_code !== undefined
      ? stock_code === "" || stock_code === null
        ? null
        : normalizeStockCode(stock_code)
      : row.stock_code;
  if (cp <= 0 || co < 0) {
    return res.status(400).json({ error: "价格须有效" });
  }
  if (pos === 0) {
    db.prepare("DELETE FROM holdings WHERE id = ?").run(id);
  } else {
    db.prepare(
      `UPDATE holdings SET position = ?, available = ?, cost_price = ?, current_price = ?, stock_code = ?
       WHERE id = ?`
    ).run(pos, av, co, cp, sc, id);
  }
  try {
    upsertDailySnapshots(db);
  } catch (_) {}
  res.json(aggregateAccount(db, row.account_id));
});

/**
 * 成交：买入扣现金、卖出加现金；买入合并持仓时加权成本
 * body: { side, stock_name, stock_code?, quantity, price, current_price? }
 */
app.post("/api/accounts/:id/trade", (req, res) => {
  const accountId = Number(req.params.id);
  const acc = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);
  if (!acc) return res.status(404).json({ error: "账户不存在" });

  const { side, stock_name, stock_code, quantity, price, current_price } =
    req.body || {};
  const qty = Math.floor(Number(quantity));
  const px = Number(price);
  if (!stock_name || !String(stock_name).trim()) {
    return res.status(400).json({ error: "请填写股票名称" });
  }
  if (!["buy", "sell"].includes(side)) {
    return res.status(400).json({ error: "side 须为 buy 或 sell" });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: "数量须为正整数" });
  }
  if (!Number.isFinite(px) || px <= 0) {
    return res.status(400).json({ error: "成交价须为正数" });
  }

  const name = String(stock_name).trim();
  const codeNorm = normalizeStockCode(stock_code);
  const notional = Math.round(qty * px * 100) / 100;
  const curPx =
    current_price != null && Number(current_price) > 0
      ? Number(current_price)
      : px;

  const tx = db.transaction(() => {
    if (side === "buy") {
      if (acc.available_cash + 1e-6 < notional) {
        throw new Error("INSUFFICIENT_CASH");
      }
      db.prepare(
        "UPDATE accounts SET available_cash = available_cash - ?, withdrawable_cash = CASE WHEN withdrawable_cash IS NULL THEN NULL ELSE withdrawable_cash - ? END WHERE id = ?"
      ).run(notional, notional, accountId);

      const h = db
        .prepare(
          "SELECT * FROM holdings WHERE account_id = ? AND stock_name = ?"
        )
        .get(accountId, name);
      if (h) {
        const newPos = h.position + qty;
        const newCost =
          (h.position * h.cost_price + qty * px) / (newPos || 1);
        db.prepare(
          `UPDATE holdings SET position = ?, available = ?, cost_price = ?, current_price = ?, stock_code = COALESCE(?, stock_code) WHERE id = ?`
        ).run(newPos, newPos, newCost, curPx, codeNorm, h.id);
      } else {
        db.prepare(
          `INSERT INTO holdings (account_id, stock_name, stock_code, position, available, cost_price, current_price)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(accountId, name, codeNorm, qty, qty, px, curPx);
      }
    } else {
      const h = db
        .prepare(
          "SELECT * FROM holdings WHERE account_id = ? AND stock_name = ?"
        )
        .get(accountId, name);
      if (!h || h.position < qty) {
        throw new Error("INSUFFICIENT_SHARES");
      }
      const costBase = Math.round(qty * Number(h.cost_price) * 100) / 100;
      const proceeds = Math.round(qty * px * 100) / 100;
      const realizedSell = Math.round((proceeds - costBase) * 100) / 100;
      db.prepare(
        "UPDATE accounts SET realized_pnl_total = COALESCE(realized_pnl_total, 0) + ? WHERE id = ?"
      ).run(realizedSell, accountId);

      db.prepare(
        "UPDATE accounts SET available_cash = available_cash + ?, withdrawable_cash = CASE WHEN withdrawable_cash IS NULL THEN NULL ELSE withdrawable_cash + ? END WHERE id = ?"
      ).run(notional, notional, accountId);

      const newPos = h.position - qty;
      if (newPos === 0) {
        db.prepare("DELETE FROM holdings WHERE id = ?").run(h.id);
      } else {
        db.prepare(
          "UPDATE holdings SET position = ?, available = ?, current_price = ? WHERE id = ?"
        ).run(newPos, newPos, curPx, h.id);
      }
    }
  });

  try {
    tx();
  } catch (e) {
    if (e.message === "INSUFFICIENT_CASH") {
      return res.status(400).json({ error: "可用资金不足" });
    }
    if (e.message === "INSUFFICIENT_SHARES") {
      return res.status(400).json({ error: "可卖数量不足" });
    }
    throw e;
  }

  try {
    upsertDailySnapshots(db);
  } catch (_) {}
  res.json(aggregateAccount(db, accountId));
});

/** 银证入金 / 出金：amount 正数；出金在服务端扣减 */
app.post("/api/accounts/:id/ledger", (req, res) => {
  const accountId = Number(req.params.id);
  const acc = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);
  if (!acc) return res.status(404).json({ error: "账户不存在" });
  const { kind, amount, note } = req.body || {};
  const amt = Math.abs(Number(amount));
  if (!["deposit", "withdraw"].includes(kind)) {
    return res.status(400).json({ error: "kind 须为 deposit 或 withdraw" });
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: "amount 须为正数" });
  }
  const delta = kind === "deposit" ? amt : -amt;
  if (kind === "withdraw" && acc.available_cash + 1e-6 < amt) {
    return res.status(400).json({ error: "可取资金不足" });
  }
  db.prepare(
    "UPDATE accounts SET available_cash = available_cash + ?, withdrawable_cash = CASE WHEN withdrawable_cash IS NULL THEN NULL ELSE withdrawable_cash + ? END WHERE id = ?"
  ).run(delta, delta, accountId);
  db.prepare(
    `INSERT INTO ledger (account_id, kind, amount, note) VALUES (?, ?, ?, ?)`
  ).run(accountId, kind, delta, note || null);
  try {
    upsertDailySnapshots(db);
  } catch (_) {}
  res.json(aggregateAccount(db, accountId));
});

app.get("/api/accounts/:id/ledger", (req, res) => {
  const accountId = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT id, kind, amount, note, created_at FROM ledger WHERE account_id = ? ORDER BY id DESC LIMIT 200`
    )
    .all(accountId);
  res.json({ items: rows });
});

/** 管理：从 JSON 全量覆盖（慎用） */
app.post("/api/admin/reseed", (_req, res) => {
  const p = process.env.SEED_JSON_PATH || defaultJsonPath();
  if (!fs.existsSync(p)) {
    return res.status(400).json({ error: "找不到 JSON 文件", path: p });
  }
  seedFromJson(db, p);
  try {
    upsertDailySnapshots(db);
  } catch (_) {}
  res.json({ ok: true, path: p });
});

/** 手动拉取行情并批量更新现价（不校验是否在交易时段） */
app.post("/api/admin/sync-quotes", async (_req, res) => {
  try {
    const r = await runQuoteSync(db);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
});

/**
 * 拉真实日 K：当前持仓×历史收盘+当前现金，写入「早于今日」的近 N 个自然日；随后刷新当日快照。
 */
app.post("/api/admin/refresh-history-kline", async (req, res) => {
  try {
    const n = Number(req.body?.calendar_days ?? req.query?.days);
    const calendarDays = Number.isFinite(n)
      ? Math.min(60, Math.max(3, Math.floor(n)))
      : historyCalendarDaysDefault();
    const r = await backfillSnapshotsFromHistoricalKlines(db, calendarDays);
    if (r.skipped && r.reason === "QUOTE_KLINE_URL empty") {
      console.warn(
        "[snapshot] refresh-history-kline skipped: QUOTE_KLINE_URL empty | trim.length=",
        (process.env.QUOTE_KLINE_URL || "").trim().length,
        "（检查 Railway 是否把变量挂到本 Web Service 并已 Redeploy）"
      );
    }
    if (r.fetch_errors?.length) {
      const sample = r.fetch_errors
        .slice(0, 5)
        .map((e) => `${e.code}: ${e.message}`)
        .join(" | ");
      console.warn(
        "[snapshot] 日K 刷新:",
        r.codes_ok ?? 0,
        "成功 /",
        r.codes_failed ?? 0,
        "失败。",
        r.codes_failed > 0
          ? "失败时历史日一律用现价 → 曲线可能成水平线。示例: " + sample
          : ""
      );
    }
    try {
      upsertDailySnapshots(db);
    } catch (_) {}
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
});

app.use(express.static(publicDir));

const port = Number(process.env.PORT) || 3780;
const listenHost = process.env.LISTEN_HOST || "0.0.0.0";
app.listen(port, listenHost, () => {
  logQuoteEnvDiagnostics();
  const { user, pass } = getAdminCredentials();
  console.log(`http://${listenHost}:${port}`);
  console.log(`登录：Positions 认证，用户「${user}」`);
  if (!process.env.ADMIN_PASS) {
    console.log("未设置 ADMIN_PASS，当前使用默认密码：" + pass);
  }
  startBuiltinQuoteScheduler(db, console.log);
  console.log(
    "内置行情：每 5 分钟、上海工作日连续窗口内执行（默认 09:10–15:50，见 QUOTE_SYNC_SESSION_START/END）；启动时立即拉一次；现价可配 TUSHARE_TOKEN（rt_k）或 QUOTE_PRICE_URL / QUOTE_SYNC_URL"
  );
  if ((process.env.QUOTE_KLINE_URL || "").trim()) {
    const d = historyCalendarDaysDefault();
    console.log(
      `已配置 QUOTE_KLINE_URL：启动时已尝试用日K回填近 ${d} 个上海自然日中早于今日的曲线数据`
    );
  }
});
