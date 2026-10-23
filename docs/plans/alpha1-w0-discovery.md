# Alpha.1 W0 只读发现报告

日期：2026-10-23（Asia/Shanghai）  
范围：只读检查 `E:\git\dgo-hub` 的 Git 基线、`integration-service` 配置/入口/公开接口，以及 W0 路线、阶段门禁和产品/API 规格。未读 `.env` 内容；未改动上游、代码、配置或 Git 索引；未运行测试、部署或服务。以下是静态发现，不构成验收证据。

## 1. 仓库基线与安全提交范围

- 根仓库已初始化但尚无 commit；工作分支符号名为 `feat/alpha1-implementation`（`git status` 显示 “No commits yet”）。此前用户消息提到 master，与本机检查不一致；执行前应以 `git symbolic-ref --short HEAD` 再确认。
- 根目录 `.gitignore` 是用户已有未跟踪文件，内容包含 `node_modules/`、`dist/`、`.env`/`.env.*.local` 等忽略规则。报告未更改它。不要用 `git add -A` 或 `git add .`；仅按明确路径添加：

  ```powershell
  Set-Location E:\git\dgo-hub
  git add -- integration-service docs
  git diff --cached --name-only
  git status --short
  ```

  对应的只读预演 `git add --dry-run -- integration-service docs` 只列出 `docs/` 和 `integration-service/` 下文件，没有根 `.gitignore`、`deliverables/` 或三份上游目录。上游目录 `OpenMetadata/`、`graphql-engine/`、`helix-foundry/` 各自有嵌套 `.git`，显式路径 staging 将其排除。`deliverables/` 是根目录的独立目录，也被排除。
- `integration-service/.gitignore` 忽略 `node_modules/`、`dist/`、`.env`；`git check-ignore -v` 命中这三项。当前三项在该目录中均存在（只检查名称），且没有出现在 staging dry-run 清单中。不要使用 `git add -f`。若实际索引审核要求更窄范围，先复核 `git diff --cached --name-only`，并确认没有 secret 内容后才提交。
- `docs/` 当前有两份产品规格及 `docs/plans/` 下路线、阶段门禁等文档。`git add -- integration-service docs` 会把整个 docs 当前基线一并纳入；dry-run 显示的实际清单为四份文档。

## 2. 上游参考状态和锁定风险

只读读取了各嵌套 repo 的 HEAD、分支名及 `git status --short`（均干净）；这只反映参考克隆，不证明部署或运行版本：

| 上游 | 当前分支 / HEAD | 路线文档要求参考钉扎 | 风险 |
|---|---|---|---|
| OpenMetadata | `main` / `0d7426d4c9ab79f7f1834351c4e963f94ad3f8c6` | `2.0.6-release` 对应 `a695261b19d48411a39502a5c5fc0b453729eb4e` | 当前 HEAD 不等于要求的参考 commit；不代表正在运行的 OM 版本 |
| Hasura graphql-engine | `master` / `d0221205fc655a6658e15e9a2c484925e8147a46` | `v2.51.1` 对应 `2b130a135659026ff6eda42c1df5722f123fd84e` | 当前源码 HEAD 与版本参考分离；运行镜像 digest 未知 |
| Helix Foundry | `main` / `00d7927d7c08e16c58316e006959f052427e7fa1` | 同一 SHA | HEAD 与路线 pin 相符，但仍不是构建产物或运行实例证明 |

路线对 U3/U5 的要求是同时记录 reference source、实际构建/运行标识、镜像 digest、配置摘要、迁移/schema 版本和探测结果；不能以 `latest`、tag 名或源码 HEAD 代替运行 digest。建议 `integration-service/deploy/upstream-pins.json` 保存被批准的参考值和来源，`deployment.lock.schema.json` + `deployment.lock.example.json` 描述 lock 结构；生成器只从实际采集结果写真实 lock。示例文件应明确标成 example，正式检查拒绝空 SHA/digest、`latest` 和不匹配。不要为“钉扎”而切换三个共享嵌套 clone 的工作树。

## 3. integration-service 当前接口与入口

### 工程和命令

