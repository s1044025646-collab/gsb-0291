import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDemo, defaultDemoInput } from "../src/demo";
import { BanditStore } from "../src/store";

test("演示：两条均值不同的固定奖励流，仍会探索较少选择的臂", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucb1-demo-"));
  const dbPath = path.join(dir, "demo.db");
  const input = defaultDemoInput();
  const { log, inputPath } = runDemo(input, dbPath);
  assert.ok(fs.existsSync(inputPath), "演示输入应保存到数据目录");

  // 从日志中统计每个臂被选次数
  const counts: Record<string, number> = { alpha: 0, beta: 0 };
  for (const line of log) {
    const m = line.match(/-> 选 (\w+)/);
    if (m) counts[m[1]] += 1;
  }
  assert.ok(counts.alpha > counts.beta, `优势臂应被更多选择: ${JSON.stringify(counts)}`);
  assert.ok(counts.beta >= 2, `劣势臂仍应被探索: ${JSON.stringify(counts)}`);
  assert.ok(log.some((l) => l.includes("回放检查: 通过")));

  // 未选择的臂不消耗序列：beta 被消耗的次数等于其被选次数
  const store = new BanditStore(dbPath);
  const exp = store.listExperiments()[0];
  const stats = store.getStats(exp.id);
  const beta = stats.arms.find((a) => a.armId === "beta")!;
  assert.equal(beta.n, counts.beta);
  store.close();
});
