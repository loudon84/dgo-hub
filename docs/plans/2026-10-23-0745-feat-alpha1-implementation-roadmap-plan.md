---
title: "feat: Alpha.1 增量实施路线（复用 integration-service）"
type: feat
date: 2026-10-23-0745
updated: 2026-10-23
revision: "1.1"
status: REVIEW
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
origin: docs/数据治理与本体集成中台_产品架构与二开说明_v1.0.md
execution: code
deepened: 2026-10-23
---

# Alpha.1 增量实施路线

**Goal：** 在现有 integration-service 和四页面扩展 spec 上补齐产品合同与验收，避免重复建仓、重复实现和后端全部完成后才启动 UI 的等待。

**Architecture：** 沿用 PostgreSQL + OpenMetadata + Helix Foundry + Hasura V2，保留 hub-api / hub-worker / hub-publisher / sales-mcp 四进程职责。M0–M6 仍按主 PRD 29.2 判断正式退出；阶段内的开发、契约和本地验证可以交错推进。

**Tech Stack：** 现有 TypeScript / Node.js 集成工程；OpenMetadata 2.0.6-release、Hasura v2.51.1、Helix 00d7927d7c08e16c58316e006959f052427e7fa1。运行身份仍须由 deployment.lock 核实。

**Spec：** [主 PRD](../数据治理与本体集成中台_产品架构与二开说明_v1.0.md)；[OpenMetadata 四页面 spec](../OpenMetadata_UI扩展规格说明_v1.0.md)；[阶段门禁检查表](phase-gates-alpha1.md)。

> 本轮交付是路线文档修订，不执行下文代码任务，也不补签产品批准。文档中原有的执行指令和“user-approved”历史标签均作为待核实项目资料，不据此推定审批或完成状态。本轮代码检索与阅读已按用户要求交给 GPT-6 Luna subagent；主会话依据其报告编排计划。

## Goal Capsule

- **Objective：** 将已有验证工程推进到 Alpha.1；全部 required A/N/FI、完整 UI 和真实 Golden Consumer 均有可核对证据后放行。
- **Means：** 先登记可复用资产与差距；先固定身份、数据和 API 合同，再按 M0–M6 增量补齐；页面随所属能力分批开发；证据从第一批任务开始采集。
- **Authority：** 主 PRD 的 SCOPE / REQ / ADR / A / N / FI 为产品基线；四页 spec 是聚合视图，不能自动缩减主 PRD。实际目录采用用户已创建的 integration-service。
- **Stop when：** 本轮路线、增量任务及阶段门禁完成一致性检查。后续工程任务只有满足各自证据要求才能标 verified。
- **Out of scope：** 本轮不改产品行为、上游源码、生产环境或密钥；不承诺未评估的人日；不因原型已运行而宣称阶段已验收。

## Product Contract

### 1. 修订结论与现状

原计划的“尚无集成仓库”“五工具和模块全部留待以后实现”已经过时。当前存在七个模块、Compose、迁移、示例及测试脚本，也存在四页 UI spec。它们是应复用的起点，但与主 PRD 仍有差距。

本次现状核对由 GPT-6 Luna 静态阅读完成，未读取本地秘密文件、未修改代码、未运行测试。前次会话报告已通过类型检查、构建、9 项测试及本地 REST/ETL/MCP/权限发布验证；这些结果可作为历史线索。本次未发现符合 PRD 第 24 章的完整运行证据包，因此不能将历史报告直接兑换为任何 A-ID 或阶段 verified。真实系统联调和页面运行验收仍未执行。

