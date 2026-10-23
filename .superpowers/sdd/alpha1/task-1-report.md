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
