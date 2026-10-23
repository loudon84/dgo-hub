# W0 final fix — scoped re-review

## Scope and evidence

- Reviewer：GPT-6.1 Sol；日期：2026-10-23（Asia/Shanghai）。本轮为唯一一次 final fix scoped re-review，无子 agent；只写本报告。
- Base：`b11e52d413fa5d0b68ee9849d8ad0b7617055066`；Head：`ac750d8fbf9cbd4913a9ca5333fbb2d0a5bdf1de`。实读 HEAD 相符，工作区 status 为空。
- 先读冻结 `w0-final-fix-brief.md` 与公开 `w0-final-fix-report.md`，再检查本轮代码/测试/schema/示例/文档差异。依赖锁作完整 JSON 图比较；只看与最终结果、身份及资源处置相关的 retained logs，没有重复阅读每段旧失败堆栈。
- 范围仅为原 W0-I1..I4/M1/M2 和本轮引入的问题；未重新 broad review，未运行 typecheck/test/build/npm install/audit、已有 focused suite、recorder 或 Docker/现场测试。
- 新的具体疑点只使用内存探针。当前 `evidence.ts` 和 `gate.test.ts` 与既有 dist 的 ES2022 转译结果规范换行后一致；未写编译输出。复用当前编译测试 fixture 的构造逻辑，在内存 Map 中构造完整人工 bundle，并以原 Gate 判定逻辑评估；所有写操作仅进入内存，没有实际 run 产物。

## Strengths

- Docker 身份纠正完整地落到 schema、八组件示例、fixture 与 README；保留 mandatory distribution digest 和 runtime/probe/application-config 一致性，未添加 image-ID fallback。
- Gate 的批准 pins 已锚定在模块所在项目的 `deploy/upstream-pins.json`，与待验 bundle 分离；纯 lock validator 仍接受调用方 pins，默认 Gate/CLI 的公共调用没有被削弱。
- 新增可到达最终 release PASS 分支的人工 fixture，避免测试只证明始终 BLOCKED；原 synthetic structure fixture 继续保留。测试注释和文档明确人工材料不构成 site evidence。
- BigInt 修复处理了 NTFS 文件号超过 Number 精度的问题，同时保留 hardlink 等价；最终代码没有退化成 Windows path-only 身份。真实 hardlink 回归兼顾独立文件和同文件别名。
- Vitest 4.1.12 变更独立提交，生成 `dist/**` 排除规则保留默认 exclusions。缺失路径测试和真实临时 Git 中文路径测试都针对原问题，未引入任意命令入口。
- 最终/历史失败记录区分清楚，Linux 最终源摘要与当前源码吻合；完整容器 ID 未留存、临时目录清理受 policy 拒绝均诚实记录。

## Original finding dispositions

| 原 finding | 判定 | 依据与剩余范围 |
|---|---|---|
| **W0-I1** Docker identity equality | **ADDRESSED** | 删除 blanket inequality；required digest_source=repo_digest/descriptor；四种可选标准 media type；missing digest/source、unknown source、runtime/probe mismatch 仍拒绝。测试接受合法 equality 和既有不同 ID，八组件示例全部更新。保持声明式 provenance 限制。 |
| **W0-I2** bundle 自选批准 pins | **ADDRESSED** | `controlledPinsPath()` 在 source `integration-service/contracts` 和 dist `integration-service/dist/contracts` 两种布局都解析到同一个项目 controlled deploy 文件；最终比较 embedded source_pins，并将 controlled pins 传给 lock validator。锚缺失/非法会 FAIL，CLI 没有 run 内 anchor 替代选项。精确批准 pins 与 Base 相同。 |
| **W0-I3** explicit nonreal authority | **NOT ADDRESSED（部分修复）** | 普通 `synthetic:`/mixed-case `example:`/`fixture:` 已拒绝，并覆盖 consumer/source/approval/owner/actor/mapping 等相关引用；但检查原始未 trim 数据，带前导空白的相同 scheme 可得到最终产品放行。详见 W0-R1。 |
| **W0-I4** development-tool advisories | **ADDRESSED** | Vitest/mocker 精确 4.1.12，tinypool 已从依赖图移除；这等价于移除原漏洞路径，不需要给不存在的包强制安装 >=2.1.2。完整 retained audit 与 omit-dev audit 均 0/exit0，运行器 major 变更有 clean install 和最终 full suite 记录。 |
| **W0-M1** missing-path CLI regression | **ADDRESSED** | `environment.test.ts:326` 新建有效 environment，但故意不创建 signoff；断言 exit1、完整稳定 unreadable_input JSON、product_ready=false 且不泄漏 missingPath。 |
| **W0-M2** Chinese Git path digests | **ADDRESSED** | 两个 Git 列表都使用 -z/NUL；导出最小 metadata seam；真实临时 Git 测试覆盖 dirty tracked 中文、untracked 中文与 deleted tracked。旧 unavailable/nonregular 分支保留。 |

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

