import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, explorationBonus } from "../src/ucb1";

test("初始阶段：每个臂按编号顺序恰好各尝试一次", () => {
  const arms = ["b", "a", "c"]; // 声明顺序无关，内部按固定规则排序
  const obs: { armId: string; reward: number }[] = [];
  const chosen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const table = decide(arms, obs);
    chosen.push(table.chosenArmId);
    obs.push({ armId: table.chosenArmId, reward: 0.5 });
  }
  assert.deepEqual(chosen, ["a", "b", "c"]);
});

test("平局规则固定：分数相同按编号升序取先", () => {
  // 两臂各观察一次且均值相同 => 分数相同，选编号较小者
  const table = decide(["b", "a"], [
    { armId: "a", reward: 0.5 },
    { armId: "b", reward: 0.5 },
  ]);
  assert.equal(table.chosenArmId, "a");
});

test("次数较少的臂得到更大的探索项", () => {
  const obs = [
    { armId: "a", reward: 0.5 },
    { armId: "a", reward: 0.5 },
    { armId: "a", reward: 0.5 },
    { armId: "b", reward: 0.5 },
  ];
  const table = decide(["a", "b"], obs);
  const a = table.arms.find((x) => x.armId === "a")!;
  const b = table.arms.find((x) => x.armId === "b")!;
  assert.ok(b.bonus! > a.bonus!, `b.bonus=${b.bonus} 应大于 a.bonus=${a.bonus}`);
  assert.equal(b.bonus, explorationBonus(4, 1));
});

test("均值随 0 和 1 正确更新", () => {
  const obs = [
    { armId: "a", reward: 1 },
    { armId: "a", reward: 0 },
    { armId: "b", reward: 1 },
  ];
  const table = decide(["a", "b"], obs);
  const a = table.arms.find((x) => x.armId === "a")!;
  assert.equal(a.n, 2);
  assert.ok(Math.abs(a.mean! - 0.5) < 1e-12);
});

test("手算短序列核对分数与选择", () => {
  // 两臂 a、b；奖励序列：a=1, b=0, 然后验证第 3、4 轮
  const obs = [
    { armId: "a", reward: 1 },
    { armId: "b", reward: 0 },
  ];
  // t=2: a: mean=1, bonus=sqrt(2 ln2 /1)=1.17741, score=2.17741
  //      b: mean=0, bonus=1.17741, score=1.17741 => 选 a
  let table = decide(["a", "b"], obs);
  assert.equal(table.t, 2);
  assert.ok(Math.abs(table.arms[0].score! - (1 + Math.sqrt(2 * Math.log(2)))) < 1e-9);
  assert.equal(table.chosenArmId, "a");

  // 第 3 轮 a 得 0：obs 变为 a:[1,0], b:[0]，t=3
  // a: mean=0.5, bonus=sqrt(2 ln3 /2)=1.04828, score=1.54828
  // b: mean=0,   bonus=sqrt(2 ln3 /1)=1.48160, score=1.48160 => 仍选 a
  obs.push({ armId: "a", reward: 0 });
  table = decide(["a", "b"], obs);
  assert.equal(table.t, 3);
  const a = table.arms.find((x) => x.armId === "a")!;
  const b = table.arms.find((x) => x.armId === "b")!;
  assert.ok(Math.abs(a.score! - (0.5 + Math.sqrt(Math.log(3)))) < 1e-9);
  assert.ok(Math.abs(b.score! - Math.sqrt(2 * Math.log(3))) < 1e-9);
  assert.equal(table.chosenArmId, "a");

  // 第 4 轮 a 再得 0：a:[1,0,0] mean=1/3 bonus=sqrt(2 ln4/3)=0.96180 score=1.29513
  // b: mean=0 bonus=sqrt(2 ln4/1)=1.66511 score=1.66511 => 探索项推动选 b
  obs.push({ armId: "a", reward: 0 });
  table = decide(["a", "b"], obs);
  assert.equal(table.chosenArmId, "b");
});

test("给未选择的臂补充未来奖励不改变已有决策（快照不可变）", () => {
  const before = decide(["a", "b"], [
    { armId: "a", reward: 1 },
    { armId: "b", reward: 0 },
  ]);
  // 之后的观察（含 b 的高奖励）不影响 before 快照
  const after = decide(["a", "b"], [
    { armId: "a", reward: 1 },
    { armId: "b", reward: 0 },
    { armId: "b", reward: 1 },
    { armId: "b", reward: 1 },
  ]);
  assert.equal(before.chosenArmId, "a");
  assert.deepEqual(before.arms, decide(["a", "b"], [
    { armId: "a", reward: 1 },
    { armId: "b", reward: 0 },
  ]).arms);
  assert.notDeepEqual(after.arms, before.arms);
});
