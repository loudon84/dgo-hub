# M0 Task 1 — 身份持久合同与凭据生命周期

**状态：** 本地实现与验证完成，等待 GPT-6.1 Sol 独立 review。Task2 OIDC 和 Task3 MCP 未开始。

**分支 / dispatch base：** `feat/alpha1-implementation` / `b2f31bb683ef72a0ff3fda0248c5cb7c8b684a02`

**提交：**

- `2549a13cb48c815cd5553c23a015e0946d561407` — 修复迁移事务边界和 task-owned fixture 清理；此提交在首次 Task1 真实 PostgreSQL fixture 前完成。
- `98b726bcb140c4e7baa8da91c3c94a23acaa44b5` — 约束 runner 的字符串词法模式并补充清理歧义证据。
- `1250b960e3f8f89841a0b1c45f04015e2335da7b` — 实现身份与凭据生命周期。
- `17856e89ea99481e06163d673bb14901a4988756` — 同步公开计划、状态、报告与结构化证据。

## 已实现合同

- opaque 凭据由 `randomBytes(32)` 生成，外观为恰好43个字符的无填充 canonical base64url。解码器要求严格字符集、解码长度32和重新编码完全相同；摘要是解码后的原始32字节的 SHA-256。数据库只保存32字节摘要。
- agent/source 共用 `control.credential_digest_registry` 的全局 digest 主键与 kind 约束；两种凭据表以固定 `digest_kind` 和复合外键绑定到注册表，不能将同一摘要跨类型复用。管理 OIDC/JWT 不由 opaque credential resolver 接受。
- `tenant_key` 与 `tenantId` 是同一不可变租户键，格式为 `[a-z][a-z0-9_]{0,31}`。数据库检查约束和 UPDATE trigger 均保护此规则。`deriveExecutionRole` 输出 `hub_<tenant_key>_<business_role>`，只接收 `sales` 或 `sales_manager`。
- `control.auth_subject` 保存部门、业务角色、管理 scopes、enabled 和 `auth_epoch`；`control.identity_binding` 唯一映射 `(issuer,subject)` 到主体；个人和来源凭据使用独立表。个人创建回执按 `(tenant_key,user_id,idempotency_key)` 唯一存储。
- `createAuthService` 提供 `resolveOidc`、个人凭据创建/列表/撤销、agent/source 认证、`assertCurrentAgent` 和受控 repository provisioning/update。可传入调用方 `PoolClient`；此时 repository 复用同一事务且不自行 BEGIN/COMMIT/release。授权状态变化和相应 `auth_epoch` 更新在事务中完成。
- 个人凭据属于 `auth_subject(tenant_key,user_id)`，不是某个单独 binding。认证时从该主体的 bindings 中稳定选择 enabled binding（按 issuer、subject 排序）；若没有 enabled binding，取稳定首项并拒绝为 revoked。`assertCurrentAgent(snapshot)` 按原 snapshot 的 issuer/subject 重查绑定，不切换到另一 binding；确认该 binding 仍 enabled 且仍指向相同主体，并比较主体 `auth_epoch`、凭据 `credential_epoch`、部门、业务角色、时区和管理 scopes。因而禁用/重绑原 binding、或另一授权事实变化时，旧请求上下文不会被替换成其他 binding。
- 创建凭据默认 TTL 为3600秒、最大86400秒；相同幂等键和请求返回不含秘密的原凭据元数据；同键不同请求为409；并发同键只创建一份凭据。列表只返回元数据且以稳定游标分页。个人撤销只允许本人，或具有 `agent:revoke` 的同租户主体；不存在、他人和重复撤销保持不可见/幂等语义。来源凭据由受控 provisioning 接口接收 secret 和 `secretRef`，没有匿名注册入口。
- `AuthError` 只暴露稳定错误码和 HTTP 状态，不保留底层数据库异常：401 认证/上下文错误、403 越权、409 幂等冲突、400 输入错误、503 授权存储不可用。

## 基础修正与范围

