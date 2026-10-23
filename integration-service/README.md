# 数据治理与本体集成中台 · 交付件 A

本工程是 OpenMetadata + Helix Foundry + Hasura V2 方案的**可运行集成原型**。CRM 与订单系统通过 REST 或 PostgreSQL ETL 写入标准模型；Hasura 在 SQL 查询层执行行列权限；销售 MCP 只提供五个固定只读工具。OpenMetadata 与 Helix 通过只读适配器核验资产和已发布模型，不作为销售数据查询旁路。项目基线以 `E:\git\dgo-hub\docs\数据治理与本体集成中台_产品架构与二开说明_v1.0.md` 为准：OpenMetadata `2.0.6-release`、Hasura `v2.51.1`、Helix Foundry `00d7927d7c08e16c58316e006959f052427e7fa1`。


## Alpha.1 W0 status (2026-10-23)

This repository is a runnable integration prototype with legacy `/v1/ingest`, `/admin/*`, and `/mcp` routes. These existing capabilities do not mean the PRD's formal `/hub/v1/*` API set is implemented. The [API/page gap matrix](contracts/api-gap-matrix.md) maps all 59 API IDs, 12 pages, and 48 A/N/FI acceptance IDs; the [implementation baseline](docs/implementation-baseline.md) lists test scope and known gaps. W0 Tasks 0–3 passed their code/spec reviews, and Task 4 is pending the overall W0 review. Engineering-tool readiness is recorded separately from product acceptance.

Site endpoints, auth/Profile bindings, CRM/order contracts and approved real inputs, IdP configuration, site signoffs, and observed deployment metadata are absent. M0 and the product gate remain BLOCKED; all 48 product acceptance rows are NOT_RUN. Hermes Agent v0.22.1 is user-reported installed elsewhere, but no runtime build or MCP call was observed. Examples are structural checks and cannot satisfy site readiness.

## 目录

| 目录 | 内容 |
|---|---|
| `ingestion-api/` | REST 写入及四页所需管理 API |
| `etl-worker/` | CRM、订单库增量抽取，水位与钩子重试 |
| `normalization/` | Zod 标准模型、版本比较、幂等、客户映射与整单事务 |
| `ontology-binding/` | Helix 活动发布代次读取、OpenMetadata 表核验、字段映射验证 |
| `permission-publish/` | Hasura 表跟踪、行列 Select 权限、草稿审批发布 |
| `sales-mcp/` | 五个固定查询工具、JWT 验证、Hasura 查询及审计 |
| `acceptance-tests/` | 单元和在线闭环验收 |

## 快速启动

需要 Docker Compose、Node.js 24。示例密码仅用于本机验证，正式部署应替换并置于密钥管理系统。

```powershell
Copy-Item .env.example .env
docker compose up -d --build
docker compose ps
npm ci
npm test
npm run build
npm run acceptance:live
```

服务地址：接入与管理 API `http://127.0.0.1:3100`，MCP `http://127.0.0.1:3101/mcp`，Hasura Console `http://127.0.0.1:8088`。PostgreSQL 不发布主机端口，避免与现有实例冲突。容器首次启动由 API 执行迁移，由独立 Publisher 执行 Hasura 表跟踪和权限初始化。运行 `docker compose logs api worker publisher mcp hasura` 查看状态。Publisher 完成后查询闸门打开。

OpenMetadata 与 Helix Foundry 属于外部部署，配置 `OPENMETADATA_*` 与 `HELIX_*` 后才会启用适配器。Helix Foundry 当前官方安全模型是本机单用户；应在受信网络内使用只读工作区令牌，正式多用户方案需单独评估身份边界。它的 `/ingest` 是**整批快照替换**，本工程不把订单增量事件直接推到该接口。

## REST 对接

`POST /v1/ingest/customer`、`POST /v1/ingest/order` 需要 `x-source-key`、`x-source-system`、`idempotency-key`。同一事件与内容重试返回 `duplicate`；同键异内容失败；旧版本返回 `stale`。订单头及**完整明细**按一个事务提交；订单须包含 `customerSourceSystem`（跨源时，例如 `crm`）与 `customerSourceId`。删除使用更高版本的 `deleted:true`，订单明细在同一事务清空。

