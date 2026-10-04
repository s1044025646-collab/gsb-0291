import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AddressInfo } from "node:net";
import { createServer } from "../src/server";
import { BanditStore } from "../src/store";
import type { Server } from "node:http";

let server: Server;
let store: BanditStore;
let base: string;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucb1-http-"));
  store = new BanditStore(path.join(dir, "http.db"));
  server = createServer(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  store.close();
});

async function api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + urlPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("HTTP：创建实验 -> 建议 -> 反馈 -> 统计 -> 解释 -> 导出 -> 回放", async () => {
  const created = await api("POST", "/api/experiments", { name: "http-exp", arms: ["a", "b"] });
  assert.equal(created.status, 201);
  const expId = created.json.experiment.id as string;

  const s1 = await api("POST", `/api/experiments/${expId}/suggestions`);
  assert.equal(s1.status, 201);
  const s2 = await api("POST", `/api/experiments/${expId}/suggestions`);
  assert.equal(s2.status, 200);
  assert.equal(s2.json.decision.id, s1.json.decision.id);

  const fb = await api("POST", `/api/experiments/${expId}/feedback`, {
    decisionId: s1.json.decision.id,
    reward: 0.7,
  });
  assert.equal(fb.status, 200);
  assert.equal(fb.json.decision.status, "confirmed");

  const dup = await api("POST", `/api/experiments/${expId}/feedback`, {
    decisionId: s1.json.decision.id,
    reward: 0.1,
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "DUPLICATE_FEEDBACK");

  const bad = await api("POST", `/api/experiments/${expId}/feedback`, {
    decisionId: s1.json.decision.id,
    reward: 2,
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "INVALID_REWARD");

  const stats = await api("GET", `/api/experiments/${expId}/stats`);
  assert.equal(stats.json.stats.t, 1);

  const explain = await api("GET", `/api/experiments/${expId}/decisions/${s1.json.decision.id}`);
  assert.equal(explain.json.decision.reason.includes("尚未被观察"), true);

  const exported = await api("GET", `/api/experiments/${expId}/export`);
  assert.equal(exported.json.events.length, 1);

  const replay = await api("POST", `/api/experiments/${expId}/replay`);
  assert.equal(replay.json.report.ok, true);

  const missing = await api("GET", "/api/experiments/nope/stats");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "EXPERIMENT_NOT_FOUND");
});
