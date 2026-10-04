import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DEFAULT_DB_PATH = path.join(DATA_DIR, "ucb1.db");

export function openDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      arms TEXT NOT NULL,          -- JSON 数组,创建时排序后固定
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL REFERENCES experiments(id),
      seq INTEGER NOT NULL,        -- 实验内决策序号,从 1 开始
      arm_id TEXT NOT NULL,
      t INTEGER NOT NULL,          -- 做出该决策时已接受的奖励总数
      stats_json TEXT NOT NULL,    -- 决策时各臂统计快照
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','rewarded')),
      reward REAL,
      created_at TEXT NOT NULL,
      rewarded_at TEXT,
      UNIQUE (experiment_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_exp ON decisions(experiment_id, seq);
  `);
  return db;
}
