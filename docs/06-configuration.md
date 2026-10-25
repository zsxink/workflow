# 项目配置契约

配置位于 `.workflow/config.yaml`，示例见 [最小配置](../examples/config/minimal.yaml) 和 [GitHub 配置](../examples/config/github.yaml)。受限预览已实现严格解析；有效配置不代表对应远端或宿主能力已可执行，参见 [实现记录](17-implementation.md)。

## 1. 基本字段

| 字段 | 默认与含义 |
| --- | --- |
| formatVersion | 必需，当前为 1 |
| project.id | 必需，稳定逻辑标识，不能因移动目录改变 |
| project.name | 人类可读项目名 |
| project.authoritativeDocs | 权威文档的项目相对路径；内容保守纳入 policy 指纹，变化从 architect 重核 |
| project.rules | 默认 `.workflow/rules.md` |
| modules | 按稳定 ID 声明代码范围与角色；技术栈不内置 |
| hosts | 所选宿主 ID 列表：codex、claude、opencode、pi；安装与原生执行能力分别检查 |
| git.baseBranch | 默认安装时从仓库事实解析并写入，不能固定 main |
| git.branchPrefix | 默认 `workflow/`，允许项目覆盖 |
| integration.profile | local 或 github，默认 local |
| integration.mode | prepare 或 integrate，默认 prepare |
| tracking.required | 是否强制关联并核实主事项，默认 false；与 integration.profile 独立 |
| tracking.providers | 项目管理连接列表，默认空；每项有 id、adapter 和厂商命名空间配置 |
| validation.commands | 命令定义：ID、argv、cwd、timeout、模块与产物白名单 |
| validation.extraSourceInputs | 额外纳入指纹的 ignored 文件，默认空 |
| policy | retryLimit、crRoundLimit、epicConcurrency、requireScopedWriteIsolation；远端动作以 integration.mode 和 run 授权为准 |
| policy.requireScopedWriteIsolation | boolean，默认 false；true 时写角色必须具备已核实的 scopedWriteIsolation，否则挂起；false 仅允许披露为 audit-only 的范围保障，不降低 Reviewer 只读要求 |
| policy.epicConcurrency | 正整数，默认 3，仅限制 Epic 就绪任务并发，不授权重叠文件写入 |
| extensions | 预留命名空间；其余未知键 strict 报错 |

`integration.mode: prepare` 只准备归档/提交/集成计划；执行变更时主会话可在已获得授权后记录 run 级有效策略并推进，不能因配置值自动推断用户同意。integration.github 字段只在 github profile 校验为必需。tracking 的 github 连接独立校验，local profile 也可配置；integration.github.repository 不作为事项仓库默认值。

tracking.providers 中 id 唯一；首个支持 adapter=github，必须配置 github.server、github.repository。change.yaml 的 tracking.provider 必须命中已配置连接；tracking.required=true 且未配置可用连接时配置错误。旧的 policy.requireIssue 不再是有效字段，严格校验拒绝；未发布设计样例已改用 tracking.required，未来兼容已发布格式时需显式迁移。完整字段语义见 [事项适配](15-tracking-adapters.md)。

## 2. 模块与角色

```yaml
modules:
  - id: app
    paths: [src/**]
    role: developer
  - id: docs
    paths: [docs/**]
    role: developer
```

模块用于选择任务上下文和验证命令，不自动授予其全部路径写权限。本次任务 writeScopes 必须是模块范围的明确子集。角色覆盖通过项目维护文件引用，生成的 managed 角色不建议手改。

角色覆盖不得取消框架必要的不变量，例如 Reviewer 只读、子 Agent 禁 Git 写入、集成证据检查。需要修改产品不变量时，应作为 Workflow 自身的新版本设计。

## 3. 验证计划

每条 command 含唯一 id、executable、args 数组、cwd、timeoutSeconds、modules 和 artifacts。`modules: ['*']` 总是适用。要求 spec-gate 时为本变更选出明确命令列表；空列表须有适用性理由与手工验收计划，不能默认当通过。

命令按配置顺序串行是 V1 默认。并行 lane 为后续优化，不能根据 backend/frontend 名称自动推导。环境透传使用显式 allowlist；日志不打印变量值。

预览实现的 `validation.commands[].envAllowlist` 默认 `[]`，运行 npm 等依赖 PATH 的命令应显式声明 `[PATH]`。执行器以 argv 直接启动，截断日志仍保留完整原始流摘要，按敏感环境变量名称识别的值做脱敏。它不是进程/文件系统沙箱，不能证明配置脚本不间接启动其他程序。Windows `.cmd/.bat` 执行暂不支持；未完成 Windows 验收。

