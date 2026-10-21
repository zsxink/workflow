# TDD、规格归档与 Git 交付

本文定义任务内 TDD 和一次变更的交付顺序。当前为目标契约，CLI、测试执行器、归档事务与宿主约束均尚未实现；命令仅为计划接口。

## 1. 各层职责

Spec 描述可观察行为；design 解释实现与验证方案；task 声明依赖、路径和测试方式。Developer 在任务内部执行 TDD；Tester 独立检查场景覆盖、测试质量并补充缺项；Reviewer 审查完整变更；Verify 执行项目声明命令。Tester 阶段不能替代开发任务中的先测试步骤。

```text
准备分支/干净 worktree → proposal / delta → design / tasks → spec-gate
  → dev：每个适用任务 Red → Green → Refactor
  → tester → cr → verify
  → sync-base → 必要重验 → archive → verify-final
  → commit → 本地合入，或 push / PR / required CI / 合并
  → 核实完成事实
```

## 2. 任务的测试方式

每个任务声明 Test-Mode、Test-Scopes、Test-Commands；非 TDD 方式另写 Test-Rationale。Test-Scopes 必须属于 Write-Scopes；命令 ID 来自项目 validation.commands，不临时拼接未经计划的 shell 命令。

| Test-Mode | 适用范围 | 完成门槛 |
| --- | --- | --- |
| tdd | 可自动验证的新增/变更行为、Bug 修复 | 关联场景的 Red、Green 和重构结果齐备 |
| verification | 独立覆盖检查、纯重构、仅增加测试、无业务行为的骨架准备 | 纯重构先补齐特征测试并通过，再重构和回归；其他任务检查前基线与完成后回归均通过，不宣称 TDD |
| exempt | 纯文档、探索，或确实无法自动验证的行为 | spec-gate 审查理由、手工/静态替代验收及责任人；行为变化仍须 Spec 场景 |

没有自动化测试条件不等于通过；例外不能由 Developer 在失败后自行切换。修改 Test-Mode、命令、范围或例外理由属于计划变化，重新经过相应门禁。涉及授权范围变化时先取得新授权。探针实验不作为已完成实现混入交付，保留为设计依据。

现有正确行为的特征测试应直接通过，不要求人为制造 Red。补测试时若发现真实缺陷，将缺陷明确为独立行为修复任务/cycle，按授权与计划门禁推进 TDD，不把缺陷修复混入“纯重构”。

## 3. Red → Green → Refactor

1. **建立 cycle**：主会话在实现尚未改变前记录 cycle ID、task/scenario IDs、实现基线、测试路径、命令及环境摘要。每个 cycle 只处理一个可观察行为增量。
2. **Red**：先编写最小行为/回归测试，运行并确认预期断言失败。实现路径相对该 cycle 基线未变；只允许测试及已声明的测试 fixture 变化。Bug 修复必须复现原问题。测试未被发现、错误配置、编译/导入失败、缺依赖、超时和进程崩溃均不算有效 Red；未改实现便通过时，先判断该行为已存在或测试无效，不得制造故障凑 Red。
3. **Green**：主会话接收有效 Red 后，才派发实现写权限。Developer 写最小实现，以同一测试内容、command/argv、运行环境重新执行，预期测试和所选回归命令 exitCode=0。不能删除、跳过或放宽断言取得 Green。
4. **Refactor**：保持行为和测试断言，整理实现后再次执行同一测试及受影响回归。无需重构时记录 not-needed 及理由，引用当前 Green 快照；不能把未运行的重构检查写为成功。
5. **验收**：主会话核对路径、时序和命令事实；Tester/Reviewer 核对失败确为预期行为缺失、测试断言有效且覆盖对应场景。任务完成需所有适用 cycle 通过、最终源码验收通过。

Red 的非零测试退出码是预期观察；采集命令成功不等于测试成功。运行工具分别记录命令结果和 cycle 是否满足 Red 条件，不能以任意 exitCode!=0 自动认定 Red 合格。业务断言语义由主会话/审查者判断，确定性工具只核对时序、摘要、权限差异和引用。

新接口若需要编译骨架才能执行行为测试，应在设计中拆出无业务行为的准备任务，按 verification 验收后建立 cycle 基线；不得在准备任务中提前实现待验证行为。新增行为依然必须观察到有效 Red，不能用接口尚不存在的编译失败代替。

Red → Green 期间测试/fixture 或测试命令改变，当前配对失效，需要新的 cycle 与有效基线；不得伪装成原 Red 对应的 Green。已完成 cycle 的历史不抹除，新增补充测试独立记录。事后补测试不得回填历史 Red；遗留实现采用 verification 或有理由的例外，不能报告遵守过 TDD。

## 4. 证据、权限与恢复

cycle 记录 run/task/cycle IDs、关联需求/场景、实现基线、各步骤开始结束时间、单调 revision、命令证据 ID、测试/fixture 摘要、前后源码指纹、Red 失败诊断和主会话接受结论、Green/Refactor 结果。command 证据来自执行器；Agent 自报与提交时间不能替代步骤证据。所有运行态留在 JSON，tasks.md 只显示结果。

