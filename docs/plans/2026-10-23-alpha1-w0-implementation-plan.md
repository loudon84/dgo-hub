# Alpha.1 W0 基线、合同与证据实施计划

更新：2026-10-23。状态：EXECUTING（本地工程任务）；产品正式批准状态仍由真实签署记录决定。

**Goal：** 把已存在的 integration-service 接管为可提交、可重跑、会拒绝错误放行的工程基线，为 M0–M6 提供统一合同和证据入口。
**Architecture：** 复用七模块和现有 TypeScript/Zod/Vitest；新增合同与纯判定函数，CLI 只负责文件输入输出。所有未满足的正式验收保持 NOT_RUN/BLOCKED。
**Spec：** 主 PRD 第 17、24–29 章，路线 v1.1 的 U1–U7；阶段门禁 phase-gates-alpha1.md。
**执行方式：** GPT-6 Luna 负责代码检索与实现；GPT-6.1 Sol 负责每任务 spec/quality review；主会话负责细计划、裁决、进度与交接。

## Global Constraints

- 工作目录 E:/git/dgo-hub；当前功能分支 feat/alpha1-implementation。根仓无历史 commit 时先建立基线，保留用户已有文件；不将三个上游仓库、秘密、node_modules、dist、deliverables 或执行草稿纳入 Git。
- 不改三个上游工作区，不重建 integration-service，不读取或回显 .env 的秘密值；例子只使用 secret_ref 或清楚的非秘密占位文本。
- 实施任务状态 planned/implemented/verified/blocked；产品验收 PASS/FAIL/BLOCKED/SKIPPED/NOT_RUN。单测通过不把产品 A-ID 自动设 PASS。
- A/N 分类为 ARCH AUTH SRC ING ETL DATA GOV ONT PUB SEC POL API MCP AGENT UI OBS OPS EVID，各有 -001；FI-01 至 FI-12。Release Gate 检查全部 48 项。
- Golden Consumer 需要批准的真实 CRM/订单输入、Hermes 实际版本及两名销售和一名部门经理；合成或占位材料不能替代。
- CLI 非正常/缺项返回非 0 且给出稳定机器 JSON；日志不得含秘密。禁止联网推送、部署现场或伪造批准/运行结果。
- 新增行为先写失败用例，再实现；每任务聚焦验证后跑完整 typecheck/test/build 一次并保存输出；review 针对实际 diff，不重复同一批全量测试。

## Review Focus

- 已有根 Git 无 commit：只精确提交本项目，不能把上游 Git 仓内容或 .env 带进基线。
- schema 合法 example 不代表真实环境齐套；REVIEW、样例身份和缺签署都必须阻断正式 M0。
- 镜像 config image ID 不等同 OCI manifest digest；源码 pins 不等同参考 clone HEAD；不能用假的 sha256 或 latest 放行。
- 证据路径不能越界/穿越符号链接；摘要、输入与版本不匹配必须失败。
- 48 项标签 PASS 但缺命令/Oracle/实际文件或缺真实消费者必须失败；样例评测不能输出产品可放行。

## Task 0：建立可追踪基线

**Refs：** R4/R6、U2。**入口：** 路线 v1.1 已修订，用户授权实施。**范围：** Git 元数据、忽略规则、现有文档/源码快照。
**Files：** root .gitignore；docs/plans/alpha1-w0-discovery.md；现有 integration-service/ 和 docs/ 的基线。
- [ ] 根据只读发现报告保留/扩展忽略规则，排除 upstream repo、node_modules/dist/.env、压缩包和 .superpowers。
- [ ] 在现有功能分支精确暂存用户已有集成源码与文档，检查 staged 文件名/敏感路径，建立 baseline commit。
- [ ] 运行已有 typecheck/test/build，保存输出到本计划执行区；不触碰运行中数据库。
- [ ] 记录 Git SHA、变更路径和基线测试结果，未执行外部测试仍为 NOT_RUN。
**验收：** 源码可用 Git 追踪且 upstream/secret 未入索引；基线测试结果可供后续比较。
**失败：** 用户文件被覆盖、秘密入索引或测试异常须先处理；不通过删除用户文件解决。