- `package.json` 为 ESM (`"type":"module"`)；TypeScript 5.9、NodeNext、strict、输出 `dist/`；存在 `package-lock.json`（lockfile v3）。当前环境只读版本为 Node `v24.14.1`、npm `11.11.0`。无单独 `vitest.config`，package script 已给出 Vitest 入口。
- 当前可建议的本机基线命令（尚未运行，不能报告通过）：

  ```powershell
  Set-Location E:\git\dgo-hub\integration-service
  npm ci
  npm run typecheck
  npm test
  npm run build
  ```

  `npm run acceptance:live` 另需 `.env`、已构建 `dist/` 及本地 Compose 服务；它不是纯离线基线。本轮不读取该 `.env`，也不执行 live/Compose。
- 仓库在 Windows PowerShell 下；没有找到 `bash` 命令。已有 `integration-service/scripts/package.ps1`，可用 PowerShell 原生文件操作与 Node CLI。若 Gate/校验脚本采用 `.mjs`，`"type":"module"`、ESM import 和 Node 24 支持直接执行 `node scripts/check-m0-entry.mjs`；`node --env-file` 也由当前 Node 支持。为脚本自身做小型 node:test/Vitest 单测，不依赖 bash 工具。

### 公开签名与运行入口（源码静态读取）

- HTTP 主入口：`app.ts` 顶层创建 Fastify（`bodyLimit=2 MiB`），调用 `registerRoutes(app)`，监听 `0.0.0.0:${PORT ?? 3000}`。`registerRoutes(app: FastifyInstance)` 在 `ingestion-api/routes.ts` 注册 `/health`、`POST /v1/ingest/:kind`，以及下列管理 API；管理区以 `x-admin-key` 做共享 key 校验。Compose/README 设置的映射端口与代码默认值要在基线记录中分别写 host/container，不能将 README 端口误认为代码默认。
- `normalization/models.ts`：`customerSchema`、`orderSchema`；导出 `Customer`、`SalesOrder`、`normalizeCustomer(input: unknown): Customer`、`normalizeOrder(input: unknown): SalesOrder`。`normalization/store.ts` 导出 `ingest(kind: Kind, sourceSystem: string, eventId: string, payload: unknown)`，事件与 normalized rows 写入 PostgreSQL。
- REST/管理路由 `ingestion-api/routes.ts`：
  - `GET /health`；`POST /v1/ingest/:kind`（kind 约束 customer/order；key、source header、idempotency header；422 写失败表）。
  - `GET /admin/ingestion/events`、`GET /admin/ingestion/failures`、`GET /admin/etl/watermarks`、`POST /admin/etl/:source/retry`。
  - `GET /admin/ontology/helix`、`GET/POST /admin/ontology/bindings`；`POST` body 为 `Binding & { openMetadataFqn: string }`，只读取上游模型/表并验证字段。
  - `GET/POST /admin/permissions`、`POST /admin/permissions/preview`、`POST /admin/permissions/:id/approve`、`POST /admin/permissions/:id/publish`。当前审批 actor 是请求 `x-actor` 值，需经可信身份 M0 处理。
  - `GET /admin/agent/tools`、`GET /admin/agent/scope/:userId?tenantId=...`、`GET /admin/agent/audit`、`GET /admin/agent/errors`。
- 其他签名：`validateBinding(binding: Binding, physicalColumns: string[])`，`fetchPublishedHelixModels()`、`fetchOpenMetadataTable(fqn)`；`PolicyInput = { table: 'customer' | 'sales_order' | 'order_item' | 'sales_summary' | 'customer_sales'; role: 'sales_reader'; columns: string[] }`，`validatePolicy(policy)`、`buildSelectPermission(policy)`；ETL `nextRetryDelay(attempt)`，worker 入口 `etl-worker/worker.ts`；Publisher 入口 `permission-publish/worker.ts`；迁移入口 `migrate.ts`；MCP 入口 `sales-mcp/main.ts` 调用 `startMcp(MCP_PORT ?? 3001)`。package scripts：`start`、`worker`、`publisher`、`mcp`、`migrate`、`test`、`typecheck`、`build`、`acceptance:live`。
- `sales-mcp/tools.ts` 固定五工具：`get_sales_context`、`find_customers`、`get_customer_orders`、`get_order_detail`、`get_sales_summary`；工具定义为只读查询。现有测试文件 `acceptance-tests/core.test.ts`、`integration.test.ts`，通过 Vitest；测试目前覆盖模型、行/列策略、五工具名、金额汇总、客户排序、绑定物理列和退避。它们不是 PRD 的全面验收，也没有本轮执行结果。