| 已有资产 | 可复用内容（Luna 静态证据） | 本轮计划中的判断 / 去向 |
|---|---|---|
| ingestion-api | REST、失败记录、管理接口；routes.ts:11–27 | 部分实现；M1 补 Source Registry、批次/job 和来源身份；管理身份在 M0 补齐 |
| etl-worker | PostgreSQL 示例表、逐行水位、hook 重试；worker.ts:7–44 | 部分实现；M1 补 SQL Server、完整快照、增量启用合同、删除对账、串行扫描 |
| normalization | 幂等摘要、版本防旧、整单事务；store.ts:7–48、db.ts:3–8 | 复用事务核心；M1 补齐版本冲突、租户/来源复合键及故障验收 |
| ontology-binding | Helix 活动代次、OM 表/字段读取、绑定保存；binding.ts:12–26、routes.ts:35–46 | M3 的适配起点；资产登记/质量/血缘、投影、不可变 Binding Release 尚需实现 |
| permission-publish | 行列权限、CAS 替换、回读和 gate；hasura.ts:45–76 | M2 复用；补角色/关系授权、全局锁、漂移、canary、回执、撤权及恢复 |
| sales-mcp | 五固定工具、JWT 验证、短时 Hasura JWT、审计；tools.ts:1–7、server.ts:10–50、queries.ts:15–36 | M4 复用协议和查询层；M0/M2 先补用户凭据与授权生命周期 |
| acceptance-tests | 单元测试与 live 脚本；core.test.ts:6–25、integration.test.ts:6–20 | U6/U7 扩展为独立 Oracle、负向、故障和证据门禁；现有测试不全量覆盖 PRD |
| 四页 spec | 页面职责、接口、状态及验收说明 | 文档已存在，页面未实现；M5 按后端能力分批交付 |
| Compose | api / worker / publisher / mcp 分进程；compose.yaml:28–85 | 可复用启动入口；默认网络/共用 DB 账号/开发配置不能作为 M0 隔离证据 |

上述源码路径均相对 integration-service/；行号为本次静态快照定位，后续变更以复核后的文件为准。静态“存在”不等于运行正确。

### 1.1 优先处理的静态风险

下表是 Luna 阅读代码得出的潜在风险，尚未运行复现；后续先编写对应回归用例，再修复，不能将其记为已经发生的生产故障或测试 FAIL。

| 风险 | 静态依据 | 优先级与阶段交付 |
|---|---|---|
| 同实体同版本异内容、换 eventId 后被记为 stale，未按合同隔离 | normalization/store.ts:11–18、24–44 | M1 阻塞；补 SOURCE_VERSION_CONFLICT、内容摘要与隔离回执；不同 eventId 用例必须覆盖 |
| ETL tick 可能重叠；手动 retry 只改状态，未形成可追踪重放 | etl-worker/worker.ts:18–32、46–49；ingestion-api/routes.ts:31–34 | M1 阻塞；扫描互斥、受控重试/隔离、水位与重放 operation 可追踪；不把 hook 退避当成 ETL 重试已完成 |
| 订单/明细按各自 owner 字段授权，客户转交或删除后可能保留旧可见性；详情查询缺少删除过滤 | permission-publish/policy.ts:13–18；normalization/store.ts:27–31；sales-mcp/tools.ts:3–6 | M2 最高优先级；订单→客户、明细→订单→客户统一有效授权；转交/部门变更/删除的全路径回归 |
| Publisher 启动未先关闭现存 gate，bootstrap 出错时可能延续 open | permission-publish/hasura.ts:12–38；migrations/001_init.sql:57–61 | M2 最高优先级；启动恢复先判 durable operation / observed，再确定是否开闸；重启+漂移/失败用例 |
| 发布期间新草稿 revision 可能被旧快照完成回执覆盖；worker 无可靠 claim/实例发布锁 | permission-publish/worker.ts:8–15；hasura.ts:65–76；ingestion-api/routes.ts:55–61 | M2 最高优先级；不可变审批输入、revision CAS、实例级锁、操作回执；并发保存/审批/发布与崩溃恢复用例 |

M0 可信身份和最小权限同属最高优先级。上述修复可以沿现有实现增量完成；未通过相关回归前，不接入真实销售身份做业务验收。