Task0 review 指出的 I1/I2 核心修复在 `2549a13` 中完成并先于 Task1 真实 PG fixture。I1 在连接前拒绝顶层事务控制；runner 要求连接会话 `standard_conforming_strings=on`，并拒绝直接顶层 `SET`/`RESET`、`RESET ALL` 和任意顶层 `set_config` 调用（包含动态拼接 setting 名）。合同要求迁移执行时不改变 SQL 字符串词法模式。扫描器忽略字符串、quoted identifier、注释和 dollar-quoted routine body；这是受支持 SQL-file 合同的边界检查，不是通用 SQL sandbox，也不解析任意 PL/pgSQL/函数副作用。

I2 helper 仅在检查 task/run labels 与完整 container ID 后操作该 ID；启动异常时从 cidfile 恢复已创建 ID；只有 Docker 可确认资源不存在才记录移除成功。daemon 检查失败或超时保留 cidfile locator，并记 `cleanup_unconfirmed`。命令 seam mock 覆盖 run 后失败、rm 失败、label 错配和 rm 后无法确认 absence。

`migrations/001_init.sql` 未修改。实施前后 SHA-256 均为 `600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251`。

## 验证与证据

最终验证在源摘要冻结后执行：`npm run typecheck`、`npm run build`、`npm test` 均退出0；Vitest 4.1.12 全部10个文件、149项测试通过。最终日志、退出码、源摘要在 [Task1 evidence](m0-task-1-evidence/)；pre/post-gate摘要一致，提交后再计算的工作树摘要也一致。

真实数据库使用 postgres:16.10-alpine。RepoDigest 与 runtime image ID 分别记录，均观测为 `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`。Task1 identity fixture 使用 task label `task1`，container ID `ff50df4d45a78735c556bc309a3867b386b14d60e4b7944886967a7f254002f7`。Foundation migration suite 有三条 task0 生命周期记录：两个此前 focused run 的 ID `69687fe5c2efd8b9e427c81f6592b1ebf66ee414dcb1edea7566704bb0e0595c`、`42aa04696cb4b509dc99791e1fff4c58cc701f5730e0464a0ae4405e506ca63a`，以及最终全套 run 的 ID `8ad475f48f2399d4173adffb71ed1f7aeb0b4851f5236076e964e972b5633cb8`。每个 ID 和唯一 run label 见对应 `*-postgres-lifecycle.jsonl`；summary 记录已按 label 校验、精确 ID 清理并确认不存在。未接触已有数据库或容器。

实现前 codec RED 曾观测为缺少模块，GREEN codec focused 用例通过；初始 RED 原始终端输出未留存，因此没有重建或伪造该证据。最终完整测试覆盖 canonical 编码/拒绝非 canonical 输入、raw-byte 摘要、随机性、execution role、真实 PG 生命周期、幂等并发、多 binding、epoch 和安全错误。

## Consumer interface appendix

以下为 `integration-service/auth/types.ts` 中导出的确切 Task1 对外形状（输入只列类型字段；运行时还执行更严格的 validation）：

