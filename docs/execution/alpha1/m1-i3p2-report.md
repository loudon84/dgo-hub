# M1-I3P2 implementation report

Status: implementation for independent controller review; not committed, merged, deployed, or approved. BASE and current HEAD: `b0fb18315a98a5d60629cb16fc5e8e05bae7fff2`.

## Implemented

- `integration-service/ingestion-api/import-recovery-plan.ts`: separately guarded approve path and shared original candidate assembly; exact typed input validation, exact missing subset, current frozenProof, current mapping and live target checks, separate current proof/fence, fail closed on expected conflicts. Existing candidate retains its read authority and proof logic. No transaction boundary, allocation, write or HTTP surface.
- `integration-service/migrations/014_import_recovery_binding.sql`: private scoped authorizer and target/fence reads, read wrapper preserved and approve wrapper restricted to hub_api. Original facts function and migrations 001-013 untouched. Customer fence key is calculated from the original typed source tuple for narrow scoped lookup; PostgreSQL and TS hashing agree for the tested foreign tuple.
- `acceptance-tests/import-recovery-binding.test.ts`: OIDC/PG/hub_api real customer two-key and partial-key cases, actual map confirmation/retest/approval/activation, real order foreign-source tuple; authorization, malformed/stale input, mismatch, deletion, cross-tenant target, original security barrier, old/current remap fence, edit, and no-write checks. Exact committed HEAD 009 is copied for the fixture; populated 013 upgrade to 014, reapply and fresh migration are exercised.
- `acceptance-tests/import-recovery-candidate.test.ts`: exclude 014 from the intentionally 013 fixture, preserving its staged migration test. `migrations.test.ts`, `identity-store.test.ts`, `source-registry.test.ts`: exact migration lists/counts extended to 014.

## Evidence and limits

The test fixture observed an actual initial RED for the absent function, then a GREEN on the lifecycle. A separate RED demonstrated that a future current remap fence was initially accepted; after the fix the complete binding file passed. Later cases were added as regression coverage after implementation; do not interpret all individual cases as independently demonstrated RED-to-GREEN. Initial combined 5-file run failed because candidate and binding fixtures used the same evidence-root `migrations` directory concurrently; the history count also still expected 13. The count was corrected and final files run with separate fresh literal roots, as shown below. An intermediate typecheck failed on `String.isWellFormed` library availability and an overly broad unavailable union; corrected before final successful typecheck/build.

Focused null-original mapping remains a unit-level classification; P1 uppercase public event behavior remains a trusted transaction-local fixture because the existing worker case-sensitive UUID bug is deferred to W/I3C. The customer fence hashing equivalence is exercised on the ordinary foreign tuple, not every allowed Unicode/escaping edge; independent review should check that SQL serialization exactly matches `JSON.stringify` for all accepted tuples. Disabled Owner, all runtime role combinations, and every wrong/deleted/cross-tenant database arrangement are not exhaustively independently exercised here. Existing parent worker REDs and prior 409 PASS + 3 FAIL = 412 plus unhandled result were not rerun or reclassified. No admission A, worker W, I3C, real CRM/Hermes or platform completion claim is made.

SHA-256 manifests `i3p2-pre-manifest.txt` and `i3p2-post-manifest.txt` in this evidence directory cover all integration-service TS/SQL (including contract TS and new files), excluding node_modules/dist. Before: 114 files; after: 116. Comparison showed only the seven owned paths listed above; all protected files and 001-013 retained their pre-task hashes. Full raw manifests are attached, and the pre-existing 009 and worker test remain dirty. `git diff --check` on tracked owned files exited 0. Scoped final inventory follows.

```text
 M integration-service/acceptance-tests/identity-store.test.ts
 M integration-service/acceptance-tests/import-recovery-candidate.test.ts
 M integration-service/acceptance-tests/management-import-worker.test.ts
 M integration-service/acceptance-tests/migrations.test.ts
 M integration-service/acceptance-tests/quarantine-read.test.ts
 M integration-service/acceptance-tests/source-registry.test.ts
 M integration-service/acceptance-tests/strict-ingestion.test.ts
 M integration-service/ingestion-api/import-recovery-plan.ts
 M integration-service/migrations/009_snapshot_runs_and_recovery.sql
?? integration-service/0
?? integration-service/1
?? integration-service/2
?? integration-service/acceptance-tests/d2-migration-diagnostic.test.ts
?? integration-service/acceptance-tests/evidence/m1-task-2/
?? integration-service/acceptance-tests/import-recovery-binding.test.ts
?? integration-service/docs/execution/
?? integration-service/migrations/014_import_recovery_binding.sql
```

