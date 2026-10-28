# Alpha.1 API gap matrix

基准：主 PRD 附录 A（原始 API-001–059，来源行 1872–1950）；M1 planned extension adds API-060 for the specific hard-delete Owner approval action absent from those 59 rows. Current M0 evidence was reconciled 2026-10-24 against the reports linked below; the remaining M1–M6 rows retain their 2026-10-23 static classifications until implemented. Classification describes the target API contract: **复用**=same contract directly reusable; **适配**=adjacent capability exists but route/input/identity/state/evidence needs change; **缺失**=no corresponding target endpoint or complete workflow. Static code and unit tests do not prove formal API completion or product acceptance PASS.

| API | PRD method/path | REQ references | Classification | Code evidence / gap | Phase | Existing test coverage |
|---|---|---|---|---|---|---|
| API-001 | GET `/hub/v1/me` | REQ-AUTH-001 | Implemented locally | `ingestion-api/identity-routes.ts`: verified OIDC `issuer/sub` resolves through M0 auth store; tenant/role come from DB; strict envelope and safe logger. Site identity binding/IdP acceptance remains blocked. | M0 | Fastify HTTP injection, real local RSA/EC JWKS and PostgreSQL; see [Task2 report](../../docs/execution/alpha1/m0-task-2-report.md) and [Task5 M0 report](../../docs/execution/alpha1/m0-task-5-report.md). |
| API-002 | GET `/hub/v1/admin/sources` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-003 | POST `/hub/v1/admin/sources` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-004 | GET `/hub/v1/admin/sources/{id}` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-005 | PATCH `/hub/v1/admin/sources/{id}` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-006 | POST `/hub/v1/admin/sources/{id}/test` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-007 | POST `/hub/v1/admin/sources/{id}/approve` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-008 | POST `/hub/v1/admin/sources/{id}/activate` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-009 | POST `/hub/v1/admin/sources/{id}/pause` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-010 | GET `/hub/v1/admin/sources/{id}/mappings` | REQ-SRC-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-011 | PUT `/hub/v1/admin/sources/{id}/mappings` | REQ-SRC-001, REQ-DATA-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-012 | POST `/hub/v1/admin/sources/{id}/mappings/validate` | REQ-SRC-001, REQ-DATA-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-013 | GET `/hub/v1/admin/identity-mappings` | REQ-DATA-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-014 | PUT `/hub/v1/admin/identity-mappings/{id}` | REQ-DATA-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-015 | POST `/hub/v1/ingest/crm/customers` | REQ-ING-001 | Adapt | ingestion-api/routes.ts POST /v1/ingest/:kind and normalization/store.ts; route, source identity, batch/job receipt contract differ. | M1 | core/integration tests cover normalization and idempotency/order behavior subsets; not this route contract. |
| API-016 | POST `/hub/v1/ingest/orders/orders` | REQ-ING-001, REQ-DATA-001 | Adapt | ingestion-api/routes.ts POST /v1/ingest/:kind and normalization/store.ts; route, source identity, batch/job receipt contract differ. | M1 | core/integration tests cover normalization and idempotency/order behavior subsets; not this route contract. |
| API-017 | GET `/hub/v1/ingestion-jobs/{id}` | REQ-ING-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-018 | GET `/hub/v1/ingestion-jobs/{id}/items` | REQ-ING-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-019 | POST `/hub/v1/admin/sources/{id}/etl-runs` | REQ-ETL-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-020 | GET `/hub/v1/admin/etl-runs` | REQ-ETL-001 | Adapt | GET /admin/etl/watermarks; not run listing. | M1 | Adjacent logic has tests; no canonical endpoint contract test. |
| API-021 | GET `/hub/v1/admin/etl-runs/{id}` | REQ-ETL-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| API-022 | POST `/hub/v1/admin/etl-runs/{id}/retry` | REQ-ETL-001 | Implemented locally | `ingestion-api/snapshot-routes.ts`, `etl-worker/snapshot-recovery.ts`, and migration `009_snapshot_runs_and_recovery.sql` implement strict failure-version CAS, authority-checked idempotent admission, and an immutable linked recovery child using `FRESH_SCAN` or `SEALED_STAGE`. Formal/site acceptance remains separate. | M1-5E1a1 | `acceptance-tests/snapshot-recovery.test.ts`: authenticated HTTP, populated 001–008 upgrade plus idempotent 009 reapply, real-role grants, fresh/sealed recovery with immutable original proof, and crash recovery on owned PostgreSQL. |
| API-023 | GET `/hub/v1/admin/quarantine` | REQ-DATA-001 | Implemented locally | `ingestion-api/quarantine-read.ts` lists immutable REST item and snapshot aggregate quarantine identities through a narrow Owner-checked loader; it does not retry or remap. | M1-5E1a2-1 | `acceptance-tests/quarantine-read.test.ts`: OIDC/API role, mixed-origin paging, exact UTC microseconds, source and current Owner/scope checks, REST/C live capture, populated-008 and accepted-009 backfill paths, role grants and rollback. Formal/site acceptance remains separate. |
| API-024 | POST `/hub/v1/admin/quarantine/{id}/retry` | REQ-DATA-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
| Import recovery extension (isolated A1 admission) | GET/POST `/hub/v1/admin/quarantine/{id}/import-recovery` | REQ-DATA-001 | Internal customer slice, not exposed | Separate OIDC Owner-scoped registrar and migration 016 atomically admit a linked child; API-024 stays REST-only. W1 adds customer execution through the W0 claim-bound proof reader; order recovery remains pending W2, and production registration remains disabled. | M1-I3A1/W | Local OIDC admission and W1 customer tests exercise claim-bound proof, canonical effects, ownership and terminal status; independent review and W2 order execution remain separate gates. |
| API-060 (planned extension) | POST `/hub/v1/admin/etl-runs/{id}/deletion-approval` | REQ-ETL-001, REQ-DATA-001 | Missing (planned contract) | This single planned extension binds a hard-delete approval to the exact source/run/candidate digest and current bound Data Owner. The original API-001–059 inventory has no operation with these semantics. It is not implemented. | M1 | No API-060 implementation/test; contract and owner-binding tests are specified in the [M1 plan](../../docs/plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md). |
| API-025 | POST `/hub/v1/admin/governance/sync` | REQ-GOV-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-026 | GET `/hub/v1/admin/assets/{id}/context` | REQ-GOV-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-027 | GET `/hub/v1/admin/ontologies/{workspaceId}` | REQ-ONT-001 | Adapt | GET /admin/ontology/helix and ontology-binding/binding.ts read active generation. | M3 | integration tests cover read-only model/field-validation subset. |
| API-028 | PUT `/hub/v1/admin/ontologies/{workspaceId}/draft` | REQ-ONT-001 | Adapt | GET/POST /admin/ontology/bindings + binding.ts; no proposal lifecycle/CAS. | M3 | integration tests cover physical field-existence subset. |
| API-029 | POST `/hub/v1/admin/ontology-proposals/{id}/validate` | REQ-ONT-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-030 | POST `/hub/v1/admin/ontology-proposals/{id}/publish` | REQ-ONT-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-031 | POST `/hub/v1/admin/binding-releases` | REQ-PUB-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-032 | POST `/hub/v1/admin/binding-releases/{id}/validate` | REQ-PUB-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-033 | POST `/hub/v1/admin/binding-releases/{id}/approve` | REQ-PUB-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-034 | POST `/hub/v1/admin/binding-releases/{id}/activate` | REQ-PUB-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-035 | GET `/hub/v1/admin/binding-releases/{id}` | REQ-PUB-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-036 | POST `/hub/v1/admin/binding-releases/{id}/rollback` | REQ-PUB-001 | Missing | No corresponding Hub endpoint or complete workflow. | M3 | No canonical API contract test. |
| API-037 | GET `/hub/v1/admin/policies` | REQ-POL-001 | Adapt | GET /admin/permissions; no desired/applied/observed contract. | M2/M5 | integration tests cover legacy flow/preview subsets; not canonical API acceptance. |
| API-038 | POST `/hub/v1/admin/policies` | REQ-POL-001 | Adapt | POST /admin/permissions creates legacy PolicyInput. | M2/M5 | integration tests cover legacy flow/preview subsets; not canonical API acceptance. |
| API-039 | PATCH `/hub/v1/admin/policies/{id}` | REQ-POL-001 | Missing | No corresponding Hub endpoint or complete workflow. | M2/M5 | No canonical API contract test. |
| API-040 | POST `/hub/v1/admin/policies/{id}/validate` | REQ-POL-001 | Missing | No policy-revision validation endpoint; draft preview belongs to API-045/P09 and does not validate a policy. | M2/M5 | No canonical policy validation test. |
| API-041 | POST `/hub/v1/admin/policies/{id}/approve` | REQ-POL-001 | Adapt | POST /admin/permissions/:id/approve; x-actor is not trusted identity. | M2/M5 | integration tests cover legacy flow/preview subsets; not canonical API acceptance. |
| API-042 | POST `/hub/v1/admin/policies/{id}/apply` | REQ-POL-001 | Adapt | POST /admin/permissions/:id/publish + Publisher; CAS/recovery contract incomplete. | M2/M5 | integration tests cover legacy flow/preview subsets; not canonical API acceptance. |
| API-043 | POST `/hub/v1/admin/policies/{id}/revoke` | REQ-POL-001 | Missing | No corresponding Hub endpoint or complete workflow. | M2/M5 | No canonical API contract test. |
| API-044 | GET `/hub/v1/admin/policies/{id}/status` | REQ-POL-001 | Missing | No corresponding Hub endpoint or complete workflow. | M2/M5 | No canonical API contract test. |
| API-045 | POST `/hub/v1/admin/access-previews` | REQ-UI-001, REQ-SEC-001 | Adapt | `POST /admin/permissions/preview` accepts caller-supplied tenantId/userId and columns; it echoes requested columns and counts rows from the Hub API view using tenant_id/owner_user_id. Response labels this a pre-release estimate and says Hasura must reverify after application. No authorized principal resolution, fixed template ID, or read of applied Hasura policy. | M2/M5 | No route-level preview or applied-policy verification test; core.test.ts tests policy helpers only. |
| API-046 | POST `/hub/v1/me/agent-credentials` | REQ-AUTH-001, REQ-AGENT-001 | Implemented locally | `ingestion-api/identity-routes.ts`: strict body and idempotency header; one-time secret response, replay omits secret; caller principal resolved from OIDC binding. | M0/M4 | Fastify injection and real PostgreSQL concurrency/replay; see [Task2 report](../../docs/execution/alpha1/m0-task-2-report.md) and [Task5 M0 report](../../docs/execution/alpha1/m0-task-5-report.md). |
| API-047 | GET `/hub/v1/me/agent-credentials` | REQ-AUTH-001 | Implemented locally | `ingestion-api/identity-routes.ts`: server-side owner scope, metadata-only stable pagination; no secret/digest or caller tenant filter. | M0/M4 | Fastify injection and real PostgreSQL pagination/privacy; see [Task2 report](../../docs/execution/alpha1/m0-task-2-report.md) and [Task5 M0 report](../../docs/execution/alpha1/m0-task-5-report.md). |
| API-048 | DELETE `/hub/v1/me/agent-credentials/{id}` | REQ-AUTH-001 | Implemented locally | `ingestion-api/identity-routes.ts` + `auth/service.ts`: bodyless idempotent 204; self/authorized same-tenant revoke; credential and subject epochs update transactionally. | M0/M4 | Fastify injection, real PostgreSQL revoke/epoch tests and Task4 live credential sequence; see [Task1](../../docs/execution/alpha1/m0-task-1-report.md), [Task2](../../docs/execution/alpha1/m0-task-2-report.md), [Task4](../../docs/execution/alpha1/m0-task-4-report.md), and [Task5 M0 report](../../docs/execution/alpha1/m0-task-5-report.md). |
| API-049 | GET `/hub/v1/admin/agent-tools` | REQ-MCP-001 | Adapt | GET /admin/agent/tools returns name/description; schema/version/health fields absent. | M5/M6 | integration tests cover tool-definition subset. |
| API-050 | GET `/hub/v1/admin/audit` | REQ-OBS-001 | Adapt | GET /admin/agent/audit; complete redaction/pagination/request_id contract absent. | M5/M6 | integration tests cover parts of audit write/read. |
| API-051 | GET `/hub/v1/admin/operations/{id}` | REQ-OBS-001 | Missing | No corresponding Hub endpoint or complete workflow. | M5/M6 | No canonical API contract test. |
| API-052 | GET `/health/live` | REQ-OPS-001 | Adapt | GET /health returns {ok:true}; differs from dependency-independent /health/live. | M5/M6 | No standalone health contract test. |
| API-053 | GET `/hub/v1/admin/health` | REQ-OPS-001 | Missing | No corresponding Hub endpoint or complete workflow. | M5/M6 | No canonical API contract test. |
| API-054 | POST `/hub/v1/sales/context` | REQ-API-001 | Missing | sales-mcp/queries.ts has query logic; shared Sales REST route is absent. | M2/M4 | integration tests cover MCP queries, not REST endpoints. |
| API-055 | POST `/hub/v1/sales/customer-search` | REQ-API-001 | Missing | sales-mcp/queries.ts has query logic; shared Sales REST route is absent. | M2/M4 | integration tests cover MCP queries, not REST endpoints. |
| API-056 | POST `/hub/v1/sales/customer-orders` | REQ-API-001 | Missing | sales-mcp/queries.ts has query logic; shared Sales REST route is absent. | M2/M4 | integration tests cover MCP queries, not REST endpoints. |
| API-057 | POST `/hub/v1/sales/order-detail` | REQ-API-001 | Missing | sales-mcp/queries.ts has query logic; shared Sales REST route is absent. | M2/M4 | integration tests cover MCP queries, not REST endpoints. |
| API-058 | POST `/hub/v1/sales/summary` | REQ-API-001 | Missing | sales-mcp/queries.ts has query logic; shared Sales REST route is absent. | M2/M4 | integration tests cover MCP queries, not REST endpoints. |
| API-059 | MCP Streamable HTTP `/mcp/sales` | REQ-MCP-001 | Adapt (M0 identity boundary) | `sales-mcp/server.ts` registers `/mcp/sales`, authenticates current personal-agent credentials, rejects invalid Origin before auth/query, and preserves the five-tool M0 closed-gate boundary. Full remote Hermes interoperability and the complete M4 protocol/consumer acceptance are not established. | M0/M4 | Fastify protocol/auth boundary, query/audit barriers, and Task4 local TLS/closed-gate probes; remote Hermes v0.22.1 remains unobserved. See [Task3](../../docs/execution/alpha1/m0-task-3-report.md), [Task4](../../docs/execution/alpha1/m0-task-4-report.md), and [Task5 M0 report](../../docs/execution/alpha1/m0-task-5-report.md). |

