# Alpha.1 M0 身份与隔离 Implementation Plan

> **For agentic workers:** 使用 superpowers:subagent-driven-development；按任务执行并由独立 reviewer 检查。用户已授权按阶段直接执行，无需再次询问是否继续。

**Goal:** 在现有七模块上交付可本地验证的迁移、可信身份、个人凭据与最小权限部署，关闭共享密钥和来访自报身份的 Alpha 默认入口。

**Architecture:** 沿用四进程与 PostgreSQL。管理 OIDC、个人 opaque Bearer、来源 Bearer 分开解析；授权事实以同库服务端绑定和 epoch 为准。现场验证缺项独立记录 BLOCKED，本机合成环境不能替代。

**Tech Stack:** 既有 TypeScript/Node24、Fastify、pg、jose、Zod、Vitest、Docker Compose；不添加身份平台或迁移框架。

**Spec:** docs/数据治理与本体集成中台_产品架构与二开说明_v1.0.md 第9.8/14/17章、REQ-ARCH/AUTH/OBS、API-001/046–048；主路线v1.1；W0公开合同。

**状态:** Task0/1/2本地实现与Sol Spec/Quality已通过。Task3修复源码a7ce7d4的20项定向测试/typecheck/build通过；Sol复审关闭I2–I5，深层参数摘要绕过审计的I1仍未关闭。按用户“继续下一个实施”指令，Task4首先修复I1，再完成独立部署/权限/TLS探测；Task3工程gate待组合review确认。现场与远端Hermes v0.22.1仍BLOCKED/未观察。

## Global Constraints

- 用户指定工作目录 E:/git/dgo-hub、分支 feat/alpha1-implementation；保留现有七模块，不改三个上游参考克隆。
- 代码检索与实现由 GPT-6 Luna subagent 完成；每任务 GPT-6.1 Sol review。主会话只编排计划、文档和证据，不直接修产品代码。
- 不读取/回显 .env、token、密码；示例不含可用默认秘密。Secret只在明确的一次性创建响应中返回；不进入日志/Git/制品。
- 管理 OIDC 绑定 (issuer,sub)；业务角色 sales / sales_manager 独立于 managementScopes。客户端 tenant/role/department/header 不成为授权事实。
- 个人凭据为恰好32个随机字节的无前缀canonical unpadded base64url（43字符），仅存解码字节的SHA256，TTL默认3600秒/最大86400秒；短期Hasura JWT使用 `hub_<tenant_key>_<business_role>` execution role、audience=hasura-sales、TTL60秒，MCP无admin secret。
- 影响授权的变更与相关auth_epoch同事务；开始和交付前复核；变化丢弃未交付结果，审计失败不交付业务数据。
- local_lab 合成测试只能记工程验证；M0正式验收仍需真实IdP/映射、网络/TLS/账号/批准与运行锁。48项产品验收不因单测通过自动变PASS。
- 数据库/容器测试仅使用本次创建且记录资源ID的独立资源；禁止迁移、清空或删除现存用户hub库/卷/容器。
- 精确暂存本任务文件，先回归RED再实现GREEN，完整typecheck/test/build一次；修复轮仅覆盖受影响测试。禁止推送、合并、现场部署或升级远端Hermes。

## Review Focus

1. 并发/失败迁移、历史SQL被修改或丢失：必须序列化与回滚，不能伪记applied（Task0真实PG）。
2. 同key并发创建、首次响应丢失、撤销他人凭据：同主体只一份回执且不重显secret，不越租户（Task1/2真实PG+HTTP）。
3. JWT签名有效但tenant/role伪造、jku指向来访地址、缺映射或JWKS失败：0业务查询、拒绝（Task2本机真实非对称签名）。
4. 查询中撤销或审计失败，包括context工具：丢弃结果，不将失败变空数据（Task3受控在途测试）。
5. 旧演示入口、默认账号继承权限或销售网络旁路：Alpha默认关闭，DB/网络探测实际被拒（Task4独立Compose）。

