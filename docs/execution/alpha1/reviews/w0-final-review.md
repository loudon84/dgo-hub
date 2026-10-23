# W0 整体工程评审

## Scope and evidence

- Reviewer：GPT-6.1 Sol；日期：2026-10-23（Asia/Shanghai）。只读评审，无子 agent；唯一写入是本报告。
- Base：`a5bee5c9a42446e092c01403aec289a7e3adc3b2`；Head：`b11e52d413fa5d0b68ee9849d8ad0b7617055066`。现场读取的 HEAD 与指定 Head 相同，评审开始时 `git status --short` 为空。
- 阅读完整 `w0-final-review-package.txt` 的 4002 行，包括全部 32 文件差异；按有界段阅读，补读工具输出截断的文档段。Task0 初始快照按既有独立评审处理，未把比较范围缩成最后一个提交。
- 依据：`w0-final-review-brief.md`、Task1–4 briefs 的冻结合同、`progress.md` 裁定、Task1 延期 minor 原报告，以及 Docker 身份和依赖审计报告。格式遵循 `requesting-code-review/code-reviewer.md`。
- 交叉检查：entry → lock → release Gate；来源合同 → fixture → Golden Consumer；48 项结果 → Oracle/文件/源代码/镜像身份；安全读文件 → recorder；API/page/REQ/阶段映射 → 已公布 M0 计划。
- 未重跑已有 typecheck/test/build、focused suites、recorder 或现场检查。既有完整 63-test 记录只证明 `f9abd03`；后续修复的 Windows 23、Linux 22+1skip、Task1 19、Task2 22 等结果按各自记录的身份引用，未扩大到当前 SHA。
- 针对新疑点执行少量只读探针：5 个相关 TS 模块与现有 dist 的 ES2022 转译结果一致（只比较内存字符串，未写 build）；纯函数人工输入、缺失文件 CLI 调用；Gate 的完整人工 bundle 在内存虚拟文件系统上运行；Git 中文路径输出检查。没有执行记录里的 command，没有网络/IdP/CRM/订单/Hermes 调用，也没有新建实际证据 run。

## Strengths

- W0 分工清楚，保留七模块原型，同时把正式 59 API、12 页面和 48 A/N/FI 的完成度明确为后续工作。页面 P03/P04/P08/P09 的合同归属修复已体现在最终差异中，没有把旧 preview 当应用权限证明。
- 环境/批准对象采用严格嵌套 schema；来源只读、tenant 绑定、site HTTPS、三个独立测试身份、五角色批准与样例边界齐全。身份与批准人共享凭据拒绝规则，避免前轮修复再次分叉。
- lock 把源 revision、分发摘要、引擎镜像身份、应用配置摘要与 probe 身份关联；必需八组件、显式额外组件与 observed/site 门槛贯通 Gate。实际摘要缺失仍然 BLOCKED，没有 image-ID fallback。
- Gate 检查 48 个精确 ID、requirement/test 归属、命令/退出码/时间、Oracle 值比较、来源集合、摘要和 Golden actor/profile/call 关联。路径检查覆盖两种分隔符、绝对路径、逐段 symlink/junction、realpath 越界；独立 artifact 用文件身份识别，覆盖 hardlink/别名而非仅比路径字符串。
- recorder 的 CLI 无任意命令入口，固定执行 typecheck/test/build，独占创建新 run，保留失败/旧 run，初始化产品结果为 NOT_RUN。原始日志与 dirty worktree 摘要没有被包装成产品 PASS。
- M0 计划已经承接可信 OIDC/DB 身份、opaque 凭据、epoch 撤销、审计交付、独立迁移与最小权限部署；Alpha 默认关闭旧路由、旧 worker 扫描及 publisher bootstrap 的过渡裁定尤其关键。

## Issues

### Critical (Must Fix)

未发现已证实的 Critical。下列 Gate 放行缺口为 Important：目前没有现场材料或已发布产品验收，未发现实际生产越权/数据泄漏事件。

### Important (Should Fix)

#### W0-I1 — Docker 29 合法分发摘要与引擎 ID 相等会被误拒

