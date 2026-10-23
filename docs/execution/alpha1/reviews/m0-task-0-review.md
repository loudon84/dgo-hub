### Spec Compliance

- ❌ **Spec gate: Needs fixes。** 发现两项 Important：**M0-T0-I1** 迁移 SQL 可自行提交，破坏每版本 SQL+ledger 原子性；**M0-T0-I2** owned PostgreSQL 启动失败路径丢失已创建资源的 ID，且另一清理分支可在删除失败后记录 removed。位置分别为 `integration-service/migrations/runner.ts:149`、`:150`、`:158`，以及 `integration-service/acceptance-tests/helpers/postgres.ts:74`、`:88`、`:154`、`:155`、`:158`。
- ✅ **W0-R1: ADDRESSED。** `integration-service/contracts/evidence.ts:80` 在同一个共享 scheme helper 中先 `trim()` 再执行原有大小写不敏感、仅匹配 scheme 的规则；与同文件 `:11` 的 schema 规范化一致。`integration-service/acceptance-tests/evidence/gate.test.ts:86` 起增加 consumer 空格 synthetic/tab mixed-case example、approval/owner 空格 fixture 的非 PASS 回归；`:126` 起保留 site/CMDB 路径或名称包含上述单词的正例及结构验证。没有把共享检查缩成单字段补丁。
- ✅ 001 未进入本轮差异，当前字节 SHA-256 与 before/after、pre-gate/post-commit 记录全部一致：`600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251`。证据为 `docs/execution/alpha1/m0-task-0-evidence/001-before.sha256:1`、`001-after.sha256:1`，及下述本次哈希核对。
- ✅ 导入安全、显式 CLI 执行和 caller pool 生命周期的代码边界清楚：`integration-service/migrate.ts:1` 不再导入 db singleton，`:67` 才构造 CLI pool，`:81` 关闭自有 pool，`:94` 仅 direct execution 执行；`integration-service/migrations/runner.ts:175` 只 checkout caller pool，`:250` 只 release client。未改 `package.json` 的 `migrate` 脚本，仍运行 `node dist/migrate.js`。
- ✅ 版本发现、严格 UTF-8 解码、LF checksum、连续版本与历史名称/checksum/缺失文件拒绝逻辑见 `integration-service/migrations/runner.ts:29`、`:44`、`:57`、`:132`。在进入 pending loop（`:224`）前验证 history（`:214`）。现有差异没有引入迁移 002 或 Tasks1–5 的身份功能。
- ✅ 同一 checked-out client 持有 session advisory lock（`integration-service/migrations/runner.ts:175`、`:189`），正常/失败结束统一 unlock/release（`:236` 起）；并发与普通语句失败回滚回归在 `integration-service/acceptance-tests/migrations.test.ts:132`、`:146`、`:217`。这一正面检查不覆盖 I1 的事务逃逸。
- ✅ 旧基线默认拒绝、显式 local_lab adoption、site 禁止及 unrelated public table 保留，代码/回归见 `integration-service/migrations/runner.ts:170`、`:203`、`:206`、`:218` 与 `integration-service/acceptance-tests/migrations.test.ts:191`、`:203`。本次针对 001 的只读补查确认 known-object 列表覆盖其应用表/视图，001 本身没有事务控制语句。
- ⚠️ **CannotVerify CV-1 — 历史 RED 原始输出。** `docs/execution/alpha1/m0-task-0-report.md:29` 叙述 R1 RED 为 32 passed/4 failed，但 review package 中只有 R1 GREEN/typecheck/build 的 raw logs；迁移导入 RED 有独立 raw log/exit。不能从当前包独立确认 R1 RED 的实际输出或执行身份。控制方如需审计这项 TDD 过程证据，应保留原始输出；不应为补历史记录重跑套件。此项不推翻可见代码的 R1 修复。
- ⚠️ **CannotVerify CV-2 — 现场/产品验收。** 本轮仅评审本地迁移基础设施与 W0-R1。106 tests、人工 release-shaped PASS fixture、容器日志均不是 48 个产品 ID 的正式 PASS，也不证明现场身份、部署、批准或真实数据。产品/site readiness 继续沿用外部 BLOCKED/NOT_RUN 状态，不能由此报告升级。
- ⚠️ **CannotVerify CV-3 — 历史执行的外部事实。** 留存三次成功资源生命周期支持其声明范围；日志本身不是外部不可伪造的执行证明。本轮没有回访既有用户数据库、历史容器或未列出的系统资源，也不把成功路径记录扩展为失败路径安全证明。

### Strengths

