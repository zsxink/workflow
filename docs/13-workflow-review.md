# MusicTag / MarkFlow 工作流复核记录

复核日期：2026-10-21。范围为两个项目当前工作树中的规则、流程、相关状态实现与 CI 配置，以及本项目设计文档；未执行两个项目的测试、流水线、归档或远端操作。下列修正均为设计变更，实施任务仍未完成。

## 1. 对照依据

| 项目 | HEAD（实际读取当前工作树） | 主要证据 |
| --- | --- | --- |
| MusicTag | `e45fc18aa1c1957c486dfbad768c6f13e7faff94` | `AGENTS.md`；`.agents/skills/pipe/WORKFLOW.md`；`.agents/tools/pipe-native/progress.js`；`.agents/workflows/pipe-preflight.sh` |
| MarkFlow | `db19df030067c23048e82bc4315f12e1072cac2c` | `AGENTS.md`；`.claude/commands/markflow-issue.md`；`scripts/check-archive-synced.sh`；`.github/workflows/ci.yml` |

MusicTag 的当前入口明确排除旧 pipe-core runner；此次未把旧 runner 当作现行执行路径。MarkFlow 的定制 issue 流程与通用 opsx 提示存在差异，此次分别阅读，没有把它们视为同一套约束。MarkFlow 有 CodeGraph 索引，但该查询未唯一命中流程文档，随后直接读取准确文件路径。

## 2. 借鉴与边界

| 观察 | 对本项目的选择 |
| --- | --- |
| MusicTag 以主会话为 Leader，原生子 Agent 分工，状态与集成使用类型化证据 | 保留主会话调度、唯一 Git 写入者和确定性门禁；不复制项目角色、目录、命令或旧运行器 |
| MusicTag Verify 核对 CI 的 job 条件、环境、安装依赖和实际命令 | 将 CI 映射与环境准备纳入验证计划；远端专属检查独立记录，避免假称本地通过 |
| MarkFlow 严格校验 Apply/Verify 回报，修复后使用新验证实例 | 本项目统一为版本化 JSON，绑定实际派发和当前 attempt；独立审查用新上下文，确定性命令仍可由主会话执行 |
| MarkFlow 要求完整 diff 及归档后最终验证，失败返回活动变更修复 | V1 强制 verify-final，定义独立归档输入校验与受控 reopen，不依赖模型判断语义等价 |
| MarkFlow 归档后修复计数跨重新归档保留 | 本项目预算同时跨恢复、重新归档、后继 run 保留；仅新用户决策可追加额度 |

MarkFlow 脚本实际主要检查非 REMOVED requirement 标题是否仍在正式规格，不验证完整场景和正文；不能借其脚本成功推断完整同步。本项目根据自身 AST、事务输出摘要和 ID 历史检查当次归档的完整投影，不要求所有历史需求永远保留在当前正式规格中。

## 3. 本次发现与修正

| 问题 | 修正及相关契约 |
| --- | --- |
| P2：归档后最终检查失败，但 reopen 原先只允许 base 前移；base 未变时修复无合法路径 | [规格规范](03-specification.md)允许 `final-check-failed` 原因，经事实与摘要核验后恢复活动输入；[运行恢复](05-runtime.md)同步该分支 |
| P2：配置允许新 run 继续，可能重置已耗尽预算 | [配置契约](06-configuration.md)定义后继 run 继承额度；运行状态保留 previousRunId、未决问题、消耗与追加依据 |
| 归档后“语义等价可复用”缺少 V1 的确定性判据 | [执行协议](04-workflow.md)改为必须通过 verify-final；归档输出、最终完整 diff、归档后所选命令分别有证据 |
| 回报模板未定义版本、run/attempt 关联和列表语法 | 执行协议定义 JSON envelope；[CLI](08-cli.md)补充 collect，拒收旧 attempt 作为当前完成证据 |
| 只说“相关检查”可能遗漏脚本、配置、规格或 CI 环境义务 | 固定 reviewBase、记录全部变更路径；验证计划记录 CI 条件/依赖、适用与跳过依据 |
| Git index 枚举配合删除 tombstone，可能使同一磁盘快照提交前后得到不同源码指纹 | source manifest 改为文件系统枚举；stage/commit 不改变源码指纹，删除 tombstone 仅用于差异证据；未声明的 ignored 跟踪输入必须诊断 |
| 用户未提交源码参与验证却不进入提交，或把 CRLF 工作树原始字节直接等同于 Git blob，无法正确证明提交结果 | 执行 worktree 隔离用户差异；最终验证分别绑定原始 manifest 和 candidateTree，经 Git 转换规则核对投影，commit tree 必须一致 |

## 4. 后续实施验收

[路线图](10-roadmap.md)保留未完成任务，并补充以下失败案例：

- base 未变、归档后检查失败，安全 reopen、修复、重新归档和最终验证。
- 连续恢复、重新归档、新建 run 后预算仍不重置；最终门禁无强制通过选项。
- 延迟回报、错误 attempt、缺失字段、无证据 DONE 均不能推进阶段。
- 删除/新增/重命名在 stage/commit 前后源码 manifest 一致；已忽略的跟踪输入不能漏采。
- 最终审查遗漏路径、CI 环境缺依赖、只剩标题而场景正文未同步均不能报通过。

修订后另经只读独立审查，确认 reopen、预算继承、归档输入校验、用户差异隔离及提交树映射的问题已闭合，未发现新的阻断性文档矛盾。实际静态检查覆盖 22 份 Markdown、32 个本地链接和 2 个 JSON 示例，未发现缺失目标、JSON 语法错误或行尾空白。

此次文档复核不证明引擎、宿主隔离、安装器或两个参考项目的现行 CI 已通过。真实运行与故障注入仍按路线图实施。
