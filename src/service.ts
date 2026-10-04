import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ArmStat, Observation, accumulate, chooseArm } from "./ucb1";

export type ErrorCode =
  | "INVALID_ARMS"
  | "EXPERIMENT_NOT_FOUND"
  | "DECISION_NOT_FOUND"
  | "DECISION_NOT_PENDING"
  | "INVALID_REWARD"
  | "BAD_REQUEST";

export class ServiceError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 400) {
    super(message);
  }
}

interface ExperimentRow {
  id: string;
  name: string;
  arms: string;
  created_at: string;
}

interface DecisionRow {
  id: number;
  experiment_id: string;
  seq: number;
  arm_id: string;
  t: number;
  stats_json: string;
  reason: string;
  status: string;
  reward: number | null;
  created_at: string;
  rewarded_at: string | null;
}

function now(): string {
  return new Date().toISOString();
}

/** Infinity 无法直接存入 JSON,用字符串标记。 */
function serializeStats(stats: ArmStat[]): string {
  return JSON.stringify(stats, (_k, v) => (v === Infinity ? "Infinity" : v));
}

function parseStats(json: string): ArmStat[] {
  return JSON.parse(json, (_k, v) => (v === "Infinity" ? Infinity : v)) as ArmStat[];
}

export class BanditService {
  constructor(private db: DatabaseSync) {}

  createExperiment(name: string | undefined, arms: unknown): { id: string; name: string; arms: string[] } {
    if (!Array.isArray(arms) || arms.length === 0) {
      throw new ServiceError("INVALID_ARMS", "arms 必须是非空数组。");
    }
    if (arms.some((a) => typeof a !== "string" || a.length === 0)) {
      throw new ServiceError("INVALID_ARMS", "每个臂编号必须是非空字符串。");
    }
    const unique = new Set(arms);
    if (unique.size !== arms.length) {
      throw new ServiceError("INVALID_ARMS", "臂编号必须唯一。");
    }
    const sorted = [...(arms as string[])].sort();
    const id = randomUUID();
    const expName = typeof name === "string" && name.length > 0 ? name : id;
    this.db
      .prepare("INSERT INTO experiments (id, name, arms, created_at) VALUES (?, ?, ?, ?)")
      .run(id, expName, JSON.stringify(sorted), now());
    return { id, name: expName, arms: sorted };
  }