- `integration-service/migrations/runner.ts:16` 的稳定错误类型和 `integration-service/migrate.ts:48` 的输出白名单避免向 CLI 暴露原始 SQL/连接错误；文件命名限制也约束了可输出的 migration identifiers。
- `integration-service/acceptance-tests/migrations.test.ts:105`、`:146`、`:160`、`:169`、`:191` 针对真实数据库状态断言重复执行、失败 DDL/ledger、drift 和 legacy 边界，测试并非只有成功返回值。
- `integration-service/acceptance-tests/helpers/postgres.ts:75` 使用随机 run name、双 ownership labels、cidfile、loopback publish 和 tmpfs；正常关闭在 `:143` 核对 exact ID+labels，在 `:146` 验证 absence。RepoDigest 与 runtime image ID 在 `:103`、`:109` 独立观察，未做 fallback。
- `docs/execution/alpha1/m0-task-0-evidence/source-digests-pre-gate.txt:1` 与 `source-digests-post-commit.txt:1` 相同，且八个当前文件哈希实测相符。报告明确 tested implementation `86b5458e697e296d848086714d581d19d13239b7`；review Head 是后续证据文档提交 `b2f31bb683ef72a0ff3fda0248c5cb7c8b684a02`，没有把二者混为同一次测试身份。
- `docs/execution/alpha1/m0-task-0-evidence/final-test.log:8`、`final-test.exit:1` 留存 7 files/106 passed/exit0，build/typecheck 也有各自 log/exit，未见警告或跳过项。本轮未重复这些验证。

### Issues

#### Critical (Must Fix)

- 无。

#### Important (Should Fix)

##### M0-T0-I1 — 迁移文件内事务控制可以提交部分 SQL，失败后 ledger 与数据库分离

- **位置：** `integration-service/migrations/runner.ts:149`、`:150`、`:151`、`:158`；遗漏回归边界在 `integration-service/acceptance-tests/migrations.test.ts:147`。
- **问题：** runner 先发 `BEGIN`，随后把未经事务控制限制的整个文件作为 SQL 执行。如果文件包含 `COMMIT` 或 `ROLLBACK`，它能结束 runner 的事务；后续 ledger insert/错误处理已经失去原来的事务边界。文件格式/UTF-8/版本校验均允许这种 SQL。
- **已确认复现：** 在本次新建的独立 PostgreSQL16.10 上，002 内容仅为 `CREATE TABLE control.review_tx_escape(id integer); COMMIT; SELECT 1 / 0;`。`runMigrations` 返回 `MIGRATION_APPLY_FAILED`，但 `to_regclass('control.review_tx_escape')` 为 `control.review_tx_escape`，002 ledger count 为 `0`。001 保留。这是实际持久化状态与账本不一致，不是仅凭代码推测；下一次正常重试同名 CREATE 也会受到已提交对象影响。
- **影响：** 违反“每个迁移 SQL 与 ledger 在同一事务原子提交”“失败002回滚其DDL与ledger”的绑定要求。正常地从 SQL 工具导出的带事务包装脚本即可触发，不需要恶意数据库用户。
- **修复方向：** 在执行任何 pending migration 前，可靠地识别并拒绝能结束/替换外层事务的顶层事务控制语句，以安全稳定错误拒绝整个 migration set；或采用能真正保证这一边界的等效设计。需正确区分注释、字符串、quoted identifiers 和 dollar-quoted routine bodies，不能用简单 substring 阻断合法函数体。加入 COMMIT/ROLLBACK 逃逸的 focused regression，同时证明无部分 DDL、无 phantom ledger。仅在失败后检测“事务已结束”不足以撤销已提交 DDL。

##### M0-T0-I2 — Docker 创建后报错会遗失 owned ID；失败清理也可能虚记 removed

- **位置：** `integration-service/acceptance-tests/helpers/postgres.ts:74`、`:88`、`:90`、`:152`、`:154`、`:155`、`:156`、`:158`。
- **问题 A：** `containerId` 只在 `docker run` 成功返回后读取。如果 daemon 已创建资源并写好 cidfile，但 CLI 在返回前超时/报错，控制流直接进入外层 catch；此时 `containerId` 仍 undefined，既不读 cidfile、不留存 created ID，也不做 ownership check/cleanup，反而删除包含 cidfile 的临时目录。
- **最小故障注入结果：** 仅把 execFile 依赖替换为内存 mock，模拟 `run` 写入合法64位 cidfile 后抛出超时错误。未调用真实 Docker。观察到 `dockerCommands=["run"]`、`errorCode="OWNED_POSTGRES_COMMAND_FAILED"`、`cidfileRetained=false`、`cleanupAttempted=false`、`ownershipCheckAttempted=false`。这证明了分支行为；不声称本次真的遗留了容器。
- **问题 B：** 对已知 ID 的失败清理，`:155` 吞掉 `docker rm` 错误后，`:156` 仍写 `removed_after_start_failure`，且没有正常 close 分支的 absence verification。删除失败可被记录成 removed，随后继续删除本地定位材料。
- **影响：** 违反任务关于即时记录 exact newly-created ID、仅精确归属清理、保留准确资源生命周期证据的要求；基础设施偶发失败可留下仍运行的 owned PostgreSQL，且失去可审计的恢复信息。三次历史成功关闭记录没有覆盖这个路径。
- **修复方向：** 在 run 的失败路径也尝试读取并严格校验本次 cidfile，及时保留 safe ID/run label；只在 exact ID 与双 label 确认后清理。清理失败应留下明确未清理状态与 ID，不能吞错后记录 removed；应验证 absence 后才记录已移除，并在无法确认时保留定位材料。增加“创建后命令失败”和“owned rm 失败”的最小 fault injection 回归，无须创建第二套服务。