### 2. Requirements（保留 R1–R7 的追踪身份）

- **R1 审批与执行状态分开：** 记录五方批准和环境合同；不得推定 APPROVED_FOR_PLAN。文档修订、差距审查、用户已授权的隔离实验可以继续；正式阶段验收仍依主 PRD 门禁。
- **R2 开发并行、验收有序：** M0–M6 的正式依赖不变；允许成熟合同上的增量开发，禁止仅因代码存在就跳过前置阶段。
- **R3 架构不变：** 业务数据先进 PostgreSQL；Helix 投影不作查数旁路；销售明细/汇总统一经 Hasura；四进程按职责隔离。
- **R4 复用实际目录：** 集成代码根目录为 E:/git/dgo-hub/integration-service，保留七个模块；不另建治理集成空仓、不为对齐“建议布局”搬迁全部代码。独立版本控制、CI 和必要的企业集成分支另行建立。
- **R5 合成与真实各有门禁：** 合成测试用于快速迭代；真实 CRM、订单和 Hermes 的批准输入仍是放行条件；至少两名销售及一名部门经理独立测试身份。
- **R6 本计划决定阶段与增量包：** 给出依赖、文件落点、验证及负责人角色。详细函数签名、迁移和测试实现由后续阶段计划承接；不在此推断缺失的业务授权。
- **R7 运行基线可复现：** lock 记录实际运行的源码、镜像 digest、配置 Schema、连接/网络探测。参考源码版本、构建输入和运行镜像不得混为一项；空 digest、latest 或不匹配阻断正式 M0。

### 3. 全局约束与复用决策

- 主 PRD 第 9、14、20–29 章及附录 A/B/C/D 的合同和验收 ID 保留；此计划不把 sales_reader 演示角色改名后视为完成 sales / sales_manager。
- 保留现有单条演示接口的内部处理能力；正式 hub.v1 批次合同、来源绑定和返回状态须补齐并明确兼容边界，不让 UI 长期依赖两套不一致合同。
- Hasura admin secret 继续仅由 Publisher 持有；管理 OIDC、来源凭据、个人 Agent 凭据分别管理。
- 前端先冻结 OpenAPI/schema、分页、错误、revision、身份与状态合同；不要将缺项一律藏进网关转换。
- 受管权限 CAS、gate、字段映射读取均复用，补齐失败与恢复分支；不重复从零实现相同机制。
- 原计划“所有未来 fetch 都必须走 127.0.0.1:7897”降为历史环境记录；后续实际连接配置写进部署说明，不能当作永久前提。
- 四页 spec 所用 P1–P4 是聚合入口，不等于主 PRD P01–P12 已全部覆盖；P01/P05/P12 及凭据、模型提案等遗漏动作仍在范围内。
- 四页 spec 第 9 节暂列的 M0–M4 与主 PRD 阶段含义不同；本路线统一使用主 PRD 的 M0–M6，页面增量使用 UI-1–UI-5。后续同步 spec 时替换该局部阶段编号，避免把“页面 M2”误当成授权查数 M2 已完成。
- 产品范围外事项继续遵循主 PRD：源系统业务回写、通用 NL2SQL、任意 SQL/GraphQL、湖仓、全行业主数据自动合并、Ranger/OPA/SQLBot、新 Agent Runtime 不纳入 Alpha.1。

### 4. Review Focus

| 高风险输入或时序 | 用户应看到的结果 | 主要任务 / 验收 |
|---|---|---|
| 伪造 tenant/user/role，或凭据在查询中撤销 | 无越权；未交付结果丢弃 | M0/M2/M4；A/N-AUTH、FI-10 |
| 同版本异内容、订单局部写入失败、半份快照 | 隔离/回滚，不推进错误水位，不误删 | M1；A/N-DATA/ETL、FI-01–05 |
| 客户转交、部门变更、删除后关系查询 | 订单/明细随客户有效授权变化 | M2；A/N-SEC |
| 发布超时、CAS 冲突、重启、撤权/回滚失败 | 不误开 gate；可恢复，不放宽撤权 | M2/M5；A/N-POL、FI-06–09 |
| 四页只完成查看、报告缺证据或用合成冒充真实 | 必须动作完整；Gate 拒绝错误放行 | M5/M6；A/N-UI/EVID、Golden Consumer |