## 文件职责

| 文件/目录 | 职责 |
|---|---|
| migrate.ts / migrations/runner.ts | 库/CLI、迁移发现、checksum、锁、事务 |
| migrations/002_identity_auth.sql | 租户、身份绑定、凭据摘要/回执/epoch |
| auth/types.ts、errors.ts、repository.ts、credentials.ts | 主体、稳定错误、受控持久变更、凭据生命周期 |
| auth/oidc.ts、ingestion-api/identity-routes.ts | 固定OIDC验证、本人API与scope边界 |
| sales-mcp/server.ts、queries.ts / auth-context.ts | opaque认证、短期JWT、前后状态检查、审计 |
| deploy/alpha1/、deploy/scripts/ | 与演示分离的启动、账号、网络、拒绝探测 |
| acceptance-tests/helpers/postgres.ts / identity*.test.ts | 独立本地真实数据库/签名/HTTP/协议验证 |

## Task 0：前置门禁修正与版本化迁移 runner

**refs:** REQ-ARCH/AUTH；架构基础验证，不单独关闭A-ARCH。**files:** migrate.ts、可选migrations/runner.ts、acceptance-tests/migrations.test.ts、helpers/postgres.ts、README.md。

**前置承接W0-R1：** 已使formal Gate的authority scheme判断与schema使用同样trim语义，覆盖带空白的consumer/source owner/approval；保持结构helper和合法引用行为。该修正独立提交并通过focused Gate验证，Sol确认ADDRESSED。另见[交接裁定](../execution/alpha1/w0-closure.md)。

**Produces:** runMigrations(pool, {directory,environmentKind,adoptLegacy001?}) -> {applied:string[],skipped:string[]}；可导入不自动执行；测试helper返回本次pool与close。

- [x] RED：空库/重复、两个并发runner、失败002、checksum改变/本地已应用文件缺失/版本重名缺序号、legacy默认拒绝与local_lab显式基线、导入无副作用。
- [x] GREEN：UTF8 LF规范化checksum；001起三位连续版本；单连接session advisory锁；每SQL和ledger同事务；不修改001。历史库默认LEGACY_BASELINE_REQUIRED，仅local_lab显式adoptLegacy001允许受控001重放；site禁止。
- [x] 真实独立PG focused、typecheck/test/build；记录资源边界和输出；实现已提交；Sol已在Task1复审确认I1/I2关闭。

**Review follow-up：** Task0 review发现 I1 顶层事务逃逸与 I2 fixture 清理证据不足。核心修复在 Task1 真实PG前以 `2549a13` 独立提交，`98b726b`补充词法模式与清理歧义处理；Task1初审又确认E字符串续行仍可逃逸，由 `a15dce8`修复并加真实PG回归。受支持合同要求迁移运行期间 `standard_conforming_strings=on`，拒绝事务控制、模式切换和明确不支持的续行形式；不是任意恶意SQL/routine副作用 sandbox。I2按完整ID和两项label核验，只在确认不存在后记录removed，无法确认时保留locator。Sol复审已确认I1/I2均ADDRESSED，关闭本地工程review gate。

## Task 1：身份持久合同与凭据生命周期

**refs:** REQ-AUTH，FI-10基础。**files:** auth/types/errors/repository/credentials.ts、002 SQL、acceptance-tests/identity-store.test.ts；复用Task0helper。

**Produces:** createAuthService({pool,clock?}) 的 resolveOidc(issuer,subject)、createAgentCredential(principal,input,idempotencyKey)、listAgentCredentials(principal,page)、revokeAgentCredential(principal,id)、authenticateAgent(token)、authenticateSource(token,entity)、assertCurrentAgent(snapshot)；对外抛稳定安全AuthError，不抛连接串。Repository提供授权变更/撤销与epoch同事务的方法，禁止业务路由直接改授权表。