#### Minor (Nice to Have)

- 无独立代码 Minor。历史 RED 输出缺口列于 CV-1，避免把未看到的证据直接判定为不存在。

### Checks and bounded evidence

- **范围/身份：** Reviewer GPT-6.1 Sol，2026-10-23（Asia/Shanghai）。Base `17d3d28ffe87ebb23e47f167cfe10fe298e6c45c` → Head `b2f31bb683ef72a0ff3fda0248c5cb7c8b684a02`。先读 brief（含 addenda）、task report，再读 review package；初次工具输出截断的中段只补读对应 package 区间。没有重新执行 git diff/status/log，也没有 broad crawl 或分派子 agent。
- **当前身份核对：** 只读 `.git/HEAD` 与对应 loose branch ref，观察到 `refs/heads/feat/alpha1-implementation` 和上述 Head；当前八个 touched/source001 文件 SHA-256 与 pre-gate/post-commit 记录逐项一致。没有声称工作区其他文件整体 clean。
- **适用指令检查：** 对 E:/、E:/git、仓库根及涉及的 integration-service/migrations/contracts/acceptance-tests/helpers/evidence 和评审输出目录祖先的明确 AGENTS.md 路径作存在性检查；未发现适用文件。
- **命名风险与未改文件补查：** (1) 001 是否自带事务边界、known-object 列表是否误判基线：只读 `migrations/001_init.sql`，无事务控制且应用表/视图在列表内；(2) W0-R1 schema/helper 规范化是否等价：只补读 `contracts/evidence.ts` 未改 schema 的前75行，确认使用相同 JavaScript trim；(3) CLI/build 路径是否仍兼容：只读 `package.json` 与 `tsconfig.json`，确认 dist/migrate.js 脚本和输出布局。除此之外未查其他业务模块。
- **compiled 探针身份：** 在内存中以 ES2022 模块选项转译 migrate.ts、runner.ts、owned PG helper，规范换行后与现有 dist 三文件完全一致；未运行 build、未写 dist。首次以 NodeNext 的独立 transpileModule 默认文件上下文比较得到配置导致的 mismatch/exit1，在创建任何资源前退出；改用与现有 ESM 输出相符的 ES2022 模块选项后三文件全 true/exit0。没有把首次探针配置问题归因于产品源码。
- **I1 focused PostgreSQL probe：** 单个新建 owned fixture、单次 `runMigrations` 失败场景和一次状态 SELECT，exit0。结果原文：`{"probe":"migration_explicit_commit_then_error","runnerError":"MIGRATION_APPLY_FAILED","result":{"escaped_table":"control.review_tx_escape","ledger_002":0}}`。没有重跑已留存106 tests、并发 suite 或 CLI checks。
- **I1 资源身份：** runLabel `ba95f525-4545-4764-afcc-66fd34f8d150`；完整 container ID `eb5b639da197617d08980bb913e5a472a14aa28f9f447e49a86816e3850f42a7`；image reference `postgres:16.10-alpine`；distribution RepoDigest `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`；runtime image ID `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`。两个字段单独观察，合法 equality 未做 fallback。
- **I1 资源处置：** lifecycle 记录 created `2026-10-23T08:24:36.093Z`，image_observed `08:24:36.251Z`，removed `08:24:38.204Z`；helper 对 exact ID 和本次双 labels 确认后删除同一 ID，并验证不存在，`ownershipConfirmed=true, containerAbsentAfterRemoval=true`。probe 的外部临时目录在解析 absolute path、确认位于指定系统临时根且有本次固定前缀后删除；生命周期安全字段已转录于本报告。
- **I2 focused fault probe：** 从已读 diff 中重建 helper，在内存转译模块里仅注入 Docker execFile mock，exit0，无真实 Docker/resource 创建。结果原文：`{"probe":"mock_docker_create_then_timeout","realDockerInvoked":false,"dockerCommands":["run"],"errorCode":"OWNED_POSTGRES_COMMAND_FAILED","cidfileRetained":false,"cleanupAttempted":false,"ownershipCheckAttempted":false}`。它验证 A 的控制流；B 根据 `:155`/`:156` 明确的吞错后写事件代码判断，没有扩大探针范围。
- **安全边界：** 本次未读 .env、凭据/令牌、用户 DATABASE_URL、环境 dump、Docker Config.Env 或用户连接串。实际数据库读写只进入上面新创建的 owned PostgreSQL；没有检查/迁移/删除任何既有用户库、容器或卷。未修改产品文件、index、HEAD、引用克隆或远端；本次持久写入仅此评审报告。

### Assessment

**Spec gate: Needs fixes。Task quality gate: Needs fixes。**

**Reasoning:** W0-R1 的共享规范化修复、常规版本历史/并发/legacy 路径及源码证据身份基本符合要求；已实测的迁移事务逃逸破坏核心数据原子性，owned resource helper 的失败路径也不满足归属和生命周期要求。应先修复 M0-T0-I1/I2，再由控制方按既定评审流程裁定；本报告不推进 Task1、不授予任何产品或 site PASS。
