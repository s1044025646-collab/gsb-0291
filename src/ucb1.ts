/** UCB1 核心逻辑:纯函数,不依赖存储层。 */

export interface ArmStat {
  armId: string;
  /** 该臂已接受奖励次数 n */
  n: number;
  /** 平均奖励 */
  mean: number;
  /** 探索项 sqrt(2*ln(t)/n),未观察时为 Infinity */
  exploration: number;
  /** 最终分数 mean + exploration */
  score: number;
}

export interface ChoiceResult {
  armId: string;
  stats: ArmStat[];
  reason: string;
}

export interface Observation {
  armId: string;
  reward: number;
}

/** 由已接受奖励序列计算每个臂的 (n, sum)。 */
export function accumulate(arms: string[], observations: Observation[]): {
  counts: Map<string, number>;
  sums: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const sums = new Map<string, number>();
  for (const arm of arms) {
    counts.set(arm, 0);
    sums.set(arm, 0);
  }
  for (const obs of observations) {
    if (!counts.has(obs.armId)) continue;
    counts.set(obs.armId, (counts.get(obs.armId) as number) + 1);
    sums.set(obs.armId, (sums.get(obs.armId) as number) + obs.reward);
  }
  return { counts, sums };
}

/** 计算每个臂的统计。t 为全部已接受奖励数。 */
export function computeStats(
  arms: string[],
  counts: Map<string, number>,
  sums: Map<string, number>,
  t: number
): ArmStat[] {
  return arms.map((armId) => {
    const n = counts.get(armId) ?? 0;
    const mean = n > 0 ? (sums.get(armId) as number) / n : 0;
    const exploration = n > 0 && t > 0 ? Math.sqrt((2 * Math.log(t)) / n) : Infinity;
    const score = n > 0 ? mean + exploration : Infinity;
    return { armId, n, mean, exploration, score };
  });
}

/**
 * UCB1 选择:
 * 1. 存在未观察过的臂时,按编号(创建时固定排序)依次选择;
 * 2. 否则选 mean + sqrt(2*ln(t)/n) 最大者,平分取编号较小者。
 */
export function chooseArm(
  arms: string[],
  counts: Map<string, number>,
  sums: Map<string, number>,
  t: number
): ChoiceResult {
  const stats = computeStats(arms, counts, sums, t);
  for (const s of stats) {
    if (s.n === 0) {
      return {
        armId: s.armId,
        stats,
        reason: `臂 ${s.armId} 尚未被观察过,按编号顺序优先尝试(初始化阶段)。`,
      };
    }
  }
  let best = stats[0];
  for (const s of stats) {
    if (s.score > best.score) best = s; // 严格大于,平分保留编号较小者
  }
  return {
    armId: best.armId,
    stats,
    reason:
      `所有臂均已观察,选择 UCB1 分数最高者 ${best.armId}` +
      `(均值 ${best.mean.toFixed(6)} + 探索项 ${best.exploration.toFixed(6)} = ${best.score.toFixed(6)},t=${t})。`,
  };
}
