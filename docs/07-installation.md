# 安装、发布、升级与卸载

## 1. 发布单元

一个 npm 包，包含构建后的 CLI、本地 runtime、共享协议、角色、宿主模板、规格模板及格式描述。最终包名发布前检查注册表并选定 scope；二进制命令名为 `workflow`。当前 package.json 标记 private，不构成可发布承诺。

目标 Node.js 22.12+、Git。V1 以 npm 安装为主，不同时维护 Homebrew、独立二进制或下载脚本。普通依赖在构建/安装时锁定，分发产物包含所需运行模块和 notices；目标仓使用包后不再调用 npx 下载规格或状态工具。

## 2. 两级版本

全局安装提供初始化/升级入口。`init` 将该版本 runtime 及协议物化到目标项目 `.workflow/runtime/` 和 `.workflow/managed/`，提交这些文件和 `install.json`。宿主入口只使用项目本地 runtime，保证 fresh clone 在具备 Node/Git 后能离线读取及执行该版本。

全局版本升级不修改现有仓；显式 `workflow upgrade` 才生成项目升级计划。项目不能同时出现一个版本的角色和另一个版本的状态解释器。

## 3. 安装步骤

1. `init --dry-run` 解析项目根、Git、目标宿主、已有目录和路径冲突。
2. 按配置或已核实的默认分支生成 config/rules 草案。
3. 计划 runtime、managed assets、共享 Skill 与所选宿主入口；入口不包含第二份完整阶段规则。
4. 写入前获得 project/install 锁，记录旧摘要和事务 journal。
5. 应用文件，写 install manifest；只有已知归属的区块可更新。
6. `doctor` 检查文件、版本、路径和本地能力；报告 installed 与 execution-ready 两种状态。

普通文件夹只允许计划或生成非执行草案；需要实际执行时要求 Git 仓库，init 不擅自创建远端、不安装 Agent 产品、不创建 GitHub Issue。

首批宿主 ID 为 codex、claude、opencode、pi，按项目选择物化入口，避免要求同时安装四个产品。安装器不启动这些宿主或安装外部子 Agent runner；宿主扩展依赖如未核实，只报告缺项，不能自动装扩展代替原生能力。doctor 分开报告入口存在、原生派发机制和实际角色隔离，尤其不能由 pi 扩展示例存在推断执行就绪。

## 4. install manifest

至少记录 formatVersion、packageVersion、assetFormatVersion、runtimeSha256、安装时间、宿主列表，以及每个 managed path 的 sourceTemplateId、installedHash、baseContentHash 与 mode。

base 内容保留在项目本地管理缓存，升级才能以“旧模板 / 现有文件 / 新模板”三方比较。用户配置、rules、规格和任务永远列为 user-owned，不能因名称一致被认领为可覆盖资产。

## 5. 幂等与升级

同版本重复 init：相同内容不写；发现用户修改时报告差异，不覆盖。第一次遇到已有未登记文件也按冲突处理，不能先写 manifest 宣称归属。

upgrade 先输出 added/updated/unchanged/conflict/removed 清单。无用户修改的 managed 文件可替换；有修改且可无歧义合并的区块生成审阅计划，有冲突则暂停该事务。主协议与 runtime 必须整体一致，不能跳过冲突文件后宣布升级完成。

存在运行中的 Agent 或未完成归档事务时阻止应用升级。挂起 run 在确认无写入者后，可按版本迁移计划升级，迁移完成必须重算 policy 指纹并重新验证必要阶段。

崩溃后依据 journal 恢复，比较目标实际摘要；不能无条件回滚用户后来编辑的文件。每次升级可回滚安装资产，但不能宣称历史运行状态可任意降级；未知格式需要明确兼容检查。

## 6. 卸载

uninstall 默认只移除仍等于 installedHash 的管理文件和明确区块。已修改文件保留并列出，不删除 `.workflow/specs/changes/archive`、项目配置、rules 和 Git 元数据中的证据。

运行中有 Agent、锁、事务或入口版本使用者时拒绝卸载 runtime。dry-run 展示将保留的文件。清除历史数据是独立显式操作，不与普通卸载合并。

## 7. 发布门禁

必须对 `npm pack` 产物在干净项目执行安装、fresh clone、离线命令、重复安装、升级冲突、崩溃恢复、卸载保留验收。测试不能依赖源码仓绝对路径或开发 node_modules。发布只在用户明确授权后执行。
