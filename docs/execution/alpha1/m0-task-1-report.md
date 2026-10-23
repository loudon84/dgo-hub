# M0 Task 1 — 身份持久合同与凭据生命周期

**状态：** 本地实现与验证完成，等待 GPT-6.1 Sol 独立 review。Task2 OIDC 和 Task3 MCP 未开始。

**分支 / dispatch base：** `feat/alpha1-implementation` / `b2f31bb683ef72a0ff3fda0248c5cb7c8b684a02`

**提交：**

- `2549a13cb48c815cd5553c23a015e0946d561407` — 修复迁移事务边界和 task-owned fixture 清理；此提交在首次 Task1 真实 PostgreSQL fixture 前完成。
- `98b726bcb140c4e7baa8da91c3c94a23acaa44b5` — 约束 runner 的字符串词法模式并补充清理歧义证据。
- `1250b960e3f8f89841a0b1c45f04015e2335da7b` — 实现身份与凭据生命周期。

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

真实数据库使用 postgres:16.10-alpine。RepoDigest 与 runtime image ID 分别记录，均观测为 `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`。Task1 identity fixture 使用 task label `task1`，container ID `ff50df4d45a78735c556bc309a3867b386b14d60e4b7944886967a7f254002f7`；Foundation migration suite 使用两个 task0 fixtures，container ID 分别为 `69687fe5c2efd8b9e427c81f6592b1ebf66ee414dcb1edea7566704bb0e0595c`、`42aa04696cb4b509dc99791e1fff4c58cc701f5730e0464a0ae4405e506ca63a`、`8ad475f48f2399d4173adffb71ed1f7aeb0b4851f5236076e964e972b5633cb8`（前两次为此前 Task0 focused run，最后一个为最终全套）。每个 ID 和唯一 run label 见对应 `*-postgres-lifecycle.jsonl`；summary 记录已按 label 校验、精确 ID 清理并确认不存在。未接触已有数据库或容器。

实现前 codec RED 曾观测为缺少模块，GREEN codec focused 用例通过；初始 RED 原始终端输出未留存，因此没有重建或伪造该证据。最终完整测试覆盖 canonical 编码/拒绝非 canonical 输入、raw-byte 摘要、随机性、execution role、真实 PG 生命周期、幂等并发、多 binding、epoch 和安全错误。

## 当前边界

这项工作只完成身份持久层和凭据生命周期，没有实现 OIDC HTTP/JWKS、MCP 传输层、Hasura JWT 实际签发、现场 deployment 或产品验收。W0-R1 已由 Sol 确认 ADDRESSED；Task0 I1/I2 修正随 Task1 等待 Sol review 确认关闭。M0–M6 的正式产品接受仍 BLOCKED/NOT_RUN，48项 A/N/FI 仍 NOT_RUN。
