# W0 Task 2 执行报告

## 结果

- 状态：`DONE_WITH_CONCERNS`
- 实现提交：`aa69a76b1e8b1fbbd05af4956d5948d535e93d8f`（`feat(alpha1): add deployment lock validation`）。本报告作为后续 Task 2 提交的一部分。
- 提供 `validateDeploymentLock`、严格 Zod/JSON Schema、固定上游 pins、只消费显式 observations 的 JSON CLI 和 synthetic 示例。
- Release 校验要求 `input_kind=observed`、`environment_kind=site`、八个组件齐全、实际 manifest digest、source revision、配置身份、PASS 探测和匹配的 runtime/probe identity。额外声明的 hub、OpenMetadata、Helix、Hasura 组件也按相应源码身份校验。
- 示例可通过结构校验，但正式检查因 `synthetic` 和 `local_lab` 被 BLOCKED，CLI `product_ready` 始终为 `false`。

## RED / GREEN

### RED：锁校验器尚不存在

命令：`npm test -- acceptance-tests/deployment-lock.test.ts`

```text
FAIL acceptance-tests/deployment-lock.test.ts
Error: Cannot find module '../contracts/deployment-lock.js'
Tests no tests
EXIT_CODE=1
```

实现 pins 与校验器后，focused suite：

```text
✓ acceptance-tests/deployment-lock.test.ts (13 tests)
Test Files 1 passed (1)
Tests 13 passed (13)
EXIT_CODE=0
```

### RED：生成 CLI 尚不存在

命令：`npm test -- acceptance-tests/deployment-lock.test.ts`

```text
FAIL acceptance-tests/deployment-lock.test.ts
Error: Cannot find module '../scripts/generate-lock.js'
Tests no tests
EXIT_CODE=1
```

实现 CLI 后：

```text
✓ acceptance-tests/deployment-lock.test.ts (16 tests)
Test Files 1 passed (1)
Tests 16 passed (16)
EXIT_CODE=0
```

### RED：附加上游组件源码身份

新增 OpenMetadata search 观测缺少 `source_sha` 的用例后，focused suite 为 `18 tests | 1 failed, 17 passed`，失败断言指出未报告 `openmetadata-search.source_sha`。按组件 ID 关联 OpenMetadata pin 后，focused suite 输出：

```text
✓ acceptance-tests/deployment-lock.test.ts (18 tests)
Test Files 1 passed (1)
Tests 18 passed (18)
EXIT_CODE=0
```

## 最终验证

命令：`npm run typecheck`

```text
> tsc --noEmit -p tsconfig.json
EXIT_CODE=0
```

命令：`npm test`

```text
Test Files 4 passed (4)
Tests 46 passed (46)
EXIT_CODE=0
```

命令：`npm run build`

```text
> tsc -p tsconfig.json
EXIT_CODE=0
```

JSON Schema/example 解析检查输出：`SCHEMA_SOURCE_SHA_REQUIRED=True`、`SCHEMA_REQUIRED_COMPONENTS=8`、`EXAMPLE_COMPONENTS=8`。`git diff --check` 通过。

## 导出与 CLI

- Public exports：`deploymentLockSchema`、`upstreamPinsFileSchema`、`DeploymentLock`、`validateDeploymentLock`；CLI export：`runGenerateLock`。
- 参数：`node dist/scripts/generate-lock.js --observations <file> --pins <file> [--output <file>] [--release]`。
- 对示例的实际语法检查命令：`node dist/scripts/generate-lock.js --observations deploy/deployment.lock.example.json --pins deploy/upstream-pins.json`；输出 `{"status":"PASS","issues":[],"product_ready":false,"scope":"deployment-lock-validation"}`，退出码 0。
- 同一示例加 `--release` 输出 `BLOCKED`，issues 为 `environment_kind: release requires site` 与 `input_kind: release requires observed deployment data`，退出码 2。

## 限制与信任边界

- 没有八个组件的现场观察，也没有真实 OM/Helix 部署观察；未生成真实 lock PASS。上游 pin 只代表参考版本。
- 示例和测试中的摘要均为 synthetic；`image_id` 是补充运行身份，不能代替 OCI `manifest_digest`。`source_sha`、manifest 和 probe 身份的一致性是对输入声明的纯校验，不证明观察来自真实运行现场。
- 采集说明只列出 Docker 镜像引用、image ID 和 repo digests 等安全元数据，不读取容器环境变量、`.env` 或秘密值。参考 clone HEAD 不作为运行源码 SHA。

## Review Round 1 修复

- 修复基线：`84052a77ae1ef38bd78ae39b7fc6a809460ff71c`；实现提交：`42fe6616a49f755998442337cd733304235ae1c8`（`fix(alpha1): close deployment lock review gaps`）。只修改 deployment-lock 合同、JSON Schema、生成 CLI 和对应测试。

### I1：拒绝把已知 image ID 当 manifest digest

新增完整 `site` + `observed` lock 用例，仅把 hub-api 的 image ID 复制进 image/runtime/probe 的 manifest 字段。

RED：`npm test -- acceptance-tests/deployment-lock.test.ts -t 'copying a known config image ID'`

```text
FAIL: expected 'PASS' to be 'BLOCKED'
Tests 1 failed | 18 skipped
EXIT_CODE=1
```

GREEN：同一命令在校验器拒绝 manifest 与 runtime config image ID 相同后通过，`Tests 1 passed | 18 skipped`，退出码 0。外部观测真实性仍不由纯校验器证明。

### I2：严格 repository:tag 镜像引用并同步 JSON Schema

用例拒绝 `:fixed`、`repo:tag:again`、`https://example.test/repo:1` 和带空白引用，同时接受 `registry.example.test:5000/repo:tag`。

RED：`npm test -- acceptance-tests/deployment-lock.test.ts -t 'repository:fixed-tag image syntax'`

```text
FAIL: :fixed expected 'BLOCKED', received 'PASS'
Tests 1 failed | 19 skipped
EXIT_CODE=1
```

JSON Schema RED：`npm test -- acceptance-tests/deployment-lock.test.ts -t 'same repository and tag restrictions'`

```text
FAIL: repo:tag:again expected false, received true
Tests 1 failed | 20 skipped
EXIT_CODE=1
```

GREEN：`npm test -- acceptance-tests/deployment-lock.test.ts -t 'repository:fixed-tag image syntax|same repository and tag restrictions'` 输出 `Tests 2 passed | 19 skipped`，退出码 0。Schema pattern 与运行校验器共享相同仓库组件、tag 和 registry port 限制。

### I3：输出文件写入失败使用机器 JSON

测试用有效 synthetic observations 把 `--output` 指向已存在目录。

RED：`npm test -- acceptance-tests/deployment-lock.test.ts -t 'requested output cannot be written'`

```text
FAIL: EISDIR while opening the output directory
Tests 1 failed | 21 skipped
EXIT_CODE=1
```

GREEN：同一命令输出 `Tests 1 passed | 21 skipped`，退出码 0；CLI 返回稳定 `{"error":"output_write","message":"Validated lock could not be written to the requested output file","product_ready":false}`，进程码 1。

### 修复后验证

```text
npm test -- acceptance-tests/deployment-lock.test.ts
Test Files 1 passed (1); Tests 22 passed (22); EXIT_CODE=0

npm run typecheck
tsc --noEmit -p tsconfig.json; EXIT_CODE=0

npm run build
tsc -p tsconfig.json; EXIT_CODE=0
```