## REQ coverage

| Requirement | Stage | Acceptance / related API |
|---|---|---|
| REQ-ARCH-001 | M0 | A/N-ARCH-001; API-001 deployment/health prerequisites |
| REQ-AUTH-001 | M0, M4 | A/N-AUTH-001; API-001, API-046–048 |
| REQ-SRC-001 | M1 | A/N-SRC-001; API-002–014 |
| REQ-ING-001 | M1 | A/N-ING-001; API-015–018 |
| REQ-ETL-001 | M1 | A/N-ETL-001; API-019–022, planned API-060 |
| REQ-DATA-001 | M1 | A/N-DATA-001; API-011–014, API-016, API-023–024, planned API-060 |
| REQ-GOV-001 | M3 | A/N-GOV-001; API-025–026 |
| REQ-ONT-001 | M3 | A/N-ONT-001; API-027–030 |
| REQ-PUB-001 | M3 | A/N-PUB-001; API-031–036 |
| REQ-SEC-001 | M2 | A/N-SEC-001; API-045, API-054–058 |
| REQ-POL-001 | M2, M5 | A/N-POL-001; API-037–045 |
| REQ-API-001 | M2 | A/N-API-001; API-054–058 |
| REQ-MCP-001 | M4 | A/N-MCP-001; API-049, API-059 |
| REQ-AGENT-001 | M4 | A/N-AGENT-001; API-046–050, API-054–059 |
| REQ-UI-001 | M5 | A/N-UI-001; P01–P12 |
| REQ-OBS-001 | M5 | A/N-OBS-001; API-050–051, API-053 |
| REQ-OPS-001 | M6 | A/N-OPS-001; API-052–053 |
| REQ-EVID-001 | M6 | A/N-EVID-001; 48-row evidence gate |
## 页面覆盖（主 PRD P01–P12 → 四页聚合规格）