- [x] RED：32bytes随机载荷/摘要非明文、默认/最大TTL、同key重试无secret/异内容409/并发单凭据、本人分页无secret/跨租户不可见、撤销与epoch同事务/重复幂等、过期/停用/无业务角色拒绝、来源个人token互拒。
- [x] GREEN：按下方精确合同建表、服务和安全回执；不自动注册/激活/授角色；来源注册只接部署提供secret与secret_ref，不开放匿名API。
- [x] 真实独立PG focused、typecheck/test/build、实现与文档精确提交；一轮修复后Sol Spec/Quality review均Approved。

## Task 2：可信 OIDC 与本人 HTTP API

**refs:** API-001/046/047/048；REQ-AUTH/AGENT。**files:** auth/oidc.ts、ingestion-api/identity-routes.ts、HTTP envelope/error helper、app.ts/registerRoutes选项、identity-http.test.ts。

**Consumes:** Task1 AuthService；**Produces:** createOidcAuthenticator(controlledConfig,authService) 与 registerIdentityRoutes(app,{authenticator,authService})；路由可用Fastify.inject验证，不需要启动用户服务。

- [x] RED：本机JWKS真实RS256/ES256签名，坏签名/issuer/audience/kid/exp/nbf/缺claim/HS/none/jku/伪造身份、未绑定/停用；JWT合法但身份仅取DB。
- [x] RED：GET/me输出白名单；POST凭据严格body+Idempotency-Key；GET列表分页上限；DELETE本人/授权管理员租户范围；HTTP401/403/404/409/422安全envelope与日志不泄漏secret。
- [x] GREEN：固定issuer/audience/JWKS/算法，site HTTPS；local_lab loopbackHTTP仅显式测试；无cookie身份流程，不增加未实现CSRF会话；企业IdP缺项fail closed。
- [x] focused HTTP+crypto+PG、typecheck/test/build、commit；一轮日志修复后Sol Spec/Quality Approved。

## Task 3：MCP 与来源认证边界接入

**refs:** REQ-AUTH/MCP/OBS，FI-10/12子集。**files:** sales-mcp/server.ts、queries.ts、auth-context.ts、ingestion-api/routes.ts、runtime配置、mcp-auth.test.ts。

**Consumes:** Task1/2主体与认证；**Produces:** Alpha /mcp/sales opaque入口、前后凭据/epoch/gate检查与审计拒绝。来源resolver供M1消费，M0不开放未实现的正式batch入口。

- [ ] RED：个人/来源/管理token不可互用；HTTP认证失败不执行工具；5工具含context都检查gate；查询在途撤销/epoch变化丢弃；审计失败无业务data；JWT中body身份不能扩大范围。
- [ ] GREEN：strict默认，旧/mcp HSJWT、/v1/ingest共享key及/admin只能local_lab+显式legacy开关；Alpha不注册旧路由。Hasura execution role由可信tenant_key和business_role精确派生为 `hub_<tenant_key>_<business_role>`，仅设置该一个allowed role；不得将sales/sales_manager直接作为execution role，也不降级到sales_reader；权限尚未M2发布时安全拒绝。
- [ ] 本地协议/受控查询边界 focused、typecheck/test/build、commit → Sol review；完整两角色GraphQL授权留M2。

## Task 4：独立 Alpha 部署与拒绝探测

**首个前置项（用户继续下一实施裁定）：** 承接Task3复审I1，先修复深度嵌套参数在安全边界外计算摘要导致无审计/原始错误的问题，补充正常审计与审计失败的定向回归并独立提交。Task3未宣布Approved；Task4独立Sol审查必须明确确认I1关闭。随后修复共享fixture证据路径，按新run集中保存全部当前资源记录，保留旧证据；不重建Task3丢失记录。销售前端网络与proxy→MCP私有网络分离，验证不能绕过TLS直接连接MCP。

