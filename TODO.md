# 待修复项（2026-10-24 代码审查发现）

来源：`src/` 只读代码审查 + 文档一致性复核。严重度按对防伪目标与可用性的影响排序。
完成后在本文件勾除，并在 docs/17-implementation.md 记录验证范围。

## 已完成

- [x] #1 digest 割裂：`commandPlanDigest` 单命令 vs 数组两种语义混用，导致 `dispatch audit` 产物接收必然误报。已统一为：证据记录存单命令摘要，`taskPlan` 存任务级数组摘要。（commit 32e60c0，130 项测试通过）

## 高严重度（阻断正确性/防伪）

- [x] #2 `state.fingerprints` 永不刷新
  - 位置：`runtime/state.ts:24` 初始化，`application/dispatch.ts:51` 仅 `??=` 一次；`workflow/receipts.ts:105` 校验起始快照与之比对。
  - 触发：Architect 完成 → 规格变更 → Developer-red 准备派发 → audit 判定 `OUTPUT_BASELINE_STALE`/`INPUT_CHANGED`，后续角色无法继续。
  - 根因：`state.fingerprints` 有两个刷新点（`applyAcceptedOutput`、`invalidateForInputs`），但应用层按设计 fail-closed，均无调用者。它不是"忘记刷新"，而是把当前阶段永不推进的派生视图当成硬门禁基准。
  - 已修：`workflow/receipts.ts:105` 比对基准改为「准备回执 + dispatch.fingerprints 恒校验；workflow 级指纹仅在已有任一 `outputReceipt`（即基线确被合法推进）时参与」。`application/dispatch.ts` 的 `??=` 语义本身正确（不覆盖已推进基线），保留。回归见 `tests/receipts.test.ts` 两项：bootstrap 基线不否决后续合法 attempt；已接收产物后旧基线派发仍被拒绝。
  - 遗留：持久化接收路径（同步刷新 `run.fingerprints`）仍受宿主来源验收阻塞，未开放。

- [x] #3 默认配置使验证命令全量失败
  - 位置：`project/index.ts:206` `globPrefix('**')` 解析为空字符串，`mayIntersect('','')` 返回 true → `CONFIG_ARTIFACT_SOURCE_OVERLAP`；`installer/index.ts:165` 默认模块 `paths: ['**']`。
  - 触发：安装后项目一旦声明 `validation.commands[].artifacts`，loadConfig 抛错；`captureFingerprints` 永远无法排除构建产物，任何写文件命令触发 `COMMAND_INPUT_CHANGED`。
  - 根因：`globPrefix` 把项目根级模式（`**`、`.`）归一成空字符串，`mayIntersect` 再按“空前缀即相交”处理。真正的漏洞在**源码侧**：模块 `paths: ['.']` 或 `['**']` 与任意产物 glob 被判相交（正确），但 `['.']` 曾被漏判为不相交，使构建白名单能掩盖源码写入。
  - 已修：`globPrefix` 对项目根级模式返回 `undefined`（不再产出空前缀）；`mayIntersect` 参数改为 `(artifact, source)`，任一侧无字面前缀即判相交并 fail closed。`docs/06-configuration.md` §4 与 `docs/05-runtime.md` §3 同步该判定契约。
  - 安装默认模块保持 `paths: ['**']` 作为占位（未虚构项目目录结构），文档明确要求先用真实目录替换再声明产物。
  - 回归：`tests/project.test.ts` 一项（`['.']` 与 `['**']` 均被 `CONFIG_ARTIFACT_SOURCE_OVERLAP` 拒绝，有界范围仍通过），`tests/install.test.ts` 一项（安装草案 → 声明产物被拒 → 替换真实目录后 loadConfig 与 `captureFingerprints` 均通过）。前者已确认在修复前代码上失败。

- [ ] #5 自报 host-evidence 控制执行就绪态
  - 位置：`hosts/evidence.ts` 解析 `.workflow/host-evidence.json` 后直接设置 `executionReady`/`roleIsolationVerified`/`nativeDispatchVerified`；references 从不验证存在性，capabilities 全凭自报。
  - 触发：伪造 JSON → doctor 误判环境 → gated 命令集可能被解锁，违背"提示词/自报不能代替权限隔离"。
  - 修复方向：host-evidence 仅作诊断输入，就绪态需能力探测 + 签名/白名单核对；拒绝未认证来源声明 ready；补伪造回归。