  private getExperiment(experimentId: string): { id: string; name: string; arms: string[] } {
    const row = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId) as
      | ExperimentRow
      | undefined;
    if (!row) throw new ServiceError("EXPERIMENT_NOT_FOUND", `实验 ${experimentId} 不存在。`, 404);
    return { id: row.id, name: row.name, arms: JSON.parse(row.arms) as string[] };
  }

  private rewardedObservations(experimentId: string): Observation[] {
    const rows = this.db
      .prepare(
        "SELECT arm_id, reward FROM decisions WHERE experiment_id = ? AND status = 'rewarded' ORDER BY seq ASC"
      )
      .all(experimentId) as Array<{ arm_id: string; reward: number }>;
    return rows.map((r) => ({ armId: r.arm_id, reward: r.reward }));
  }

  suggest(experimentId: string): {
    decisionId: number;
    seq: number;
    armId: string;
    t: number;
    stats: ArmStat[];
    reason: string;
    reused: boolean;
  } {
    const exp = this.getExperiment(experimentId);
    const pending = this.db
      .prepare("SELECT * FROM decisions WHERE experiment_id = ? AND status = 'pending'")
      .get(experimentId) as DecisionRow | undefined;
    if (pending) {
      return {
        decisionId: pending.id,
        seq: pending.seq,
        armId: pending.arm_id,
        t: pending.t,
        stats: parseStats(pending.stats_json),
        reason: pending.reason,
        reused: true,
      };
    }
    const observations = this.rewardedObservations(experimentId);
    const t = observations.length;
    const { counts, sums } = accumulate(exp.arms, observations);
    const choice = chooseArm(exp.arms, counts, sums, t);
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM decisions WHERE experiment_id = ?")
      .get(experimentId) as { maxSeq: number };
    const result = this.db
      .prepare(
        "INSERT INTO decisions (experiment_id, seq, arm_id, t, stats_json, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
      )
      .run(experimentId, seqRow.maxSeq + 1, choice.armId, t, serializeStats(choice.stats), choice.reason, now());
    return {
      decisionId: Number(result.lastInsertRowid),
      seq: seqRow.maxSeq + 1,
      armId: choice.armId,
      t,
      stats: choice.stats,
      reason: choice.reason,
      reused: false,
    };
  }

  submitReward(decisionId: number, reward: unknown): {
    decisionId: number;
    armId: string;
    reward: number;
    t: number;
  } {
    if (typeof reward !== "number" || !Number.isFinite(reward) || reward < 0 || reward > 1) {
      throw new ServiceError("INVALID_REWARD", "奖励必须是 [0,1] 区间内的有限数。");
    }
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId) as
      | DecisionRow
      | undefined;
    if (!row) throw new ServiceError("DECISION_NOT_FOUND", `决策 ${decisionId} 不存在或已过期。`, 404);
    if (row.status !== "pending") {
      throw new ServiceError("DECISION_NOT_PENDING", `决策 ${decisionId} 已收到过奖励,不能重复反馈。`, 409);
    }
    const updated = this.db
      .prepare(
        "UPDATE decisions SET status = 'rewarded', reward = ?, rewarded_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(reward, now(), decisionId);
    if (Number(updated.changes) !== 1) {
      throw new ServiceError("DECISION_NOT_PENDING", `决策 ${decisionId} 已收到过奖励,不能重复反馈。`, 409);
    }
    const tRow = this.db
      .prepare("SELECT COUNT(*) AS c FROM decisions WHERE experiment_id = ? AND status = 'rewarded'")
      .get(row.experiment_id) as { c: number };
    return { decisionId, armId: row.arm_id, reward, t: tRow.c };
  }

  stats(experimentId: string): {
    experimentId: string;
    t: number;
    pendingDecisionId: number | null;
    stats: ArmStat[];
  } {
    const exp = this.getExperiment(experimentId);
    const observations = this.rewardedObservations(experimentId);
    const { counts, sums } = accumulate(exp.arms, observations);
    const pending = this.db
      .prepare("SELECT id FROM decisions WHERE experiment_id = ? AND status = 'pending'")
      .get(experimentId) as { id: number } | undefined;
    return {
      experimentId,
      t: observations.length,
      pendingDecisionId: pending ? pending.id : null,
      stats: chooseArm(exp.arms, counts, sums, observations.length).stats,
    };
  }

  explain(decisionId: number): {
    decisionId: number;
    experimentId: string;
    seq: number;
    armId: string;
    t: number;
    stats: ArmStat[];
    reason: string;
    status: string;
    reward: number | null;
  } {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId) as
      | DecisionRow
      | undefined;
    if (!row) throw new ServiceError("DECISION_NOT_FOUND", `决策 ${decisionId} 不存在。`, 404);
    return {
      decisionId: row.id,
      experimentId: row.experiment_id,
      seq: row.seq,
      armId: row.arm_id,
      t: row.t,
      stats: parseStats(row.stats_json),
      reason: row.reason,
      status: row.status,
      reward: row.reward,
    };
  }

  exportEvents(experimentId: string): {
    experimentId: string;
    arms: string[];
    events: Array<Record<string, unknown>>;
  } {
    const exp = this.getExperiment(experimentId);
    const rows = this.db
      .prepare("SELECT * FROM decisions WHERE experiment_id = ? ORDER BY seq ASC")
      .all(experimentId) as unknown as DecisionRow[];
    return {
      experimentId,
      arms: exp.arms,
      events: rows.map((r) => ({
        decisionId: r.id,
        seq: r.seq,
        armId: r.arm_id,
        t: r.t,
        stats: parseStats(r.stats_json),
        reason: r.reason,
        status: r.status,
        reward: r.reward,
        createdAt: r.created_at,
        rewardedAt: r.rewarded_at,
      })),
    };
  }

  replay(experimentId: string): {
    experimentId: string;
    ok: boolean;
    checked: number;
    errors: Array<{ seq: number; decisionId: number; message: string }>;
    finalStats: ArmStat[];
  } {
    const exp = this.getExperiment(experimentId);
    const rows = this.db
      .prepare("SELECT * FROM decisions WHERE experiment_id = ? ORDER BY seq ASC")
      .all(experimentId) as unknown as DecisionRow[];
    const errors: Array<{ seq: number; decisionId: number; message: string }> = [];
    const observations: Observation[] = [];
    let expectedSeq = 1;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        errors.push({
          seq: row.seq,
          decisionId: row.id,
          message: `顺序错误:期望 seq=${expectedSeq},实际 seq=${row.seq}(可能缺失事件)。`,
        });
        expectedSeq = row.seq;
      }
      expectedSeq += 1;
      const t = observations.length;
      const { counts, sums } = accumulate(exp.arms, observations);
      const choice = chooseArm(exp.arms, counts, sums, t);
      if (row.t !== t) {
        errors.push({
          seq: row.seq,
          decisionId: row.id,
          message: `t 不一致:记录为 ${row.t},回放重建为 ${t}。`,
        });
      }
      if (row.arm_id !== choice.armId) {
        errors.push({
          seq: row.seq,
          decisionId: row.id,
          message: `选中臂不一致:记录为 ${row.arm_id},回放重建为 ${choice.armId}。`,
        });
      }
      const recorded = parseStats(row.stats_json);
      for (let i = 0; i < choice.stats.length; i++) {
        const a = recorded[i];
        const b = choice.stats[i];
        if (
          !a ||
          a.armId !== b.armId ||
          a.n !== b.n ||
          !closeEnough(a.mean, b.mean) ||
          !closeEnough(a.score, b.score)
        ) {
          errors.push({
            seq: row.seq,
            decisionId: row.id,
            message: `臂 ${b.armId} 分数不一致:记录 ${JSON.stringify(a)},回放 ${JSON.stringify(b)}。`,
          });
        }
      }
      if (row.status === "rewarded" && row.reward !== null) {
        observations.push({ armId: row.arm_id, reward: row.reward });
      }
    }
    const { counts, sums } = accumulate(exp.arms, observations);
    return {
      experimentId,
      ok: errors.length === 0,
      checked: rows.length,
      errors,
      finalStats: chooseArm(exp.arms, counts, sums, observations.length).stats,
    };
  }
}

function closeEnough(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < 1e-9;
}