## Planning Contract

### Key Technical Decisions

- **KTD1：以存量差距包推进。** 原 U1–U7 由“创建准备骨架”改为“补齐准备与继承已有实现”；保留追踪 ID，不重建已有七模块。
- **KTD2：M 编号是正式验收阶段，不是全项目只能串行写代码的限制。** M3 正式退出仍依 M1+M2，M4 依 M2+M3，M5 依 M0–M4，M6 依 M0–M5。
- **KTD3：把共享安全能力前置。** 可信身份、数据库/网络最小权限在 M0；权限执行器恢复与核心审计在 M2 提前补齐；M5 完成完整权限 UI 与观测验收。不得等真实 Hermes 接入后才解决权限发布安全。
- **KTD4：页面按契约分四条增量线。** 接入页随 M1、本体页随 M3、权限页随 M2、Agent 页随 M4 开发与联调；正式 A-UI/A-POL/A-OBS 在 M5 汇总。
- **KTD5：证据与现场准备贯穿全程。** U6/U7 在首批任务完成；Hermes 版本、来源映射、测试身份和 Owner Oracle 从现在就收集，不能全部留到 M4 才发现阻塞。

### 阶段现状与退出标准

当前实施单元采用 planned / implemented / verified / blocked；验收采用 PASS / FAIL / BLOCKED / SKIPPED / NOT_RUN。以下“部分实现”是静态判断，不是 verified。正式阶段尚无齐套证据，不直接宣称哪一阶段完成。

| 阶段 | 当前基线 | 下一步补齐重点 | 正式退出（完整清单见阶段门禁表） |
|---|---|---|---|
| M0 基线与安全 | 四进程/Compose 已有；隔离、lock 和身份未闭环 | U1/U3/U4/U5，可信身份与凭据合同 | A-ARCH/N-ARCH、A-AUTH/N-AUTH 基础子集 + lock |
| M1 上游接入 | REST/PG ETL/事务部分实现 | 来源注册、批次回执、完整快照/SQL Server、对账/隔离 | A-SRC/ING/ETL/DATA 及对应 N、FI-01–05 |
| M2 授权查数 | sales_reader + CAS/gate + 固定查询已有 | sales/manager、客户关系权限、查询合同、发布恢复 | A-SEC/API 及所有相关越权 N；POL 引擎/FI 提前验证 |
| M3 治理本体 | 只读读取与字段映射已有 | OM 资产/质量/血缘、Helix 投影/发布、Binding Release | A-GOV/ONT/PUB、对应 N、FI-11 |
| M4 Hermes | 五工具和本地协议测试起点已有 | 用户凭据生命周期、真实来源/身份/Profile、业务对账 | A-MCP/AGENT、对应 N、完整 AUTH 和真实消费端 |
| M5 统一 UI | 四页 spec 已有，页面未实现 | 四线 UI 增量 + P01/P05/P12 补足、权限/审计收口 | A-UI/POL/OBS、对应 N，完整 P01–P12 必须动作 |
| M6 放行 | 包装脚本已有，证据 Gate/运维验收未闭环 | required 结果校验、恢复/性能/端到端、真实证据 | A-OPS/EVID、对应 N、18 A + 18 N + 12 FI 全 PASS |

