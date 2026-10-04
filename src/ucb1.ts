/**
 * UCB1 核心逻辑（纯函数，无 IO）。
 *
 * 规则：
 * - 臂编号唯一，排序规则固定：按字符串字典序升序。
 * - 尚未观察过的臂优先，按编号顺序依次选择。
 * - 所有臂至少观察一次后：score = mean + sqrt(2 * ln(t) / n)，
 *   其中 t 为全部已接受奖励数，n 为该臂已接受奖励数。
 * - 分数相同（含并列最大）时按编号升序取先者。
 */

export interface Observation {
  armId: string;
  reward: number;
}

export interface ArmScore {
  armId: string;
  /** 该臂已接受奖励次数 */
  n: number;
  /** 平均奖励；未观察时为 null */
  mean: number | null;
  /** 探索项 sqrt(2 ln t / n)；未观察时为 null */
  bonus: number | null;
  /** 最终分数 mean + bonus；未观察时为 null */
  score: number | null;
}

export interface DecisionTable {
  /** 决策时已接受的奖励总数 */
  t: number;
  arms: ArmScore[];
  chosenArmId: string;
  reason: string;
}

export function compareArmIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function explorationBonus(t: number, n: number): number {
  return Math.sqrt((2 * Math.log(t)) / n);
}

export function decide(armIds: string[], observations: Observation[]): DecisionTable {
  if (armIds.length === 0) {
    throw new Error("实验至少需要一个臂");
  }
  const sorted = [...armIds].sort(compareArmIds);
  const counts = new Map<string, { n: number; sum: number }>();
  for (const id of sorted) counts.set(id, { n: 0, sum: 0 });
  for (const obs of observations) {
    const entry = counts.get(obs.armId);
    if (!entry) throw new Error(`观察记录包含未知臂: ${obs.armId}`);
    entry.n += 1;
    entry.sum += obs.reward;
  }
  const t = observations.length;

  const arms: ArmScore[] = sorted.map((armId) => {
    const { n, sum } = counts.get(armId)!;
    if (n === 0) {
      return { armId, n: 0, mean: null, bonus: null, score: null };
    }
    const mean = sum / n;
    const bonus = explorationBonus(t, n);
    return { armId, n, mean, bonus, score: mean + bonus };
  });

  const unobserved = arms.filter((a) => a.n === 0);
  if (unobserved.length > 0) {
    const chosen = unobserved[0].armId;
    return {
      t,
      arms,
      chosenArmId: chosen,
      reason: `臂 "${chosen}" 尚未被观察过，按编号顺序优先尝试未观察的臂`,
    };
  }

  // arms 已按编号升序，严格大于才替换 => 平局时取编号较小者
  let best = arms[0];
  for (const arm of arms) {
    if (arm.score! > best.score!) best = arm;
  }
  return {
    t,
    arms,
    chosenArmId: best.armId,
    reason:
      `所有臂均已观察，按 UCB1 打分 score = mean + sqrt(2*ln(t)/n)，t=${t}；` +
      `臂 "${best.armId}" 分数最高（${best.score!.toFixed(6)}），平局时按编号升序取先`,
  };
}
