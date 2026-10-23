# W0 Task 1 执行报告

## 结果

- 状态：`DONE_WITH_CONCERNS`
- 实现提交：`5dbd54cecea9acaede1c792d4be16f35c5b3eedd`
- 改动：EnvironmentInput 与 SignoffRecord 的严格 Zod schema、M0 纯判定器、机器 JSON CLI、环境 JSON Schema 和示例、审批清单、13 项 Task 1 测试。
- 判定器 PASS 的范围是入口输入格式与合同一致性校验。它不访问现场、解析秘密引用或证明网络/IdP/源库/备份探测成功。
- 产品顾虑：尚无真实 IdP、CRM/订单批准输入、Hermes 实际版本、真实测试身份与签署；这些产品验收保持 BLOCKED。没有以样例替代现场证据。

## RED / GREEN 记录

### RED：新合同模块未实现

命令：`npm test -- acceptance-tests/environment.test.ts`

输出：

```text
 RUN  v3.2.7 E:/git/dgo-hub/integration-service

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  acceptance-tests/environment.test.ts [ acceptance-tests/environment.test.ts ]
Error: Cannot find module '../contracts/environment.js' imported from 'E:/git/dgo-hub/integration-service/acceptance-tests/environment.test.ts'
 ❯ acceptance-tests/environment.test.ts:2:1
      1| import { describe, expect, it } from 'vitest';
      2| import { environmentInputSchema } from '../contracts/environment.js';
       | ^
      3| import { signoffRecordSchema } from '../contracts/signoff.js';

 Test Files  1 failed (1)
      Tests  no tests
```

### RED：身份引用允许嵌入 URL 凭据

命令：`npm test -- acceptance-tests/environment.test.ts`

输出：

```text
 ❯ acceptance-tests/environment.test.ts (12 tests | 1 failed) 43ms
   ✓ environment and signoff contracts > accepts a complete site input with tenant-bound distinct test identities
   ✓ environment and signoff contracts > requires issuer, source contracts, and all five approved signoffs
   ✓ environment and signoff contracts > blocks REVIEW records and missing approval actors or timestamps
   ✓ environment and signoff contracts > rejects credential-bearing endpoints and invalid secret references
   ✓ environment and signoff contracts > rejects duplicate sources, invalid timezone, and additional secret fields
   ✓ environment and signoff contracts > requires site HTTPS and a sales and manager identity set bound to the tenant
   × environment and signoff contracts > rejects credentials embedded in identity references
     → expected true to be false // Object.is equality
   ✓ environment and signoff contracts > does not pass an example or a mismatched environment kind as formal M0 readiness
   ✓ M0 entry CLI > returns a stable usage error for missing arguments
   ✓ M0 entry CLI > validates examples successfully while explicitly reporting product_ready false
   ✓ M0 entry CLI > returns exit code 2 for valid but blocked formal readiness
   ✓ M0 entry CLI > returns exit code 1 for unreadable and schema-invalid inputs

 FAIL  acceptance-tests/environment.test.ts > environment and signoff contracts > rejects credentials embedded in identity references
AssertionError: expected true to be false // Object.is equality
 ❯ acceptance-tests/environment.test.ts:137:67
      135|     const environment = validEnvironment();
      136|     environment.test_identities[0]!.actor_ref = 'https://user:password…';
      137|     expect(environmentInputSchema.safeParse(environment).success).toBe(false);
       |                                                                   ^

 Test Files  1 failed (1)
      Tests  1 failed | 11 passed (12)
```

### GREEN：focused 合同与 CLI 测试

命令：`npm test -- acceptance-tests/environment.test.ts`

身份引用校验收紧后的输出：

```text
 RUN  v3.2.7 E:/git/dgo-hub/integration-service

 ✓ acceptance-tests/environment.test.ts (12 tests) 39ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at 12:43:38
   Duration 603ms (transform 73ms, setup 0ms, collect 182ms, tests 39ms, environment 0ms, prepare 142ms)
```

### 完整验证

`npm run typecheck`：

```text
> data-governance-integration-service@1.0.0 typecheck
> tsc --noEmit -p tsconfig.json
```

`npm test`：

```text
> data-governance-integration-service@1.0.0 test
> vitest run

 RUN  v3.2.7 E:/git/dgo-hub/integration-service

 ✓ acceptance-tests/core.test.ts (5 tests) 8ms
 ✓ acceptance-tests/integration.test.ts (4 tests) 4ms
 ✓ acceptance-tests/environment.test.ts (13 tests) 41ms

 Test Files  3 passed (3)
      Tests  22 passed (22)
   Start at 12:44:35
   Duration 625ms (transform 194ms, setup 0ms, collect 566ms, tests 52ms, environment 1ms, prepare 448ms)
```

`npm run build`：

```text
> data-governance-integration-service@1.0.0 build
> tsc -p tsconfig.json
```

示例 CLI 命令：

```text
node dist/scripts/check-m0-entry.js --signoffs ../docs/approvals/alpha1-signoffs.example.json --environment ../docs/approvals/environment-inputs.example.json --expected-kind local_lab --validate-example
{"status":"BLOCKED","missing":["example:syntax_only"],"example":true,"product_ready":false,"scope":"entry-input-validation"}
```

此外，三个交付 JSON 文件均通过 `ConvertFrom-Json` 解析；`git diff --cached --check` 无空白错误。Task 1 文件之外没有进入提交。

## 首轮 review 修复（Round 1）

