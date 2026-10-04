import { openDb, DEFAULT_DB_PATH } from "./db";
import { BanditService, ServiceError } from "./service";
import { runDemo } from "./demo";
import { createServer } from "./api";

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const USAGE = `用法: node dist/src/cli.js <命令> [参数]

命令:
  serve [--port N]                 启动 HTTP API(默认端口 0,即自动选空闲端口)
  create --arms A,B,C [--name X]   创建实验
  suggest --exp <id>               请求建议(有未决决策时返回同一个)
  feedback --decision <id> --reward <0..1>  提交奖励
  stats --exp <id>                 查看当前统计
  explain --decision <id>          解释历史决策
  export --exp <id>                导出事件
  replay --exp <id>                回放检查
  demo                             运行离线演示(固定奖励流)

环境变量: DB_PATH 指定数据库文件(默认 ./data/ucb1.db), PORT 指定端口。`;

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;

  if (cmd === "serve") {
    const port = Number(argValue(args, "--port") ?? process.env.PORT ?? 0);
    const server = createServer(dbPath);
    server.listen(port, () => {
      const addr = server.address();
      console.log(`UCB1 服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
    });
    return;
  }

  const service = new BanditService(openDb(dbPath));
  try {
    switch (cmd) {
      case "create": {
        const armsRaw = argValue(args, "--arms");
        if (!armsRaw) throw new ServiceError("BAD_REQUEST", "缺少 --arms A,B,C");
        print(service.createExperiment(argValue(args, "--name"), armsRaw.split(",").map((s) => s.trim())));
        break;
      }
      case "suggest":
        print(service.suggest(required(args, "--exp")));
        break;
      case "feedback": {
        const id = Number(required(args, "--decision"));
        const reward = Number(required(args, "--reward"));
        print(service.submitReward(id, reward));
        break;
      }
      case "stats":
        print(service.stats(required(args, "--exp")));
        break;
      case "explain":
        print(service.explain(Number(required(args, "--decision"))));
        break;
      case "export":
        print(service.exportEvents(required(args, "--exp")));
        break;
      case "replay":
        print(service.replay(required(args, "--exp")));
        break;
      case "demo":
        runDemo(service);
        break;
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ServiceError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

function required(args: string[], flag: string): string {
  const v = argValue(args, flag);
  if (v === undefined) throw new ServiceError("BAD_REQUEST", `缺少参数 ${flag}`);
  return v;
}

main();
