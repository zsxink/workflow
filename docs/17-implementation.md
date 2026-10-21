# 首轮实现与验收记录

2026-10-21 开始按现有 v1 契约实施。此文记录实际交付边界，不替代专题规范或路线图。

## 实施顺序

1. 自研规格 AST、解析、严格校验、追踪和同步投影。
2. 共享 Git 元数据定位、原子状态、CAS 所有权、指纹和可恢复文件事务。
3. 确定性工作流门禁及命令证据，不启动任何模型或 Agent 进程。
4. 精确版本本地 runtime、托管资产和安装/升级/卸载计划。
5. CLI 集成、临时 Git fixtures、打包后离线安装与回归。

实现沿用 TypeScript + ESM / Node.js 22.12+。运行依赖锁定并打入本地 runtime。宿主入口仅引导主会话调用原生协作机制；入口存在不构成原生派发、身份或 Reviewer 只读能力证据。未取得真实能力和授权来源证据时必须停止门禁。后续 GitHub、tracking、Epic 和真实双仓试点仍须独立实施验收。

## 当前交付边界

| 模块 | 已实现 | 尚未开放或验收 |
| --- | --- | --- |
| 规格 M1 | 原始字节 AST、严格 YAML/ID/场景/任务校验、trace、同步/归档领域计划、历史索引重建、三方重新基线和归档投影校验 | 规则语义、行为正确性和批准来源仍须独立核查 |
| 运行 M2 | common-dir、CAS/revision/owner、幂等请求、固定 runtime 摘要、派生视图、原始文件 manifest、文件 journal、逐路径恢复/回滚、只读恢复诊断、跨进程命令证据索引与摘要核验 | 真实宿主停止证据、接管/孤锁/进程被杀后的 guard 恢复、完整归档/reopen 业务事务、用户授权追加预算 |
| 工作流 M3 | 纯阶段/任务派发协议、TDD 证据状态机、范围与旧 attempt 检查、完整 diff 覆盖结构、输入失效和预算继承、CLI planned 任务包/回报审计和真实基线采集 | TDD cycle 开启/接受/步骤 CLI、真实身份与授权、独立隔离审查、最终候选树/提交/集成闭环 |
| 安装 M4 | 本地固定 bundle、许可证、共享协议/角色、Codex/Claude 薄入口、managed-bases、安装/升级/卸载事务和冲突保护、doctor | 宿主真实执行能力、两仓试点、公开发布；OpenCode/pi 不生成入口 |
| M5/M6 | 仅解析已有配置/规格中的声明 | tracking/GitHub 远端事实、Epic、旧产品格式导入 |

`validate --gate spec` 是结构校验，通过不代表授权或实际执行门禁通过。`validate --gate integration` 在没有运行层核实的授权/CR/Verify/场景证据时失败；CLI 不接受用自写 JSON 注入成功。

TDD/阶段纯函数从 `src/workflow/index.ts` 导出供后续应用层集成。命令证据由真实执行器产生，started 先占 operation-id 并关联 CAS 状态，completed 以不可覆写副文件及摘要保存；跨进程读取核对 schema、run/runtime/operation 关系和副文件摘要。已完成基线批次同请求重放只读原记录，返回 `historical`、`currentFreshness`；源码改变后不把历史通过当成当前通过。started/unknown 不得补造历史或自动重跑。TDD 纯函数的 Red/Green 接受仍只信任进程内采集，尚未把持久化历史开放成 TDD 阶段成功来源。

Reviewer 覆盖检查只证明覆盖声明完整，不证明宿主已隔离；因此整个成功链仍受阻断。主会话子 Agent 的本次代码审阅也不作为产品宿主权限验收证据。预览不能凭自写的 `{actor: user}` 增加重试额度。

`src/runtime/index.ts` 提供事务恢复 API，CLI `recover/takeover` 当前保持阻断：保留 guard/锁的真实进程中断不能仅以时间或 PID 推断停止。本轮中断测试采用每个持久化 checkpoint 的异常注入，验证部分落盘后的收敛和冲突；它不等同 kill/断电恢复的完整验收。多文件事务仍非 OS 级整体原子。

另有命令执行期间 SIGKILL 的实际测试，验证 started 记录、残留执行锁和同 operation-id 重放继续阻断，未验证自动清理残锁或恢复为成功。

