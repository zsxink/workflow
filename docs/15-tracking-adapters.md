# 项目管理事项适配

本契约将需求来源建模为外部 work item，界面可显示 Issue、任务或工单。当前为设计，尚无适配器实现；首个交付为 GitHub Issues 只读接入，其他项目管理软件后续按同一契约扩展。

## 1. 与仓库集成分开配置

`tracking` 管事项读取、身份和输入快照；`integration` 管 Git、PR、required CI 和合并事实。两者独立：本地 Git 项目可以读取 GitHub Issue，GitHub PR 项目也可以从其他事项系统接入或不关联事项。事项所在仓库不必等于代码仓库。

| 层 | 职责 | 不承担的事实 |
| --- | --- | --- |
| tracking adapter | 获取事项标题、正文、状态、标签和来源版本，保留平台原始字段 | 规格批准、源码验证、PR 是否合并 |
| repository adapter | 分支、推送、PR、CI、merge SHA、当前集成事实 | 需求来源的生命周期或任务状态含义 |
| workflow | 将事项内容转成 proposal/场景，执行授权与门禁，关联本地 change 和证据 | 从标签或状态自动推断用户授权 |

适配接口内置于同一版本化包，首版不建设动态第三方插件加载器。后续可新增 Jira、Linear 等适配实现，通用阶段图和规格格式不增加厂商分支；这些实现目前不在交付承诺中。

## 2. 连接配置与事项引用

项目配置中的 `tracking.providers` 是连接列表；每项有稳定的本地 id、adapter 类型和厂商命名空间配置。首版只接受 adapter=github；不识别的 adapter 明确报不支持，不能回退到 GitHub。允许配置多个 GitHub 连接，便于不同项目空间。

```yaml
tracking:
  required: true
  providers:
    - id: github-issues
      adapter: github
      github:
        server: https://github.com
        repository: example/planning
```

GitHub 连接的 server 和 repository 均显式固定；不从当前 Git remote 推断事项仓库。认证由对应连接/宿主环境提供，配置只可引用凭据来源，不写 token。无效连接、认证不足和网络失败按不同诊断返回；required=true 时不能将读取失败当成未关联事项继续。

每个 change 在 `change.yaml` 中可有一个主事项引用：

```yaml
tracking:
  provider: github-issues
  itemId: "42"
```

provider 引用配置连接 id，itemId 为平台范围内的不透明字符串。实际身份由 adapter、规范化 server、项目空间/repository 与 itemId 联合确定，不能仅用 `#42`、标题、URL 或本地连接别名去重。每次解析引用都绑定连接配置摘要；更改连接指向不能悄悄把同一个 change 重新绑定到另一个事项。GitHub 初版在指定 repository 内按事项编号解析，并确认对象确为 Issue，拒绝把 PR 当作输入事项。

tracking.required 默认 false；未配置时允许用户直接提供需求并创建本地 change。required=true 时 bootstrap/spec-gate 要求主事项身份已核实且有输入快照。首版一个主事项不意味着一个事项只能对应一个 change；一个事项可拆成多个变更，其关闭状态不决定这些变更是否集成。

## 3. 适配器契约与标准快照

```ts
interface TrackingAdapter {
  id: string;
  inspectCapabilities(connection: TrackingConnection): TrackingCapabilities;
  readItem(input: TrackingReadRequest): Promise<WorkItemSnapshot>;
}
```

能力按 supported/unsupported/unknown 报告。首版只实现 readItem；创建事项、搜索同步、评论、状态回写与自动关闭均不在首个实现范围，不生成伪成功记录。业务阶段只依赖标准模型，不 import github 实现。

标准快照包含 canonicalIdentity、canonicalUrl、title、description、原始状态/标签、可用的 sourceRevision、内容摘要、fetchedAt、adapterVersion 和连接配置摘要。厂商特有字段留在明确的 providerData 中；没有映射的状态保留 unknown，不把 closed/done 直接映射为 Workflow success。

只读查询可以返回快照而不修改 run。执行时由主会话显式绑定到 run 的 evidence；持久化快照按摘要引用，state.json 只维护已接受快照引用和处理决策，不另建同步数据库。默认快照留在运行证据目录，不把可能包含内部信息的完整事项正文自动提交 Git；proposal 保留采用的需求和必要来源引用。

## 4. 输入变化、授权与恢复

外部事项是需求输入，正式 Spec 仍是本项目的行为契约。获取事项不代表需求批准；其中的文本、标签和链接不能当作执行命令或额外权限。主会话提炼 proposal、场景和范围后，按已有用户授权记录审批。

启动/恢复、进入集成及提交归档/推送/合并前，由工作流应用层重新读取当前主事项，与已接受快照核对；这些来源检查不放进 repository adapter，也不要求两个远端查询构成跨系统原子快照。required=true 时无法读取则挂起；未要求事项的纯本地变更不因此依赖网络。已绑定的可选事项读取失败时记录 unavailable，保留旧快照并挂起涉及来源新鲜度判断的推进，由主会话显式记录在现有授权范围内是否继续，不能把失败报告成未变化。

内容变化先标记 needs-triage，主会话比较差异。若影响已接受的行为、范围、设计或验证计划，先修订权威文档并使相关审批/CR/Verify 失效；若只有与本变更无关的标签或状态变化，记录无语义影响的依据后继续。不因 fetchedAt 刷新而使证据失效，也不无条件把外部正文覆盖进 Spec。恢复中源引用改动或连接重绑定必须重新核实身份和授权。

若已归档但尚未集成，且来源变化经 triage 确认需要修订活动输入，先停止提交/推送/合并，以 `source-changed` 原因引用前后来源快照和处理决策，经 [受控 reopen](03-specification.md)核实未集成及原输出摘要后恢复，再修订、重验和重新归档；不得直接编辑归档。已集成后出现新需求，只创建后续 change，不倒改完成历史。来源事实可能在最后查询后继续变化，证据记录实际查询时点，不承诺跨系统无竞态事务。

事项关闭、被删除或访问失败不证明代码完成。Epic 依赖继续按当前本地集成或 PR 合并事实解锁；不按厂商事项状态推断。一个事项关联多个 change 时，不因其中一个合并就自动关闭主事项。

## 5. 与 PR 的关联及扩展

PR 正文可引用主事项 canonicalUrl。只有来源平台、server、目标事项身份及关闭语法可核实，且有明确授权时，未来才可生成自动关闭关系；初版仅生成普通引用，不自动加入 `Closes #N`，避免跨仓或跨平台误关闭。PR 所属 repo/base 必须由 repository adapter 独立核查。

后续状态回写需新增能力契约、权限、幂等 operation ID、当前来源 revision 核查和独立 checkpoint。代码集成成功与事项回写成功分别报告；跨系统操作没有整体原子事务，回写失败不回滚已完成合并，也不能冒称事项已更新。
