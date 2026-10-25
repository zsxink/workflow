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
| 工作流 M3 | 纯阶段/任务派发协议、无任务 Architect 与非 TDD planned 包、TDD/产物接收领域状态机、删除场景追踪、范围/旧 attempt/命令计划时序核查、完整 diff、失效/预算、CLI 回报/真实工作树只读产物审计和真实基线采集 | TDD cycle 开启/接受/步骤 CLI、真实身份与授权、独立隔离审查、最终候选树/提交/集成闭环 |
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
npm run build
npm link
cd /path/to/git-project
workflow --help
workflow init --dry-run --json
workflow init
```

本地试用可用 `npm link` 建立全局命令链接，不会发布 npm 包。进入目标仓库后，交互终端运行 `workflow init` 可选择 Codex、Claude 或两者，并选择中文或英文模板；默认中文。也可使用 `--hosts codex`、`--hosts claude`、`--hosts codex,claude`，以及 `--language zh-CN` 或 `--language en`。非交互终端未传 `--hosts` 时默认 Codex，未传 `--language` 时默认中文；已安装项目重复初始化时沿用安装清单中的语言。operation-id 自动生成。安装需现有 Git 提交，默认分支从仓库事实核实；普通目录只能生成非执行安装计划。安装后的 `.workflow/runtime/workflow.js` 不依赖全局 npm 包或开发 node_modules。应提交托管 runtime、模板 base 缓存及 install.json。

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

2026-10-22 模板优化：初始化协议、五类角色、项目规则和变更 proposal/design/tasks 均采用中英文 Markdown 资产；变更正文从 CLI 内联内容迁入模板目录，沿用原有语言选择与事务。补齐方案取舍、可观察验收、路径依赖、回报说明及规则 ID 指引；来源与取舍见 [参考资料](12-references.md)，维护入口见 [模板说明](../assets/README.md)。本轮 `npm run check` 的类型检查、构建与 102 项测试通过（0 失败/跳过），包含双语草案、安装冲突保护及打包后离线生成验证；这些结果不增加真实宿主或完整生命周期的验收范围。

同日角色模板补强：五类双语角色从职责摘要扩为执行说明，补齐启动输入、权限、分步方法、角色证据标准、停止条件和可读交接结构。核对并修正了非 TDD 开发任务的权限条件、归档前/最终验证的候选树适用范围，以及审查严重度与引擎枚举的一致性。独立只读复核后无剩余确定性问题；实际重新运行构建及 CLI/安装专项测试 16 项通过（0 失败/跳过），`git diff --check` 通过。本轮为模板与说明文档修改，未重跑全部 102 项测试，也不构成真实宿主权限验收。

角色与工作流衔接：五类双语模板增加阶段位置、进入条件、上游输入、实际角色 ID、交接产物、退出门槛和失败回流；protocol/shared Skill 明确 Leader 按角色映射组合任务指令、输入与证据。区分 dev 内 task/cycle/Red-Green attempt 与顶层阶段，以及 integrate 内最终 Reviewer/Verifier 门禁；只读回报 `files: []`，DONE 仍需审计。实际构建与 CLI/安装专项 16 项通过（0 失败/跳过）；独立文档复核发现的旧 Verify 表 candidateTree 条件已同步修正。当前 `dispatch prepare` 仍不自动注入角色 Markdown、关联真实身份或推进成功，本轮没有改变引擎实现及宿主验收边界。

首轮实现验收运行 `npm run check`：TypeScript 严格检查、单文件构建及 96 项测试全部通过，0 失败/跳过。`git diff --check` 通过。实现测试使用临时 Git 项目、中文/空格路径和 linked worktree。安装包测试实际执行 `npm pack`，解包后安装、提交并 fresh clone，再用随仓 runtime 检查/卸载；不从源码 node_modules 加载运行依赖。

本机实际运行环境为 macOS / Node.js 24.21.0。另以纯 `--version` 元数据查询观测到 Codex CLI 0.162.1、Claude Code 2.1.306；没有启动 Agent 会话，这些版本信息不证明原生身份关联、权限隔离或宿主闭环已通过。Node.js 22.12 是目标下限，本轮未单独使用该版本执行测试。

两轮独立审查发现的运行元数据符号链接、跨 worktree 写入、初始化失败遗留锁、入口幂等重试、remote base 对应本地分支绕过，以及批次最终输入/完成回执和任务包范围竞态均已修复，定向复核及最终全量测试通过。本轮复核未留下已证实的 blocker/major；不代表所有目标能力已实现。

可审阅安装包生成于 `.artifacts/workflow-project-0.1.0-preview.1.tgz`，该目录忽略入 Git。未操作本项目 Git index/HEAD，未公开发布。未通过的路线图项目保持未勾选。真实宿主、Windows 命令执行、GitHub/事项来源、双仓试点及公开发布未验证。


2026-10-22 规范衔接复核：统一规范来源/权限交集、当前能力与宿主优先级；补充授权 attempt 产物接收、Tester 补测与历史 TDD 的目标契约，中英文安装模板同步。`project.authoritativeDocs` 和可枚举的根/嵌套 AGENTS.md/CLAUDE.md 纳入 policy 指纹，忽略/产物目录中的适用规范须显式声明，避免遍历全部依赖目录；回归覆盖忽略目录中的显式权威输入及文档变化后的 policy 失效。完整复核与未闭合路径见 [衔接复核](18-contract-review.md)。

本轮实际 `npm run check`：类型检查、单文件构建与全部 104 项测试通过（0 失败/跳过），包括临时 Git、打包离线安装及新增指纹回归；21 份入口/专题 Markdown 的 127 个本地链接目标检查通过，`git diff --check` 通过。这些结果不关闭 Architect 无任务启动、非 TDD 派发、多任务/Tester 产物接收、删除项追踪或真实宿主/完整集成验收待办。未操作本项目 Git index/HEAD 或外部发布。

本轮独立审查发现的显式 policy glob 被默认剪枝排除问题已修复并增加回归；复核后未发现本轮范围内剩余阻断问题。该结论不覆盖工作区本轮之前所有修改。


同日后续四路径实施：Architect 省略 --task 准备 change scope 包、回报 taskIds=[]；非 TDD 的 developer-verification/developer-exempt 从真实任务绑定模式、命令完整摘要及替代验收计划，非 Architect 派发前执行完整结构校验。REMOVE 与 UPDATE 删除场景进入 current/removal 追踪，删除任务可审计引用本次原 REQ；移除证据强制独立用途与验收理由，不重新激活历史 ID。

新增产物审计/接收纯领域 API：准确核对新增/修改/删除、权限、起止输入、当前 attempt、真实命令与派发时序/完整计划；防伪审计对象经域转换后记录 outputReceipt、终结 attempt、更新指纹并失效相应后续阶段，保留完成 cycle 历史。CLI `dispatch audit` 只读采集 Git/文件事实，不应用接收、不执行任意命令、不修改状态。宿主身份/授权来源、真实持久化接收、跨进程接收证据和 exempt 替代验收可信来源仍未验收，相关成功门禁保留。

本轮最终验证：`npm run check` 的严格类型检查、单文件构建与全部 **130 项测试通过**（0 失败、0 跳过）；21 份入口/专题 Markdown 的 128 个本地链接目标及 `git diff --check` 通过。新增回归包含真实命令采集的 Red→Green→免重构领域接收链、Tester 历史保留、删除/重命名/越界/未知写入者、缺少起始快照、陈旧/复制/篡改审计对象、同 ID 不同命令、派发前命令及跨进程序列拒收，并验证 CLI 只读 audit 不改变 run。产物接收仅适用于写角色，不替代独立 CR/Verify；替代验收来源缺失保持拒收。独立审查发现的问题均经修复及回归，最终由主会话复核；没有将领域 fixture 中的 attached 身份当作真实宿主证据。保留原工作区修改，未操作本项目 Git index/HEAD 或外部发布。

## 本地既有工作流对照与 Agent 规格优化

对照 MarkFlow `markflow-issue` 与 MusicTag `pipe epic` 的本地定义，补齐主会话六步执行循环、可读派发上下文、失败分类及 Epic 调度目标契约。来源摘要和取舍见[参考资料](12-references.md)，权威规则见[执行协议](04-workflow.md)。同步中英文 protocol、shared Skill、Architect 和 design/tasks 模板，明确跨 change 前提使用既有 `change.yaml.dependsOn`，设计正文仅解释理由；Architect 无元数据写权限时向 Leader 提交建议。保留五职责、任务内 TDD、严格只读审查、自研规格与唯一 Leader。

本轮仅修改文档与安装模板，不新增机器字段、CLI 或运行时实现。Epic 就绪计算、恢复与调度仍为 M6 待实施；两参考仓库只读调研，未运行其流程或修改文件。未完成的宿主、授权、事务与集成验收继续保持未完成。

实际验证：先运行 `npm run check`，类型检查、构建及全部 130 项测试通过（0 失败/跳过）；独立审查发现跨 change 依赖仅写设计正文的模板遗漏，修正后定向复核无剩余确定性问题。最终模板重新构建，并运行 CLI/安装专项 17 项全部通过（0 失败/跳过），包含双语生成、升级保护及打包离线安装；最终模板调整后未再次运行全量测试。另检查 22 份 Markdown 的 136 个本地链接目标及 `git diff --check`。这些检查不构成真实宿主或 Epic 闭环验收。保留工作区既有修改，未操作本项目 Git index/HEAD 或发布。

## 基线指纹比对修复（2026-10-25）

修复 TODO #2：`workflow/receipts.ts` 的 `OUTPUT_BASELINE_STALE` 原先把 `state.fingerprints` 当作恒真基准，而该值在当前阶段只有首次派发的 `??=` 一个写入点——`applyAcceptedOutput` 与 `invalidateForInputs` 虽会推进它，但应用层按设计 fail-closed，均无调用者。结果是输入合法变化后，后续角色的 `dispatch prepare`/`audit` 必然误报基线陈旧。

现比对基准为：准备回执与 `dispatch.fingerprints` 始终校验；workflow 级指纹仅在已有任一 `outputReceipt`（基线确经接收推进）时参与，否则不否决后续合法 attempt。`docs/05-runtime.md` §3 同步该契约。持久化接收路径（同步刷新 `run.fingerprints`）仍受宿主来源验收阻塞，未开放。

本轮验证：`npm run check` 的严格类型检查、单文件构建与全部 **132 项测试通过**（0 失败/0 跳过）。新增两项回归：bootstrap 基线不否决后续合法 attempt；已接收产物推进基线后，按旧基线派发的 attempt 仍被判 `OUTPUT_BASELINE_STALE`。第一项已在修复前代码上确认失败。同时修正 `tests/workflow.test.ts` 遗留的 `commandPlanDigest` 数组调用（commit 32e60c0 改签名后未同步，导致 typecheck 失败）。未操作本项目 Git index/HEAD 或外部发布；本轮不改变真实宿主、持久化接收与集成验收状态。

## 产物/源码范围相交判定修复（2026-10-25）

修复 TODO #3。原 `globPrefix` 把项目根级模式（`**`、`.`）归一成空字符串，`mayIntersect` 再按“空前缀即相交”判定，导致两个后果：安装默认模块 `paths: ['**']` 使任何 `artifacts` 声明必然 `CONFIG_ARTIFACT_SOURCE_OVERLAP`；模块 `paths: ['.']`（同为整个项目）反被判为不相交，构建白名单可掩盖源码写入。

现 `globPrefix` 对项目根级模式返回 `undefined`，不再产出空前缀；`mayIntersect(artifact, source)` 任一侧无字面前缀即判相交并 fail closed。安装默认模块仍为 `paths: ['**']` 占位，不虚构项目目录结构；`docs/06-configuration.md` §4 与 `docs/05-runtime.md` §3 明确“两侧都需有字面前缀才能证明不相交”，要求项目先用真实目录替换再声明产物。

本轮验证：`npm run check` 的严格类型检查、单文件构建与全部 **134 项测试通过**（0 失败/0 跳过）。新增两项回归：`tests/project.test.ts` 验证 `['.']` 与 `['**']` 均被拒绝、有界范围仍通过（已确认在修复前代码上失败）；`tests/install.test.ts` 验证安装草案声明产物被拒、替换真实目录后 `loadConfig` 与 `captureFingerprints` 均通过且 `dist/` 被排除。未操作本项目 Git index/HEAD 或外部发布；本轮不改变真实宿主、持久化接收与集成验收状态。