页面 ID 与标题以主 PRD 附录 B 为准；UI-1..UI-4 是四页聚合规格入口，UI-5 表示原生 OpenMetadata/运维交付入口映射。页面工作流/API归属按附录 B逐项核对。页面验收属 M5；括号内的 M1–M4 表示其API/能力依赖。

| PRD ID / canonical title | 聚合入口 | 阶段 | PRD工作流与 API ownership | 当前实现与差距 |
|---|---|---|---|---|
| P01 总览 | UI-5 总览待补 | M5 | 状态卡并可钻取任务、策略、审计；API-002/020/037/049/053 | 无聚合UI；这些 API 只提供部分来源数据，且多为缺失或适配。 |
| P02 数据源 | UI-1 接入 | M5（M1依赖） | 新建→测试→审批→激活；编辑→重测；暂停；API-002–009 | 没有受管数据源端点/工作流。 |
| P03 字段与身份映射 | UI-1 接入 | M5（M1依赖） | 来源字段映射到标准属性、转换/版本/状态映射，用户/部门/客户身份映射与主来源字段权；保存草稿、结构校验、查看影响、人工确认冲突；API-010–014 | API-010–012字段映射与API-013–014身份映射均缺失；现有 `/admin/ontology/bindings` 是本体到资产字段的绑定，不是来源映射或身份映射。 |
| P04 同步任务与隔离 | UI-1 接入 | M5（M1依赖） | 查看batch/run/event、接收/应用/隔离计数、游标、错误与客户依赖；修正映射后逐项重试；API-017–024/051 | `/admin/ingestion/events`、`/admin/ingestion/failures`、`/admin/etl/watermarks` 与 `/admin/etl/:source/retry` 是部分旧 seam；无规范 job/item/run/quarantine/operation receipt 生命周期，失败列表不等于隔离队列。 |
| P05 数据资产与治理 | UI-5 原生 OpenMetadata | M5（M3依赖） | 查看资产、分类、质量、血缘、术语与Owner；触发受控同步并查看质量历史；API-025/026及原生 OM | 原生 OM 可承载既有治理浏览；本 Hub 无 API-025/026规范同步与context端点，适配器仅只读核验。 |
| P06 本体模型 | UI-2 本体绑定 | M5（M3依赖） | 编辑固定三类模型/关系提案，校验并确认发布；API-027–030 | 仅有Helix活动代次只读与字段存在性检查；缺提案编辑、校验、发布工作流。 |
| P07 查询绑定与发布 | UI-2 本体绑定 | M5（M3依赖） | 创建草稿→校验→独立审批→激活；看历史并显式回退；API-031–036/051 | 旧绑定列表/创建仅验证活动对象与物理字段；缺不可变Binding Release、审批、激活、回退与operation查询。 |
| P08 授权策略 | UI-3 数据权限 | M5（M2依赖） | 编制、验证、提交审批、发布、撤销并查看漂移；API-037–044/051 | 旧 `/admin/permissions` list/create/approve/publish 与Publisher提供部分草稿/审批/应用 seam；缺正式 revision/CAS、撤权/恢复及desired/applied/observed核验。此处不把草稿预览视为策略验证或应用证明。 |
| P09 权限验证 | UI-3 数据权限 | M5（M2依赖） | 固定测试主体/模板：草稿对合成fixture预览；对已应用策略，按获授权主体只读验证可见列/行范围、拒绝原因并留证；API-045 | `POST /admin/permissions/preview` 是草稿估算 seam：调用者直接提供 tenantId/userId与列，服务端回显请求列，并用固定 tenant_id/owner_user_id 条件查询Hub API视图计数；返回“预发布估算；生效后应由 Hasura 复验”。它没有固定模板ID或服务端解析的principal，也不读取已应用Hasura策略/代表授权主体执行只读验证；因此不能证明应用权限。当前测试只校验 policy helper，不覆盖该路由或应用策略验证。 |
| P10 Agent 服务与凭据 | UI-4 Agent 服务 | M5（M4依赖） | 用户创建/复制一次性token、撤销、下载无秘密配置模板、本人联通测试；服务管理员看MCP URL和工具状态；API-046–049/001 | 工具目录有旧只读API；用户凭据API和Hermes/Profile联通流程缺失。 |
| P11 调用审计 | UI-4 Agent 服务 | M5（M4依赖） | 按request/operation ID检索、查看脱敏错误并在授权范围内导出；API-050/051 | 旧 audit/errors 查询部分可复用；完整脱敏审计、操作查询与追踪合同未完成。 |
| P12 运行与交付记录 | UI-5 运维/交付总览 | M5（M6依赖） | 查看实际版本/摘要、依赖、gate、备份/恢复和required验收；API-053/051 | Task3提供本地检查记录及结构/发布Gate工具；无规范运行健康/operation API或真实lock/恢复数据。 |
## 48项 required acceptance 阶段覆盖