本次变更必须从已声明命令中形成明确的适用命令集，并将“适用/不适用/手工验收”及理由写入验证计划和运行证据。命令可声明稳定的 `modules` 与产物白名单；项目可把不变量检查脚本作为命令登记。引擎不内置 `npm`、`cargo`、特定测试框架或项目目录判断，也不允许以空命令集隐式通过。

`policy.retryLimit` 默认为 2，表示首次尝试之后同一问题允许的重试/修复次数；`policy.crRoundLimit` 默认为 3，表示同一变更实现修复链的 CR 总轮数。归档后的首次最终审查是独立门禁，修复后的实现复审继续计入原 CR 轮次；最终门禁失败后的再次执行受 retryLimit 约束。额度跨恢复、重新归档和同 change 的后继 run 继承。达到上限进入 suspended，只有明确的新用户决策可追加额度，新建 run 本身不提供新额度。

CI 映射是验证计划证据而非未声明的 config 顶层字段。记录格式为 `{status: mapped|not-applicable, rationale, entries: [...]}`；每项含 workflowPath、workflowHash、jobId、conditions、runner、toolVersions、setupSteps、requiredEnvNames、commandIds、execution（local/remote-required）。commandIds 必须命中声明命令；仅远端执行项可为空，但须有远端检查标识及理由。无 CI 时 entries 为空并说明依据；不接受环境变量明文值。

验证计划还应核对项目现有 CI：记录 workflow 文件摘要、job 条件、运行器/工具版本、安装步骤、系统依赖、必要环境变量名与对应 command IDs。项目提供映射，主会话和独立审查者核对完整性；V1 不宣称自动理解任意 CI 配置。无 CI 的项目记录 not-applicable。本地适用命令缺依赖时先准备环境或标为 blocked，不得改成 skip；由项目策略明确只在远端执行的检查单列 remote-required，留给 wait-required-ci 检查，不能算作本地已通过。CI 文件或命令/依赖变化须重选计划并使相关证据失效。

相同任务复用验证的缓存键包括 executable/argv/cwd、输入指纹组、相关环境摘要、工具版本及命令计划。V1 首先采用真实执行，不优先引入复杂缓存。

任务 Test-Commands 同样引用 validation.commands，可声明定向测试命令与所选回归命令；不为某个框架拼接过滤参数。Red 与 Green 配对须使用同一测试内容、命令和环境，记录预期失败断言而非仅检查非零退出码。行为任务默认要求 TDD；verification/exempt 的适用性由 spec-gate 按任务理由及替代验收检查，项目配置不能把缺依赖或测试失败解释为自动例外。任务内命令结果不代替最终 Verify/verify-final。

## 4. 路径与命令约束

cwd、输入、产物、角色覆盖路径必须相对项目根，规范化后位于边界内；绝对路径、`..` 逃逸和符号链接越界被拒绝。读取运行根使用 Git 解析路径，不接受普通任务路径覆盖共享 Git 元数据。

命令是显式可执行文件和参数，不将字符串交给 shell，不自动运行 package.json 中任意脚本。配置可指定 `npm` + `['run','build']`，其行为与项目自身脚本授权一致。Windows 可执行文件解析由进程层统一处理，不能让宿主模板各自拼命令。

产物排除是基于真实项目根的明确 glob，不允许 `**` 排除整个项目。与声明源范围有交集时配置校验报错，防止构建白名单掩盖源码写入。

判定只看字面前缀：产物 glob 与模块范围都必须有确定的、无 glob 分量的首段目录，才能证明二者不相交；任一侧是项目根级模式（如模块 `paths: ['**']`、`['.']`，或产物 `['**']`）时无法证明，按相交处理并报错。安装生成的默认模块是项目根级占位 `paths: ['**']`，项目必须先用真实目录替换，再声明构建产物；这不是自动探测，而是把“构建产物与源码分离”留给项目显式确认。

## 5. 生效与迁移

配置一经修改，重新计算 policyFingerprint 和验证计划，恢复算法使对应下游失效。自动检测可给建议，不未经确认写入或执行猜测结果。

新增不兼容字段升级 formatVersion 并提供迁移计划；未知版本不能按宽松 YAML 静默加载。项目安装版本写在 install manifest，配置不以全局包版本决定解释语义。
