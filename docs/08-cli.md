# CLI 契约草案

下表为完整目标接口。受限预览已开放的命令及限制以 [实现记录](17-implementation.md) 和 `workflow --help` 为准，其余入口明确拒绝，不能按下表推断已交付。所有命令共享 `--project <path>`、`--json`；写命令另需 owner/revision 或所属事务凭据。当前 `--project` 必须指向 Git worktree 根，默认 cwd 不能改变状态归属。

## 1. 命令目录

| 命令 | 用途 | 副作用 |
| --- | --- | --- |
| `workflow init [--hosts codex,claude,opencode,pi] [--profile local] [--language zh-CN\|en]` | 初始化接入 | 按选择安装宿主入口和对应语言模板；默认中文，安装不等于原生执行就绪，支持 dry-run |
| `workflow doctor` | 安装、配置、能力检查 | 只读，不启动模型 |
| `workflow upgrade [--to version]` | 项目版本升级 | 默认计划；apply 显式应用 |
| `workflow uninstall` | 移除管理资产 | 默认计划；保留用户数据 |
| `workflow change new <change>` | 创建变更与模板 | 在主会话已准备的变更分支写入；目标分支上拒绝写入，不自动批准 |
| `workflow change list` | 列出活动/归档 | 只读 |
| `workflow tracking read --provider <id> --item <id>` | 读取标准事项快照 | 只读外部查询，不更新 run 或源平台 |
| `workflow tracking refresh <change> --run <id>` | 核实已关联主事项并刷新证据 | 写 run 快照引用/变化诊断，不覆盖 Spec、不回写事项 |
| `workflow change reopen <change> --transaction <id> --reason base-changed\|final-check-failed\|source-changed` | 恢复尚未集成的归档 | 校验原因证据、未集成事实和原输出摘要，执行逆向事务 |
| `workflow validate <change> --gate draft|spec|integration` | 规格门禁 | 只读结构与证据核查 |
| `workflow trace <change>` | 展示需求、场景、任务覆盖 | 只读 |
| `workflow sync <change>` | 生成正式规格投影 | 只读，无 apply 模式 |
| `workflow archive <change> --run <id>` | 应用同步并归档 | integration gate 下的 journal 事务 |
| `workflow run init <change>` | 建立 run 与独占锁 | 运行记录，不调用 Agent |
| `workflow approve <change> --evidence <file>` | 记录已有用户授权 | 绑定语义摘要，不能制造授权 |
| `workflow dispatch prepare ...` | 生成子任务包 | planned attempt |
| `workflow dispatch attach ... --agent-id <id>` | 记录已派发 Agent | 关联真实派发事实 |
| `workflow dispatch collect ... --report <file>` | 校验当前 attempt 的 JSON 回报 | 保存解析与关联结果；不因 DONE 自动通过阶段 |
| `workflow dispatch audit <change> --run <id> --dispatch <id> --attempt <id>` | 从准备回执与真实工作树核查全部产物差异 | 只读诊断；acceptedOutput/executionReady 均为 false，不应用接收转换 |
| `workflow test-cycle baseline <change> --task <id>` | 运行开 cycle 前的计划检查 | 执行器采集定向/回归结果及快照，不因采集成功声称测试通过 |
| `workflow test-cycle open <change> --task <id> --baseline <evidence-id> [--mode new-test\|existing-failure]` | 在实现前固定 TDD 基线 | 主会话建立 cycle、记录测试范围和命令计划 |
| `workflow test-cycle run <cycle> --step red\|green\|refactor --command <id>` | 执行任务内测试并采集证据 | 主会话调用确定性执行器；校验步骤、快照和命令，Red 另需主会话接受失败原因 |
| `workflow verify <change> --run <id> --stage pre-archive\|final` | 执行所选验证计划并采集证据 | 执行项目声明命令；final 另校验归档输出，独立审查证据由门禁核对 |
| `workflow phase record <change> --phase <id> --status <status> --evidence <file>` | 请求阶段转换 | 运行引擎重查前置条件，不允许调用方直接置成功 |
| `workflow task record <change> --task <id> --status <status> --evidence <file>` | 请求任务转换 | 核查派发、路径及验收证据 |
| `workflow checkpoint record <change> --checkpoint <id> --evidence <file>` | 记录当前交付事实 | 从 Git/事务/远端重查，不能自报完成 |
| `workflow change rebaseline <change> [--apply --plan-id <id> --resolution <file>]` | 重新基线预览/应用 | 三方计划、显式冲突处置及证据失效，见规格规范 §11 |
| `workflow lock heartbeat <change> --run <id>` | 更新 owner 的诊断时间 | CAS 更新，不延长可自动抢占的租约，不证明 Agent 存活 |
| `workflow candidate capture <change> --run <id>` | 固定主会话已准备的 index 树 | 只读 Git，写候选树证据；不执行 git add/commit |
| `workflow candidate confirm <change> --run <id> --commit <sha>` | 绑定验证树与提交 | 只读 Git，核查 commit tree 及验证前后快照，写证据 |
| `workflow status <change>` | 查看状态和证据有效性 | 只读 |
| `workflow resume-plan <change>` | 当前事实与恢复建议 | 只读，远端模式可查询网络 |
| `workflow takeover <change> --run <id> --previous-owner <id> --evidence <file>` | 显式会话接管 | 校验活性证据、记录 journal |
| `workflow recover --transaction <id>` | 收敛未完成事务 | 范围受原 journal 限制 |
| `workflow epic ready <epic>` | 按依赖与事实计算就绪集 | 只读；后续里程碑 |
| `workflow integrate <change>` | 集成计划/逐 checkpoint 执行 | 按授权和 profile 执行 |