- **位置：** `integration-service/contracts/deployment-lock.ts:84`；关联反向回归 `integration-service/acceptance-tests/deployment-lock.test.ts:105`，采集语义说明 `integration-service/README.md:100`。
- **问题：** 仅凭 `manifest_digest === runtime_identity.image_id` 判定“把 config image ID 复制成 manifest”。Docker 29.8.1/containerd 的 image inspect 可以把 index descriptor digest 同时作为 `.Id` 和 RepoDigest；这是合法实测值。README 仍称 image_id 为本地镜像配置身份，也延续了过强假设。
- **证据：** 已提供的 `docker-image-identity.md` 保存安全字段观测和固定 Moby 源码证据；本轮在完整人工 observed/site lock 中让 hub-api 的 image/runtime/probe ID 同步等于其已有分发摘要，纯校验返回 `BLOCKED`，唯一 issue 是 `manifest_digest must not be populated with the config image_id`。
- **影响：** 合法现场锁无法通过；M0 后续实际 lock 和 Gate 消费会被错误阻断。它是既有计划假设需要纠正，不是实际摘要要求应被放宽。
- **最小修复：** 移除 blanket inequality；保留分发摘要必填及 runtime/probe/app-config 一致性。补充声明式摘要来源（真实 RepoDigests 或 Descriptor）和可用的 descriptor media type，使 equality 有采集来源可解释。当前 `manifest_digest` 如保留字段名，应说明它指 resolved registry descriptor，可为 index 或单平台 manifest。`.Id` 只按引擎观测保存；缺 RepoDigest/Descriptor 仍 BLOCKED，绝不能以 `.Id` 补齐。应用 `config.digest` 与 OCI config blob digest 必须继续区分；字段重命名可在下一合同修订统一处理。
- **回归：** Docker 29 index equality 正例、不同 ID 正例、缺实际分发摘要负例、runtime/probe 不匹配负例；原“known config image ID”用例应改为缺少分发来源的负例，不能继续把字符串相等当充分证据。
- **裁定：** W0 收口修复项；先修再让 M0 依赖该合同。

#### W0-I2 — Gate 的批准 pins 来自同一 bundle，可自洽改写固定上游版本

- **位置：** `integration-service/contracts/evidence.ts:177`、`:180`、`:319`；`integration-service/contracts/deployment-lock.ts:35`、`:159`。
- **问题：** `upstreamPinsFileSchema` 只检查字符串形状，Gate 将 run 内的 `upstream-pins.json` 直接当 approved pins，再与同一 run 的 lock 比较。最终没有和仓库冻结的 Helix/OM/Hasura pins 建立独立比较。纯 lock 函数接受调用者提供的 pins 没有问题；最终 Gate 将待验证内容同时当比较基准是接口缺口。
- **可复现步骤：** 在完整人工 bundle 的 `upstream-pins.json.source_pins.hasura` 与 `deployment.lock.json.source_pins.hasura` 同步改成 `{tag:'unapproved-99', revision:'eeee…'(40)}`，再将 `components.hasura.source_sha` 同步改值，并重算被影响文件摘要；不改变任何批准记录。内存 Gate 控制组 `PASS/product_ready=true`；改写组仍为同样 PASS、issues=[]。单独把改写 lock 对仓库 canonical pins 校验则正常 BLOCKED，证实缺口在 Gate 的信任基准接入。
- **影响：** 包内可以自选未批准上游版本而得到产品放行，与 W0 的 exact pins/R7 边界冲突。文件 SHA 只能保证包内一致，不能充当“批准版本”的独立基准。
- **最小修复：** 保留纯校验器参数化；最终 Gate 从受控仓库常量/构建随附批准 pins 获取 expected pins，先对 run 内 pins 作精确比较，再校验 lock。或者显式向 Gate 注入由受控调用方提供的 expected pins，并确保 CLI 默认绑定仓库冻结值。不要从 bundle 内再读取另一个可自改字段充当批准，也不需要新签名服务。
- **回归：** 完整人工 observed/site 结构允许到达最终 release 分支；同时改 bundle pins/lock/source 仍须 BLOCKED/非零；只修改任一处也非 PASS。冻结三组 tag/revision 的现有精确值测试应保留。
- **裁定：** W0 收口修复项，M0 继续复用 Gate 前应关闭。

#### W0-I3 — 明示 synthetic 的消费者引用仍能通过正式 Gate