18 A + 18 N + 12 FI，共48项。阶段归属不表示通过；当前产品状态按 Task3 Gate 实际结果为 `NOT_RUN`。FI关联按PRD第23章。

| 阶段 | Acceptance IDs | Negative IDs | Failure injections |
|---|---|---|---|
| M0 | A-ARCH-001, A-AUTH-001 | N-ARCH-001, N-AUTH-001 | — |
| M1 | A-SRC-001, A-ING-001, A-ETL-001, A-DATA-001 | N-SRC-001, N-ING-001, N-ETL-001, N-DATA-001 | FI-01, FI-02, FI-03, FI-04, FI-05 |
| M2 | A-SEC-001, A-API-001 | N-SEC-001, N-API-001 | — |
| M3 | A-GOV-001, A-ONT-001, A-PUB-001 | N-GOV-001, N-ONT-001, N-PUB-001 | FI-11 |
| M4 | A-MCP-001, A-AGENT-001 | N-MCP-001, N-AGENT-001 | FI-10 (AUTH/API in-flight checks) |
| M5 | A-POL-001, A-UI-001, A-OBS-001 | N-POL-001, N-UI-001, N-OBS-001 | FI-06, FI-07, FI-08, FI-12 |
| M6 | A-OPS-001, A-EVID-001 | N-OPS-001, N-EVID-001 | FI-09 |

FI-06–09 cover publish/recovery: engine implementation starts in M2, page workflow is M5, recovery/restore gate is M6. FI-10 is first implemented as M0 revocation safety, then exercised with sales queries in M4. The 48 acceptance result state is never inferred from source coverage or local tooling.
