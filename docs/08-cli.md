# CLI 契约草案

以下命令均为计划接口，当前尚无可运行 CLI。所有命令共享 `--project <path>`、`--json`；写命令另需 owner/revision 或所属事务凭据。默认 cwd 仅用于定位项目，不能改变状态归属。

## 1. 命令目录

| 命令 | 用途 | 副作用 |
| --- | --- | --- |
| `workflow init [--hosts codex,claude,opencode,pi] [--profile local]` | 初始化接入 | 按选择安装四种宿主入口；安装不等于原生执行就绪，支持 dry-run |
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
| `workflow test-cycle open <change> --task <id>` | 在实现前固定 TDD 基线 | 主会话建立 cycle、记录测试范围和命令计划 |
| `workflow test-cycle run <cycle> --step red\|green\|refactor --command <id>` | 执行任务内测试并采集证据 | 主会话调用确定性执行器；校验步骤、快照和命令，Red 另需主会话接受失败原因 |
| `workflow verify <change> --run <id> --stage pre-archive\|final` | 执行所选验证计划并采集证据 | 执行项目声明命令；final 另校验归档输出，独立审查证据由门禁核对 |
| `workflow phase/task/checkpoint ...` | 记录和校验推进 | 强制类型证据及状态机 |
| `workflow status <change>` | 查看状态和证据有效性 | 只读 |
| `workflow resume-plan <change>` | 当前事实与恢复建议 | 只读，远端模式可查询网络 |
| `workflow takeover ...` | 显式会话接管 | 校验活性证据、记录 journal |
| `workflow recover --transaction <id>` | 收敛未完成事务 | 范围受原 journal 限制 |
| `workflow epic ready <epic>` | 按依赖与事实计算就绪集 | 只读；后续里程碑 |
| `workflow integrate <change>` | 集成计划/逐 checkpoint 执行 | 按授权和 profile 执行 |

没有 `workflow run` 自动启动完整 Agent 流水线的含义。Skill 的用户触发文本与 CLI 名称可以相同，但宿主主会话负责解释并调度。verify 仅执行确定性命令与校验，不启动 Reviewer/Verifier；原生派发仍由主会话完成。命令执行权限和允许产物写入须由宿主约束，CLI 的事后快照不构成隔离。

test-cycle run 对 Red 分别返回命令的真实 exitCode 和是否待接受/已接受的步骤结果；预期测试失败不能伪写为 exitCode=0。接受 Red 的主会话判断通过 phase/task 类型证据接口记录，需引用诊断与原始命令证据；该 CLI 不自行判断自然语言断言正确。所有 TDD 命令只采集和推进任务证据，不启动模型，不写 Git 引用。

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

`status` 成功读取一个失败 run 仍可 exit 0，不能把退出码解释为该 run 成功；`validate` 不通过返回 2/3。`doctor` 能完整检查但能力不足时返回 5，并清晰列 installed=true、executionReady=false。

## 4. 计划与应用

upgrade、uninstall、integrate 默认生成计划，应用时提供 plan-id、当前输入摘要与授权。已在会话得到授权的动作不重复询问，但必须记录证据。archive 只接受 gate 通过且基线未变的 run，不能绕过验证用参数强制成功。

每个写命令支持幂等 operation-id，同一 ID 与不同 payload 组合返回冲突。运行时必须重新核查可从文件/Git查明的事实，不只验证调用方 JSON 字段非空。