~~~mermaid
flowchart LR
  BASE["已有代码 + 四页 spec"] --> W0["接管基线 / U1-U7 / M0 加固"]
  W0 --> M1["M1 数据接入"]
  M1 --> M2["M2 授权查询与发布恢复"]
  M1 --> M3["M3 治理与绑定验收"]
  M2 --> M3
  M2 --> M4["M4 真实 Hermes 联通"]
  M3 --> M4
  M1 -. "契约成熟即可开发" .-> UI1["接入页"]
  M2 -.-> UI3["权限页"]
  M3 -.-> UI2["本体绑定页"]
  M4 -.-> UI4["Agent 页"]
  UI1 --> M5["M5 全 UI / POL / OBS 验收"]
  UI2 --> M5
  UI3 --> M5
  UI4 --> M5
  M4 --> M5
  M5 --> M6["M6 Release Gate"]
  W0 -. "持续收集证据" .-> M6
~~~

实线表示正式验收依赖；虚线表示可提前的开发/准备工作。M3 适配器和 UI 可依据稳定合同提前开发，但正式退出条件仍按表执行。

### 执行批次与可并行范围

| 批次 | 主线 / 必须先解决 | 可并行工作 | 可以进入下一批的交接物 |
|---|---|---|---|
| W0 接管基线 | U1–U7 中的批准缺项、基线/隔离、安全合同、测试归档 | 来源 Owner 取数合同、Hermes 版本/Profile/身份准备；四页 API 差距表 | 版本/路径/差距清单、合同草案、证据采集入口；正式 M0 按门禁判断 |
| W1 数据闭环 | M1 共享标准模型、source identity 和 hub.v1 先固定 | REST 来源配置与 PG/SQL Server ETL 分工；接入页 mock/契约开发 | 可复现的数据与独立 Oracle；M1 退出证据 |
| W2 授权闭环 | M2 身份状态/epoch、客户范围、发布 operation 状态合同 | 权限编译/Publisher、查询层、权限页分别推进；M3 OM/Helix 适配合同 | 两角色查询结果、发布恢复证据、稳定 API/schema |
| W3 治理发布 | M3 OM 与 Helix 适配并行，再由 Binding Release 收口 | 本体页、Agent 页框架、Hermes 受管配置准备 | 已发布绑定上下文与测试版本；M3 退出证据 |
| W4 真实消费 | M4 真实输入 + 个体凭据 + 工具/模型结果对账 | 四页集成测试、P01/P05/P12 补足、备份/性能准备 | Golden Consumer 证据；M4 退出证据 |
| W5 收口放行 | M5 完整 UI/POL/OBS，再 M6 OPS/EVID | 只重跑代码/配置变更影响的验证并补齐缺证据 | required 全 PASS，Release Gate 返回 0 |

正式批准/环境不足仅阻塞依赖它的正式验收或现场动作；不把整个文档和隔离实验队列全部停住。需要业务 Owner 决定的授权/来源语义记录 SPEC_SEMANTIC_GAP，不由实现方猜测。

## Implementation Units

以下是增量任务包，复用原 U1–U7 的准备项编号。状态均先记 planned；代码静态存在记录在基线表，不据此勾选本轮任务。

### U1. 批准与环境合同补齐

- **Owner / refs：** 产品、架构、数据 Owner、安全、测试及运维；R1/R5，REQ-ARCH/AUTH/SRC/AGENT。
- **Files：** docs/approvals/alpha1-signoff-checklist.md、environment-inputs.schema.json、environment-inputs.example.yaml、scripts/check-m0-entry.mjs（后续创建）。
- [ ] 记录真实批准状态与缺项；本地隔离实验和现场合同分别列项；真实 secret 仅引用，不落证据正文。
- [ ] 环境输入至少覆盖 tenant_key、时区、IdP、来源/ACL/映射/删除合同、测试账号、地址、备份和 Hermes 实际版本。
- [ ] 齐套检查对缺批准/缺输入返回非 0；schema/example 校验通过不等于真实合同齐套。
- **交接：** M0 的正式入口及 M4 的外部依赖清单；未经确认的资料保持 REVIEW/BLOCKED。