- **位置：** `integration-service/contracts/evidence.ts:69`、`:222`、`:324`。
- **问题：** consumer 的 `deployment_ref` 只有 nonempty 规则；release 分支只看三处 input_kind=real 和 run.kind=observed，未拒绝 authority-bearing reference 明示的 synthetic 身份。环境 actor 已拒绝 `synthetic:`，但 Golden consumer 的声明存在同类边界遗漏。
- **证据：** 完整人工控制 bundle 的 consumer 是 Hermes/v0.22.1、`deployment_ref='site://hermes'`。仅将该引用改成 `synthetic://hermes`，其余 site/observed/real、三个 actor、48 项、批准和摘要均保持自洽；刷新 manifest 摘要后，内存 `evaluateReleaseGate` 仍返回 `{status:'PASS', product_ready:true, issues:[]}`。
- **影响：** Gate 接受明确声明为合成消费者的正式发布材料。这里不要求它证明物理远端运行或人类真实性；拒绝自己声明的 synthetic scheme 是已有文本中可检测的矛盾，不属于远程 attestation。
- **最小修复：** 在正式 release 路径对 consumer deployment identity 施加明确的非合成引用约束，至少覆盖已使用的 `synthetic:`；若合同支持 fixture/example 等非真实 schemes，应冻结其名单并一致处理。继续允许结构 helper 校验合成 fixture。不要用任意字符串含 `synthetic` 的模糊搜索代替引用语义，也不要声称此规则能够验证真实远端身份。
- **回归：** 控制 bundle 可到达 release PASS；consumer `synthetic://` 在相同人工 bundle 下为 BLOCKED；结构 helper 仍支持 synthetic fixtures。对来源批准/owner 等 authority-bearing references 的已定义显式非真实 scheme 采用同一条清楚规则，避免只改一个入口后再漂移。
- **裁定：** W0 收口修复项；与现场缺材料是两件事，不能因现场本来 BLOCKED 而丢弃此可复现放行缺口。

#### W0-I4 — 开发工具漏洞需作出明确处置，不能以 omit-dev=0 关闭

- **位置：** `integration-service/package.json:32`（`vitest:^3.2.4`）；锁中实际 Vitest/mocker 3.2.7、tinypool 1.1.1。本项是既有基线债务，由本次整体评审显式承接，并非 W0 新引入的生产依赖。
- **证据：** 本轮只读解析当前 lock 确认以上三者均 dev=true。保留审计报告对当前 lock 的结果为 1 moderate/2 critical package entries，omit-dev=0；归一化后 255 个 package 条目一致，历史/当前 raw hash 差异是 CRLF/LF，不是曾修过漏洞。四份 GitHub primary advisory 在本轮再次核对，受影响/修复版本与原审计一致。
- **实际暴露：** mocker 问题需要可访问的 public mocker/interceptor HMR endpoint；当前是 `vitest run`，没有建立本项目暴露该 endpoint 的证据。tinypool 两项需要 prototype pollution 等前置条件，可能在开发/CI worker 执行代码；没有本项目可达污染入口的证据。不能把 npm Critical 数量解释成已证实的 Hub runtime Critical，也不能据 dev 标签断言测试环境安全。
- **处置建议：** 优先在最终修复波次作一个独立依赖变更，将 Vitest/mocker 升到覆盖这些 advisory 的 4.1.12 或经核实的更高兼容版本，并确认实际解析 tinypool >=2.1.2；不要仅强行 override 跨 major 的 tinypool，也不要直接照 audit 建议跳 5.x。4.x 是 major，Node24 engine 满足只代表可安装，项目兼容性需要实测。本轮没有更新依赖或声称升级已验证。
- **验证：** 在无现场秘密的独立环境执行 clean install、完整 typecheck/test/build 一次并保留新 lock/源身份；重跑 audit 与 omit-dev audit。由于本项真实改变测试运行器，完整 suite 在修复波次有必要。若暂缓，需由执行控制方在 ledger 明确承接：负责人、期限、不得暴露 public mocker endpoint、不得让不可信输入/污染状态进入有秘密的 runner；在引入这些暴露前完成升级。
- **裁定：** Important 的开发/CI 维护项；现有证据不足以把它单独当成可信本地 M0 开发的安全封锁，但必须升级或作出上述有边界的显式延期，不能静默忽略。
- **Primary sources：** [mocker redirect](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)、[mocker manual](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)、[tinypool worker options](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)、[tinypool run options](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)。

### Minor (Nice to Have)

#### W0-M1 — 延期 Task1 M1：补真实 read-error 回归