事务 journal 只允许当前 worktree 的 `.workflow-transactions/` 或共享 common-dir 的 `workflow/transactions/`，其余自定义位置拒绝，保证普通读取能发现未完成事务。未知状态版本只返回清空权限/预算嵌套数据的只读诊断投影，写入和后继 run 继承均拒绝。开发源码身份以整个 `src` 树摘要固定，构建产物以实际 bundle 字节固定。

## 可运行接口

```sh
npm ci
npm run check
node bin/workflow.js --help
node bin/workflow.js init --project /path/to/git-project --hosts codex,claude --dry-run --json
node bin/workflow.js init --project /path/to/git-project --hosts codex,claude --operation-id install-001 --json
```

安装需现有 Git 提交，默认分支从仓库事实核实；普通目录只能生成非执行安装计划。安装后的 `.workflow/runtime/workflow.js` 不依赖全局 npm 包或开发 node_modules。应提交托管 runtime、模板 base 缓存及 install.json。

主会话先准备独立分支，再创建变更：

```sh
node /path/to/git-project/.workflow/runtime/workflow.js change new demo --project /path/to/git-project --operation-id draft-001
# 主会话填写 proposal、delta、design、tasks 和配置；模板本身不会通过 spec gate。
node /path/to/git-project/.workflow/runtime/workflow.js validate demo --project /path/to/git-project --gate spec --json
node /path/to/git-project/.workflow/runtime/workflow.js sync demo --project /path/to/git-project --json
```

配置没有默认为所有项目选择测试命令。生成的命令空集不能用于宣称验证通过。引擎不自行发起 Git 写入、模型派发或远端集成；项目声明的验证命令仍是已授权代码，执行器不提供进程/文件系统沙箱，输入变化检测不代替宿主权限隔离。

`dispatch prepare <change> --task <id> --role reviewer --run <id> --owner <token> --expected-revision <n> --operation-id <id>` 保存 planned 包和起始快照；不会调用宿主。`dispatch collect` 校验回报协议并持久化审计；未 attach 的 DONE 会被拒绝。`test-cycle baseline` 使用相同写凭据串行执行任务声明的全部 Test-Commands；每条采集前后 HEAD/index、manifest、命令/环境摘要及真实退出码。该入口不是有效 Red，也不会打开 cycle。`evidence show <change> --run <id> --operation-id <command-operation-id>` 在新进程核查记录，CLI 只输出摘要，不回显原始命令日志。

`change rebaseline <change> --run <id>` 为只读三方预览，从该 run 的 bootstrap HEAD 固定 Git 对象读取旧规格并核对 baseHash。原基线内容不可得时拒绝，不遍历历史猜测，也不覆盖 delta。

升级/卸载先输出摘要计划，`--apply --plan-digest <hash> --operation-id <id>` 应用。相同 operation-id 的入口重试先核对持久化请求和实际输出；参数不同或输出被外部编辑会拒绝，不能用重试掩盖变化。run init 需要无无关差异的独立分支；本机 `.git/info/exclude` 不能隐藏待交付的输入。

## 验收状态

最终运行 `npm run check`：TypeScript 严格检查、单文件构建及 96 项测试全部通过，0 失败/跳过。`git diff --check` 通过。实现测试使用临时 Git 项目、中文/空格路径和 linked worktree。安装包测试实际执行 `npm pack`，解包后安装、提交并 fresh clone，再用随仓 runtime 检查/卸载；不从源码 node_modules 加载运行依赖。

本机实际运行环境为 macOS / Node.js 24.21.0。另以纯 `--version` 元数据查询观测到 Codex CLI 0.162.1、Claude Code 2.1.306；没有启动 Agent 会话，这些版本信息不证明原生身份关联、权限隔离或宿主闭环已通过。Node.js 22.12 是目标下限，本轮未单独使用该版本执行测试。

两轮独立审查发现的运行元数据符号链接、跨 worktree 写入、初始化失败遗留锁、入口幂等重试、remote base 对应本地分支绕过，以及批次最终输入/完成回执和任务包范围竞态均已修复，定向复核及最终全量测试通过。本轮复核未留下已证实的 blocker/major；不代表所有目标能力已实现。

可审阅安装包生成于 `.artifacts/workflow-project-0.1.0-preview.1.tgz`，该目录忽略入 Git。未操作本项目 Git index/HEAD，未公开发布。未通过的路线图项目保持未勾选。真实宿主、Windows 命令执行、GitHub/事项来源、双仓试点及公开发布未验证。
