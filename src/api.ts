import * as http from "node:http";
import { openDb, DEFAULT_DB_PATH } from "./db";
import { BanditService, ServiceError } from "./service";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

export function createServer(dbPath: string = DEFAULT_DB_PATH): http.Server {
  const service = new BanditService(openDb(dbPath));
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const bodyText = method === "POST" ? await readBody(req) : "";
      let body: Record<string, unknown> = {};
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          throw new ServiceError("BAD_REQUEST", "请求体必须是合法 JSON。");
        }
      }

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/experiments") {
        return send(res, 201, service.createExperiment(body.name as string | undefined, body.arms));
      }
      if (parts[0] === "experiments" && parts.length >= 2) {
        const id = parts[1];
        if (method === "POST" && parts[2] === "suggest" && parts.length === 3) {
          return send(res, 200, service.suggest(id));
        }
        if (method === "GET" && parts[2] === "stats" && parts.length === 3) {
          return send(res, 200, service.stats(id));
        }
        if (method === "GET" && parts[2] === "export" && parts.length === 3) {
          return send(res, 200, service.exportEvents(id));
        }
        if (method === "POST" && parts[2] === "replay" && parts.length === 3) {
          return send(res, 200, service.replay(id));
        }
      }
      if (parts[0] === "decisions" && parts.length === 3) {
        const decisionId = Number(parts[1]);
        if (!Number.isInteger(decisionId)) {
          throw new ServiceError("BAD_REQUEST", "决策编号必须是整数。");
        }
        if (method === "POST" && parts[2] === "feedback") {
          return send(res, 200, service.submitReward(decisionId, body.reward));
        }
        if (method === "GET" && parts[2] === "explain") {
          return send(res, 200, service.explain(decisionId));
        }
      }
      throw new ServiceError("BAD_REQUEST", `未知路由:${method} ${url.pathname}`, 404);
    } catch (err) {
      if (err instanceof ServiceError) {
        return send(res, err.status, { error: { code: err.code, message: err.message } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}

if (require.main === module) {
  const portEnv = process.env.PORT;
  const port = portEnv ? Number(portEnv) : 0; // 默认选择空闲端口
  const server = createServer(process.env.DB_PATH);
  server.listen(port, () => {
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    console.log(`UCB1 服务已启动: http://127.0.0.1:${actual}`);
  });
}