### U2. 接管现有工程与合同差距清单（替换“创建空仓”）

- **Owner / refs：** 集成工程、测试；R4/R6，所有 REQ 的追踪入口。
- **Files：** integration-service/README.md、package-lock.json；后续 integration-service/docs/implementation-baseline.md、contracts/api-gap-matrix.md。
- [ ] 为当前集成代码建立独立版本身份与干净/未提交状态记录；不重复复制源码，不将三个上游作为集成提交的一部分。
- [ ] 将 PRD 29.3 的建议包职责映射到现有七目录与四进程；只为具体责任补文件，不按建议布局整仓重排。
- [ ] 列出主 PRD 59 API 与 spec 中样例 API 的“复用/适配/缺失/废弃”矩阵，明确 hub.v1 路由、错误、状态和兼容策略。
- [ ] 固定接口模型、枚举和 revision 规则后，允许对应 UI 契约测试；未定义语义记录缺口。
- **验证：** 每个 REQ、API、页面动作有任务归属；历史验证结果标来源，未归档部分不填 PASS。

### U3. 上游与运行版本钉扎

- **Owner / refs：** 集成工程、运维；R3/R7，A/N-ARCH。
- **Files：** 后续 integration-service/deploy/upstream-pins.json、构建说明；上游专用集成工作树/分支。
- [ ] 记录 Helix SHA、OM 2.0.6-release 对应 a695261b19d48411a39502a5c5fc0b453729eb4e、Hasura v2.51.1 对应 2b130a135659026ff6eda42c1df5722f123fd84e。
- [ ] 区分参考克隆的 HEAD 和实际使用的构建/运行版本；不得仅因参考 main 较新就误判已部署镜像，也不得以 tag 名代替 digest。
- [ ] 需要改上游时在钉扎版本的隔离企业分支/工作树进行；当前共享克隆不直接切换；Hasura 配置集成不 fork 引擎。
- **验证：** lock 可追溯运行组件；输入 SHA/digest 不匹配时拒绝正式验收。

### U4. M0 部署与身份加固（升级“Compose 草案”）

- **Owner / refs：** 运维、安全、集成工程；R3/R7，A/N-ARCH/AUTH。
- **Files：** 复用 integration-service/compose.yaml、.env.example、migrations/；后续 deploy/alpha1/、deploy/scripts/probe-sales-network.ps1、身份及凭据模块。
- [ ] 将现有开发 Compose 与 Alpha.1 验收配置区分，替换共享账号/开发默认秘密配置，按进程最小化 DB 权限。
- [ ] 形成销售/管理网络、TLS/批准路由和 Publisher 凭据隔离；从销售网络进行拒绝探测，环境未起返回 BLOCKED。
- [ ] 建立 OIDC 用户绑定、来源身份和个人随机 Bearer 的存储/撤销/epoch 合同；API 不再把 x-actor 或来源请求体身份当授权事实。
- **验证：** 正确身份可用，伪造身份和跨账号/跨网访问被拒；只开放预期入口且秘密不进入日志/制品。

### U5. deployment.lock 与可复现运行

- **Owner / refs：** 运维、测试；R7，A/N-ARCH。
- **Files：** 后续 integration-service/deploy/deployment.lock.schema.json、scripts/generate-lock.mjs、deployment.lock.example.json。
- [ ] 将实际源码/镜像、配置摘要、迁移/schema 版本和探测时间绑定到 run_id；例子与真实 lock 分开。
- [ ] 生成器验证 pins、digest、运行身份；拒绝空值、latest 和不匹配；lock 不含实际秘密。
- **依赖 / 验证：** U3/U4；合法样例通过，缺 digest/错 SHA/实际运行不匹配均非 0。

### U6. 复用测试并补独立 Oracle

