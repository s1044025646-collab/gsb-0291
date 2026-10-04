import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BanditStore } from "../src/store";
import { ApiError } from "../src/errors";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucb1-test-"));
  return path.join(dir, "test.db");
}

function expectApiError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `期望 ApiError，实际: ${String(err)}`);
    assert.equal((err as ApiError).code, code);
    return;
  }
  assert.fail(`期望抛出 ${code}，但未抛错`);
}

test("t 只随有效反馈增加，请求建议不改变统计", () => {
  const store = new BanditStore(tempDb());
  const exp = store.createExperiment("t-test", ["a", "b"]);
  const s1 = store.requestSuggestion(exp.id);
  const s2 = store.requestSuggestion(exp.id);
  assert.equal(s2.reused, true);
  assert.equal(s2.decision.id, s1.decision.id);
  let stats = store.getStats(exp.id);
  assert.equal(stats.t, 0);
  assert.equal(stats.arms.every((a) => a.n === 0), true);
  store.submitFeedback(exp.id, s1.decision.id, 1);
  stats = store.getStats(exp.id);
  assert.equal(stats.t, 1);
  store.close();
});

test("非法奖励被拒绝：负数、大于 1、NaN、非数值", () => {
  const store = new BanditStore(tempDb());
  const exp = store.createExperiment("bad-reward", ["a"]);
  const { decision } = store.requestSuggestion(exp.id);
  for (const bad of [-0.1, 1.01, NaN, Infinity, "0.5", null, undefined]) {
    expectApiError(() => store.submitFeedback(exp.id, decision.id, bad), "INVALID_REWARD");
  }
  // 决策仍处于待反馈状态，统计未变
  assert.equal(store.getStats(exp.id).t, 0);
  store.submitFeedback(exp.id, decision.id, 0.5);
  assert.equal(store.getStats(exp.id).t, 1);
  store.close();
});

test("重复反馈与过期决策编号被明确拒绝，不二次累计", () => {
  const store = new BanditStore(tempDb());
  const exp = store.createExperiment("dup", ["a", "b"]);
  const { decision } = store.requestSuggestion(exp.id);
  store.submitFeedback(exp.id, decision.id, 0.8);
  expectApiError(() => store.submitFeedback(exp.id, decision.id, 0.8), "DUPLICATE_FEEDBACK");
  expectApiError(() => store.submitFeedback(exp.id, decision.id, 0.1), "DUPLICATE_FEEDBACK");
  expectApiError(() => store.submitFeedback(exp.id, "no-such-id", 0.5), "DECISION_NOT_FOUND");
  assert.equal(store.getStats(exp.id).t, 1);
  store.close();
});

test("进程重启后待反馈决策仍可继续，不默认奖励零也不跳臂", () => {
  const dbPath = tempDb();
  let store = new BanditStore(dbPath);
  const exp = store.createExperiment("restart", ["a", "b"]);
  const { decision } = store.requestSuggestion(exp.id);
  store.close();

  store = new BanditStore(dbPath);
  const again = store.requestSuggestion(exp.id);
  assert.equal(again.reused, true);
  assert.equal(again.decision.id, decision.id);
  assert.equal(again.decision.chosenArm, decision.chosenArm);
  assert.equal(store.getStats(exp.id).t, 0);
  store.submitFeedback(exp.id, decision.id, 0.6);
  assert.equal(store.getStats(exp.id).t, 1);
  store.close();
});

test("独立实验之间不串数据", () => {
  const store = new BanditStore(tempDb());
  const expA = store.createExperiment("A", ["x", "y"]);
  const expB = store.createExperiment("B", ["x", "y"]);
  const s = store.requestSuggestion(expA.id);
  store.submitFeedback(expA.id, s.decision.id, 1);
  assert.equal(store.getStats(expA.id).t, 1);
  assert.equal(store.getStats(expB.id).t, 0);
  // B 的待反馈决策不受 A 影响
  const sB = store.requestSuggestion(expB.id);
  assert.equal(sB.decision.chosenArm, "x");
  // A 的决策编号不能用于 B
  expectApiError(() => store.submitFeedback(expB.id, s.decision.id, 0.5), "DECISION_NOT_FOUND");
  store.close();
});

test("回放与在线统计一致，且能发现被篡改的事件", () => {
  const store = new BanditStore(tempDb());
  const exp = store.createExperiment("replay", ["a", "b"]);
  const rewards = [1, 0, 0, 1, 0.5, 0.2, 0.9, 0.1];
  for (const reward of rewards) {
    const { decision } = store.requestSuggestion(exp.id);
    store.submitFeedback(exp.id, decision.id, reward);
  }
  const report = store.replay(exp.id);
  assert.equal(report.ok, true);
  assert.equal(report.checked, rewards.length);
  assert.deepEqual(report.finalStats.arms, store.getStats(exp.id).arms);
  store.close();

  // 直接改库制造不一致：回放必须报告具体事件
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const dbPath = (store as unknown as { dbPath: string }).dbPath;
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE decisions SET chosen_arm = 'b' WHERE seq = 1").run();
  db.close();
  const store2 = new BanditStore(dbPath);
  const bad = store2.replay(exp.id);
  assert.equal(bad.ok, false);
  assert.equal(bad.mismatches[0].seq, 1);
  store2.close();
});

test("臂编号重复或为空被拒绝", () => {
  const store = new BanditStore(tempDb());
  expectApiError(() => store.createExperiment("bad", ["a", "a"]), "INVALID_ARGUMENT");
  expectApiError(() => store.createExperiment("bad", []), "INVALID_ARGUMENT");
  expectApiError(() => store.createExperiment("", ["a"]), "INVALID_ARGUMENT");
  store.close();
});