```powershell
$h=@{'x-source-key'='change-me-ingest-key';'x-source-system'='crm';'idempotency-key'='crm-c1-v1'}
$customer=@{sourceId='c1';tenantId='t1';ownerUserId='u1';version=1;name='Acme';email='a@acme.test'} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3100/v1/ingest/customer -Headers $h -ContentType application/json -Body $customer
$h['x-source-system']='orders';$h['idempotency-key']='erp-o1-v1'
$order=@{sourceId='o1';customerSourceSystem='crm';customerSourceId='c1';tenantId='t1';ownerUserId='u1';version=1;total=40;status='paid';items=@(@{sku='A';quantity=2;unitPrice=20})} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3100/v1/ingest/order -Headers $h -ContentType application/json -Body $order
```

## 数据库 ETL

示例源表见 `examples/source-schema.sql`。配置 `CRM_DB_URL`、`ORDER_DB_URL` 后，worker 按 `(updated_at, source_id)` 顺序抽取，每成功一行再前移水位；出错记录不前移，下一轮自动重试。源库需在更新时可靠地递增 `version` 和 `updated_at`。CRM 数据须先于关联订单可用。`GET /admin/etl/watermarks` 展示水位和错误，`POST /admin/etl/{source}/retry` 清除错误状态；实际重试由轮询执行。上游源表和游标方案是本演示约定，真实 CRM/订单库应做字段映射与快照一致性评审。

## 版本化数据库迁移

迁移文件放在 `migrations/`，使用连续三位版本号和名称，例如 `001_init.sql`。`npm run migrate` 运行独立 CLI；它要求调用环境显式提供 `DATABASE_URL`，`HUB_ENVIRONMENT_KIND` 可设为 `local_lab` 或 `site`，缺省按 `site` 处理。CLI 不加载 `.env` 文件。迁移 ledger 保存版本、文件名、规范化 LF 后的 UTF-8 SQL SHA-256 和应用时间；runner 用 PostgreSQL session advisory lock 串行化执行，并在每个迁移事务中同时执行 SQL 与写入 ledger。已应用文件缺失、改名、checksum 改变或历史有缺口都会拒绝继续。

迁移 SQL 由 runner 包在自己的事务中执行，文件本身不得包含顶层 `BEGIN`、`START TRANSACTION`、`COMMIT`、`END`、`ROLLBACK`、`ABORT`、`PREPARE TRANSACTION` 或对应 prepared commit/rollback 语句。runner 会在连接数据库前逐条扫描 SQL，并忽略空白、行注释、嵌套块注释、字符串、转义字符串、quoted identifier 和 dollar-quoted routine body；发现事务控制语句时以 `MIGRATION_TRANSACTION_CONTROL_FORBIDDEN` 拒绝整组迁移。routine body 中这些单词仍可正常使用。单引号与 E 字符串支持按 PostgreSQL 规则以换行续接；若换行续接的 E 字符串后续片段含反斜杠且不能由该边界扫描明确安全判断，则拒绝为 `MIGRATION_SQL_LEXING_UNSUPPORTED`。runner 要求连接会话的 `standard_conforming_strings=on`，并拒绝迁移顶层 SQL 通过 `SET`、`RESET` 或 `set_config` 更改此模式（`RESET ALL` 也拒绝）；不符合此合同返回 `MIGRATION_SQL_MODE_UNSUPPORTED`。这是受支持的 migration-file 合同与边界检查，不是任意 SQL 或 routine 副作用 sandbox。

默认情况下，检测到既有 hub 布局却没有迁移记录时，runner 返回 `LEGACY_BASELINE_REQUIRED`。仅在受控的本地实验库上，可显式设置 `HUB_ENVIRONMENT_KIND=local_lab` 并传入 `npm run migrate -- --adopt-legacy-001`，重放幂等的 001 并记录基线；site 环境禁止此选项。不要将基线接管用于已有部署数据。程序调用方可从 `migrate.ts` 导入 `runMigrations(pool, { directory, environmentKind, adoptLegacy001 })`；导入不会连接或执行迁移，传入的 pool 由调用方管理。