Red 阶段派发写范围仅为 Test-Scopes；接收 Red 后才准备包含实现范围的新派发包。角色不自行升级权限；严格范围隔离与 audit-only 按宿主能力报告，不把事后差异核查宣称为事前隔离。旧派发结束后才能启动同路径的新写入者。

恢复时核对正在运行的进程/Agent、文件快照和已提交证据；不能由当前测试通过倒推出曾经 Red。中断但未记录的结果需重新执行；基线不再可核实时使当前配对失效并给出恢复计划，不覆盖现场或自动回退实现。TDD 的预期 Red 不消耗修复预算；环境失败、无效测试修正和已失败的 Green 按现有重试政策计数。

## 5. Spec 如何归档

活动变更位于 `.workflow/changes/<change>/`，正式规格位于 `.workflow/specs/<capability>/spec.md`。在本变更分支完成以下步骤：

1. 校验 proposal/delta/design/tasks、授权、场景覆盖、适用 TDD 与当前 CR/Verify 证据；存在未完成任务或未决行为问题时不归档。
2. 先同步目标分支。若正式规格基线、源码、规则或计划变化，重新基线并重做受影响门禁。
3. `workflow sync <change>` 只生成投影，核对 baseHash、ADD/UPDATE/REMOVE、稳定 ID 和冲突；不会提前写正式规格。
4. `workflow archive <change> --run <id>` 在事务中应用正式规格更新、登记历史 ID，并将整个活动目录移到 `.workflow/archive/<date>-<change>/`，记录原始输入、输出摘要、事务 ID 和恢复材料。日期在事务准备时固定；同名目标冲突时拒绝覆盖。
5. 强制执行 verify-final：校验当次完整规格投影、归档内容、索引和最终完整 diff，重跑所选命令；正式规格、代码、测试与归档一起进入同一候选 Git 树。

V1 的规格同步在 archive 事务中落地，无独立写入正式规格的 sync apply 步骤。归档成功只表示文件事务完成，不能报告已合并。归档后的文档路径由事务映射解析，验证命令不得继续盲读原活动路径；无法支持归档输入的命令须在计划时处理。

归档后失败且需要修复：在未集成且原输出摘要可核实的前提下，reopen 逆向恢复活动输入，再修复、验证、重新归档。事务中断使用 recover；外部改动冲突时保留现场。已集成归档不可 reopen 或重写，后续修订创建新 change，以 UPDATE/REMOVE/ADD 演进正式规格。当前正式规格允许取代旧行为，不要求所有历史需求继续存在。

## 6. Git 如何交付

| 时点 | 主会话的动作与检查 |
| --- | --- |
| bootstrap | 解析正确 repo/base、固定 base SHA 和 reviewBase；从 base 建立独立变更分支，名称使用项目 branchPrefix；有用户差异时使用干净 worktree |
| 开发中 | 子 Agent 只写授权文件；主会话审计后可提交规格、实现与测试检查点。Red 中间态可以不提交；TDD 证据独立保存，不要求“一个颜色一个 commit” |
| 归档前 | 获取并同步当前目标分支；默认采用 merge 保留已有历史，冲突由主会话协调修复；base 变化触发重验，不把 sync 当成普通成功命令 |
| 归档后 | 主会话只暂存本变更清单，固定 candidateTree，完成最终独立审查和验证，再提交归档；拒绝把用户差异或运行证据目录混入提交 |
| local | 重新确认 base 与候选提交；有合入授权则将分支合入目标分支并核查内容和可达关系；无授权保留可审阅分支及提交 |
| github | 推送变更分支，复用本仓正确 base 的 PR，等待 required CI，重新确认 head/base 后按授权合并，核实 PR 与 merge SHA、内容投影 |
| 收尾 | 已完成集成事实独立于清理结果；只删除已确认属于本 run、已合入且无用户差异的分支/worktree。清理失败报告 warning，不改写远端成功事实 |

分支准备由主会话在 `change new` 之前完成；`run init` 随后关联已存在的 change 和分支并核实 bootstrap，不隐式切换分支。创建分支、生成规格与真正执行模型是不同操作，不能把 CLI 创建模板描述成流水线已启动。

不直接在目标分支开发；同 change 默认复用其可核实的分支，不根据名称猜测归属。默认不 rebase 已发布分支、不 force push、不 reset 既有历史；用户明确要求其他 Git 策略时需另行制定证据与恢复方案。local profile 不要求 PR；是否强制关联事项由独立 tracking.required 决定，两个 profile 都适用。PR 可普通引用事项来源，初版不自动关闭来源事项，详见 [事项适配](15-tracking-adapters.md)。

“源码仓的 GitHub Actions、验证脚本或工作流配置变化”本身也属于变更范围：行为变化先更新 Spec/设计，维护任务说明适用性；重新核对 CI 条件、安装依赖和命令映射，更新 policy/plan/source 指纹及受影响审查。修改项目接入策略不能取消 Workflow 的基本门禁；修改通用协议则通过 Workflow 自身的新版本及安装升级交付。

如果归档后目标分支前移，或事项来源变化经复核需要修改已接受需求，不在已归档输入上直接修改并续推：先确认未集成，再按相应原因 reopen、同步/修订、重验和重新归档。无论 local 还是 github，完成状态必须来自当前 Git/远端事实，不能来自任务勾选、事项状态或归档目录存在。