## Task 1：批准与环境合同判定器

**Refs：** U1，REQ-ARCH/AUTH/SRC/AGENT 的准备；不关闭这些产品 A-ID。
**Files：** integration-service/contracts/environment.ts、contracts/signoff.ts；scripts/check-m0-entry.ts；acceptance-tests/environment.test.ts；docs/approvals/alpha1-signoff-checklist.md、environment-inputs.schema.json、environment-inputs.example.json、alpha1-signoffs.example.json；package.json。
**Produces：**
- EnvironmentInput：schema_version、environment_kind(local_lab/site)、tenant_key、business_timezone、idp(issuer/audience/jwks_uri)、sources(只读 endpoint、secret_ref、mapping_ref、replica_authorization_ref、deletion_contract_ref)、identity_mapping_ref、tls_hostname、internal_services、backup_ref、hermes.actual_version。
- SignoffRecord：schema_version、contract_ref、approvals（product/architecture/data_owner/security/test 五项）；状态 REVIEW/APPROVED_FOR_PLAN，批准项必须 actor_ref/approved_at。
- evaluateM0Entry(signoffs: unknown, environment: unknown, options: {expectedKind: 'local_lab'|'site'; allowExample: boolean}): {status:'PASS'|'BLOCKED'; missing:string[]; example:boolean}。
**Steps：**
- [ ] RED：缺 issuer/来源合同/某批准、REVIEW、来源字段含 password、伪造 secret_ref、site 评估却传 local_lab、sample 标志都不能放行；完整非样例合同可通过。
- [ ] GREEN：用现有 Zod 实现严格 schema 与上述纯函数；默认拒绝额外秘密字段。secret_ref 为引用，不接受连接串内 userinfo 或秘密查询参数。
- [ ] 导出 JSON Schema 和清楚的 example=true / REVIEW 示例；不得预填批准或真实 IdP/消费者版本。
- [ ] CLI 接收 --signoffs/--environment/--expected-kind，默认正式判定拒绝 example；可显式 --validate-example 只检查语法且结果 product_ready=false，不能输出正式 PASS。
- [ ] 测试 schema/纯函数/CLI 正反例；运行 typecheck/test/build 并提交。
**Side effects：** 只写本项目代码/文档与用户指定输出文件；不访问现场、不读取秘密。
**Evidence：** RED/GREEN、完整测试输出、commit 和报告。缺现场输入属于产品 BLOCKED，不阻断判定器交付。

## Task 2：版本 pins 与 deployment.lock 判定

**Refs：** U3/U5、R7，A/N-ARCH 的准备。
**Files：** deploy/upstream-pins.json、contracts/deployment-lock.ts、deploy/deployment.lock.schema.json、deploy/deployment.lock.example.json、scripts/generate-lock.ts、acceptance-tests/deployment-lock.test.ts、README.md、package.json。
**Consumes：** Task1 的 environment_kind；根 Git 基线身份。
**Produces：** validateDeploymentLock(input: unknown, pins: unknown, options:{release:boolean}): {status:'PASS'|'BLOCKED'; issues:string[]}；lock 记录 source pins、组件实际 source_sha、镜像精确 tag+manifest_digest、config_schema、probe 时间/结果、input_kind、run_id。
**Exact pins：** Helix 00d7927d7c08e16c58316e006959f052427e7fa1；OM 2.0.6-release / a695261b19d48411a39502a5c5fc0b453729eb4e；Hasura v2.51.1 / 2b130a135659026ff6eda42c1df5722f123fd84e。
- [ ] RED：缺 digest、浮动 latest、source SHA 不匹配、probe 未运行、组件缺失、用 image_id 充 manifest_digest、synthetic release 均 BLOCKED。
- [ ] GREEN：严格 schema、纯校验器与生成 CLI；只消费显式 observations，不静默补默认版本/摘要，不修改上游 checkout。
- [ ] 示例有 input_kind=synthetic，语法有效但正式 release 校验阻断；真实组件 observations 尚缺时输出缺项，不造 lock PASS。
- [ ] 提供只读采集操作说明，区分参考 clone HEAD、构建 source 和实际运行；输出不包含环境秘密。
- [ ] 精确测试、typecheck/test/build、提交与报告。
**失败范围：** 正式 lock 不齐套保持 BLOCKED；不影响生成/校验行为本身的单测交付。