## 中严重度

- [ ] #4 validate gate 顺序静默中毒
  - 位置：`application/dispatch.ts:30` architect 走 draft gate；`src/workflow/dispatch.ts:75` 相关假设。undeclared testCommands 时 `config.validation.commands.find(id)!` 返回 undefined 污染 taskPlan。
  - 修复方向：task 作用域派发前强制命令声明唯一性检查（复用 `runtime/evidence.ts` declaredTaskCommands 的断言）；对 taskPlan 字段存在性断言。
  - 注：receipts.ts:35 的 `task!` 空断言崩溃已随手修复于 commit 32e60c0。

- [ ] #6 `transactions.ts:84` expectedHash 可选 → 调用方省略时退化为最后写入获胜，无 STALE_INPUT。修复方向：写事务强制 expectedHash 或明确文档化调用方义务并加断言。

- [ ] #7 `installer/index.ts:77` manifest() 对每个 managedPath 强制 readBase；清理 `.workflow/managed-bases/**` 后 uninstall/doctor 全部 `MANAGED_BASE_MISSING`。修复方向：按操作意图惰性读取 base。

- [ ] #8 `fingerprints.ts:102` 每个排除目录线性过滤全部 tracked entries，大仓二次方退化。修复方向：按目录前缀建一次索引或排序后二分。

- [ ] #9 `io.ts:13` `open(dirname,'r')` + `sync()` 在 Windows 不可用。修复方向：平台分支跳过目录 fsync 并记录限制；Windows CI 验证。

- [ ] #15 `spec/validate.ts` integration gate：`loadChange()` 永不填充 `integrationEvidence` → `--gate integration` 实际不可达（当前是 fail-closed，方向安全，但开放接收前必须补自动化验收集成路径）。

## 低严重度

- [ ] #11 版本字面量多处硬编码（`cli/main.ts:24` fallback、`runtime/state.ts:17`）依赖 build define 注入；核实 `__WORKFLOW_VERSION__` 实际生效并收敛到单一来源。
- [ ] #12 `fingerprints.ts:93` PATH_COLLISION 用 NFC+lowercase 归一化，在大小写敏感文件系统误杀 `App.js`/`app.js`。
- [ ] #13 `installer/index.ts:278` `status === 'preserved'` 分支无写入方，属死路径或防御缺口。
- [ ] #14 `spec/sync.ts` planSync 在 SPEC_TARGET_MISSING 诊断后仍写 tombstone，消费者忽略诊断时有 latent resurrection。

## 死代码 / 缺口

- [ ] 无调用者导出待确认：`project/index.ts selectCommands`、`runtime/state.ts inheritBudgets`、`workflow/tdd.ts completeRefactorWithoutChanges`、`workflow/receipts.ts applyAcceptedOutput`（应用入口未开放前属预期保留）。
- [ ] TDD 工作流缺 CLI 入口：`recordTestStep`/`acceptRed`/`assessVerification`/`attachDispatch` 仅纯函数导出，属 roadmap M3「TDD cycle 开启/接受/步骤 CLI」待办。
- [ ] 并发/竞态模拟测试缺失；CAS race、symlink 攻击向量、security-critical 证据校验序列覆盖稀疏。

## 文档状态修正（与代码同步）

- [ ] `docs/10-roadmap.md:148-153`「本轮复核新增验收（未实现）」节过期：M1 七项、M2 大部分、M3 混合状态项实际已实现并有回归；仅 takeover、candidate capture/confirm、approve 来源核查确属未实现。建议区分「领域实现（有测试）/ 阶段验收（含门禁）」两列。
- [ ] M0 勾选项过期：规格语法/AST/ID/formatVersion 已冻结。
- [ ] `docs/16-comprehensive-review.md:421`「审批、派发、测试、安装命令仍不能运行」已被现状推翻，需加快照日期声明或改写。
- [ ] README:34「只读」修饰范围含糊：`dispatch prepare/collect`、`test-cycle baseline` 需写凭据并持久化记录。
- [ ] 磁盘仅 `.artifacts/…preview.1.tgz`，版本号已是 `0.1.0-preview.2`：重新打包并记录验收。
- [ ] `docs/17-implementation.md` 归档行补注「仅投影校验，事务未开放」。