没有 `workflow run` 自动启动完整 Agent 流水线的含义。Skill 的用户触发文本与 CLI 名称可以相同，但宿主主会话负责解释并调度。verify 仅执行确定性命令与校验，不启动 Reviewer/Verifier；原生派发仍由主会话完成。命令执行权限和允许产物写入须由宿主约束，CLI 的事后快照不构成隔离。

test-cycle run 对 Red 分别返回命令的真实 exitCode 和是否待接受/已接受的步骤结果；预期测试失败不能伪写为 exitCode=0。接受 Red 的主会话判断通过 test-cycle accept 类型证据接口记录，需引用诊断与原始命令证据；该 CLI 不自行判断自然语言断言正确。所有 TDD 命令只采集和推进任务证据，不启动模型，不写 Git 引用。

## 2. 结构化输出

```json
{
  "apiVersion": 1,
  "ok": true,
  "command": "resume-plan",
  "data": {
    "changeId": "session-timeout",
    "nextPhase": "verify",
    "reusable": ["bootstrap", "architect", "spec-gate", "dev", "tester", "cr"],
    "invalidated": ["verify", "integrate"],
    "actions": ["run-current-validation-plan"]
  },
  "diagnostics": []
}
```

失败使用相同 envelope，ok=false，包含稳定 code、path/line、hint。stdout 在 JSON 模式只输出该 envelope；过程日志写 stderr，不把密钥或环境值加入输出。输出长度和命令日志有上限。

## 3. 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 查询成功或写操作完成；具体 ready/pass 仍须读 data |
| 2 | 参数、配置、格式、路径或引用错误 |
| 3 | 门禁未通过、输入或证据已过期 |
| 4 | 锁冲突、revision 冲突、接管条件不足 |
| 5 | 挂起，需要用户决定或缺必要宿主能力 |
| 6 | 外部命令/网络/认证失败，详见 errorKind |
| 7 | 未完成事务或需要恢复 |
| 1 | 未分类内部错误 |

`status` 成功读取一个失败 run 仍可 exit 0，不能把退出码解释为该 run 成功；`validate` 不通过返回 2/3。`doctor` 能完整检查安装和 `.workflow/host-evidence.json`；缺少或过期的宿主证据时返回 5，并列出逐宿主能力及依据。`hostExecutionReady` 不等于完整工作流就绪；受限预览没有阶段成功证据入口时，`workflowLifecycleReady=false` 且项目级 `executionReady=false`。

