# UCB1 多臂老虎机决策与奖励反馈回放后端

一个本地运行的顺序决策实验服务:你声明若干候选臂,服务每次给出一个选择建议,你再提交实际观察到的奖励。核心算法为经典 UCB1,用于复现"探索—利用"过程。仅提供 HTTP API 与 CLI,不含任何前端。

**本服务不连接广告、交易或真实用户系统,不承诺找到最佳方案,也不提供统计显著性结论。**

## 环境要求

- Windows 本地运行,无需 Docker / WSL / 付费服务 / 外部在线 API
- Node.js ≥ 22.5(使用内置 `node:sqlite`,无需原生编译;开发环境为 Node 25)
- 依赖仅 `typescript` 与 `@types/node`(开发依赖)

## 快速开始

```powershell
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务(默认自动选择空闲端口)
npm run demo       # 运行离线演示(固定奖励流)
```

端口配置:环境变量 `PORT`,或 `node dist/src/cli.js serve --port 8080`。端口为 0(默认)时由系统分配空闲端口,启动日志会打印实际端口。

数据目录:项目内 `./data/`,数据库文件默认 `./data/ucb1.db`,可用环境变量 `DB_PATH` 覆盖。

## 核心规则

- **UCB1 分数**:臂 i 的分数 = 平均奖励 + `sqrt(2*ln(t)/n_i)`,其中 `t` 是全部已接受奖励数,`n_i` 是该臂已接受奖励数。
- **初始化**:尚未观察过的臂按编号(创建时排序固定)依次各选一次。
- **平局**:分数相同时选编号较小者。
- **t 的口径**:只统计已接受的奖励;待反馈的建议不计入 t,也不会改变任何统计。
- **每实验最多一个待反馈决策**:再次请求建议返回同一个决策编号;必须提交匹配的奖励才进入下一轮。
- **奖励校验**:必须是 `[0,1]` 区间内的有限数;非法奖励、未知/过期决策编号、重复反馈均被拒绝且不会二次累计。
- **持久化**:决策创建与奖励确认各自原子完成;进程重启后待反馈决策仍可继续提交奖励,不会默认为 0 或跳到其他臂。
- **臂集合**:创建时确定并排序,之后不可修改;编号唯一。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/experiments` | 创建实验,body: `{"name":"x","arms":["a","b"]}` |
| POST | `/experiments/:id/suggest` | 请求建议(有未决决策时返回同一个,`reused:true`) |
| POST | `/decisions/:id/feedback` | 提交奖励,body: `{"reward":0.7}` |
| GET | `/experiments/:id/stats` | 当前统计(每臂 n、均值、探索项、分数) |
| GET | `/decisions/:id/explain` | 解释历史决策(决策时快照与理由) |
| GET | `/experiments/:id/export` | 导出实验全部事件 |
| POST | `/experiments/:id/replay` | 回放检查 |
| GET | `/health` | 健康检查 |

错误响应格式:`{"error":{"code":"...","message":"..."}}`,错误码包括 `INVALID_ARMS`、`EXPERIMENT_NOT_FOUND`、`DECISION_NOT_FOUND`、`DECISION_NOT_PENDING`、`INVALID_REWARD`、`BAD_REQUEST`。

## CLI

```powershell
node dist/src/cli.js create --arms A,B,C --name 我的实验
node dist/src/cli.js suggest --exp <实验ID>
node dist/src/cli.js feedback --decision <决策ID> --reward 0.8
node dist/src/cli.js stats --exp <实验ID>
node dist/src/cli.js explain --decision <决策ID>
node dist/src/cli.js export --exp <实验ID>
node dist/src/cli.js replay --exp <实验ID>
node dist/src/cli.js serve --port 8080
node dist/src/cli.js demo
```

## 回放检查

回放从空统计出发,按事件顺序逐条重建:核对每条决策做出时的 `t`、选中臂以及每个臂的分数是否与记录一致。发现缺失、顺序错误或分数不符时,会报告具体的 `seq` 与决策编号及原因。回放结束后的最终统计与在线统计一致。

## 离线演示器

`npm run demo` 使用两个预先写好的固定奖励流(均值约 0.2 与 0.75)。只有某臂被选中时才消耗它序列中的下一个值;未被选中的臂的未见值不会计入均值。演示输入保存到 `data/demo-input.json` 以便复现。可以看到:即使 B 明显更好,UCB1 仍会周期性探索选择次数较少的 A(其探索项随 t 增长)。演示只做单一策略展示,不包含策略比较或概率模型拟合。

## 建议与已观察结果的区别

- **建议**是服务在"当时已接受奖励"基础上给出的下一步选择,本身不是观测数据;未提交奖励前,它不进入任何统计。
- **已观察结果**是你提交并被接受的奖励,只有它才更新各臂次数、均值与 t。
- 历史决策的分数快照在决策时固化,之后给其他臂补充奖励不会改写已有决策记录。

## 限制

- 有限轮输出**不能证明某臂绝对更好**;UCB1 只保证探索与利用的平衡策略,不给出统计显著性结论。
- 奖励必须落在 `[0,1]`;臂集合创建后不可变。
- 单进程服务,未做鉴权,仅面向本地实验用途。
- `node:sqlite` 在 Node 25 仍为实验特性(启动时有 ExperimentalWarning),接口未来可能微调。