## Task 3：48项证据合同与 Release Gate

**Refs：** U7、REQ-EVID，支持全部阶段。
**Files：** contracts/evidence.ts、acceptance-tests/evidence/run-gate.ts、acceptance-tests/evidence/gate.test.ts、evidence/README.md、scripts/record-local-checks.ts、package.json。
**Consumes：** Task2 lock 校验器；Task1 环境/批准判定。
**Produces：** evaluateReleaseGate(runDir:string): Promise<{status:'PASS'|'FAIL'|'BLOCKED'; product_ready:boolean; issues:string[]}>；required IDs 是共用约束列出的 18 A + 18 N + 12 FI。
- [ ] RED：任意项缺失/重复/非PASS、空 evidence、sha被改、path traversal/绝对路径/符号链接、版本/输入不匹配均不能放行。
- [ ] 结果严格记录 acceptance_id/requirement_ids/test_ids/status/command/exit_code/时间/git_sha/image_digests/input_manifest/oracle(expected/actual)/evidence_files。NOT_RUN 可缺 command/actual，不计通过。
- [ ] Gate 核对 deployment.lock、source-contracts、fixture/input manifest、file-digests 和每项证据；真实消费者材料含 approved real 输入、Hermes/version、三个独立主体及 oracle/trace 引用，synthetic/placeholder 不能冒充。
- [ ] Gate 不以某路径名包含 golden-consumer 就当真实；输入 kind、来源批准引用、消费者标识和摘要互相匹配。
- [ ] record-local-checks 仅运行固定 allowlist 的现有 typecheck/test/build，记录本地 check_results 与输出摘要；canonical 48项默认 NOT_RUN，不将 npm test 成功标为全部 A PASS。live 接入验证明确可选，需要已启动的本地实验配置。
- [ ] CLI 正常缺项返回非0和 JSON；sample 仅供自身测试，不能输出 product_ready=true。通过最小完整测试 fixture 证明校验逻辑，再跑缺文件/伪Golden负例。
- [ ] typecheck/test/build，执行本地检查采集生成本次 run 目录，预期产品 Gate 为 BLOCKED/非0，提交代码/文档（运行产物按忽略策略保留本地）。
**Side effects：** 只读受控 run 目录；不执行证据内 command，不访问网络、不删除恢复材料。

## Task 4：API/页面差距矩阵与 W0 收口

**Refs：** U2/U6/U7；主 PRD 附录 A/B。
**Files：** integration-service/docs/implementation-baseline.md、contracts/api-gap-matrix.md；docs/execution/alpha1/status.md；README.md。
- [ ] GPT-6 Luna 逐项核对 API-001–059、REQ、P01–P12 与四页聚合 spec；用复用/适配/缺失分类，记录代码证据和 M0–M6归属，不猜写真实运行结果。
- [ ] 将前次静态发现的身份、同版本冲突、关系授权/删除、重启gate、并发发布、ETL重叠列为下一阶段回归任务。
- [ ] 文档列出现有测试实际覆盖和未覆盖；W0工具通过与M0产品未验收明确分开。
- [ ] 以 Task1/2/3 运行真实缺项判定，保存机器结果，下一批 M0 细计划引用这些输入。
**验收：** 59 API 与12功能页无孤立项；48 A/N/FI都有阶段归属；W0代码经Sol review；真实输入缺项未伪填。

## 交接与状态

Task0 → Task1 → Task2 → Task3 → Task4 顺序推进；每任务实现后由 GPT-6.1 Sol review，Important/Critical 修复后再下一任务。每个实现报告保存到 .superpowers/sdd/alpha1/，review 读取该任务 brief、报告和精确 diff 文件。W0 完成后立即创建 M0 身份/网络/账号的下一批细计划并继续可独立实现工作；正式产品门禁按实际证据记录。

