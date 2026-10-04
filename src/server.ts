import * as http from "node:http";
import { AddressInfo } from "node:net";
import { BanditStore, defaultDbPath } from "./store";
import { toErrorBody } from "./errors";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: BanditStore): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body, null, 2);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/health") {
        return send(200, { ok: true });
      }
      if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "experiments") {
        return send(200, { experiments: store.listExperiments() });
      }
      if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "experiments") {
        const body = (await readBody(req)) as { name?: string; arms?: string[] };
        const experiment = store.createExperiment(String(body.name ?? ""), body.arms as string[]);
        return send(201, { experiment });
      }
      if (parts.length >= 3 && parts[0] === "api" && parts[1] === "experiments") {
        const experimentId = decodeURIComponent(parts[2]);
        const action = parts[3];
        if (method === "GET" && parts.length === 3) {
          return send(200, { experiment: store.getExperiment(experimentId) });
        }
        if (method === "POST" && action === "suggestions" && parts.length === 4) {
          const { decision, reused } = store.requestSuggestion(experimentId);
          return send(reused ? 200 : 201, { decision, reused });
        }
        if (method === "POST" && action === "feedback" && parts.length === 4) {
          const body = (await readBody(req)) as { decisionId?: string; reward?: number };
          if (typeof body.decisionId !== "string") {
            return send(400, { error: { code: "INVALID_ARGUMENT", message: "decisionId 必须是字符串" } });
          }
          const decision = store.submitFeedback(experimentId, body.decisionId, body.reward);
          return send(200, { decision });
        }
        if (method === "GET" && action === "stats" && parts.length === 4) {
          return send(200, { stats: store.getStats(experimentId) });
        }
        if (method === "GET" && action === "decisions" && parts.length === 5) {
          const decision = store.getDecision(experimentId, decodeURIComponent(parts[4]));
          return send(200, { decision });
        }
        if (method === "GET" && action === "export" && parts.length === 4) {
          return send(200, store.exportEvents(experimentId));
        }
        if (method === "POST" && action === "replay" && parts.length === 4) {
          return send(200, { report: store.replay(experimentId) });
        }
      }
      return send(404, { error: { code: "NOT_FOUND", message: `未匹配的路由: ${method} ${url.pathname}` } });
    } catch (err) {
      const { status, body } = toErrorBody(err);
      return send(status, body);
    }
  });
}

export function startServer(options: { port?: number; dbPath?: string } = {}): {
  server: http.Server;
  store: BanditStore;
  ready: Promise<number>;
} {
  const store = new BanditStore(options.dbPath ?? defaultDbPath());
  const server = createServer(store);
  const ready = new Promise<number>((resolve) => {
    // 默认端口 0：由操作系统分配空闲端口
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return { server, store, ready };
}

if (require.main === module) {
  const portArg = process.env.PORT ?? process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
  const port = portArg !== undefined ? Number(portArg) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`非法端口: ${portArg}`);
    process.exit(1);
  }
  const { ready } = startServer({ port });
  ready.then((actualPort) => {
    console.log(`UCB1 服务已启动: http://127.0.0.1:${actualPort} (数据库: ${defaultDbPath()})`);
  });
}