## 4. 计划与应用

upgrade、uninstall、integrate 默认生成计划，应用时提供 plan-id、当前输入摘要与授权。已在会话得到授权的动作不重复询问，但必须记录证据。archive 只接受 gate 通过且基线未变的 run，不能绕过验证用参数强制成功。

每个写命令支持幂等 operation-id，同一 ID 与不同 payload 组合返回冲突。运行时必须重新核查可从文件/Git查明的事实，不只验证调用方 JSON 字段非空。

## 5. 推进与证据接口

普通 run 写命令显式提供 `--run <id> --owner <token> --expected-revision <n> --operation-id <id>`。创建/恢复入口有独立前置条件：run init 在独占创建锁下生成 run/owner 与初始 revision，不要求尚不存在的 owner；takeover 提供 run、previous-owner 标识、当前 revision 和停止证据，不要求原 owner token，新 owner 由接管事务生成；recover 通过 transaction ID、journal 输入摘要及原 owner 或有效接管凭据执行，有活性不明写入者时仍拒绝。三类入口均需 operation-id；例外不允许普通写操作跳过所有权。不得按 cwd 猜 run；owner token 不是用户批准凭据。phase status 使用 pending/running/succeeded/failed/suspended，task 使用 pending/running/done/blocked，仅接受协议允许的边；checkpoint ID 必须命中当前 profile 的交付步骤表，未知值拒绝。证据文件引用已有 evidence IDs，包含 `{formatVersion, runId, subjectId, kind, evidenceIds}`；主会话语义结论另含 rationale 及来源引用，不用文件存在代替核查。

baseline 证据属于 task，早于 cycle；open 重查源码/测试/命令/环境与证据一致。new-test 默认要求全部基线检查通过；existing-failure 必须把非零结果逐项绑定本次授权目标业务断言与 scenario，其他失败阻断。未发现测试、环境错误等不能进入既有失败模式；模式与基线证据记入 cycle，后续 accept 不补造时序。

Red 接受使用 `workflow test-cycle accept <cycle> --evidence <file>`，适用同一 run 写凭据；引用执行器生成的 Red 命令证据、失败断言诊断、scenario IDs 和主会话接受理由。拒绝旧 cycle、基线已变或非业务断言失败；工具只核查结构/事实，语义结论由后续独立审查复核。

`dispatch prepare` 返回 dispatch/attempt ID。任务级派发提供 `--task <id> --role <id>`；Architect 可省略 --task 创建 change 级派发，回报 taskIds 为 []。非 TDD 角色为 developer-verification / developer-exempt，模式必须与真实任务一致，exempt 另需显式 Alternative-Acceptance。attach/collect 提供 `--dispatch <id> --attempt <id>` 及目录表中的 agent-id/report。attach 的原生工具来源记录与结果引用必须可核查，不能把任意字符串作为真实身份。当前准备入口不开放真实宿主 attach 或阶段成功。

`approve` 的证据记录授权主体、宿主/会话、用户消息或交互记录引用、scope、语义指纹及时间。可读取宿主记录时核对来源；不可读取时标 provenance-unverified 并挂起授权门禁，提供用户在当前会话确认并留存可引用记录的路径。主会话自写的“用户同意”不能形成新的授权；V1 不提供对恶意本地主机的签名认证。

`candidate capture` 记录 HEAD、index tree、source/spec/plan/policy 指纹、Git 转换策略摘要及完整路径 manifest。final 验证绑定该证据并在前后重查；confirm 要求 commit tree 与已验证候选树相同，记录验证 HEAD → commit SHA 映射。二者不授予 Git 写权限。

`verify-final` 是文档中的阶段/checkpoint 名称，唯一 CLI 调用形式为 `workflow verify <change> --run <id> --stage final`，不存在独立的 `workflow verify-final` 命令。`change new` 从已解析配置的 git.baseBranch 核对完整目标 ref；ref 不存在或归属有歧义时拒绝，不以分支短名猜测。