## Raw verification brackets

Working directory for test commands: `E:\git\dgo-hub\integration-service`. Literal root assignment precedes each fixture command. Output captured verbatim in the named evidence files; exit codes are from the process, not inferred from logs.

### Initial lifecycle RED

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\a1182467-5c97-4265-a1ee-3e7c16cd1701'; npx vitest run acceptance-tests/import-recovery-binding.test.ts`; exit `1`; raw output [i3p2-red.log]:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service

 ❯ acceptance-tests/import-recovery-binding.test.ts (1 test | 1 failed) 6433ms
   × builds a separately approved binding plan after mapping confirmation and retest 112ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  acceptance-tests/import-recovery-binding.test.ts > builds a separately approved binding plan after mapping confirmation and retest
AssertionError: expected undefined to be type of 'function'

Expected: "function"
Received: "undefined"

 ❯ acceptance-tests/import-recovery-binding.test.ts:99:72
     97|  expect((await app.inject({method:'POST',url:`/hub/v1/admin/sources/${…
     98|  const mod=await import('../ingestion-api/import-recovery-plan.js');
     99|  expect((mod as Record<string,unknown>).readImportRecoveryBindingPlan)…
       |                                                                        ^
    100| });
    101|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  03:52:03
   Duration  7.16s (transform 283ms, setup 0ms, import 543ms, tests 6.43s, environment 0ms)
```

### Current fence RED

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\5513f3ca-5742-412d-9182-3dce21c46708'; npx vitest run acceptance-tests/import-recovery-binding.test.ts`; exit `1`; raw output [i3p2-fence-red.log]:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service

 ❯ acceptance-tests/import-recovery-binding.test.ts (10 tests | 1 failed) 7511ms
   × rejects a remap fence newer than the current binding revision 68ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  acceptance-tests/import-recovery-binding.test.ts > rejects a remap fence newer than the current binding revision
AssertionError: expected 'ELIGIBLE' to be 'UNAVAILABLE' // Object.is equality

Expected: "UNAVAILABLE"
Received: "ELIGIBLE"

 ❯ acceptance-tests/import-recovery-binding.test.ts:157:12


⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
   Start at  03:56:41
   Duration  8.27s (transform 302ms, setup 0ms, import 571ms, tests 7.51s, environment 0ms)
```

### Current fence GREEN

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\7b6443a9-050a-43bf-b26f-a8dab5b0bd09'; npx vitest run acceptance-tests/import-recovery-binding.test.ts`; exit `0`; raw output [i3p2-fence-green.log]:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service


 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  03:57:09
   Duration  8.44s (transform 331ms, setup 0ms, import 644ms, tests 7.62s, environment 0ms)
```

### Combined run with fixture collision and stale count

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\a44108f8-8a93-4e64-956a-8a824b464904'; npx vitest run acceptance-tests/import-recovery-binding.test.ts acceptance-tests/import-recovery-candidate.test.ts acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts acceptance-tests/source-registry.test.ts`; exit `1`; raw output [i3p2-affected.log]:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service

 ❯ acceptance-tests/migrations.test.ts (19 tests | 1 failed) 7310ms
     × runs the compiled CLI with an explicit environment and closes its own pool 1198ms
 ❯ acceptance-tests/import-recovery-candidate.test.ts (13 tests | 13 skipped) 8547ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  acceptance-tests/import-recovery-candidate.test.ts [ acceptance-tests/import-recovery-candidate.test.ts ]
AssertionError: expected '014_import_recovery_binding' to be '013_import_recovery_candidate' // Object.is equality

Expected: "013_import_recovery_candidate"
Received: "014_import_recovery_binding"

 ❯ acceptance-tests/import-recovery-candidate.test.ts:84:124


⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  acceptance-tests/migrations.test.ts > versioned migration runner > runs the compiled CLI with an explicit environment and closes its own pool
AssertionError: expected { exists: true, count: 14 } to deeply equal { exists: true, count: 13 }

- Expected
+ Received

  {
-   "count": 13,
+   "count": 14,
    "exists": true,
  }

 ❯ acceptance-tests/migrations.test.ts:197:33


⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  2 failed | 3 passed (5)
      Tests  1 failed | 71 passed | 13 skipped (85)
   Start at  03:55:35
   Duration  11.83s (transform 809ms, setup 0ms, import 2.10s, tests 43.20s, environment 1ms)
```

### Binding final

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\b657fb7c-a794-4ca5-89e9-0483db55ec13'; npx vitest run acceptance-tests/import-recovery-binding.test.ts`; exit `0`; raw output [i3p2-binding-final2.log]:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service


 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  03:59:09
   Duration  9.25s (transform 334ms, setup 0ms, import 600ms, tests 8.46s, environment 0ms)
```

### Candidate final

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\e5492ac1-c805-44eb-b4eb-bebd88d84d11'; npx vitest run acceptance-tests/import-recovery-candidate.test.ts`; exit `0`; raw output [i3p2-candidate-verified.log]:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service


 Test Files  1 passed (1)
      Tests  13 passed (13)
   Start at  03:57:43
   Duration  11.20s (transform 483ms, setup 0ms, import 902ms, tests 10.06s, environment 0ms)
```

### History final

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\23f2e811-9413-43c4-b3ec-116503e0e512'; npx vitest run acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts acceptance-tests/source-registry.test.ts`; exit `0`; raw output [i3p2-history-verified.log]:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service


 Test Files  3 passed (3)
      Tests  64 passed (64)
   Start at  03:57:43
   Duration  13.19s (transform 552ms, setup 0ms, import 915ms, tests 27.86s, environment 0ms)
```

### Typecheck

Command: `npm run typecheck`; exit `0`; raw output [i3p2-typecheck-final.log]:

```text
> data-governance-integration-service@1.0.0 typecheck
> tsc --noEmit -p tsconfig.json
```

### Build

Command: `npm run build`; exit `0`; raw output [i3p2-build-final.log]:

```text
> data-governance-integration-service@1.0.0 build
> tsc -p tsconfig.json
```


## Controller repair 1 (C1-C3)

C1: both suites now put their entire owned fixture under separately named UUID subroots of the same `M0_RUN_EVIDENCE_ROOT`. This isolates staged migration directories and lifecycle evidence without serializing tests or weakening historical 013 and upgrade/reapply assertions. The combined five-file run below is the direct regression check.

C2: the earlier 114/116 manifests are scope-before/scope-after only. The new gate manifest is captured immediately before the combined run, typecheck and build, and again immediately afterward with no intervening source edits. Both contain 116 TS/SQL files, including contract TS and new untracked files; the manifest bytes have the same SHA-256 `751622548179CF42FAB60BDE08C7F0C0EEA61E38E86E20EA0ED44084DF252340`. HEAD before and after is `b0fb18315a98a5d60629cb16fc5e8e05bae7fff2`. The raw manifest, inventory, gate script and comparison are in this evidence directory. Comparison with the earlier post-scope manifest shows only the candidate and binding test files changed in repair; protected files and 001-013 are unchanged. `git diff --check` on tracked owned files returned 0.

C3: the foreign-order lifecycle runs for both its ordinary key and an accepted `source_pk` containing a quote, backslash, CJK, supplementary emoji, U+2028 and U+2029. For each, actual mapping confirmation, retest, approval and activation produce an eligible plan; a transaction-local newer customer fence is keyed using the actual JavaScript `customerReferenceMappingKey`, and the guarded plan returns unavailable. To check sensitivity, 014 was temporarily mutated from `customer_key:='c:'` to `customer_key:='x:'`; the escaped case then failed because the guarded plan returned eligible. The original migration bytes were restored in `finally` and matched pre-mutation SHA-256 `3043C6C0D0BD080D559B9A61D1544E305C61C3B4A6C78292AE8C275F140EE00C`. This is representative coverage, not exhaustive Unicode equivalence. One editing command hit Windows GBK encoding and truncated the binding test; it was restored byte-for-byte from the controller-frozen initial source, whose SHA matched the prior post-scope manifest, before applying the repair in UTF-8.

The gate passed **90/90**, typecheck and build exited 0. No product logic was changed during repair. Previous independent runs and combined collision remain recorded above; no full-package or parent worker rerun is claimed. Fresh independent review of the entire task plus repair remains outstanding.

### Mutation sensitivity RED

Command: temporarily replace `customer_key:='c:'` with `customer_key:='x:'` in 014, run `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\e0d9924d-b102-4f84-82d8-d459e6c3c402'; npx vitest run acceptance-tests/import-recovery-binding.test.ts -t escaped-unicode`, then restore original bytes in `finally`; test exit 1.

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service

 ❯ acceptance-tests/import-recovery-binding.test.ts (13 tests | 1 failed | 12 skipped) 6850ms
   × binds an order with a escaped-unicode foreign customer key after a new approval 559ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  acceptance-tests/import-recovery-binding.test.ts > binds an order with a escaped-unicode foreign customer key after a new approval
AssertionError: expected 'ELIGIBLE' to be 'UNAVAILABLE' // Object.is equality

Expected: "UNAVAILABLE"
Received: "ELIGIBLE"

 ❯ acceptance-tests/import-recovery-binding.test.ts:210:552


⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 12 skipped (13)
   Start at  04:04:59
   Duration  7.64s (transform 316ms, setup 0ms, import 592ms, tests 6.85s, environment 0ms)
```

### Escaped and ordinary lifecycle before mutation

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\4e398cf4-0d91-4dfd-8ac3-6d0bec826301'; npx vitest run acceptance-tests/import-recovery-binding.test.ts`; exit 0.

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service


 Test Files  1 passed (1)
      Tests  13 passed (13)
   Start at  04:04:38
   Duration  8.94s (transform 315ms, setup 0ms, import 566ms, tests 8.20s, environment 0ms)
```

### Bracketed combined gate

Command: `& 'E:\git\dgo-hub\docs\execution\alpha1\m1-i3p2-evidence\repair-gate.ps1'`; exit 0. Exact commands and manifest capture:

```powershell
$ErrorActionPreference='Stop'
$evidence='E:\git\dgo-hub\docs\execution\alpha1\m1-i3p2-evidence'
$workspace='E:\git\dgo-hub'
Set-Location $workspace
function Write-Manifest([string]$target) {
  Get-ChildItem -Recurse 'integration-service' -File | Where-Object { $_.Extension -in '.ts','.sql' -and $_.FullName -notmatch 'node_modules|\\dist\\' } | Sort-Object FullName | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $($_.Path)" } | Set-Content -Encoding utf8 $target
}
git rev-parse HEAD | Set-Content -Encoding utf8 "$evidence\repair-gate-head-before.txt"
git status --short -- integration-service | Set-Content -Encoding utf8 "$evidence\repair-gate-status-before.txt"
Write-Manifest "$evidence\repair-gate-pre-manifest.txt"
Set-Location "$workspace\integration-service"
$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\6206baef-a813-4f13-aa47-218c01c6dd03'
npx vitest run acceptance-tests/import-recovery-binding.test.ts acceptance-tests/import-recovery-candidate.test.ts acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts acceptance-tests/source-registry.test.ts 2>&1 | Tee-Object -FilePath "$evidence\repair-gate-combined.log"
$testExit=$LASTEXITCODE
npm run typecheck 2>&1 | Tee-Object -FilePath "$evidence\repair-gate-typecheck.log"
$typeExit=$LASTEXITCODE
npm run build 2>&1 | Tee-Object -FilePath "$evidence\repair-gate-build.log"
$buildExit=$LASTEXITCODE
Set-Location $workspace
Write-Manifest "$evidence\repair-gate-post-manifest.txt"
git rev-parse HEAD | Set-Content -Encoding utf8 "$evidence\repair-gate-head-after.txt"
git status --short -- integration-service | Set-Content -Encoding utf8 "$evidence\repair-gate-status-after.txt"
$pre=Get-FileHash "$evidence\repair-gate-pre-manifest.txt" -Algorithm SHA256
$post=Get-FileHash "$evidence\repair-gate-post-manifest.txt" -Algorithm SHA256
"test=$testExit typecheck=$typeExit build=$buildExit pre_manifest=$($pre.Hash) post_manifest=$($post.Hash) identical=$($pre.Hash -eq $post.Hash)" | Tee-Object -FilePath "$evidence\repair-gate-result.txt"
if ($testExit -ne 0 -or $typeExit -ne 0 -or $buildExit -ne 0 -or $pre.Hash -ne $post.Hash) { exit 1 }
```

Combined test output:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service


 Test Files  5 passed (5)
      Tests  90 passed (90)
   Start at  04:05:39
   Duration  12.04s (transform 924ms, setup 0ms, import 2.48s, tests 45.36s, environment 1ms)
```

Typecheck output:

```text
> data-governance-integration-service@1.0.0 typecheck
> tsc --noEmit -p tsconfig.json
```

Build output:

```text
> data-governance-integration-service@1.0.0 build
> tsc -p tsconfig.json
```

Result:

```text
test=0 typecheck=0 build=0 pre_manifest=751622548179CF42FAB60BDE08C7F0C0EEA61E38E86E20EA0ED44084DF252340 post_manifest=751622548179CF42FAB60BDE08C7F0C0EEA61E38E86E20EA0ED44084DF252340 identical=True
```

Raw hash comparison and protected inventory:

```text
prior scope files=116 gate pre files=116 gate post files=116
pre/post dictionary identical=True
REPAIR CHANGE E:\git\dgo-hub\integration-service\acceptance-tests\import-recovery-binding.test.ts C8686D93DF7A9A3D534B66613F45D0B7D3590A197E6114304E63CC9F3F2277D8 -> 64104EDDCA62FA213A1299C5F3B2787FB12D613392D04B8FCBB660B6326D54A1
REPAIR CHANGE E:\git\dgo-hub\integration-service\acceptance-tests\import-recovery-candidate.test.ts 04D8E6486F2FC195B04481CD352D2609EF2746022473598365D27045873FD0CA -> 919694EC7AA70F4A00256B3DB128BD9BD0F121A377AC728C5D7E82DC4893582D
PROTECTED E:\git\dgo-hub\integration-service\migrations\009_snapshot_runs_and_recovery.sql old=40E2B46A9027FA69EA16B7826BD69F7C2D7CD9183ED76FCE5E9DBCACDD0C367F current=40E2B46A9027FA69EA16B7826BD69F7C2D7CD9183ED76FCE5E9DBCACDD0C367F unchanged=True
PROTECTED E:\git\dgo-hub\integration-service\acceptance-tests\management-import-worker.test.ts old=C5B95D87BC59F94241A5AF0EC47E3DA0ED3760437A7FB7F8E9A478BE375DAD41 current=C5B95D87BC59F94241A5AF0EC47E3DA0ED3760437A7FB7F8E9A478BE375DAD41 unchanged=True
PROTECTED E:\git\dgo-hub\integration-service\acceptance-tests\quarantine-read.test.ts old=EBF0A384211B9C3EEB5FB0D745EBFCC17C3E94B9A777D3071F49A0E2A58E4AAF current=EBF0A384211B9C3EEB5FB0D745EBFCC17C3E94B9A777D3071F49A0E2A58E4AAF unchanged=True
PROTECTED E:\git\dgo-hub\integration-service\acceptance-tests\strict-ingestion.test.ts old=7EDE576273C7610CEC15D7710F8B2D7524D730DECC26B850C363F99C2126D705 current=7EDE576273C7610CEC15D7710F8B2D7524D730DECC26B850C363F99C2126D705 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\001_init.sql 600491B647D88DD2F282A425AFE1005E7FE2C4C87A67B30570DE52408A7F2251 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\002_identity_auth.sql 1267FD0803AE543E73E701CCF277DE8A9D09CB6F1A601658B11F3AC1D926C062 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\003_mcp_audit_boundary.sql E682D1F350CDE309E5C556904CE694EE3D8CFAFA58AE8FBAD0E610CE0EE7274E unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\004_alpha1_runtime_security.sql 11549B816BD696841AB30BEB2B2B457617EFA929A9AD397976E1409D75FF7298 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\005_source_registry.sql 7085104C2EF23033398ADE93441DEF385FC04B67BD3D39C73BF7E5CFE90A3F7F unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\006_canonical_data_and_receipts.sql FB52F395BD0C0F1D29E5234788B39737A922BF0F9928F7E99BECFB6BE91F3065 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\007_durable_ingestion_jobs.sql 4E2CCEFE6F34D3EF4AA043EE8FE54FC88C45C225D07FD80FB827FEF37B564159 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\008_durable_worker_leases_and_retries.sql 4FCD01D104945A16102034B906D8DF5423BBC325F08B6105106B0383F5CD370A unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\009_snapshot_runs_and_recovery.sql 40E2B46A9027FA69EA16B7826BD69F7C2D7CD9183ED76FCE5E9DBCACDD0C367F unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\010_simulated_import.sql 1E0ECAD5406B0829FB15318DC62D79193C47EB3808AB04DFE65B90B9A9368567 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\011_management_import_admission.sql AD5DEEE2DCBEFDC297CC5CE0931AE41298ABFA2BC5B061AF77051E32E144309E unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\012_import_quarantine.sql 2DBDB863D0D0C25420471943A0FE71AF3F2FC6D118FA8B3EFAE051AEBE16D906 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\013_import_recovery_candidate.sql D7C8AE4C57D0C707E79CC7BB6C334D1819CCB62A8FFEC61E4EB5226273045EF9 unchanged=True
```

## Independent review fix 2 (R1-R3)

R1: the two suites now call the focused `integration-service/acceptance-tests/helpers/import-recovery-fixture.ts` for the single real OIDC, hub_api, management import and quarantine setup. It retains independently named UUID subroots for staging and lifecycle evidence. The helper closes initialized resources if setup fails. The only changes from frozen `context/i3p2-review1-source` are the two consuming test files and the new helper; product TS and 014 SQL hashes match the reviewed source.

R2/R3: for each populated fixture the helper applies 013 and checks reapplication, checks a fresh 013 database and reapplication, then applies 014 and explicitly asserts the populated reapply has no new applications and skips 014. A separate fresh 014 database and its reapply remain asserted. Both complete P1 and P2 behavioral suites now execute against the populated database with 014 installed, including the replaced read wrapper. Historical 013 migration checks remain before 014 installation. The existing P1 `null-ref` label was not touched; it remains an absent-key fixture, not a new null-mapping lifecycle claim.

The final same-root combined gate passed 5 files, 90 tests, with typecheck and build exit 0. The 119-file immediate pre/post manifests include all integration-service TS/SQL including the new helper plus the two contract Markdown files; both manifest SHA-256 values are `485CE591CA9827EDBF60D85DFC360F2F5EFF702A64F02EAD45F511E84BF4575C`. HEAD before and after: `b0fb18315a98a5d60629cb16fc5e8e05bae7fff2`. The prior manifests did not contain the Markdown files; their current hashes match the controller's prior supplemental hashes. All protected files and migrations 001-013 match the previous gate. Full-package and parent-worker tests were not rerun; remaining A/W/I3C and representative Unicode limits remain as stated above. No commit, merge or deployment. Scoped rereview remains outstanding.

### Focused two-suite run

Command: `$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\58659bd1-dcb4-4043-bb3c-b7abc0dd1001'; npx vitest run acceptance-tests/import-recovery-candidate.test.ts acceptance-tests/import-recovery-binding.test.ts`; exit 0.

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service


 Test Files  2 passed (2)
      Tests  26 passed (26)
   Start at  04:14:26
   Duration  12.78s (transform 647ms, setup 0ms, import 1.21s, tests 22.44s, environment 0ms)
```

### Final same-root bracketed gate

Command: `& 'E:\git\dgo-hub\docs\execution\alpha1\m1-i3p2-evidence\fix2-gate.ps1'`; exit 0. Exact commands and immediate manifest capture:

```powershell
$ErrorActionPreference='Stop'
$evidence='E:\git\dgo-hub\docs\execution\alpha1\m1-i3p2-evidence'
$workspace='E:\git\dgo-hub'
Set-Location $workspace
function Write-Manifest([string]$target) {
  Get-ChildItem -Recurse 'integration-service' -File | Where-Object { ($_.Extension -in '.ts','.sql' -or ($_.Extension -eq '.md' -and $_.FullName -match '\\contracts\\')) -and $_.FullName -notmatch 'node_modules|\\dist\\' } | Sort-Object FullName | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $($_.Path)" } | Set-Content -Encoding utf8 $target
}
git rev-parse HEAD | Set-Content -Encoding utf8 "$evidence\fix2-gate-head-before.txt"
git status --short -- integration-service | Set-Content -Encoding utf8 "$evidence\fix2-gate-status-before.txt"
Write-Manifest "$evidence\fix2-gate-pre-manifest.txt"
Set-Location "$workspace\integration-service"
$env:M0_RUN_EVIDENCE_ROOT='E:\m1t5-runtime\cda16853-befa-47bf-9a5a-f2f7a1bcf902'
npx vitest run acceptance-tests/import-recovery-binding.test.ts acceptance-tests/import-recovery-candidate.test.ts acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts acceptance-tests/source-registry.test.ts 2>&1 | Tee-Object -FilePath "$evidence\fix2-gate-combined.log"
$testExit=$LASTEXITCODE
npm run typecheck 2>&1 | Tee-Object -FilePath "$evidence\fix2-gate-typecheck.log"
$typeExit=$LASTEXITCODE
npm run build 2>&1 | Tee-Object -FilePath "$evidence\fix2-gate-build.log"
$buildExit=$LASTEXITCODE
Set-Location $workspace
Write-Manifest "$evidence\fix2-gate-post-manifest.txt"
git rev-parse HEAD | Set-Content -Encoding utf8 "$evidence\fix2-gate-head-after.txt"
git status --short -- integration-service | Set-Content -Encoding utf8 "$evidence\fix2-gate-status-after.txt"
$pre=Get-FileHash "$evidence\fix2-gate-pre-manifest.txt" -Algorithm SHA256
$post=Get-FileHash "$evidence\fix2-gate-post-manifest.txt" -Algorithm SHA256
"test=$testExit typecheck=$typeExit build=$buildExit pre_manifest=$($pre.Hash) post_manifest=$($post.Hash) identical=$($pre.Hash -eq $post.Hash)" | Tee-Object -FilePath "$evidence\fix2-gate-result.txt"
if ($testExit -ne 0 -or $typeExit -ne 0 -or $buildExit -ne 0 -or $pre.Hash -ne $post.Hash) { exit 1 }
```

Combined test output:

```text
RUN  v4.1.12 E:/git/dgo-hub/integration-service


 Test Files  5 passed (5)
      Tests  90 passed (90)
   Start at  04:15:00
   Duration  14.47s (transform 848ms, setup 0ms, import 2.17s, tests 50.92s, environment 1ms)
```

Typecheck output:

```text
> data-governance-integration-service@1.0.0 typecheck
> tsc --noEmit -p tsconfig.json
```

Build output:

```text
> data-governance-integration-service@1.0.0 build
> tsc -p tsconfig.json
```

Result:

```text
test=0 typecheck=0 build=0 pre_manifest=485CE591CA9827EDBF60D85DFC360F2F5EFF702A64F02EAD45F511E84BF4575C post_manifest=485CE591CA9827EDBF60D85DFC360F2F5EFF702A64F02EAD45F511E84BF4575C identical=True
```

Raw review snapshot and protected hash comparison:

```text
previous TS/SQL=116 final all TS/SQL/contracts MD=119 pre/post identical=True
DELTA E:\git\dgo-hub\integration-service\acceptance-tests\helpers\import-recovery-fixture.ts NEW OR PREVIOUS CONTRACT SUPPLEMENT -> 08230CE117A47F1EAA05D8113154F73A9A129B62C697850CEE2E061974512960
DELTA E:\git\dgo-hub\integration-service\acceptance-tests\import-recovery-binding.test.ts 64104EDDCA62FA213A1299C5F3B2787FB12D613392D04B8FCBB660B6326D54A1 -> ECB93BEF70D68A0AC333AC18F45249B83831C0334D2A78490FCF87A0083D016E
DELTA E:\git\dgo-hub\integration-service\acceptance-tests\import-recovery-candidate.test.ts 919694EC7AA70F4A00256B3DB128BD9BD0F121A377AC728C5D7E82DC4893582D -> 8C18E07455B85ADFFFD6764DDD02EC3D554B76EDF23259FC98FD41F353BC085D
DELTA E:\git\dgo-hub\integration-service\contracts\api-gap-matrix.md NEW OR PREVIOUS CONTRACT SUPPLEMENT -> 1C46182705EE7FADC1F44D008FBD676BAE90C192CB97E1D56C90175734C87EEF
DELTA E:\git\dgo-hub\integration-service\contracts\simulated-import.md NEW OR PREVIOUS CONTRACT SUPPLEMENT -> CCF7900B291716A98015553D171FB2EB920B39C9BDF0CCC2EF2D98DB90506576
REVIEW1 integration-service/acceptance-tests/import-recovery-binding.test.ts old=64104EDDCA62FA213A1299C5F3B2787FB12D613392D04B8FCBB660B6326D54A1 new=ECB93BEF70D68A0AC333AC18F45249B83831C0334D2A78490FCF87A0083D016E changed=True
REVIEW1 integration-service/acceptance-tests/import-recovery-candidate.test.ts old=919694EC7AA70F4A00256B3DB128BD9BD0F121A377AC728C5D7E82DC4893582D new=8C18E07455B85ADFFFD6764DDD02EC3D554B76EDF23259FC98FD41F353BC085D changed=True
REVIEW1 integration-service/ingestion-api/import-recovery-plan.ts old=E1ACC21F90004C68B80D9F1319BD5F3C34B77088EB13C61E8AB93E4FC20F503B new=E1ACC21F90004C68B80D9F1319BD5F3C34B77088EB13C61E8AB93E4FC20F503B changed=False
REVIEW1 integration-service/migrations/014_import_recovery_binding.sql old=3043C6C0D0BD080D559B9A61D1544E305C61C3B4A6C78292AE8C275F140EE00C new=3043C6C0D0BD080D559B9A61D1544E305C61C3B4A6C78292AE8C275F140EE00C changed=False
PROTECTED E:\git\dgo-hub\integration-service\migrations\009_snapshot_runs_and_recovery.sql 40E2B46A9027FA69EA16B7826BD69F7C2D7CD9183ED76FCE5E9DBCACDD0C367F unchanged=True
PROTECTED E:\git\dgo-hub\integration-service\acceptance-tests\management-import-worker.test.ts C5B95D87BC59F94241A5AF0EC47E3DA0ED3760437A7FB7F8E9A478BE375DAD41 unchanged=True
PROTECTED E:\git\dgo-hub\integration-service\acceptance-tests\quarantine-read.test.ts EBF0A384211B9C3EEB5FB0D745EBFCC17C3E94B9A777D3071F49A0E2A58E4AAF unchanged=True
PROTECTED E:\git\dgo-hub\integration-service\acceptance-tests\strict-ingestion.test.ts 7EDE576273C7610CEC15D7710F8B2D7524D730DECC26B850C363F99C2126D705 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\001_init.sql 600491B647D88DD2F282A425AFE1005E7FE2C4C87A67B30570DE52408A7F2251 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\002_identity_auth.sql 1267FD0803AE543E73E701CCF277DE8A9D09CB6F1A601658B11F3AC1D926C062 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\003_mcp_audit_boundary.sql E682D1F350CDE309E5C556904CE694EE3D8CFAFA58AE8FBAD0E610CE0EE7274E unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\004_alpha1_runtime_security.sql 11549B816BD696841AB30BEB2B2B457617EFA929A9AD397976E1409D75FF7298 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\005_source_registry.sql 7085104C2EF23033398ADE93441DEF385FC04B67BD3D39C73BF7E5CFE90A3F7F unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\006_canonical_data_and_receipts.sql FB52F395BD0C0F1D29E5234788B39737A922BF0F9928F7E99BECFB6BE91F3065 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\007_durable_ingestion_jobs.sql 4E2CCEFE6F34D3EF4AA043EE8FE54FC88C45C225D07FD80FB827FEF37B564159 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\008_durable_worker_leases_and_retries.sql 4FCD01D104945A16102034B906D8DF5423BBC325F08B6105106B0383F5CD370A unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\009_snapshot_runs_and_recovery.sql 40E2B46A9027FA69EA16B7826BD69F7C2D7CD9183ED76FCE5E9DBCACDD0C367F unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\010_simulated_import.sql 1E0ECAD5406B0829FB15318DC62D79193C47EB3808AB04DFE65B90B9A9368567 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\011_management_import_admission.sql AD5DEEE2DCBEFDC297CC5CE0931AE41298ABFA2BC5B061AF77051E32E144309E unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\012_import_quarantine.sql 2DBDB863D0D0C25420471943A0FE71AF3F2FC6D118FA8B3EFAE051AEBE16D906 unchanged=True
MIGRATION E:\git\dgo-hub\integration-service\migrations\013_import_recovery_candidate.sql D7C8AE4C57D0C707E79CC7BB6C334D1819CCB62A8FFEC61E4EB5226273045EF9 unchanged=True
```

Scoped Git inventory before gate:

```text
M integration-service/acceptance-tests/identity-store.test.ts
 M integration-service/acceptance-tests/import-recovery-candidate.test.ts
 M integration-service/acceptance-tests/management-import-worker.test.ts
 M integration-service/acceptance-tests/migrations.test.ts
 M integration-service/acceptance-tests/quarantine-read.test.ts
 M integration-service/acceptance-tests/source-registry.test.ts
 M integration-service/acceptance-tests/strict-ingestion.test.ts
 M integration-service/ingestion-api/import-recovery-plan.ts
 M integration-service/migrations/009_snapshot_runs_and_recovery.sql
?? integration-service/0
?? integration-service/1
?? integration-service/2
?? integration-service/acceptance-tests/d2-migration-diagnostic.test.ts
?? integration-service/acceptance-tests/evidence/m1-task-2/
?? integration-service/acceptance-tests/helpers/import-recovery-fixture.ts
?? integration-service/acceptance-tests/import-recovery-binding.test.ts
?? integration-service/docs/execution/
?? integration-service/migrations/014_import_recovery_binding.sql
```

## Controller acceptance of scoped re-review

The independent fix-round review `task-i3p2-rereview-2.md` found R1, R2 and R3 addressed and no new Critical or Important breakage. The controller accepted the local P2 specification and quality gate and authorized a local commit of the exact task paths. This is not formal platform, release or wider I3R completion. The accepted combined five-file gate remains 90/90, with typecheck and build exit 0 and matching 119-file pre/post source and contract manifests at HEAD `b0fb18315a98a5d60629cb16fc5e8e05bae7fff2`.