本地 ETL 冒烟验证：

```powershell
Get-Content examples/source-schema.sql -Raw | docker compose exec -T postgres psql -U hub -d hub
Get-Content examples/etl-seed.sql -Raw | docker compose exec -T postgres psql -U hub -d hub
docker compose run --rm -e CRM_DB_URL=postgres://hub:hub_dev_password@postgres:5432/hub -e ORDER_DB_URL=postgres://hub:hub_dev_password@postgres:5432/hub -e WORKER_ONCE=1 worker
docker compose exec -T postgres psql -U hub -d hub -c "SELECT source_system,last_status FROM control.etl_watermark"
```

## 管理 API 与权限

所有 `/admin/*` 需要 `x-admin-key`。`x-actor` 用于草稿创建、独立审批、发布操作的操作人标识。

| 操作 | API |
|---|---|
| 接入事件与 ETL 水位 | `GET /admin/ingestion/events`、`GET /admin/etl/watermarks` |
| 手动重试 | `POST /admin/etl/:source/retry` |
| Helix 模型、绑定列表与验证保存 | `GET /admin/ontology/helix`、`GET/POST /admin/ontology/bindings` |
| 权限草稿、审批、发布 | `GET/POST /admin/permissions`、`POST /admin/permissions/:id/approve`、`POST /admin/permissions/:id/publish` |
| MCP 工具与审计 | `GET /admin/agent/tools`、`GET /admin/agent/audit`、`GET /admin/agent/errors` |

Hasura 策略使用 `tenant_id = X-Hasura-Tenant-Id` 且 `owner_user_id = X-Hasura-User-Id`，列为明确白名单。客户邮箱和电话只通过 `api.customer` 脱敏视图提供，原始列不跟踪。`api.sales_summary` 与 `api.customer_sales` 在数据库聚合后再由 Hasura 按会话变量过滤。示例启动会自动发布默认 `sales_reader` 权限以便联调。权限发布由独立 Publisher 执行：先关闭查询闸门，导出 Hasura metadata 与资源版本，修改受管权限后用 `replace_metadata` 原子提交，再读回核对并打开闸门。发布失败时闸门保持关闭。API 返回 `queued` 表示已排队，须轮询策略状态确认 `published`。撤权、漂移自动纠正与多实例发布锁仍需接入企业控制平面。正式环境应移除默认权限自动发布。

## Hermes MCP 对接

HTTP Streamable MCP 地址为 `http://<trusted-host>:3101/mcp`。调用须带 `Authorization: Bearer <JWT>`；JWT 使用 HS256，含 `sub`、`tenant_id`、`role=sales_reader`、`iss=data-hub`、`aud=sales-mcp`、过期时间。生产应改用企业身份提供方的非对称签名/JWKS，并在网关验证 Hermes 用户与令牌绑定。工具名称对齐 PRD：`get_sales_context`、`find_customers`、`get_customer_orders`、`get_order_detail`、`get_sales_summary`。MCP 验证用户令牌后签发 60 秒 Hasura JWT，只发送固定的 `sales_reader` GraphQL 查询，不接受任意 SQL/GraphQL。MCP 容器没有 Hasura Admin Secret。

Hermes 配置示意（按实际版本的远程 MCP 配置格式调整）：

```json
{ "url": "http://trusted-host:3101/mcp", "headers": { "Authorization": "Bearer <per-user-short-lived-jwt>" } }
```

## 验证与边界

`npm test` 覆盖金额一致性、标准化、列白名单、行过滤表达式、五个工具、绑定验证及重试。`npm run acceptance:live` 需启动本机 Compose，覆盖 REST 写入、幂等、MCP 握手与五工具调用、跨用户行隔离、原始列拒绝。真实 OpenMetadata、Helix Foundry、CRM、订单库与 Hermes 环境未纳入本地验收。