**refs:** REQ-ARCH/AUTH/OPS。**files:** deploy/alpha1/compose.yaml、最小权限SQL/启动脚本、deploy/scripts/probe-sales-network.ps1、.env.example/README、部署测试。

- [ ] RED：定义API/worker/publisher/MCP/Hasura账号能力矩阵并实际探测禁用动作；销售入口无法访问管理/数据库/Hasura admin；缺秘密/IdP/TLS配置启动或探测返回BLOCKED非假PASS。
- [ ] GREEN：migrator一次性DDL、API启动不迁移；最小账号；Hasura业务只读api视图和独立metadata DB；只有publisher拥有admin secret；销售仅入口代理/MCP，不与DB/管理面同网。原演示Compose保留显式lab，Alpha配置独立。
- [ ] 独立Compose project/本次资源ID；本机TLS可用受控自签证书验证链路，真实DNS/TLS与现场网络仍BLOCKED。不得对现存项目down或删卷。
- [ ] focused配置/真实DB拒绝/网络探测、typecheck/test/build、commit → Sol review；记录实测拓扑而非仅静态yaml。

## Task 5：本地证据与阶段交接

**refs:** REQ-EVID、所有M0子集。**files:** docs/execution/alpha1/status.md、implementation-baseline.md、API矩阵、M0报告/本地run说明；随后M1细计划。

- [ ] 合并各任务工程证据与准确commit/测试数量；用W0记录器新建run并执行entry/lock/Gate，预期缺真实材料仍BLOCKED。
- [ ] API001/046–048及legacy边界状态更新；列明已本地验证与缺现场项，Hermes版本不再列未知。
- [ ] Sol阶段整体review，处理遗留；创建M1细计划继续实现来源/批次/规范化/ETL及接入页，不等待现场输入。

## 精确身份合同与裁定