## 4. W0 产物建议：目录、类型、检查语义

路线原文参考 `docs/plans/2026-10-23-0745-feat-alpha1-implementation-roadmap-plan.md` 的 U1–U7，`docs/plans/phase-gates-alpha1.md` 的共用门禁/M0，主 PRD 附录 A（59 个 API）和附录 B（P01–P12）。以下是供实现计划落细的目录建议。

### U1 批准与环境输入

- 建议文件：`docs/approvals/alpha1-signoff-checklist.md`、`docs/approvals/environment-inputs.schema.json`、`docs/approvals/environment-inputs.example.yaml`；检查器建议落在已有 package 根目录 `integration-service/scripts/check-m0-entry.mjs`，在 `integration-service/package.json` 注册 `check:m0-entry`。
- Checklist 将产品/架构/数据 Owner/安全/测试/运维批准状态、签署人引用/时间、缺项、负责人、记录来源逐项列出。主 PRD 当前 front matter 与正文仍是 `REVIEW`，并明确不得自动改成 `APPROVED_FOR_PLAN`。示例和 schema 通过只能证明格式正确，不能伪造批准状态或现场合同；现场缺项用 `REVIEW`/`BLOCKED`，状态词沿路线/门禁既有词汇，不创造隐含签署。
- Schema 建议顶层 `schemaVersion`、`environmentKind: isolated-local | site`、`approval.status`（保留实际事实值）、`tenantKey`、`timezone`、`idp`、`sources[]`（来源 Owner、访问/快照授权、ACL、字段/身份映射版本、删除语义）、`testIdentities[]`（只放 ID/角色引用，不放口令）、`endpoints`（URL/网络边界）、`secretRefs`（Vault/secret manager 引用，不放秘密）、`backup`（责任人/目标/最近证据引用）、`hermes`（实际版本/Profile/身份映射准备状态）、`evidenceRefs`。把 `isolated-local` 与 `site` 分开，使本地开发合同不能通过现场门禁。
- `check-m0-entry.mjs` 建议有两个明确模式：schema/example 格式检查；正式入口检查。第一种可对示例通过；第二种须检查批准状态、指定 `environmentKind` 的全部必填项和引用可解析/证据存在，对缺批准/缺输入返回非 0，并输出缺项/`BLOCKED`，绝不只因 schema valid 就放行。不要打开/打印 secret 值，只检查引用名和权限化访问是否成功。

### U2 基线和 API gap matrix

- 基线记录建议 `integration-service/docs/implementation-baseline.md`，矩阵准确路径按路线为 `integration-service/contracts/api-gap-matrix.md`。基线字段：运行入口/模块责任、源码 HEAD 与工作树状态、package 与 lock 摘要、Node/npm、Compose 服务/端口、已知验证命令及“本轮未执行”的结果状态；历史记录标为历史线索，不带成此次 PASS。
- 矩阵每行对应主 PRD `API-001`–`API-059`，字段建议：`api_id`、PRD method/path、当前实际 method/path、现有 handler 或缺失、页面动作/P01–P12、REQ/权限主体、输入输出/状态码差异、幂等/revision/request_id、差距分类（复用/适配/缺失/废弃）、目标任务、状态（planned/implemented/verified/blocked）、证据引用。当前服务使用 `/admin/*` 和 `/v1/ingest/*`，PRD 使用 `/hub/v1/...`；即使功能相似，路径、身份、操作状态/分页/错误包装不同也应标“适配”，不能标 exact reuse。
- 必须覆盖两套产品契约：主 PRD 附录 A 的 59 个新 Hub API；四页 spec §4–7 的示例 `/admin/...` 接口。页面映射参 PRD P01–P12 表：接入 P02–P04、治理 P05–P07、授权 P08–P09、Agent P10–P11、总览 P01、运行/交付 P12。例：现有 events/watermarks/ontology/bindings/permissions/tools/audit/errors 可作为适配起点；source registry、批次 job/items、quarantine、governance sync、ontology proposal / binding release、policy operation/status/revoke、个人 credential 生命周期、audit/operations/health 与 sales endpoints 都是缺失或需要新合同。API-059 是 MCP Streamable HTTP `/mcp/sales`，和现有 MCP 实现的 `/mcp` 路由要显式标兼容/适配待定。
- 矩阵测试建议：逐条静态/route contract 覆盖 59 IDs，assert 每个有且只有一种分类与目标任务；handler 集成检查 method/path、成功/失败 envelope、401/403/409/422/202、分页上限、幂等/revision；页面动作 contract 检查 P01–P12 追踪；差异测试锁定路径与旧 API 行为，不因为同名就判复用。MCP 单独验证 API-059 的协议/工具 schema。无服务器真实依赖的外部 API 测试记 NOT_RUN/BLOCKED，不冒报 PASS。