```ts
createAuthService(options: { pool: Pool; clock?: () => Date }): AuthService

type BusinessRole = 'sales' | 'sales_manager';
type SourceEntity = 'customer' | 'order';
type AuthScope =
  | 'source:read' | 'source:write' | 'source:approve' | 'mapping:write'
  | 'governance:read' | 'governance:write' | 'ontology:write' | 'ontology:publish'
  | 'binding:read' | 'binding:write' | 'binding:approve' | 'binding:publish'
  | 'policy:read' | 'policy:write' | 'policy:approve' | 'policy:publish' | 'policy:revoke'
  | 'access:preview' | 'agent:read' | 'agent:revoke' | 'audit:read'
  | 'operation:read' | 'ops:read';

type UserPrincipal = Readonly<{
  userId: string; tenantId: string; departmentId: string | null;
  businessRole: BusinessRole | null; managementScopes: readonly AuthScope[];
  authEpoch: string; businessTimezone: string; issuer: string; subject: string;
}>;
type AgentPrincipal = UserPrincipal & Readonly<{
  credentialId: string; credentialEpoch: string; expiresAt: string;
}>;
type SourcePrincipal = Readonly<{
  sourceId: string; tenantId: string; allowedEntities: readonly SourceEntity[];
  credentialId: string; revision: string;
}>;

type CreateAgentCredentialInput = Readonly<{ purpose: string; ttl_seconds?: number }>;
type AgentCredentialMetadata = Readonly<{
  credential_id: string; purpose: string; created_at: string;
  expires_at: string; revoked_at: string | null;
}>;
type CreateAgentCredentialResult = AgentCredentialMetadata & Readonly<{
  secret: string | null; replayed: boolean;
}>;
type AgentCredentialPage = Readonly<{ cursor?: string; limit?: number }>;
type AgentCredentialPageResult = Readonly<{
  items: readonly AgentCredentialMetadata[]; next_cursor: string | null;
}>;

resolveOidc(issuer: string, subject: string): Promise<UserPrincipal>;
createAgentCredential(
  principal: UserPrincipal, input: CreateAgentCredentialInput, idempotencyKey: string,
): Promise<CreateAgentCredentialResult>;
listAgentCredentials(
  principal: UserPrincipal, page?: AgentCredentialPage,
): Promise<AgentCredentialPageResult>;
revokeAgentCredential(principal: UserPrincipal, credentialId: string): Promise<void>;
authenticateAgent(token: string): Promise<AgentPrincipal>;
authenticateSource(token: string, entity: SourceEntity): Promise<SourcePrincipal>;
assertCurrentAgent(snapshot: AgentPrincipal): Promise<void>;
```

`clock` 是可选函数，须返回有效 `Date`；默认值为 `() => new Date()`。`createAgentCredential` 单独接收 `idempotencyKey`；首次结果返回一次性 `secret`，同请求 replay 返回 `secret: null, replayed: true`，元数据字段与 `AgentCredentialMetadata` 相同。`purpose` 经过 trim，接受1–96个允许的 ASCII 字符；`ttl_seconds` 默认3600，接受整数1–86400。`listAgentCredentials` 默认 limit 20，接受1–100；cursor 是上次结果给出的 UUID string，结束时 `next_cursor` 为 null。`assertCurrentAgent` 返回 void，只在精确 snapshot 仍然有效时 resolve。

`AuthError` 包含 `code` 与 `status`；`message` 等于稳定 code，不附带数据库 cause：

| Code | HTTP status |
|---|---:|
| `AUTH_INVALID`, `AUTH_EXPIRED`, `AUTH_REVOKED`, `AUTH_CONTEXT_CHANGED`, `PRINCIPAL_MAPPING_MISSING` | 401 |
| `AUTH_FORBIDDEN` | 403 |
| `IDEMPOTENCY_CONFLICT` | 409 |
| `AUTH_INPUT_INVALID` | 400 |
| `AUTH_UNAVAILABLE` | 503 |

受控 repository 合同（可选 `client` 是调用方拥有的 `PoolClient`；提供后 Task1 不开嵌套事务或释放它）：

```ts
provisionTenant(input: TenantProvisionInput, client?: PoolClient): Promise<void>
provisionSubject(input: SubjectProvisionInput, client?: PoolClient): Promise<void>
bindIdentity(input: IdentityBindingInput, client?: PoolClient): Promise<void>
updateSubject(input: SubjectProvisionInput, client?: PoolClient): Promise<void>
setIdentityBinding(issuer: string, subject: string, enabled: boolean, client?: PoolClient): Promise<void>
setTenantEnabled(tenantId: string, enabled: boolean, client?: PoolClient): Promise<void>
provisionSourceCredential(input: SourceCredentialProvisionInput, client?: PoolClient): Promise<void>
updateSourceCredential(
  sourceId: string, tenantId: string, enabled: boolean, revision: string,
  allowedEntities: readonly SourceEntity[], client?: PoolClient,
): Promise<void>
```

Input records 精确为 `TenantProvisionInput={tenantId,businessTimezone,enabled?}`、`SubjectProvisionInput={tenantId,userId,departmentId?,businessRole?,managementScopes?,enabled?}`、`IdentityBindingInput={issuer,subject,tenantId,userId,enabled?}`、`SourceCredentialProvisionInput={sourceId,tenantId,token,secretRef,allowedEntities,revision,enabled?}`。字段均按上述类型定义；repository 方法都返回 `Promise<void>`。