#### W0-R1 — 原始/规范化字符串不一致，W0-I3 可被前导空白绕过

- **位置：** `integration-service/contracts/evidence.ts:79`、`:111`、`:375`；漏测边界在 `integration-service/acceptance-tests/evidence/gate.test.ts:89`。
- **原因：** consumer deployment_ref、source owner_ref 等 schema 使用 `z.string().trim().min(1)`。`validateBundle` 用解析后的值做结构检查，但返回给 release 分支的 `d` 仍是原始 JSON。新增 `nonrealAuthorityIssues(d)` 对这些原始引用直接执行 `^(synthetic|example|fixture):`，未按同一合同 trim。前导空格/制表符在 schema 里合法规范化，在实际 lexical guard 中却躲过 scheme 检查。
- **最小复现：** 使用本轮已有完整 release-shaped 人工 fixture；仅将 `golden-consumer/manifest.json.consumer.deployment_ref` 从 `site://unit-test` 改为 `" synthetic://hermes"`，重算 manifest SHA。控制组、批准 pins、48 项、三 actor、其他材料都保持不变。
- **实际结果：** compiled Gate 返回 `{status:'PASS',product_ready:true,issues:[]}`。同一 fixture 的无空白 `synthetic://hermes` 返回 BLOCKED；`"\tExAmPlE://hermes"` 同样返回 PASS。把 source contract 的 owner_ref 改成 `" fixture://owner"`，保持摘要一致，也返回 PASS。由此确认不只是 consumer 单字段问题。
- **影响：** self-reported real/observed 仍能覆盖合同语义上明示非真实的 authority。原 W0-I3 的正式 release 约束尚未闭合；这是可本地修复的声明边界问题，不能归为现场 attestation 缺失。
- **最小纠正：** lexical helper 先对引用做与 schema 完全相同的 trim，再匹配冻结 scheme；或让 formal check 消费 schema 解析后的规范化对象。不要只给 consumer 单字段补丁、不要改成 substring 检查，也无需修改现场可信度边界。
- **必要回归：** 已有真实临时 FS 的 release-shaped fixture，参数化覆盖三种 scheme 和大小写，以及前导空格/制表符、首尾空白；至少 consumer 和 source owner/approval 两类入口要证明非 PASS。对其他合法 opaque/CMDB/site 引用，以及 URI 中路径/名称含这些单词的正例仍放行；synthetic structure helper 仍能 PASS。使用 focused Gate 回归即可，不需要为这条字符串修复重复 85 项 full suite。
- **本轮处理：** 未改代码、未追加第二轮修复。交由主会话按既定 single-wave breaker 明确承接，不能把 I3 标成关闭。

### Minor (Nice to Have)

#### W0-R2 — 报告高估常规 suite 对 compiled-layout 的执行覆盖

- **位置：** `docs/execution/alpha1/w0-final-fix-report.md:25`；配置 `integration-service/vitest.config.ts:5`。
- 报告称 source 和 compiled-layout 分支都通过 build/full suite 获得 unit coverage，且 full suite 使用 current build output。最终配置明确排除 dist，保留 full test log 只记录 6 files/85 tests；build 能证明编译成功，但本身不能证明实际调用过 dist 的 Gate 分支。
- **本轮补充证据：** 源码/dist 一致后，用同一编译 Gate 逻辑分别携带真实 source/dist module URL 在内存 FS 调用，观察两个布局读取的 anchor 都为 `E:\git\dgo-hub\integration-service\deploy\upstream-pins.json`，两组人工控制均 PASS；模拟 anchor 缺失为 FAIL/product_ready=false。此结果支持 I2 已修复，但不是历史 full suite 执行 compiled-layout 的证明，也不是整进程 CLI 实测。
- **建议：** 将报告文字改为“build 验证编译，full suite 验证 source；本次 scoped review 的专用路径探针验证 source/dist anchor 解析”。如果将来需要永久 compiled CLI coverage，增加单独 child-process 测试；本轮无须重跑套件来补历史宣称。
- **裁定：** Minor，文档证据范围纠正；不另阻断 I2 或 M0 的本地设计工作。

## Verification and evidence identity

### Controlled pins / CLI

- 默认公共 `evaluateReleaseGate(runDir)` 未加弱化参数，source/dist 布局计算与当前项目树一致。
- `acceptance-tests/evidence/run-gate.ts:9` 的未改默认调用直接进入该函数；没有独立 pins 参数或 run 内替代 anchor。CLI 映射 PASS→0/BLOCKED→2/FAIL→1 保持不变。这里是已读调用链检查，不声称本轮启动了真实 CLI 进程。
- 缺少 controlled anchor 在专用内存调用中为 FAIL/non-ready；无需要放宽 fail-closed。Gate 仍只验证声明一致性，不证明 approved 文件背后的外部身份。