- **位置：** `integration-service/acceptance-tests/environment.test.ts:305`；错误处理在 `integration-service/scripts/check-m0-entry.ts:63`。
- 现有 named unreadable/schema-invalid 用例仍只写可读的 malformed 与 schema-invalid 文件，未触发 read-error。
- 本轮只读调用一个不存在的 signoff 路径，实际返回 exitCode=1、`error='unreadable_input'`、固定安全 message、product_ready=false；因此没有发现对应产品逻辑 bug。
- **明确 triage：** 保持原 Minor，非阻塞，未关闭/未丢弃。建议最终修复波次补一个不存在路径的持久测试，确认稳定 JSON/exit1/不回显敏感内容；只需覆盖该 case 的 focused test，无须为此重复全套。

#### W0-M2 — recorder 使用逐行 Git 路径输出，中文文件摘要会漏记

- **位置：** `integration-service/scripts/record-local-checks.ts:66`、`:67`。
- `git diff --name-only` 和 `git ls-files --others` 默认会转义非 ASCII 路径；代码按换行 split 后把带引号/八进制转义的显示串当实际路径，lstat 失败并进入 unavailable_paths。文件名含换行也无法可靠解析。
- **证据：** 本轮对仓库已有中文 PRD 路径调用 `git ls-files -- <精确路径>`，返回 `"docs/\346\225…v1.0.md"`；同路径 `-z` 输出真实中文名和 NUL。未修改文件或运行新 recorder。相同 Git 路径输出约定用于当前两个列表命令。
- **影响：** dirty=true 和 unavailable_paths 会披露不完整，因此不是静默产品 PASS；但含中文文档的 dirty worktree 无法按计划形成完整内容身份，后续 M0 中文文档变更很容易遇到。
- **修复：** 两个命令加 `-z`，按 NUL 分隔，不把 Git 显示转义当路径。保留删除文件/non_regular 的 unavailable 记录。补中文文件名路径回归即可。
- **裁定：** Minor；建议本轮便宜修复，不阻断 M0 产品范围设计。

## Focused verification

以下全是工程探针，不是任何产品验收结果。

| 检查 | 结果及限制 |
|---|---|
| TS→dist 对比 | environment/signoff/deployment-lock/evidence/check-m0-entry 五模块，ES2022 输出规范换行后全部一致；无 build 写入 |
| 人工 observed/site lock 控制 | validateDeploymentLock PASS；只验证已声明字段 |
| Docker digest equality | 合法的字段相等形态被 BLOCKED：W0-I1 |
| 改写 lock 与自带 pins | 对自带 pins PASS；对仓库批准 pins BLOCKED：W0-I2 的纯函数边界证据 |
| 完整人工 Gate 控制 | 内存虚拟 FS，48 PASS shaped rows、独立 artifact identity、摘要自洽，进入最终 PASS 分支 |
| 同步改写 Gate bundle pins/lock/source | 仍 PASS/product_ready=true：W0-I2 |
| 明示 synthetic consumer ref | 仅 consumer deployment_ref 改 synthetic://，仍 PASS/product_ready=true：W0-I3 |
| 不存在 signoff 路径 CLI | exit1/unreadable_input/稳定安全 JSON；支持 W0-M1 为 coverage minor |
| Git 中文路径输出 | 默认被引用转义；-z 为真实路径：W0-M2 |
| 当前 lock 精确版本 | Vitest3.2.7/mocker3.2.7/tinypool1.1.1，dev=true；未 install/audit 重复运行 |

Gate 探针使用现有 dist 中 evidence 模块的原逻辑，仅将 fs/promises 三个读元数据函数接到内存 Map，并将相对模块链接到已匹配源码的现有模块；没有改变判定逻辑。它能证明 W0-I2/I3 的关联分支，不能当成实际 Windows/Linux 文件安全或 site evidence 验证。真实路径安全已有 retained focused Windows/Linux 测试，本轮没有覆盖或替代它们。

## Explicit deferred-item triage and M0 dependency assessment

| 项目 | 裁定 / 所属阶段 |
|---|---|
| Docker29 identity 相等 | W0-I1，纠正旧计划假设；保持真实分发摘要来源要求，W0 修复 |
| 开发工具 advisories | W0-I4，升级或有边界显式延期；不是 runtime 漏洞豁免 |
| Task1 原 M1 | W0-M1，维持 Minor，建议最终波次补持久回归 |
| 新 Gate pins/synthetic 缺口 | W0-I2/I3，本地可修，不应转为“缺现场资料”延期 |
| 可信身份、撤销在途、旧路由 | M0 已明确安排，未实现不算 W0 漏交；执行时必须默认关闭旧共享密钥/自报身份路径 |
| publisher 重启 gate/worker 演示扫描 | M0 过渡运行裁定已写入计划，必须先闭闸/不扫未批准来源；不能等 M2 才阻止 Alpha 暴露 |
| 同版本冲突、关系授权/删除、ETL 重叠 | 分别归 M1 数据语义、M2 关系权限、M1 ETL 回归；保留，不能将旧测试覆盖等同这些已解决 |
| 并发 publish/CAS/recovery | 引擎 M2、工作流 M5、恢复 M6；M0 暂不开放权限 capability，保持闭闸 |
| UI/OM/Helix/Hermes | 矩阵保留 M3/M4/M5 缺口；静态 upstream 能力不代替部署能力 |

