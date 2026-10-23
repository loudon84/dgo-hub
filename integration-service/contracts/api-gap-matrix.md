# Alpha.1 API gap matrix

基准：主 PRD 附录 A（API-001–059，来源行 1872–1950）；当前实现源 `integration-service/`；静态核对日期 2026-10-23，HEAD `1ffd8824b1c00108373823e6239ea63eb23216dc`。分类描述目标 API 合同：**复用**=相同合同可直接复用；**适配**=有相邻能力但仍需调整路径、输入、身份、状态或证据合同；**缺失**=没有对应目标端点/完整流程。静态代码与单测不自动证明正式 API 已实现或产品验收 PASS。

| API | PRD method/path | REQ references | Classification | Code evidence / gap | Phase | Existing test coverage |
|---|---|---|---|---|---|---|
| API-001 | GET `/hub/v1/me` | REQ-AUTH-001 | Missing | No corresponding Hub endpoint or complete workflow. | M0 | No canonical API contract test. |
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
| API-022 | POST `/hub/v1/admin/etl-runs/{id}/retry` | REQ-ETL-001 | Adapt | POST /admin/etl/:source/retry; lacks approved revision/reliable cursor contract. | M1 | Adjacent logic has tests; no canonical endpoint contract test. |
| API-023 | GET `/hub/v1/admin/quarantine` | REQ-DATA-001 | Adapt | GET /admin/ingestion/failures; not quarantine. | M1 | Adjacent logic has tests; no canonical endpoint contract test. |
| API-024 | POST `/hub/v1/admin/quarantine/{id}/retry` | REQ-DATA-001 | Missing | No corresponding Hub endpoint or complete workflow. | M1 | No canonical API contract test. |
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
| API-040 | POST `/hub/v1/admin/policies/{id}/validate` | REQ-POL-001 | Adapt | POST /admin/permissions/preview; preview contract differs. | M2/M5 | integration tests cover legacy flow/preview subsets; not canonical API acceptance. |
| API-041 | POST `/hub/v1/admin/policies/{id}/approve` | REQ-POL-001 | Adapt | POST /admin/permissions/:id/approve; x-actor is not trusted identity. | M2/M5 | integration tests cover legacy flow/preview subsets; not canonical API acceptance. |
| API-042 | POST `/hub/v1/admin/policies/{id}/apply` | REQ-POL-001 | Adapt | POST /admin/permissions/:id/publish + Publisher; CAS/recovery contract incomplete. | M2/M5 | integration tests cover legacy flow/preview subsets; not canonical API acceptance. |
| API-043 | POST `/hub/v1/admin/policies/{id}/revoke` | REQ-POL-001 | Missing | No corresponding Hub endpoint or complete workflow. | M2/M5 | No canonical API contract test. |
| API-044 | GET `/hub/v1/admin/policies/{id}/status` | REQ-POL-001 | Missing | No corresponding Hub endpoint or complete workflow. | M2/M5 | No canonical API contract test. |
| API-045 | POST `/hub/v1/admin/access-previews` | REQ-UI-001, REQ-SEC-001 | Adapt | POST /admin/permissions/preview; caller-supplied identity fields differ from fixed principal contract. | M2/M5 | integration tests cover legacy flow/preview subsets; not canonical API acceptance. |
| API-046 | POST `/hub/v1/me/agent-credentials` | REQ-AUTH-001, REQ-AGENT-001 | Missing | No corresponding Hub endpoint or complete workflow. | M0/M4 | No canonical API contract test. |
| API-047 | GET `/hub/v1/me/agent-credentials` | REQ-AUTH-001 | Missing | No corresponding Hub endpoint or complete workflow. | M0/M4 | No canonical API contract test. |
| API-048 | DELETE `/hub/v1/me/agent-credentials/{id}` | REQ-AUTH-001 | Missing | No corresponding Hub endpoint or complete workflow. | M0/M4 | No canonical API contract test. |
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
| API-059 | MCP Streamable HTTP `/mcp/sales` | REQ-MCP-001 | Adapt | sales-mcp/server.ts uses SDK at /mcp and permits POST only; /mcp/sales, identity and complete Streamable HTTP contract are not implemented. | M4 | integration tests cover tool subset; Task3 gate tests do not verify MCP protocol. |

## REQ coverage

| Requirement | Stage | Acceptance / related API |
|---|---|---|
| REQ-ARCH-001 | M0 | A/N-ARCH-001; API-001 deployment/health prerequisites |
| REQ-AUTH-001 | M0, M4 | A/N-AUTH-001; API-001, API-046–048 |
| REQ-SRC-001 | M1 | A/N-SRC-001; API-002–014 |
| REQ-ING-001 | M1 | A/N-ING-001; API-015–018 |
| REQ-ETL-001 | M1 | A/N-ETL-001; API-019–022 |
| REQ-DATA-001 | M1 | A/N-DATA-001; API-011–014, API-016, API-023–024 |
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

四页聚合规格来源 `docs/OpenMetadata_UI扩展规格说明_v1.0.md`；UI-1..UI-4 映射到四个聚合入口，UI-5 映射原生 OpenMetadata 与运行/交付总览。前置 API 阶段按 PRD M0–M4 分开，页面验收属于 M5。

| PRD页面 | 聚合入口 | 阶段 | 覆盖与代码现状 |
|---|---|---|---|
| P01 总览 | UI-5 总览待补 | M5 | 四页规格没有总览；API-002/020/037/049/053只提供部分数据源，无聚合UI。 |
| P02 接入配置 | UI-1 接入 | M5（M1 API依赖） | 来源/任务/映射/重试；实现为旧 `/v1/ingest`、事件/水位/重试，无受管来源配置工作流。 |
| P03 批次与隔离 | UI-1 接入 | M5（M1 API依赖） | 有失败查询/重试 seam；无规范 job/item/quarantine API。 |
| P04 字段映射 | UI-1 接入 | M5（M1 API依赖） | 规格有映射只读/验证；无来源映射配置或完整数据合同。 |
| P05 原生元数据治理 | UI-5 原生 OpenMetadata | M5 | 复用原生资产/血缘/质量入口；只读 `ontology-binding` 不证明扩展 UI 或写回完成。 |
| P06 本体工作区 | UI-2 本体绑定 | M5（M3 API依赖） | 有 Helix 活动模型只读与字段存在性校验；缺提案编辑/验证/发布/审批。 |
| P07 绑定与发布 | UI-2 本体绑定 | M5（M3 API依赖） | 旧绑定列表/创建是适配 seam；缺不可变 Binding Release、批准、激活与恢复。 |
| P08 策略设计 | UI-3 数据权限 | M5（M2 API依赖） | 旧 policy list/create/preview seam；缺正式角色、关系、版本合同。 |
| P09 权限发布 | UI-3 数据权限 | M5（M2 API依赖） | 有旧草稿/审批/应用；缺 CAS、并发锁、撤权恢复和 desired/applied/observed 证据。 |
| P10 Agent 配置 | UI-4 Agent 服务 | M5（M4 API依赖） | 有旧工具目录/范围 API；缺用户绑定凭据与 Hermes Profile/真实版本绑定。 |
| P11 调用追踪 | UI-4 Agent 服务 | M5（M4 API依赖） | 有旧 audit/errors 查询；脱敏、request_id、审计失败闭锁、真实调用证据未验收。 |
| P12 运行与交付记录 | UI-5 运维/交付总览 | M5（OPS/EVID gate归M6） | PRD要求 lock、gate、备份/恢复；Task3提供本地检查记录与结构/发布Gate工具。 |

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