- UserPrincipal 字段：userId、tenantId、departmentId:string|null、businessRole:'sales'|'sales_manager'|null、managementScopes:string[]、authEpoch（非负 bigint 的十进制字符串）、businessTimezone、issuer、subject；AgentPrincipal 在此基础上附 credentialId、credentialEpoch、expiresAt。SourcePrincipal 独立，只有 sourceId、tenantId、allowedEntities:customer|order、credentialId、revision，不能结构性当作 UserPrincipal。
- 管理 scope 独立于业务角色；初期只允许当前绑定租户。固定 scope 枚举：source:read/write/approve、mapping:write、governance:read/write、ontology:write/publish、binding:read/write/approve/publish、policy:read/write/approve/publish/revoke、access:preview、agent:read/revoke、audit:read、operation:read、ops:read（斜杠展开为各完整字符串）。管理角色不隐式拥有任何销售范围，sales_manager 缺 departmentId 不具业务查询能力。M1及后续接口复用这些 scope，不信任 body/header 的 tenant 或 role。
- 持久对象：control.tenant（不可变tenant_key、启用/时区）、control.auth_subject（tenant_key+user_id、部门、业务角色、scope、enabled、auth_epoch）、control.identity_binding（issuer+subject 唯一指向 auth_subject、enabled）、control.agent_credential（digest、过期/撤销、创建元数据、epoch）、control.source_credential（独立digest/来源/实体/状态/配置revision）、全局control.credential_digest_registry（digest唯一且kind不可复用），以及个人创建凭据的幂等回执。禁止自动注册、自动激活或授予角色；管理员 provisioning 属受控 DB/部署输入，不开放匿名注册。
- opaque token 恰好是32bytes随机载荷的43字符canonical unpadded base64url，不带个人/来源前缀；严格解码并以原始32bytes计算SHA256。全局digest-kind注册表和个人/来源分开的表及resolver防止类型复用；管理JWT不能当opaque credential。tenantId就是不可变的tenant_key，格式 `[a-z][a-z0-9_]{0,31}`，不由请求/claims派生或清洗。日志始终遮蔽 Authorization、Cookie、x-source-key 及创建响应secret，错误不回显原token。
- 个人凭据 POST 必须 Idempotency-Key，body 只允许 purpose 与 ttl_seconds。相同用户+key+请求摘要重试返回原 credential_id/expires_at 等回执、secret 不再返回；同key异内容409；并发相同key仅一份凭据。客户端丢失首次秘密需创建新key并撤销旧凭据，不能从服务端恢复秘密。凭据列表分页默认20/上限100，稳定游标/排序；拒绝越权凭据ID时404/不披露存在。
- DELETE 本人凭据幂等204（未知/他人返回同等不可见语义，不能撤销他人），有 agent:revoke 的当前租户管理员可撤销本租户目标；同事务将目标凭据revoked/credential_epoch+1与 auth_subject.auth_epoch+1。每次认证从DB读取当前主体和epoch；auth_epoch用于请求开始/交付前比较，不把所有其他有效凭据永久判失效。撤销只使目标凭据后续认证失败；同用户其他凭据的在途请求因epoch变化被丢弃，后续新请求可按当前授权重新认证。已撤销重复操作不反复提升epoch。
- auth_subject 部门/角色/启停、tenant启停及来源凭据替换由后续受控工作流更新；所有影响销售授权的变更必须使用同事务 epoch bump，测试直接调用受控 repository 方法，不靠请求体自选。OIDC principal 每次从DB重读，Agent 每次认证及返回前重读；数据库不可用拒绝，不缓存过期授权事实。
- OIDC 配置固定受控issuer/audience/JWKS与算法 RS256/ES256；不允许 HS、none、客户端jku/x5u动态地址。生产HTTPS；本机测试显式 local_lab 允许loopbackHTTP。jose校验 exp/iss/aud/sub必填和nbf，不使用JWT中的tenant/role/dept/scope覆盖DB。未知kid/错误签名/过期/JWKS不可用返回AUTH_INVALID且0业务查询；未绑定PRINCIPAL_MAPPING_MISSING；停用/撤销AUTH_REVOKED。
- API统一envelope/request_id；每请求由服务端生成可追踪ID，不将任意来访字符串直接写日志。服务日志不记录body/headers；仅最小状态。GET /me 返回用户/租户/部门/业务角色/管理scope/时区，不返回token、digest、issuer秘密或内部连接。
- M0将strict MCP映射到恰好一个 `hub_<tenant_key>_<business_role>` Hasura execution role的短期JWT（audience=hasura-sales，60秒）；business_role只能是sales或sales_manager，tenant_key来自当前数据库绑定。M2尚未发布对应权限时请求被Hasura拒绝；不能为了演示成功静默降为sales_reader或admin。local_lab旧路径需独立显式开关，Alpha默认禁用。M0只接入身份与gate/epoch/审计边界；完整查询语义、关系过滤与role权限归M2。
- 查询开始与交付前校验credential、auth_subject/tenant启用和epoch、query_gate epoch/open；get_sales_context同样受检查。工具层审计成功后才交付，审计失败AUDIT_UNAVAILABLE且不返回业务数据；错误审计不得带原始业务payload或秘密。M2负责客户转交epoch与关系一致性，M0本地先证明撤销在途结果丢弃（FI-10子集）与审计失败（FI-12子集）。
- M0的新来源resolver不等于来源可接入：旧/v1/ingest和/admin不能在Alpha默认注册；正式/hub/v1/ingest由M1接入来源配置、映射、批次后开放。明确返回不可用/404，不能继续接受共享key和自报owner。M1之前Alpha仅开放/me/credentials及健康和认证MCP边界。
- 独立测试数据库/容器必须有本次run的不可猜测名称，记录资源ID再清理；测试finally只删除本次创建资源。对现存hub服务、容器或卷无隐式迁移/清理。真正OIDC/网络/TLS/现场用户映射仍BLOCKED，不从本机测试推断。

## 分派前检查（规划期记录）

