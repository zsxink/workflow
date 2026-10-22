# 安装、发布、升级与卸载

## 1. 发布单元

一个 npm 包，包含构建后的 CLI、本地 runtime、共享协议、角色、宿主模板、规格模板及格式描述。初始化用的 Markdown 模板放在仓库 `assets/templates/` 下，按协议、角色、宿主 Skill、入口区块和项目规则分文件维护；构建时嵌入单文件 runtime，安装后的项目不依赖源码仓或额外模板目录。最终包名发布前检查注册表并选定 scope；二进制命令名为 `workflow`。当前 package.json 标记 private，不构成可发布承诺。

模板内容契约：入口仅负责定位协议与能力检查；协议定义阶段输入、产物和停止条件；角色定义职责、路径边界和报告内容；项目规则记录已确认事实、命令与稳定规则 ID。`change new` 的 proposal/design/tasks 模板同样以中英文 Markdown 资产维护（`installer/<language>/change/`），不在 CLI 内维护第二份正文。模板应提示问题依据、影响能力、方案取舍、可观察验收、任务依赖和验证计划；未确认项显式保留，不能生成成功证据或默认授权。机器章节、任务字段和 ID 仍遵循 [规格规范](03-specification.md)，上游方法来源与取舍见 [参考资料](12-references.md)。

目标 Node.js 22.12+、Git。V1 以 npm 安装为主，不同时维护 Homebrew、独立二进制或下载脚本。普通依赖在构建/安装时锁定，分发产物包含所需运行模块和 notices；目标仓使用包后不再调用 npx 下载规格或状态工具。

用户已确认保留随仓提交固定 runtime 的分发方案；首轮以自用项目接入为先，不因试点绕过安装/升级安全契约。

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

优先宿主 ID 为 codex、claude，opencode、pi 保留为后续适配 ID；仅对当前版本已交付的 adapter 按项目选择物化入口，未交付目标返回 unsupported，不生成虚假可用入口。避免要求同时安装四个产品。安装器不启动这些宿主或安装外部子 Agent runner；宿主扩展依赖如未核实，只报告缺项，不能自动装扩展代替原生能力。doctor 分开报告入口存在、原生派发机制和实际角色隔离，尤其不能由 pi 扩展示例存在推断执行就绪。

## 4. install manifest

至少记录 formatVersion、packageVersion、assetFormatVersion、runtimeSha256、安装时间、模板语言（`zh-CN` 或 `en`）、宿主列表，以及每个 managed path 的 sourceTemplateId、installedHash、baseContentHash 与 mode。

初始化模板提供中文和英文两套。CLI 默认选择中文；交互终端可在初始化时选择语言，非交互调用可传 `--language en`。未重新指定时沿用安装清单中的语言。已安装项目可再次运行 `workflow init --language en` 切换语言：未修改的托管文件会更新，用户修改的文件仍按冲突处理；`.workflow/rules.md` 只有在内容仍与旧版默认模板完全一致时才会切换，定制规则会保留。

base 内容按内容摘要保存在随安装提交的 `.workflow/managed-bases/sha256/<hash>.json`，格式为 `{formatVersion: 1, encoding: "base64", sha256, content}`，hash/sha256 均针对解码后的原始模板字节；读取时解析 JSON、解码再核验摘要，不以工作树 JSON 的换行计算模板摘要，避免 autocrlf 改变模板原始内容。缓存不可手改；此目录自身不递归进入 managed 模板列表。fresh clone 后必须验证摘要，缺失/损坏时拒绝自动合并，不从当前用户文件推断旧模板。升级据此以“旧模板 / 现有文件 / 新模板”三方比较。用户配置、rules、规格和任务永远列为 user-owned，不能因名称一致被认领为可覆盖资产。

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
