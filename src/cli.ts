import { BanditStore, defaultDbPath } from "./store";
import { toErrorBody } from "./errors";

function argValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const USAGE = `UCB1 多臂老虎机本地实验 CLI

用法: node dist/src/cli.js <命令> [参数]   （可用 --db=<路径> 指定数据库，默认 data/ucb1.db）

命令:
  create   --name=<名称> --arms=a,b,c          创建实验（臂编号唯一，创建后不可变）
  list                                        列出全部实验
  suggest  --exp=<实验ID>                      请求下一轮建议（有未反馈决策时返回同一个）
  feedback --exp=<实验ID> --decision=<决策ID> --reward=<0..1>
                                              提交实际观察到的奖励
  stats    --exp=<实验ID>                      查看当前统计（次数/均值/探索项/分数）
  explain  --exp=<实验ID> --decision=<决策ID>   解释某次历史决策
  export   --exp=<实验ID> [--out=<文件>]        导出全部事件
  replay   --exp=<实验ID>                      从空统计回放并核对每个决策
`;

export function runCli(argv: string[]): number {
  const [command, ...rest] = argv;
  const dbPath = argValue(rest, "db") ?? defaultDbPath();
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  const store = new BanditStore(dbPath);
  try {
    switch (command) {
      case "create": {
        const name = argValue(rest, "name") ?? "";
        const arms = (argValue(rest, "arms") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        printJson({ experiment: store.createExperiment(name, arms) });
        return 0;
      }
      case "list": {
        printJson({ experiments: store.listExperiments() });
        return 0;
      }
      case "suggest": {
        const exp = argValue(rest, "exp") ?? "";
        printJson(store.requestSuggestion(exp));
        return 0;
      }
      case "feedback": {
        const exp = argValue(rest, "exp") ?? "";
        const decision = argValue(rest, "decision") ?? "";
        const rewardRaw = argValue(rest, "reward");
        const reward = rewardRaw === undefined ? undefined : Number(rewardRaw);
        printJson({ decision: store.submitFeedback(exp, decision, reward) });
        return 0;
      }
      case "stats": {
        printJson({ stats: store.getStats(argValue(rest, "exp") ?? "") });
        return 0;
      }
      case "explain": {
        printJson({ decision: store.getDecision(argValue(rest, "exp") ?? "", argValue(rest, "decision") ?? "") });
        return 0;
      }
      case "export": {
        const data = store.exportEvents(argValue(rest, "exp") ?? "");
        const out = argValue(rest, "out");
        if (out) {
          require("node:fs").writeFileSync(out, JSON.stringify(data, null, 2), "utf8");
          console.log(`已导出 ${data.events.length} 个事件到 ${out}`);
        } else {
          printJson(data);
        }
        return 0;
      }
      case "replay": {
        const report = store.replay(argValue(rest, "exp") ?? "");
        printJson({ report });
        return report.ok ? 0 : 2;
      }
      default:
        console.error(`未知命令: ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    const { body } = toErrorBody(err);
    console.error(`错误 [${body.error.code}] ${body.error.message}`);
    return 1;
  } finally {
    store.close();
  }
}

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