- W0 三个校验器只复用公开导出，M0不重写；任务brief含前置精确SHA和测试命令。
- 每个任务由Luna实现并记录RED/GREEN、完整typecheck/test/build，再交Sol独立spec/quality review；重要问题先修复，再下一任务。此处记录为原计划的执行流程，具体 W0 复核状态见 `docs/execution/alpha1/status.md`。
- 本草案不等于已实现；正式计划在W0合同完成后冻结并存入docs/plans，实施者只收本任务brief及相关接口。


## M0-0 分派接口草案

文件：integration-service/migrate.ts（可导入库/CLI）、migrations/runner.ts（若单文件职责需要）、acceptance-tests/migrations.test.ts、acceptance-tests/helpers/postgres.ts、README.md。保留001 SQL字节不变；禁止为了迁移校验重写历史SQL。

Produces：runMigrations(pool:pg.Pool, options:{directory:string,environmentKind:'local_lab'|'site',adoptLegacy001?:boolean}):Promise<{applied:string[],skipped:string[]}>；测试专用临时PG fixture返回pool与close（close只清理本次资源）。SQL文件版本固定三位数字从001连续，重名版本、缺序号、非UTF8/空SQL、已应用记录缺本地文件/改名/改checksum均拒绝。UTF8 LF规范化checksum；migration ledger version/name/checksum/applied_at；同一连接会话advisory锁序列化整个run；每SQL与ledger记录同事务。没有迁移SQL前失败不得伪写applied。

RED 用真实独立PG：empty applies001/second run skips；两个并发runner每版只执行一次；002制造错误回滚其DDL与记录，001保留；checksum/文件缺失/重复或缺序号拒绝；无ledger但已含001业务对象默认LEGACY_BASELINE_REQUIRED；local_lab+显式adoptLegacy001仅允许幂等001基线，不用于site；导入库不自动连接/执行。测试日志含计数和安全资源ID，不打印连接串/密码。真实Docker不可用时命令清楚BLOCKED，不能跳过后声称verified；当前Docker已就绪。

CLI默认保持npm run migrate可用，明确--adopt-legacy-001只local_lab。失败只输出安全错误码/版本名，不输出SQL参数或DATABASE_URL。不要创建/迁移现存用户hub库。任务先失败用例→focusedGREEN→typecheck/test/build→精确提交→Solreview。



## Alpha 过渡运行裁定

M0仅身份与隔离就绪时，未批准来源的worker不得启动旧演示固定表扫描；无已发布/验证权限的publisher启动先关闸并保持关闭，不能调用旧bootstrap自动打开gate。旧演示扫描与bootstrap同旧HTTP路由一样只属于local_lab+显式legacy路径。Task3/4按现有进程入口实现清楚的未就绪状态，M1/M2再接入真正的调度与恢复；不要伪造业务capability PASS，也不引入可绕过门禁的force-ready开关。健康、进程存活与业务就绪分开记录。

## 分派时冻结的配置与就绪合同

- HUB_ENVIRONMENT_KIND=local_lab|site，默认site；HUB_ENABLE_LEGACY_LAB默认false，仅local_lab可显式开启，site+true拒绝。
- OIDC固定受控HUB_AUTH_ISSUER/AUDIENCE/JWKS_URL；HUB_AUTH_ALLOW_LOOPBACK_HTTP仅显式local_lab测试允许，site禁止。库与测试不自动读取.env。
- 旧query_gate=open或sales_reader已发布不证明Alpha就绪。M0严格MCP包括context在M2受控applied证明缺失时保持NOT_READY；测试可注入受控状态验证在途边界，运行时没有force-ready开关，MCP不获得gate写权。
- Task4本地TLS优先用PowerShell7/.NET内存证书API，仅写本次临时目录、客户端显式CA信任；不修改主机证书存储或系统信任。服务SQL权限按M0真实查询重新核定，publisher关闸权限必须可执行约束而非普通UPDATE授权声明。