正式上线前仍需：企业 SSO 与双人审批身份可信化；源库字段映射和 CDC/补数；OpenMetadata 自定义属性与血缘写回方案；Helix 发布版本固定与部署隔离；Hasura 撤权和权限漂移处理；管理页面实现、监控告警与备份恢复。这里交付的是完整可运行的**集成验证代码**，不是已完成生产认证的企业平台。

## 部署版本锁

`deploy/upstream-pins.json` 固定 Helix Foundry、OpenMetadata 和 Hasura 的参考源码版本。`deploy/deployment.lock.schema.json` 描述每个部署组件的镜像引用、分发 descriptor 摘要、摘要来源、适用时的 descriptor media type、源码 revision、应用配置 schema 与摘要，以及采集时间和能力探测记录。八个必需组件是 hub-api、hub-worker、hub-publisher、sales-mcp、hasura、postgres、openmetadata 和 helix-foundry；现场声明的额外组件也必须提供完整观测。`manifest_digest` 保留原字段名，表示 registry RepoDigest 或解析出的 OCI/Docker descriptor，可对应 index 或单平台 manifest；`digest_source` 必须是 `repo_digest` 或 `descriptor`。可选 `descriptor_media_type` 仅接受 OCI index/manifest 与 Docker manifest-list/manifest media type。`image_id` 是 Docker 引擎报告的身份，不能普遍解释为 OCI config blob；它仍是独立字段，不能补足缺少的分发摘要。`config.digest` 继续表示应用配置摘要。

生成器只读显式提供的观测 JSON 与 pins 文件，不连接 Docker、上游 checkout 或运行现场，也不读取容器环境变量。命令参数为 `--observations <file> --pins <file>`，可选 `--output <file>` 写出通过结构检查的锁，`--release` 增加正式部署条件。结构检查通过只说明声明字段和内部身份一致，输出仍为 `product_ready: false`；release 模式要求 `input_kind=observed`、`environment_kind=site`、全部组件探测为 PASS，且版本和运行身份匹配。

可从部署控制面或镜像仓库只读收集运行时元数据。Docker 环境可只读取以下字段，避免导出容器环境：

```powershell
docker inspect --format '{{.Config.Image}} {{.Image}} {{.Id}}' <container>
docker image inspect --format '{{json .RepoDigests}}' <image>
```

从实际构建记录或可信制品元数据取得组件 `source_sha`；参考 clone 的 HEAD 只作为参考 clone 观察，不能代表运行镜像的源码身份。分发摘要从 registry RepoDigest 或 descriptor 观察取得，并声明相应 `image.digest_source`；可观察到时记录 `image.descriptor_media_type`。Docker `image_id` 单独记入可选 `image.image_id`，即使它与分发摘要相同也有效，只要声明的摘要来源存在且 runtime/probe 身份相符。如果没有 RepoDigest 或 descriptor，保留分发摘要/来源缺失，正式校验会 BLOCKED，不能使用 image ID 回退。来源字段是声明的 provenance，不是加密证明。能力探测必须记录被探测的运行 image ID、manifest digest、应用配置摘要和 UTC 时间。

样例可用如下命令检查 JSON 形状；它会通过结构检查并明确保持 `product_ready: false`：

```powershell
node dist/scripts/generate-lock.js --observations deploy/deployment.lock.example.json --pins deploy/upstream-pins.json
```

当前尚未提供 OpenMetadata、Helix Foundry 及八个组件的实际部署观测，因此正式 lock 保持 BLOCKED。样例中的摘要仅用于演示结构，`input_kind=synthetic` 明确禁止其作为真实部署证据。

## 已核对的上游接口

- [Hasura V2 Metadata API](https://hasura.io/docs/2.0/api-reference/metadata-api/index/) 与 [权限规则](https://hasura.io/docs/2.0/auth/authorization/permissions/)
- [OpenMetadata 表 REST API](https://docs.open-metadata.org/latest/api-reference/data-assets/tables)（以本地 `2.0.6-release` 实例 OpenAPI 核对最终字段）
- [Helix Foundry API](https://github.com/HelixDB/helix-foundry/blob/main/docs/API.md) 与 [安全/快照说明](https://github.com/HelixDB/helix-foundry/blob/main/README.md)
