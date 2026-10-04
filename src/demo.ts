import * as fs from "node:fs";
import * as path from "node:path";
import { BanditStore, defaultDataDir } from "./store";

/**
 * 离线演示器：每个臂有预先写好的奖励序列，只有选中该臂时才消耗它的下一个值；
 * 其他臂未被看到的值不会计入均值。演示输入会保存到数据目录以便复现。
 */

export interface DemoInput {
  name: string;
  rounds: number;
  streams: Record<string, number[]>;
  note: string;
}

export function defaultDemoInput(): DemoInput {
  // 两条固定奖励流：alpha 平均约 0.7，beta 平均约 0.3
  const alpha = [0.6, 0.8, 0.7, 0.9, 0.5, 0.8, 0.7, 0.6, 0.9, 0.7, 0.8, 0.6, 0.7, 0.8, 0.7, 0.6, 0.8, 0.9, 0.7, 0.6, 0.8, 0.7, 0.5, 0.9, 0.7, 0.8, 0.6, 0.7, 0.8, 0.7];
  const beta = [0.4, 0.2, 0.3, 0.5, 0.2, 0.4, 0.3, 0.2, 0.4, 0.3, 0.1, 0.4, 0.3, 0.2, 0.4, 0.3, 0.5, 0.2, 0.3, 0.4, 0.2, 0.3, 0.4, 0.1, 0.3, 0.4, 0.2, 0.3, 0.4, 0.3];
  return {
    name: "demo-two-streams",
    rounds: 30,
    streams: { alpha, beta },
    note: "固定奖励流：alpha 均值约 0.7，beta 均值约 0.3；只有被选中时才消耗对应流的下一个值",
  };
}

export function runDemo(input: DemoInput, dbPath: string): { log: string[]; inputPath: string } {
  const dataDir = defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const inputPath = path.join(dataDir, `demo-input-${Date.now()}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2), "utf8");

  const store = new BanditStore(dbPath);
  const log: string[] = [];
  try {
    const experiment = store.createExperiment(input.name, Object.keys(input.streams));
    const cursors: Record<string, number> = {};
    for (const arm of Object.keys(input.streams)) cursors[arm] = 0;

    log.push(`实验 ${experiment.id}（${input.name}），臂: ${experiment.arms.join(", ")}，共 ${input.rounds} 轮`);
    for (let round = 1; round <= input.rounds; round++) {
      const { decision } = store.requestSuggestion(experiment.id);
      const arm = decision.chosenArm;
      const stream = input.streams[arm];
      if (!stream) throw new Error(`演示输入缺少臂 "${arm}" 的奖励流`);
      const reward = stream[cursors[arm] % stream.length];
      cursors[arm] += 1; // 只有被选中的臂才消耗序列
      store.submitFeedback(experiment.id, decision.id, reward);
      const stats = store.getStats(experiment.id);
      const summary = stats.arms
        .map((a) => `${a.armId}: n=${a.n} mean=${a.mean === null ? "-" : a.mean.toFixed(3)}`)
        .join("  ");
      log.push(`第 ${String(round).padStart(2)} 轮 -> 选 ${arm}，奖励 ${reward.toFixed(2)} | ${summary}`);
    }
    const report = store.replay(experiment.id);
    log.push(`回放检查: ${report.ok ? "通过" : "失败"}（核对 ${report.checked} 个事件）`);
    const finalStats = store.getStats(experiment.id);
    log.push(
      "最终统计: " +
        finalStats.arms
          .map((a) => `${a.armId}(n=${a.n}, mean=${a.mean === null ? "-" : a.mean.toFixed(3)})`)
          .join(", ") +
        "。注意：有限轮结果不能证明某臂绝对更好。",
    );
  } finally {
    store.close();
  }
  return { log, inputPath };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const inputArg = args.find((a) => a.startsWith("--input="));
  const dbArg = args.find((a) => a.startsWith("--db="));
  const input = inputArg
    ? (JSON.parse(fs.readFileSync(inputArg.slice("--input=".length), "utf8")) as DemoInput)
    : defaultDemoInput();
  const dbPath = dbArg ? dbArg.slice("--db=".length) : path.join(defaultDataDir(), `demo-${Date.now()}.db`);
  const { log, inputPath } = runDemo(input, dbPath);
  for (const line of log) console.log(line);
  console.log(`演示输入已保存: ${inputPath}（可用 --input=<该文件> 复现）`);
}