除 W0-I1/I2/I3 外，没有从本轮差异确认另一个会阻止开始 M0 本地迁移/身份实现的缺失前置。W0-I4 必须有明确处置；其他阶段产品功能按计划保留。修复这些工程合同不需要真实现场材料，也无需再次询问用户已授权的本地实施是否继续。

## Recommendations

1. 一次最终修复波次处理 W0-I1–I3，顺手补 W0-M1/M2；对 W0-I4 独立提交升级或记明延期裁定。不要改写历史测试身份或已有 run。
2. Gate 新增一份可到达 release 最终分支的人工完整 fixture，覆盖 expected pins/显式 synthetic 的正反例；文件安全测试继续使用真实临时文件系统。fixture 仍明确是单测材料，不保存成 observed site evidence。
3. 仅按实际变更运行必要验证：lock/Gate/path/CLI focused 回归和 typecheck/build；若升级 Vitest，则 clean install 后完整 suite 一次，并保留 Windows 路径及 Linux alias 风险覆盖。无需重新执行现场命令或重复历史 recorder。
4. 新报告/状态注明最终修复 SHA、测试数量与 dirty 文件身份；只在之后真正运行时生成新的 local_check，不覆盖 `task3-final-20261023`。实现 review 更新成收口状态后继续 M0；产品 48 项仍 NOT_RUN。

## Declined to judge

- **现场身份、批准真实性与 secret_ref 实际目标：** W0 只验证声明和一致性；本轮没有这些输入/权限。保持外部 BLOCKED，未引入签名/证明服务。
- **真实 CRM/订单数据、实际源接口和删除/备份恢复：** 现场合同和证据缺失，属于后续正式产品验收；不能从人工 fixture 推断。
- **远端 Hermes v0.22.1 的实际构建/Profile/注册工具名/授权调用：** 只有用户报告版本与固定官方文档发现；不升级、不猜 runtime commit，M4 待实际 probe。
- **已存测试报告的历史执行真实性：** 按 retained evidence 引用；本轮不重跑相同套件，不声称较早成功覆盖后续 SHA。
- **原型业务功能的生产级完整性：** 本轮只评 W0 新差异和已声明 M0 接续依赖；同版本冲突、关系/删除、publish recovery、ETL overlap 等仍是上述有阶段的 backlog，不因超出 W0 被静默删除。
- **W0 无 UI/正式 API 实现：** W0 交付合同和差距矩阵，矩阵已声明 Missing/Adapt；本轮不把未来 M0–M6 功能当 W0 漏交。
- **entry CLI 的 product_ready 命名：** 它的 PASS 明确带 `scope=entry-input-validation`，既有文档和 Gate 也将它限定为入口；未按名称推断整个产品验收通过。今后若对外展示，必须保留该 scope。
- **untrusted concurrent writer 的原子文件证明：** 明确合同要求评估期间 runDir 不变；未宣称当前 fs 读法抵御恶意并发修改。
- **advisory 的本项目可利用链与升级兼容性：** 已核对前置条件和锁定版本，未发现/执行利用链，未 install 升级；W0-I4 提供具体处置和验证门槛。

## Assessment

**Spec verdict：Needs fixes. Quality verdict：Needs fixes.**

**Ready to merge / close W0? With fixes.**

工程结构和后续阶段划分基本可用，但 W0-I1 错拒合法部署，W0-I2/I3 可让矛盾或未批准的声明通过最终 Gate，应在 W0 收口后继续 M0 本地实施；W0-I4 需升级或显式有边界延期，两个 Minor 不单独阻塞。

**Product readiness：BLOCKED。** 没有现场 IdP/CRM/订单/三身份批准材料、observed deployment lock 或真实 Golden Consumer；48 项产品结果保持 NOT_RUN。本报告的人工 PASS 探针、工程测试记录和代码 review 均不构成 M0–M6 产品验收通过。
