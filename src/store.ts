import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { decide, ArmScore, DecisionTable, Observation } from "./ucb1";
import { ApiError } from "./errors";

export interface Experiment {
  id: string;
  name: string;
  arms: string[];
  createdAt: string;
}

export interface Decision {
  id: string;
  experimentId: string;
  seq: number;
  chosenArm: string;
  /** 决策时已接受的奖励总数 */
  t: number;
  arms: ArmScore[];
  reason: string;
  status: "pending" | "confirmed";
  reward: number | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface ArmStats {
  armId: string;
  n: number;
  mean: number | null;
  bonus: number | null;
  score: number | null;
}

export interface ExperimentStats {
  experimentId: string;
  t: number;
  pendingDecisionId: string | null;
  arms: ArmStats[];
}

export interface ReplayMismatch {
  decisionId: string;
  seq: number;
  problem: string;
  expected: unknown;
  actual: unknown;
}

export interface ReplayReport {
  experimentId: string;
  ok: boolean;
  checked: number;
  mismatches: ReplayMismatch[];
  finalStats: ExperimentStats;
}

interface DecisionRow {
  id: string;
  experiment_id: string;
  seq: number;
  chosen_arm: string;
  t: number;
  snapshot: string;
  reason: string;
  status: string;
  reward: number | null;
  created_at: string;
  confirmed_at: string | null;
}

const EPS = 1e-9;

export class BanditStore {
  private readonly db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        arms TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id),
        seq INTEGER NOT NULL,
        chosen_arm TEXT NOT NULL,
        t INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','confirmed')),
        reward REAL,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        UNIQUE (experiment_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_exp ON decisions(experiment_id, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  createExperiment(name: string, arms: string[]): Experiment {
    if (typeof name !== "string" || name.trim() === "") {
      throw new ApiError("INVALID_ARGUMENT", "name 必须是非空字符串");
    }
    if (!Array.isArray(arms) || arms.length === 0) {
      throw new ApiError("INVALID_ARGUMENT", "arms 必须是非空数组");
    }
    const seen = new Set<string>();
    for (const arm of arms) {
      if (typeof arm !== "string" || arm.trim() === "") {
        throw new ApiError("INVALID_ARGUMENT", "每个臂编号必须是非空字符串");
      }
      if (seen.has(arm)) {
        throw new ApiError("INVALID_ARGUMENT", `臂编号重复: "${arm}"`);
      }
      seen.add(arm);
    }
    const experiment: Experiment = {
      id: randomUUID(),
      name: name.trim(),
      arms: [...arms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO experiments (id, name, arms, created_at) VALUES (?, ?, ?, ?)")
      .run(experiment.id, experiment.name, JSON.stringify(experiment.arms), experiment.createdAt);
    return experiment;
  }

  getExperiment(experimentId: string): Experiment {
    const row = this.db
      .prepare("SELECT id, name, arms, created_at FROM experiments WHERE id = ?")
      .get(experimentId) as { id: string; name: string; arms: string; created_at: string } | undefined;
    if (!row) {
      throw new ApiError("EXPERIMENT_NOT_FOUND", `实验不存在: ${experimentId}`, 404);
    }
    return { id: row.id, name: row.name, arms: JSON.parse(row.arms) as string[], createdAt: row.created_at };
  }

  listExperiments(): Experiment[] {
    const rows = this.db
      .prepare("SELECT id, name, arms, created_at FROM experiments ORDER BY created_at")
      .all() as unknown as { id: string; name: string; arms: string; created_at: string }[];
    return rows.map((row) => ({ id: row.id, name: row.name, arms: JSON.parse(row.arms) as string[], createdAt: row.created_at }));
  }

  private rowToDecision(row: DecisionRow): Decision {
    return {
      id: row.id,
      experimentId: row.experiment_id,
      seq: row.seq,
      chosenArm: row.chosen_arm,
      t: row.t,
      arms: JSON.parse(row.snapshot) as ArmScore[],
      reason: row.reason,
      status: row.status as Decision["status"],
      reward: row.reward,
      createdAt: row.created_at,
      confirmedAt: row.confirmed_at,
    };
  }

  private getPendingRow(experimentId: string): DecisionRow | undefined {
    return this.db
      .prepare("SELECT * FROM decisions WHERE experiment_id = ? AND status = 'pending' ORDER BY seq DESC LIMIT 1")
      .get(experimentId) as DecisionRow | undefined;
  }

  private confirmedObservations(experimentId: string): Observation[] {
    const rows = this.db
      .prepare(
        "SELECT chosen_arm, reward FROM decisions WHERE experiment_id = ? AND status = 'confirmed' ORDER BY seq",
      )
      .all(experimentId) as unknown as { chosen_arm: string; reward: number }[];
    return rows.map((row) => ({ armId: row.chosen_arm, reward: row.reward }));
  }

  /**
   * 请求下一轮建议。若已有待反馈决策，返回同一个决策（不生成第二次选择）。
   * 新决策的创建在单事务内完成；未收到奖励前不改变任何观测统计。
   */
  requestSuggestion(experimentId: string): { decision: Decision; reused: boolean } {
    const experiment = this.getExperiment(experimentId);
    return this.tx(() => {
      const pending = this.getPendingRow(experimentId);
      if (pending) {
        return { decision: this.rowToDecision(pending), reused: true };
      }
      const observations = this.confirmedObservations(experimentId);
      const table: DecisionTable = decide(experiment.arms, observations);
      const seqRow = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM decisions WHERE experiment_id = ?")
        .get(experimentId) as { next_seq: number };
      const decision: Decision = {
        id: randomUUID(),
        experimentId,
        seq: seqRow.next_seq,
        chosenArm: table.chosenArmId,
        t: table.t,
        arms: table.arms,
        reason: table.reason,
        status: "pending",
        reward: null,
        createdAt: new Date().toISOString(),
        confirmedAt: null,
      };
      this.db
        .prepare(
          `INSERT INTO decisions (id, experiment_id, seq, chosen_arm, t, snapshot, reason, status, reward, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
        )
        .run(
          decision.id,
          experimentId,
          decision.seq,
          decision.chosenArm,
          decision.t,
          JSON.stringify(decision.arms),
          decision.reason,
          decision.createdAt,
        );
      return { decision, reused: false };
    });
  }

  /**
   * 提交奖励。校验：奖励为 [0,1] 有限数；决策属于该实验且处于 pending。
   * 确认在单事务内完成；重复反馈与过期编号明确拒绝，不会二次累计。
   */
  submitFeedback(experimentId: string, decisionId: string, reward: unknown): Decision {
    this.getExperiment(experimentId);
    if (typeof reward !== "number" || !Number.isFinite(reward) || reward < 0 || reward > 1) {
      throw new ApiError("INVALID_REWARD", `奖励必须是 [0,1] 区间内的有限数，收到: ${JSON.stringify(reward)}`);
    }
    return this.tx(() => {
      const row = this.db
        .prepare("SELECT * FROM decisions WHERE id = ?")
        .get(decisionId) as DecisionRow | undefined;
      if (!row || row.experiment_id !== experimentId) {
        throw new ApiError("DECISION_NOT_FOUND", `决策编号不存在或不属于该实验: ${decisionId}`, 404);
      }
      if (row.status !== "pending") {
        throw new ApiError(
          "DUPLICATE_FEEDBACK",
          `决策 ${decisionId} 已确认过奖励（reward=${row.reward}），拒绝重复反馈`,
          409,
        );
      }
      const confirmedAt = new Date().toISOString();
      this.db
        .prepare("UPDATE decisions SET status = 'confirmed', reward = ?, confirmed_at = ? WHERE id = ? AND status = 'pending'")
        .run(reward, confirmedAt, decisionId);
      const updated = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId) as unknown as DecisionRow;
      return this.rowToDecision(updated);
    });
  }

  getDecision(experimentId: string, decisionId: string): Decision {
    this.getExperiment(experimentId);
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId) as DecisionRow | undefined;
    if (!row || row.experiment_id !== experimentId) {
      throw new ApiError("DECISION_NOT_FOUND", `决策编号不存在或不属于该实验: ${decisionId}`, 404);
    }
    return this.rowToDecision(row);
  }

  getStats(experimentId: string): ExperimentStats {
    const experiment = this.getExperiment(experimentId);
    const observations = this.confirmedObservations(experimentId);
    const table = decide(experiment.arms, observations);
    const pending = this.getPendingRow(experimentId);
    return {
      experimentId,
      t: table.t,
      pendingDecisionId: pending ? pending.id : null,
      arms: table.arms,
    };
  }

  listDecisions(experimentId: string): Decision[] {
    this.getExperiment(experimentId);
    const rows = this.db
      .prepare("SELECT * FROM decisions WHERE experiment_id = ? ORDER BY seq")
      .all(experimentId) as unknown as DecisionRow[];
    return rows.map((row) => this.rowToDecision(row));
  }

  /** 导出全部事件（按 seq 排序的决策记录），用于回放与审计。 */
  exportEvents(experimentId: string): { experiment: Experiment; events: Decision[] } {
    return { experiment: this.getExperiment(experimentId), events: this.listDecisions(experimentId) };
  }

  /**
   * 回放检查：从空统计开始，按事件顺序重建，
   * 逐项核对每个决策当时的 t、可用数据、选中臂与各臂分数。
   */
  replay(experimentId: string): ReplayReport {
    const experiment = this.getExperiment(experimentId);
    const events = this.listDecisions(experimentId);
    const mismatches: ReplayMismatch[] = [];
    const observations: Observation[] = [];

    events.forEach((event, index) => {
      if (event.seq !== index + 1) {
        mismatches.push({
          decisionId: event.id,
          seq: event.seq,
          problem: "事件顺序错误：seq 不连续",
          expected: index + 1,
          actual: event.seq,
        });
      }
      const recomputed = decide(experiment.arms, observations);
      if (event.t !== recomputed.t) {
        mismatches.push({
          decisionId: event.id,
          seq: event.seq,
          problem: "决策时 t 与已接受奖励数不一致",
          expected: recomputed.t,
          actual: event.t,
        });
      }
      if (event.chosenArm !== recomputed.chosenArmId) {
        mismatches.push({
          decisionId: event.id,
          seq: event.seq,
          problem: "选中臂与当时可用数据重算结果不一致",
          expected: recomputed.chosenArmId,
          actual: event.chosenArm,
        });
      }
      for (const arm of recomputed.arms) {
        const recorded = event.arms.find((a) => a.armId === arm.armId);
        if (!recorded) {
          mismatches.push({
            decisionId: event.id,
            seq: event.seq,
            problem: `快照缺少臂 "${arm.armId}"`,
            expected: arm,
            actual: null,
          });
          continue;
        }
        const fields: (keyof ArmScore)[] = ["n", "mean", "bonus", "score"];
        for (const field of fields) {
          const a = recorded[field];
          const b = arm[field];
          const equal =
            a === null && b === null
              ? true
              : typeof a === "number" && typeof b === "number" && Math.abs(a - b) < EPS;
          if (!equal) {
            mismatches.push({
              decisionId: event.id,
              seq: event.seq,
              problem: `臂 "${arm.armId}" 的 ${field} 与重算结果不一致`,
              expected: b,
              actual: a,
            });
          }
        }
      }
      if (event.status === "confirmed") {
        observations.push({ armId: event.chosenArm, reward: event.reward! });
      } else if (index !== events.length - 1) {
        mismatches.push({
          decisionId: event.id,
          seq: event.seq,
          problem: "存在未确认奖励的历史决策（只允许最后一个决策处于 pending）",
          expected: "confirmed",
          actual: event.status,
        });
      }
    });

    return {
      experimentId,
      ok: mismatches.length === 0,
      checked: events.length,
      mismatches,
      finalStats: this.getStats(experimentId),
    };
  }
}

export function defaultDataDir(): string {
  return process.env.UCB1_DATA_DIR ?? path.join(process.cwd(), "data");
}

export function defaultDbPath(): string {
  return process.env.UCB1_DB_PATH ?? path.join(defaultDataDir(), "ucb1.db");
}
