import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

export function openDb() {
  const dbPath =
    process.env.POSITIONS_DB_PATH ||
    path.join(root, "data", "positions.db");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broker TEXT NOT NULL,
      account_name TEXT NOT NULL UNIQUE,
      account_type TEXT,
      position_ratio REAL,
      available_cash REAL NOT NULL DEFAULT 0,
      withdrawable_cash REAL,
      daily_profit REAL DEFAULT 0,
      daily_profit_pct REAL,
      realized_pnl_total REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      stock_name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0,
      cost_price REAL NOT NULL,
      current_price REAL NOT NULL,
      UNIQUE(account_id, stock_name),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS snapshot_daily (
      account_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      total_assets REAL NOT NULL,
      market_value REAL NOT NULL,
      position_profit REAL NOT NULL DEFAULT 0,
      realized_pnl REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, day),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);
  const snapCols = db.prepare("PRAGMA table_info(snapshot_daily)").all();
  if (!snapCols.some((c) => c.name === "position_profit")) {
    db.exec(
      `ALTER TABLE snapshot_daily ADD COLUMN position_profit REAL NOT NULL DEFAULT 0`
    );
  }
  if (!snapCols.some((c) => c.name === "realized_pnl")) {
    db.exec(
      `ALTER TABLE snapshot_daily ADD COLUMN realized_pnl REAL NOT NULL DEFAULT 0`
    );
  }
  const accCols = db.prepare("PRAGMA table_info(accounts)").all();
  if (!accCols.some((c) => c.name === "realized_pnl_total")) {
    db.exec(
      `ALTER TABLE accounts ADD COLUMN realized_pnl_total REAL NOT NULL DEFAULT 0`
    );
  }
  const cols = db.prepare("PRAGMA table_info(holdings)").all();
  if (!cols.some((c) => c.name === "stock_code")) {
    db.exec("ALTER TABLE holdings ADD COLUMN stock_code TEXT");
  }
  if (!cols.some((c) => c.name === "prev_close")) {
    db.exec("ALTER TABLE holdings ADD COLUMN prev_close REAL");
  }
  if (!cols.some((c) => c.name === "prev_close_day")) {
    db.exec("ALTER TABLE holdings ADD COLUMN prev_close_day TEXT");
  }
}

export function seedFromJson(db, jsonPath) {
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const insertAcc = db.prepare(`
    INSERT INTO accounts (broker, account_name, account_type, position_ratio, available_cash, withdrawable_cash, daily_profit, daily_profit_pct, realized_pnl_total)
    VALUES (@broker, @account_name, @account_type, @position_ratio, @available_cash, @withdrawable_cash, @daily_profit, @daily_profit_pct, @realized_pnl_total)
  `);
  const insertHold = db.prepare(`
    INSERT INTO holdings (account_id, stock_name, stock_code, position, available, cost_price, current_price)
    VALUES (@account_id, @stock_name, @stock_code, @position, @available, @cost_price, @current_price)
  `);

  const tx = db.transaction(() => {
    db.exec("DELETE FROM ledger; DELETE FROM holdings; DELETE FROM accounts;");
    for (const a of raw.accounts || []) {
      const s = a.summary || {};
      const info = insertAcc.run({
        broker: a.broker || "",
        account_name: a.account_name,
        account_type: a.account_type ?? null,
        position_ratio: a.position_ratio ?? null,
        available_cash: s.available_cash ?? 0,
        withdrawable_cash: s.withdrawable_cash ?? null,
        daily_profit: s.daily_profit ?? 0,
        daily_profit_pct: s.daily_profit_pct ?? null,
        realized_pnl_total: s.realized_pnl_total ?? 0,
      });
      const accountId = info.lastInsertRowid;
      for (const h of a.holdings || []) {
        const sc =
          h.stock_code != null
            ? String(h.stock_code).match(/(\d{6})/)?.[1] ?? null
            : h.code != null
              ? String(h.code).match(/(\d{6})/)?.[1] ?? null
              : null;
        insertHold.run({
          account_id: accountId,
          stock_name: h.stock_name,
          stock_code: sc,
          position: h.position,
          available: h.available ?? h.position,
          cost_price: h.cost_price,
          current_price: h.current_price,
        });
      }
    }
  });
  tx();
}

export function defaultJsonPath() {
  return path.join(root, "original_accounts.json");
}