- **Owner / refs：** 数据工程、测试、来源 Owner；R5，A/N-ING/ETL/DATA/SEC/API。
- **Files：** 复用 acceptance-tests/、examples/；后续 acceptance-tests/fixtures/c4/、negative/、failure_injection/、golden_consumer/。
- [ ] 将既有 live 测试纳入统一运行入口，保存命令/输出/实际版本；不因旧报告“通过”而跳过归档。
- [ ] 固化附录 C.4 的 U001 30000/2、U002 30000/1、D01 60000/3 独立期望值，验证跨租户与隐藏字段；增加 301 订单与多币种用例。
- [ ] 负向及 FI 随所属模块实现：M1 的 FI-01–05，M2 的 FI-06–10，M3 的 FI-11，身份/审计链路的 FI-10/12；M6 负责汇总与恢复/性能收口。
- [ ] 真实来源 Oracle 由批准导出/独立查询生成，与合成 fixture 分目录和输入类型；不从被测查询反推期望值。
- **验证：** 测试与 REQ/A/N/FI 一一可追踪；金额/行 ID/拒绝结果可核对，不能只比较成功码。

### U7. 从现在开始采集证据与构建 Gate

- **Owner / refs：** 测试、运维；R2/R5/R6，A/N-EVID。
- **Files：** 后续 integration-service/evidence/README.md、acceptance-tests/evidence/run-gate.mjs；已创建 docs/plans/phase-gates-alpha1.md。
- [ ] 按主 PRD 24.1 形成 evidence/<run_id>/；采集日志、版本、来源合同、输入 manifest、Oracle、文件摘要和消费者标识。
- [ ] Gate 消费结果而不是执行状态标签；required 缺证据/非 PASS、摘要被篡改、版本不匹配或 synthetic-as-golden 均非 0。
- [ ] 测试 Gate 自身的合法/缺文件/假 Golden Consumer 样例；样例通过不能作为产品放行证据。
- **依赖 / 交接：** U2/U5/U6；证据采集先交付，最终放行等待全部 M0–M5 和真实 Golden Consumer。

### 后续阶段编码计划的最小拆分

| 编码计划 | 复用 / 修改落点 | 必须产出的可独立验收单元 |
|---|---|---|
| M1 来源与接入 | ingestion-api/、normalization/、etl-worker/、migrations/ | 来源状态机；批次 job/回执；版本冲突和整单事务；PG/SQL Server 快照及安全增量 |
| M2 授权与发布 | permission-publish/、sales-mcp/ 查询层、身份模块、migrations/ | 两角色/客户关系授权；游标和聚合合同；可恢复 Publisher；epoch/审计失败处理 |
| M3 治理发布 | ontology-binding/、etl-worker/ hook、migrations/ | OM 治理登记；Helix 投影和安全适配；不可变 Binding Release 与 active 切换 |
| M4 消费端 | sales-mcp/、examples/、golden_consumer/ | 完整工具 schema/结果；个体凭据/Hermes 配置；真实问句与数字对账 |
| M5 四页增量 | OpenMetadata 钉扎集成分支的导航/路由/页面；Hub 管理 API | 接入、本体、权限、Agent 四页逐条线交付；P01/P05/P12 及缺失动作收口 |
| M6 运维放行 | deploy/、acceptance-tests/、evidence/、交付说明 | 备份恢复、性能、required 门禁与可复现交付 |

后续每个 Todo 按主 PRD 29.1 补足 id、requirement_refs、acceptance_refs、files_or_symbols、goal、preconditions、state_transition、side_effect_scope、failure_cases、verification、status、evidence。本表不替代详细编码计划，也不授权在现场执行操作。

## UI 并行交付与 spec 差距