- 状态：`DONE_WITH_CONCERNS`
- 修复提交：`acbe4ce9cffac05ad853b9776a7998c37f90bcc4`
- Review 基线：`4e08a8c923342717bd9f64a75b0d6fba231137cd`。
- I1：明确 `synthetic:` 身份仍可用于 `local_lab`，但不能满足 site readiness。
- I2：拒绝 `pwd`、`user`、`username`、`passwd`、`token`、`secret`、`auth`、API key 等凭据查询名；使用 URLSearchParams 解码后再归一化检查，覆盖 `%70%77%64`。仍拒绝 userinfo。
- I3：local_lab IdP issuer 和 JWKS URL 仅允许 HTTPS 或 loopback HTTP。
- I4：环境测试身份和批准人统一使用 `identityReferenceSchema`；URI-like 引用解析失败时拒绝，保留 `urn:employee:alice` 等合法 opaque 引用。
- 空引用探测：`vault:///` 在 RED 用例中曾被接受；secret_ref 改为必须包含非空路径段后已拒绝。
- 同步更新环境 JSON Schema 的 secret_ref pattern 与运行时规则说明。其结构除导出元信息外与当前 Zod `toJSONSchema` 完全匹配。

### 修复 RED

命令：`npm test -- acceptance-tests/environment.test.ts`

```text
 RUN  v3.2.7 E:/git/dgo-hub/integration-service

 ❯ acceptance-tests/environment.test.ts (16 tests | 5 failed) 50ms
   × rejects credential-bearing endpoints and invalid secret references
     → vault:///: expected true to be false // Object.is equality
   × blocks synthetic identities in site readiness while allowing them in a local lab
     → expected true to be false // Object.is equality
   × rejects password aliases in accepted endpoint query strings
     → mssql://db.example.test/hub?user=readonly&pwd=NON_SECRET_SENTINEL: expected true to be false // Object.is equality
   × allows only HTTPS or loopback HTTP for local-lab IdP URLs
     → expected true to be false // Object.is equality
   × rejects credentials embedded in identity references
     → expected true to be false // Object.is equality
   ✓ 11 other contract and CLI tests

 Test Files  1 failed (1)
      Tests  5 failed | 11 passed (16)
```

### 修复 GREEN

命令：`npm test -- acceptance-tests/environment.test.ts`

```text
> data-governance-integration-service@1.0.0 test
> vitest run acceptance-tests/environment.test.ts

 RUN  v3.2.7 E:/git/dgo-hub/integration-service

 ✓ acceptance-tests/environment.test.ts (16 tests) 43ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
   Start at 12:56:21
   Duration 592ms (transform 66ms, setup 0ms, collect 170ms, tests 43ms, environment 0ms, prepare 130ms)
```

变更后的专项检查：

`npm run typecheck`：

```text
> data-governance-integration-service@1.0.0 typecheck
> tsc --noEmit -p tsconfig.json
```

`npm run build`：

```text
> data-governance-integration-service@1.0.0 build
> tsc -p tsconfig.json
```

schema 对齐命令输出：

```text
SCHEMA_MATCH
EXAMPLES_PARSE
```

`git diff --check` 与 `git diff --cached --check` 均无空白错误；Git 仅提示 Windows 工作区将 LF 转为 CRLF。未重跑全量测试；本轮变更覆盖由 16 项 focused 测试、typecheck 和 build 验证。

## 首轮修复复审（Round 2）

- 状态：`DONE_WITH_CONCERNS`
- 修复提交：`b8b072b43414db6b111badd6f02b7ffd41531a76`
- Review 基线：`f76c929242b13d7714c5ff92843236ab62e95e22`。
- R1：在所有 URI scheme 分支之前拒绝裸 `name:password@host` 语法；环境测试身份和批准人共享此校验。`urn:employee:alice` 正例仍通过。
- R2：归一化查询名后恢复旧的 `auth` 子串拒绝边界；`auth_key`、`pwd` 与百分号编码后的 `pwd` 都由 focused 用例覆盖。
- JSON Schema 结构没有变化，本轮只收紧 Zod refinements，因此不需重新生成。

### RED

命令：`npm test -- acceptance-tests/environment.test.ts`

```text
 RUN  v3.2.7 E:/git/dgo-hub/integration-service

 ❯ acceptance-tests/environment.test.ts (19 tests | 3 failed) 56ms
   × rejects bare user:password@host syntax in test identity references
     → expected true to be false // Object.is equality
   × rejects bare user:password@host syntax in approval actor references
     → expected true to be false // Object.is equality
   × rejects auth_key endpoint query aliases while retaining password aliases
     → expected true to be false // Object.is equality
   ✓ 16 other contract and CLI tests

 Test Files  1 failed (1)
      Tests  3 failed | 16 passed (19)
   Start at 13:00:37
   Duration 607ms (transform 72ms, setup 0ms, collect 181ms, tests 56ms, environment 0ms, prepare 143ms)
```

### GREEN

命令：`npm test -- acceptance-tests/environment.test.ts`

```text
> data-governance-integration-service@1.0.0 test
> vitest run acceptance-tests/environment.test.ts

 RUN  v3.2.7 E:/git/dgo-hub/integration-service

 ✓ acceptance-tests/environment.test.ts (19 tests) 44ms

 Test Files  1 passed (1)
      Tests  19 passed (19)
   Start at 13:00:49
   Duration 572ms (transform 71ms, setup 0ms, collect 171ms, tests 44ms, environment 0ms, prepare 135ms)
```

`npm run typecheck`：

```text
> data-governance-integration-service@1.0.0 typecheck
> tsc --noEmit -p tsconfig.json
```

`npm run build`：

```text
> data-governance-integration-service@1.0.0 build
> tsc -p tsconfig.json
```

Task 1 原有 I1–I4、`vault:///`、有效 opaque URN、`pwd` 与编码后 query alias 等回归均在这 19 项 focused 测试中继续通过。未重跑全量 suite，符合本轮限定的变更覆盖范围。
