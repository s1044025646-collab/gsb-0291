# UCB1 多臂老虎机本地实验后端

一个纯本地的顺序决策实验服务：你声明若干候选臂，每轮取得一个选择建议，再提交实际观察到的奖励，服务用 UCB1 算法在“探索”与“利用”之间做权衡。仅提供 HTTP API 与 CLI，无界面；不连接广告、交易或真实用户系统。

技术栈：TypeScript + Node.js（内置 `node:http` 与 `node:sqlite`，零运行时依赖），Windows 本地直接运行，不需要 Docker / WSL / 外部服务。要求 Node.js ≥ 22.5（`node:sqlite` 目前为实验特性，启动时会有 ExperimentalWarning，属正常）。

## 快速开始

```powershell
npm install        # 安装 TypeScript 等开发依赖
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # 运行离线演示（两条固定奖励流）
```

端口配置：`npm start -- --port=8080` 或设置环境变量 `PORT`；不传则端口为 0，由操作系统分配空闲端口，启动日志会打印实际端口。

数据目录：默认 `<项目目录>/data/`，可用环境变量 `UCB1_DATA_DIR` 或 `UCB1_DB_PATH` 覆盖。

## 核心规则

- 臂编号唯一，排序规则固定（字典序升序）；实验创建后臂集合不可变。
- 尚未观察过的臂按编号顺序依次优先选择。
- 所有臂至少观察一次后：`score = mean + sqrt(2 * ln(t) / n)`，其中 `t` 是全部已接受奖励数、`n` 是该臂已接受奖励数；分数相同时按编号升序取先。
- `t` 只随有效反馈增加：请求建议、非法奖励、被拒绝的反馈都不会改变统计。
- 每个实验最多一个待反馈决策：重复请求建议返回同一个决策编号；提交匹配奖励后才进入下一轮。
- 决策创建与反馈确认各自在单个 SQLite 事务内完成；进程重启后待反馈决策原样保留，可继续提交奖励，不会默认为奖励零，也不会跳到其他臂。
- 决策只使用当时已确认的奖励，不读取未来奖励，也不使用任何模拟环境的“真实均值”。

## “建议”与“已观察结果”的区别

**建议**是基于当前已确认奖励算出的下一步尝试对象，本身不是结论；**已观察结果**是你提交并被接受的奖励，只有它才进入统计。未收到奖励的建议不会改变任何计数或均值。由于轮数有限且探索项持续存在，**有限轮输出不能证明某臂绝对更好**，本服务也不提供统计显著性结论，不承诺找到最佳方案。

## HTTP API

所有响应为 JSON；错误统一为 `{ "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/experiments` | 创建实验，body: `{"name": "...", "arms": ["a","b"]}` |
| GET | `/api/experiments` | 列出实验 |
| GET | `/api/experiments/:id` | 实验详情 |
| POST | `/api/experiments/:id/suggestions` | 请求建议；已有待反馈决策时返回同一个（`reused: true`） |
| POST | `/api/experiments/:id/feedback` | 提交奖励，body: `{"decisionId": "...", "reward": 0.0~1.0}` |
| GET | `/api/experiments/:id/stats` | 当前统计：每臂次数、均值、探索项、分数 |
| GET | `/api/experiments/:id/decisions/:decisionId` | 解释历史决策（当时快照与选择理由） |
| GET | `/api/experiments/:id/export` | 导出全部事件 |
| POST | `/api/experiments/:id/replay` | 回放检查：从空统计顺序重建并逐项核对 |

错误码：`INVALID_ARGUMENT`（参数缺失/臂重复）、`INVALID_REWARD`（奖励非 [0,1] 有限数）、`EXPERIMENT_NOT_FOUND`、`DECISION_NOT_FOUND`（过期或不属于本实验的决策编号）、`DUPLICATE_FEEDBACK`（重复反馈，HTTP 409，不会二次累计）。

## CLI

```powershell
npm run cli -- create   --name=demo --arms=a,b,c
npm run cli -- suggest  --exp=<实验ID>
npm run cli -- feedback --exp=<实验ID> --decision=<决策ID> --reward=0.7
npm run cli -- stats    --exp=<实验ID>
npm run cli -- explain  --exp=<实验ID> --decision=<决策ID>
npm run cli -- export   --exp=<实验ID> --out=events.json
npm run cli -- replay   --exp=<实验ID>
```

所有命令支持 `--db=<路径>` 指定数据库文件。

## 回放检查

回放从空统计开始，按事件顺序重建：对每个决策核对当时的 `t`、可用数据、选中臂以及每臂的次数/均值/探索项/分数，并检查事件顺序连续、历史决策均已确认。发现不一致时报告具体事件（决策编号、序号、期望值与实际值）。

## 离线演示器

`npm run demo` 使用两条预先写好的固定奖励流（alpha 均值约 0.7、beta 均值约 0.3）跑 30 轮：只有被选中时才消耗该臂序列的下一个值，未被看到的值不计入均值。演示输入保存到 `data/demo-input-*.json`，可用 `node dist/src/demo.js --input=<文件>` 复现。演示不包含其他策略对比或概率模型拟合。

## 测试

`npm test` 覆盖：初始每臂恰好各试一次、固定平局规则、少次数臂探索项更大、均值随 0/1 更新、`t` 只随有效反馈增加、手算短序列核对分数与选择、未来奖励不影响已有决策、非法奖励、重复反馈、未决请求重复读取、重启继续反馈、实验间隔离、回放与在线统计一致、演示中劣势臂仍被探索。

## 限制

- 单机单进程本地服务，无鉴权、无并发横向扩展设计。
- `node:sqlite` 为 Node 实验特性，未来版本 API 可能变化。
- 不做统计显著性推断，不承诺找到最优臂；奖励须为 [0,1] 有限数。