### U3/U5 上游 pins 与 deployment lock

- 路线列的 pin 目标：Helix `00d7927d...`、OpenMetadata `2.0.6-release` 对应 SHA `a695261b...`、Hasura `v2.51.1` 对应源码 `2b130a...`。当前三个克隆 HEAD 与之不同者（OM/Hasura）要作为参考差异记录，不能擅自 checkout。
- 建议：`integration-service/deploy/upstream-pins.json`（仓库参考源 pin）；`integration-service/deploy/deployment.lock.schema.json`、`integration-service/deploy/deployment.lock.example.json`；`integration-service/scripts/generate-lock.mjs`（依据现场检查结果，不用 SHA/tag 推算镜像 digest）。Lock 要含 `run_id`、采集 UTC 时间、源码 revision、镜像 repository+digest、配置 schema/摘要、migration/schema 版本、网络/连接探测结果、每个组件的来源与采集者。secret 只记 `secret_ref` 或已脱敏摘要，不写值。
- 校验建议：测试合法 fixture；缺 SHA/digest、`latest`、参考与实际不匹配、schema 版本/配置 digest 不符、实际运行 probe 未通过或缺失分别非 0；报告 stale pin 单独作为 reference discrepancy，不能因此误判已有镜像版本。

### U6/U7 证据 gate

- 建议路径：`integration-service/evidence/README.md` 说明 `evidence/<run_id>/` 文件约定；`integration-service/acceptance-tests/evidence/run-gate.mjs` 校验 required acceptance，配 manifest schema/example。每项记录 acceptance_id、requirement_ids/test_ids、状态、命令/退出码、时间、源码/镜像/配置版本、`environment_kind`、`input_kind`、独立 Oracle、实际结果、证据相对路径及 SHA-256、消费者标识。
- Gate 从 PRD/阶段清单读取 required IDs，而非信任结果里的自称 required 集合；缺 required 记录或文件、状态非 PASS、摘要失配、版本 lock 不符、真实 Golden Consumer 缺失、`synthetic` 被标成 golden 均非 0。脚本样例需含完整合法集和逐个失败负例；样例通过仅证明 gate 能工作，产品验收仍 NOT_RUN/BLOCKED。
- 推荐 node:test 或 Vitest 单测输入 manifest/tempdir/哈希校验即可，不启动 Compose。PowerShell 可用 `node ...` 调用 `.mjs`；避免脚本依赖 `bash`, `sha256sum`, Unix path 行为，路径校验用 Node `path.resolve/relative` 和 `node:crypto` SHA-256。

## 5. 适用说明与风险

- 仓库没有根 `AGENTS.md`，`integration-service/` 下也没有 `AGENTS.md`；三个上游各有自己的 `AGENTS.md`，但本轮未修改/进入其源码工作，因此不适用其代码更改规则。
- 最高风险是把静态代码、README 的历史/本地验证描述、参考 clone SHA 或格式校验结果当成本轮产品验收。路线和阶段门禁都明确：历史通过仅为重跑线索；静态存在只能记 implemented；批准、环境、有效证据齐全之前不得标 M0 verified。
- 其他需要在细计划明确的风险：当前 API 与 PRD 版本化路径/身份/操作状态差异大；service README 写 Node 24、代码端口默认值与 Compose 映射需复核；默认共享 admin/source key 与 `x-actor` 不能算可信身份；当前 lockfile 能复现 npm 树但不是部署 lock；OM/Hasura clone HEAD 不是要求版本；上游克隆应保持干净、不能为 pin 切换共享工作树。
