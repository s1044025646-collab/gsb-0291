import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb } from "../src/db";
import { BanditService, ServiceError } from "../src/service";
import { accumulate, chooseArm } from "../src/ucb1";

function memService(): BanditService {
  return new BanditService(openDb(":memory:"));
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ServiceError, `期望 ServiceError,实际 ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`期望抛出 ${code},但未抛错`);
}

test("初始阶段每臂恰好各尝试一次,按编号顺序", () => {
  const svc = memService();
  const exp = svc.createExperiment("t", ["c", "a", "b"]);
  assert.deepEqual(exp.arms, ["a", "b", "c"]);
  const picked: string[] = [];
  for (let i = 0; i < 3; i++) {
    const s = svc.suggest(exp.id);
    picked.push(s.armId);
    svc.submitReward(s.decisionId, 0.5);
  }
  assert.deepEqual(picked, ["a", "b", "c"]);
});

test("分数相同时按编号较小者获胜", () => {
  const arms = ["a", "b"];
  const { counts, sums } = accumulate(arms, [
    { armId: "a", reward: 0.5 },
    { armId: "b", reward: 0.5 },
  ]);
  const choice = chooseArm(arms, counts, sums, 2);
  assert.equal(choice.armId, "a");
});

test("次数较少的臂探索项更大", () => {
  const arms = ["a", "b"];
  const { counts, sums } = accumulate(arms, [
    { armId: "a", reward: 1 },
    { armId: "a", reward: 1 },
    { armId: "a", reward: 1 },
    { armId: "b", reward: 1 },
  ]);
  const choice = chooseArm(arms, counts, sums, 4);
  const a = choice.stats.find((s) => s.armId === "a")!;
  const b = choice.stats.find((s) => s.armId === "b")!;
  assert.ok(b.exploration > a.exploration);
});

test("均值随奖励 0 和 1 正确更新", () => {
  const svc = memService();
  const exp = svc.createExperiment("t", ["x"]);
  for (const r of [1, 0, 1, 0]) {
    const s = svc.suggest(exp.id);
    svc.submitReward(s.decisionId, r);
  }
  const st = svc.stats(exp.id);
  assert.equal(st.t, 4);
  assert.equal(st.stats[0].n, 4);
  assert.ok(Math.abs(st.stats[0].mean - 0.5) < 1e-12);
});

test("t 只随有效反馈增加,建议不改变统计", () => {
  const svc = memService();
  const exp = svc.createExperiment("t", ["a", "b"]);
  svc.suggest(exp.id);
  svc.suggest(exp.id);
  assert.equal(svc.stats(exp.id).t, 0);
  const s = svc.suggest(exp.id);
  svc.submitReward(s.decisionId, 1);
  assert.equal(svc.stats(exp.id).t, 1);
});

test("手算短序列核对分数与选择", () => {
  const svc = memService();
  const exp = svc.createExperiment("t", ["a", "b"]);
  // 第1、2轮:初始化,各试一次
  let s = svc.suggest(exp.id);
  assert.equal(s.armId, "a");
  svc.submitReward(s.decisionId, 1);
  s = svc.suggest(exp.id);
  assert.equal(s.armId, "b");
  svc.submitReward(s.decisionId, 0);
  // 第3轮: t=2, a: 1+sqrt(2ln2/1)≈2.1776, b: 0+sqrt(2ln2/1)≈1.1776 -> a
  s = svc.suggest(exp.id);
  assert.equal(s.armId, "a");
  const aStat = s.stats.find((x) => x.armId === "a")!;
  assert.ok(Math.abs(aStat.score - (1 + Math.sqrt(2 * Math.log(2)))) < 1e-9);
  svc.submitReward(s.decisionId, 1);
  // 第4轮: t=3, a: 1+sqrt(2ln3/2)≈2.0482, b: 0+sqrt(2ln3/1)≈1.4822 -> a
  s = svc.suggest(exp.id);
  assert.equal(s.armId, "a");
  svc.submitReward(s.decisionId, 0);
  // 第5轮: t=4, a: 2/3+sqrt(2ln4/3)≈1.6275, b: 0+sqrt(2ln4/1)≈1.6651 -> b
  s = svc.suggest(exp.id);
  assert.equal(s.armId, "b");
  const bStat = s.stats.find((x) => x.armId === "b")!;
  assert.ok(Math.abs(bStat.score - Math.sqrt(2 * Math.log(4))) < 1e-9);
});

test("给未选择臂补充未来奖励不会改变已有决策记录", () => {
  const svc = memService();
  const exp = svc.createExperiment("t", ["a", "b"]);
  const s1 = svc.suggest(exp.id);
  svc.submitReward(s1.decisionId, 1);
  const s2 = svc.suggest(exp.id);
  svc.submitReward(s2.decisionId, 0);
  const before = svc.explain(s1.decisionId);
  // 继续多轮,只影响之后的决策
  for (let i = 0; i < 5; i++) {
    const s = svc.suggest(exp.id);
    svc.submitReward(s.decisionId, 1);
  }
  const after = svc.explain(s1.decisionId);
  assert.deepEqual(after, before);
});

test("非法奖励、重复反馈、未知决策被拒绝", () => {
  const svc = memService();
  const exp = svc.createExperiment("t", ["a"]);
  const s = svc.suggest(exp.id);
  for (const bad of [-0.1, 1.1, NaN, Infinity, "0.5", null]) {
    expectCode(() => svc.submitReward(s.decisionId, bad), "INVALID_REWARD");
  }
  expectCode(() => svc.submitReward(99999, 0.5), "DECISION_NOT_FOUND");
  svc.submitReward(s.decisionId, 0.5);
  expectCode(() => svc.submitReward(s.decisionId, 0.5), "DECISION_NOT_PENDING");
  assert.equal(svc.stats(exp.id).t, 1); // 未二次累计
});

test("未决请求重复读取返回同一个决策", () => {
  const svc = memService();
  const exp = svc.createExperiment("t", ["a", "b"]);
  const s1 = svc.suggest(exp.id);
  const s2 = svc.suggest(exp.id);
  assert.equal(s1.decisionId, s2.decisionId);
  assert.equal(s2.reused, true);
  assert.equal(svc.stats(exp.id).t, 0);
});

test("进程重启后待反馈决策可继续", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucb1-"));
  const dbPath = path.join(dir, "test.db");
  const db1 = openDb(dbPath);
  const svc1 = new BanditService(db1);
  const exp = svc1.createExperiment("t", ["a", "b"]);
  const s1 = svc1.suggest(exp.id);
  db1.close();
  // 模拟重启:重新打开同一个数据库文件
  const db2 = openDb(dbPath);
  const svc2 = new BanditService(db2);
  const s2 = svc2.suggest(exp.id);
  assert.equal(s2.decisionId, s1.decisionId);
  assert.equal(s2.armId, s1.armId);
  svc2.submitReward(s1.decisionId, 0.8);
  assert.equal(svc2.stats(exp.id).t, 1);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("独立实验之间不串数据", () => {
  const svc = memService();
  const e1 = svc.createExperiment("e1", ["a"]);
  const e2 = svc.createExperiment("e2", ["a"]);
  const s1 = svc.suggest(e1.id);
  svc.submitReward(s1.decisionId, 1);
  assert.equal(svc.stats(e1.id).t, 1);
  assert.equal(svc.stats(e2.id).t, 0);
});

test("回放与在线统计一致", () => {
  const svc = memService();
  const exp = svc.createExperiment("t", ["a", "b", "c"]);
  const rewards = [0.2, 0.9, 0.4, 0.8, 0.1, 0.7, 0.3, 0.6, 0.5, 0.9];
  for (const r of rewards) {
    const s = svc.suggest(exp.id);
    svc.submitReward(s.decisionId, r);
  }
  const replay = svc.replay(exp.id);
  assert.equal(replay.ok, true);
  assert.equal(replay.checked, 10);
  const online = svc.stats(exp.id);
  assert.deepEqual(replay.finalStats, online.stats);
});

test("回放能发现被篡改的事件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucb1-"));
  const dbPath = path.join(dir, "test.db");
  const db = openDb(dbPath);
  const svc = new BanditService(db);
  const exp = svc.createExperiment("t", ["a", "b"]);
  for (const r of [1, 0, 1]) {
    const s = svc.suggest(exp.id);
    svc.submitReward(s.decisionId, r);
  }
  db.prepare("UPDATE decisions SET arm_id = 'b' WHERE seq = 3").run();
  const replay = svc.replay(exp.id);
  assert.equal(replay.ok, false);
  assert.ok(replay.errors.some((e) => e.seq === 3 && e.message.includes("选中臂不一致")));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("臂编号重复或为空被拒绝", () => {
  const svc = memService();
  expectCode(() => svc.createExperiment("t", ["a", "a"]), "INVALID_ARMS");
  expectCode(() => svc.createExperiment("t", []), "INVALID_ARMS");
  expectCode(() => svc.createExperiment("t", ["a", ""]), "INVALID_ARMS");
});
