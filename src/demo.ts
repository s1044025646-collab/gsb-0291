import * as fs from "node:fs";
import * as path from "node:path";
import { BanditService } from "./service";
import { DATA_DIR } from "./db";

export interface DemoInput {
  arms: string[];
  /** 每个臂预先写好的奖励序列,只有选中该臂时才消耗下一个值 */
  rewardStreams: Record<string, number[]>;
  rounds: number;
}

/** 内置演示:两个平均表现不同的固定奖励流。 */
export const DEFAULT_DEMO: DemoInput = {
  arms: ["A", "B"],
  rewardStreams: {
    A: [0.1, 0.2, 0.1, 0.3, 0.2, 0.1, 0.2, 0.3, 0.1, 0.2, 0.2, 0.1, 0.3, 0.2, 0.1, 0.2, 0.1, 0.2, 0.3, 0.2],
    B: [0.7, 0.8, 0.6, 0.9, 0.7, 0.8, 0.6, 0.7, 0.9, 0.8, 0.7, 0.6, 0.8, 0.7, 0.9, 0.7, 0.8, 0.6, 0.7, 0.8],
  },
  rounds: 20,
};

/**
 * 离线演示器:每轮请求建议,选中某臂才消耗该臂奖励序列的下一个值;
 * 未被选中的臂的值不会被看到,也不计入均值。演示输入保存到 data/ 以便复现。
 */
export function runDemo(service: BanditService, input: DemoInput = DEFAULT_DEMO): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const inputPath = path.join(DATA_DIR, "demo-input.json");
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2), "utf8");

  const exp = service.createExperiment("demo", input.arms);
  const cursors: Record<string, number> = {};
  for (const arm of input.arms) cursors[arm] = 0;

  console.log(`实验 ${exp.id} 已创建,臂: ${input.arms.join(", ")},共 ${input.rounds} 轮`);
  console.log(`演示输入已保存: ${inputPath}\n`);

  for (let round = 1; round <= input.rounds; round++) {
    const suggestion = service.suggest(exp.id);
    const arm = suggestion.armId;
    const stream = input.rewardStreams[arm];
    const idx = cursors[arm];
    if (idx >= stream.length) {
      console.log(`第 ${round} 轮:臂 ${arm} 的奖励序列已耗尽,演示提前结束。`);
      break;
    }
    const reward = stream[idx];
    cursors[arm] = idx + 1;
    service.submitReward(suggestion.decisionId, reward);
    const chosen = suggestion.stats.find((s) => s.armId === arm);
    const scoreText = chosen && Number.isFinite(chosen.score) ? chosen.score.toFixed(4) : "init";
    console.log(
      `第 ${String(round).padStart(2)} 轮 -> 选 ${arm} | 奖励 ${reward.toFixed(2)} | 决策时分数 ${scoreText}`
    );
  }

  const final = service.stats(exp.id);
  console.log(`\n最终统计(t=${final.t}):`);
  for (const s of final.stats) {
    console.log(
      `  臂 ${s.armId}: n=${s.n}, 均值=${s.mean.toFixed(4)}, 探索项=${
        Number.isFinite(s.exploration) ? s.exploration.toFixed(4) : "inf"
      }`
    );
  }
  const replay = service.replay(exp.id);
  console.log(`\n回放检查: ${replay.ok ? "通过" : "失败"}(核对 ${replay.checked} 条决策)`);
  console.log("注意:有限轮结果不能证明某臂绝对更好,仅展示 UCB1 的探索与利用过程。");
}