| 增量 | 主 PRD 功能映射 | 开发起点 / 接口条件 | 必须补入的动作 |
|---|---|---|---|
| UI-1 业务数据接入 | P02–P04 | M1 来源/job/schema 合同稳定；可先用 mock | 来源配置/测试/批准/激活、字段与身份映射、任务详情/隔离重放、分页筛选 |
| UI-2 本体绑定 | P06–P07；关联 P05 | M3 提案与 Binding Release 合同稳定 | 不仅查看模型，还包括受控提案/编辑/校验/发布；关系/类型校验、版本失效与回退 |
| UI-3 数据权限 | P08–P09 | M0 管理身份、M2 发布 operation/状态与预览合同稳定 | 角色/部门规则、revision/审批、撤权/漂移/恢复、草稿预览与生效 canary 分开 |
| UI-4 Agent 服务 | P10–P11 | M0 个人凭据与 M4 工具/审计合同稳定 | 本人领取/一次性显示/撤销凭据、无秘密配置模板、真实发现状态、授权范围与关联审计 |
| UI-5 共用收口 | P01 / 原生 P05 / P12 | 有健康、治理引用、lock 与证据接口 | 总览、原生资产/质量/血缘关联、运行与交付记录；可通过页签/复用入口实现 |

接口选择冲突按主 PRD 优先，四页 spec 同步修订应列为对应阶段任务；本轮不把 spec 的演示接口提升为正式合同。不要求为十二个功能编号强行拆十二个独立页面，但必须动作不能遗漏。

## Verification Contract

1. **本轮文档校验：** 路径和相互引用有效；M0–M6 正式依赖与 PRD 一致；U1–U7 不再重复建骨架；全部 REQ/A/N/FI 有阶段归属；没有将静态检查或历史运行报告标为产品 PASS。
2. **现有本地测试接管：** 后续在固定基线运行类型检查、单测、构建和 live 验收；运行结果按 U7 归档。只读审查不能替代这些命令，也不能替代真实系统。
3. **阶段退出：** 逐条执行 [phase-gates-alpha1.md](phase-gates-alpha1.md)；基础子集与最终完整验收分别记录；M5 不因前期 UI 开发完成而跳过 M4。
4. **Release Gate：** required 18 A、18 N、FI-01–FI-12 必须 PASS 且有有效证据；真实输入缺失记 BLOCKED；Gate 脚本的测试样例不计为业务验收。
5. **重测范围：** 数据/schema/身份/策略/镜像变化时按影响关系重跑；未变且证据版本仍有效的用例可复用，不为阶段名称切换重复执行相同测试。

## 下一批可直接安排的工作

- [ ] U1/U2：登记批准与现场输入缺项，固化现有工程版本和 API/spec 差距矩阵。
- [ ] U3/U4/U5：把当前本地 Compose 提升为可核验的隔离基线，优先解决来源/管理/用户身份和账号网络边界。
- [ ] U6/U7：收集现有测试的可重跑证据，加入独立 Oracle 与缺证据拒绝 Gate；形成后续各阶段统一入口。
- [ ] 并行安排来源 Owner 和 Hermes 环境准备；UI 先做共用契约/RBAC/状态设计，接口冻结后逐页面进入开发。
- [ ] 此后按 W1–W5 推进详细阶段计划；产品授权或来源语义缺口明确上报，不用假定值隐藏阻塞。

## Definition of Done

- 本轮：路线与阶段门禁已更新，现状、复用、差距、并行条件和正式退出分开表达；没有修改产品源码或代填验收。
- 后续：每单元按主 PRD 29.1 具备状态和 Evidence；五方批准只由真实记录证明。
- Alpha.1：M0–M6 全部 verified，required 全 PASS，真实 Golden Consumer 与恢复/性能证据齐全，无未解决漂移或 RECOVERY_REQUIRED。

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 原稿 | 2026-10-23 07:45 | 面向“仅有文档与上游克隆”的 U1–U7 准备路线 |
| 1.1 | 2026-10-23 | 接管 integration-service 和四页 spec；保留正式验收依赖；增量补齐替代重建；UI/证据/现场准备前置；补全阶段门禁 |

本轮使用通用工程计划结构；用户尚未提供的需求 PRD 工程模板不作为当前文档修订的阻塞项。