## Fix round 1/5 — scoped Sol findings

**Reviewed base:** `68c8657aad4d001ab4cecd6c6e72e6346c311956`. **Fix commit:** `a15dce871dd7017385e10f8b6dfc3ce18e3c2b50`. Both reported findings are addressed in code and focused verification; scoped Sol re-review is pending. Consumer interface is unchanged.

- **M0-T0-I1 — addressed:** The scanner now recognizes newline-separated adjacent string segments after an E string, including whitespace and comments between segments. It preserves E escape handling across the continuation so the actual top-level `COMMIT` and `ROLLBACK` in the reproducer are found during migration discovery, before `pool.connect()`. A continued E-string segment containing a backslash is conservatively rejected as `MIGRATION_SQL_LEXING_UNSUPPORTED` when no transaction-control token was otherwise found. Ordinary legal newline continuation remains accepted. The PostgreSQL regression copies unchanged 001/002 plus the exact 003 reproducer for both controls and confirms preflight rejection leaves the schema absent and ledger at zero.
- **M0-T1-I1 — addressed:** Cursor validation still resolves the UUID only for the current `(tenant_key,user_id)`. The list query now compares `(created_at,id)` against an owner-filtered SQL CTE anchor, so `timestamptz` microseconds never round-trip through JavaScript `Date`. The deterministic `.000900Z/.000800Z/.000700Z` regression enumerates all three credentials through limit-1 pages; forged and cross-user cursor cases remain covered.

**RED:** Before these implementation changes, `npm test -- acceptance-tests/migration-boundary.test.ts acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts` exited 1 (3 files, 54 tests, 51 passed / 3 failed). Real PostgreSQL showed COMMIT left `control.review_e_commit` behind with ledger versions 001/002 but no 003; ROLLBACK also failed apply after 001/002 were written; submillisecond pagination traversed 1 of 3 credentials. The round1 RED summary is in [focused-red-summary.md](m0-task-1-evidence/round1/focused-red-summary.md). The independent review's original raw probe remains in the scratch review package.

**GREEN / focused gate:** `npm test -- acceptance-tests/migration-boundary.test.ts acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts` exited 0: 3 files, 54 tests passed. `npm run typecheck` and `npm run build` each exited 0. Raw command logs and exit files are in [round1 evidence](m0-task-1-evidence/round1/). No unrelated full suite was rerun.

The final round1 migration fixture used task label `task0`, run label `1462f684-eb54-4957-a2de-730199b101ea`, and container ID `1e23a0abdf1eb1bf1ec6af8be88ad19409a5f6b39716ad9143cc0f11e82dcd4c`. The identity fixture used task label `task1`, run label `974e4acf-8010-4f7d-9104-301c7c962d47`, and container ID `8575e30c53996079184f12536b15d98b37bd8cb017dfa2b9b44a7fddb7be63a6`. An earlier focused GREEN retry is also fully recorded in the lifecycle JSONL as task0/run `e59632d6-133e-4df4-acbe-ce04ca42a587`, container `dd6e3c83714ecc9ddc36c7ea078c0f127ddcbfd6e86b8aa64a4da411ce949672`. Every recorded container has `ownershipConfirmed=true` and `containerAbsentAfterRemoval=true`. The resource summaries preserve both image fields; RepoDigest and runtime image ID were each observed as `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`.

The original Task1 evidence directory was restored and left unchanged; all fix-round outputs are isolated under `m0-task-1-evidence/round1/`. `001_init.sql` SHA-256 remains `600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251`.

## 当前边界

这项工作只完成身份持久层和凭据生命周期，没有实现 OIDC HTTP/JWKS、MCP 传输层、Hasura JWT 实际签发、现场 deployment 或产品验收。W0-R1 已由 Sol 确认 ADDRESSED；Task0 I1/I2 修正随 Task1 等待 Sol review 确认关闭。M0–M6 的正式产品接受仍 BLOCKED/NOT_RUN，48项 A/N/FI 仍 NOT_RUN。