### Filesystem identity

- 最终 `safeReadEvidenceFile` 在 `evidence.ts:145` 使用 `lstat(...,{bigint:true})`；精确 dev/ino 转为字符串，没有 Number 转换，非零时以 `file:dev:ino` 比较；仅零 dev/ino 才回退 canonical real path。
- 新真实文件测试先证明 oracle/answer 普通文件不同，再创建真实 hardlink，证明 identity 相同并由 Golden 三 artifact 独立性检查拒绝。测试没有用假路径/假 inode 模拟 Windows hardlink。
- 既有逐段 symlink/junction/realpath guard 保留；本轮未重新执行这些测试。保留记录支持 Windows NTFS 与最终 Linux 路径行为，不扩大成恶意并发写入的原子证明。

### Dependency and retained test results

- 当前 lock 字节 SHA-256 为 `d57e05b22cac17293328b3d3ebd97e55786a100ca06dce93084766039d083065`，与保存记录一致；Vitest/mocker 为 4.1.12，tinypool 无条目，公开 npm registry URL 和 integrity 字段在新图中存在。
- 完整 JSON 图比较：所有既有非 dev package 的元数据与 Base 一致，无新非 dev package；没有不相关 production dependency 升级。
- 最终 Windows retained log：Vitest4.1.12、6 files、85 passed；独立 exit file 为 typecheck/build/test 全0。早期失败没有被改写为成功。没有因看见 final85 就推断本次新 R1 边界已经被测到。
- 当前 integration-service 树从实现提交 `90f3776605b91ebd9729902c6fac0dd366b08ab2` 到 review Head 没有再变；后续为 docs/evidence 提交。Windows pre-commit 验证仍按报告所记源树引用，不声称日志自身构成密码学执行证明。
- 最终 Linux retained log：Node24.22.1/npm11.19.1/Vitest4.1.12；2 files，31 passed、1 Windows-only skip。`linux-source-sha256.txt` 中 evidence.ts、gate.test.ts、record-local-checks.ts 和其测试四个文件 SHA 均与当前字节完全一致。
- 旧 Linux 74+1skip 是 pre-BigInt fixture 的历史结果；本轮未把它当最终 BigInt 验证。最终 31+1skip 和 Windows85 是不同覆盖集合，均未冒充现场验收。
- retained full/omit-dev audits 都 vulnerabilities={}、total0，保存退出码均0；本轮未重复联网 audit。它证明保存时间点已报告 advisory 的处置，不是所有未来漏洞永久为零。

### Resource disposition

只采信保存记录：容器名称保留，完整容器 ID 未保留；不得反推 ID。记录了 docker run --rm、按名称停止 apt attempt，以及最终无匹配运行容器快照；这些不足以重新证明每个历史资源完整生命周期。临时 mount 目录删除被 command policy 拒绝且未重试，目录仍保留；本评审没有执行 cleanup，也没有把它标成已清理。

## Recommendations

1. 主会话按单次最终复审上限裁定并记录 W0-R1/I3 残余，将规范化一致性作为复用 formal Gate 前的明确前置；本报告不另启代理/修复循环。
2. W0-R2 只纠正证据范围，不为补一句报告重复完整套件。原 W0-I1/I2/I4/M1/M2 可关闭。
3. 继续保持缺现场批准/IdP/CRM/orders/observed lock/Golden Consumer 为外部 BLOCKED。M0 的本地迁移/身份实现应沿用既有授权和隔离约束；任何剩余 Gate 缺口不得被发布状态掩盖。

## Declined to judge

- 不重评未变的原型业务、API/page 分期、M0–M6 产品 backlog；本轮只复核六 findings 和修复新问题。
- 不证明现场审批、秘密引用目标、真实数据、远端 Hermes v0.22.1 构建或三人实际调用；材料未齐，产品仍 BLOCKED。
- 不重新运行保留测试/audit/Docker；报告中的历史执行按其明确源身份与日志接受，缺失完整容器 ID 和 cleanup 限制不补造。
- 内存 probe 验证判定和布局分支，未将其当真实 Windows/Linux FS/完整 CLI/现场 evidence 验证。

## Assessment

**Spec verdict：Needs fixes。Quality verdict：Needs fixes。**

**W0-I1/I2/I4/M1/M2：ADDRESSED；W0-I3：NOT ADDRESSED（部分修复，W0-R1 残余）。**

本轮修复整体收敛且测试/依赖证据有明确身份，但正式 nonreal authority 仍存在可复现的 raw/normalized 绕过。依单波次规则将残余交主会话裁定，不把本次复审写成全部无遗留批准。

产品 M0–M6 继续 **BLOCKED/NOT_RUN**，48 项没有由本报告、85 单测或人工 PASS fixture 升为产品 PASS。
