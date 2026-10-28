# M1-5E1a1 Fix round 2 independent rereview

Prior P2 build-output-to-runtime binding: ADDRESSED.
Spec Compliance: PASS (E1a1 task scope, cumulative with round 1).
Task quality: Approved.
Remaining findings: 0 Critical, 0 P1, 0 P2. No new evidence-repair breakage found.

## Scope and pins

This rereview is restricted to the one open P2 in task-5e1a1-rereview-1.md and breakage introduced by its evidence repair. The four closed findings and the closed real-partial-original/source-writer acceptance gap are carried forward, not reopened. The binding task brief's build-before-Node/loaded-dist/source/evidence rules remain the acceptance criterion.

Read the policy-blocked-host-artifacts note first, the Fix2 report supplement, prior review context, and the full 1,027-line Fix2 review package in four bounded chunks. The supplied range is `4bc2ebf837b7478c57519c2421b7b95f288108f5..023dde50e12e86da985ce494039113437caf54e4`, containing eb5a9a8 and the follow-up 023dde5 that includes the seven ignored build capture files. No product/test diff appears in this package; the controller separately verified integration-service has no change in that range.

Product source pin remains `55bc0ea1605952baa967ec81c6a4cc90564879c6`. The fresh build, focused test and verifier actually ran at `4bc2ebf837b7478c57519c2421b7b95f288108f5`; they are not relabeled as executions at 55bc0ea. The final docs/evidence delivery is 023dde5.

No suite, build, verifier script, process/container inspection, resource operation, Git command, or subagent was run by this reviewer. Independent verification used read-only byte hashing and parsing of explicitly allowed saved records. Only this report was written.

## Why the P2 is addressed

Paths below are relative to the permitted package:
`docs/execution/alpha1/m1-task-5e1a1-fix2-evidence/9d499149-7503-436f-b74c-5f7db7c33e3e/`.

### Build bytes were persisted before the test

`tools/Capture-Build.ps1:7` reads the emitted dist entry only after a successful build and source-after snapshot, then writes a build-output manifest and SHA-256 sidecar. The build command record contains the manifest digest and output path/size/digest. This supplies the missing build-time artifact record rather than relying on a later artifact observation.

`captures/build/build-output-manifest.json:3` binds capture `08b23034-e615-43c8-a55c-75d23bd2ba1f`, actual HEAD before/after 4bc2ebf, command/cwd/source snapshot paths, and output:

- `E:/git/dgo-hub/integration-service/dist/etl-worker/snapshot-apply-worker.js`
- 15,569 bytes
- SHA-256 `f0a1422b1560cfc25b362588a0af69e9f63ce28b87c354cce8691d2228b643cc`

Independently recomputed the manifest's actual raw SHA-256 as `dd7fbde6ce7812805032c05ede51a22e57fce899a2d5b1d2a875cffa12a5abb5`; it equals its sidecar, the build command's manifest digest, and the focused test command's manifest digest. These checks read actual files, not just the report's stated value.

The captured timestamp order is build finished `09:33:03.9561048Z`, manifest created `09:33:03.9578141Z`, then focused test started `09:33:12.8563510Z`. Independently parsed and checked this ordering. The report correctly qualifies the old Fix1 evidence and does not retroactively treat its post-run hashes as this new proof.

### Both actual child imports match the persisted build output

`tools/Capture-Test.ps1:2` obtains the build capture ID from that persisted manifest; its command record retains the manifest path/digest. The unchanged accepted test still hashes the module in each child before dynamically importing that module URL.

Read and independently parsed the original child messages preserved in `captures/focused-test/stdout.txt:9`. Both NODE_MODULE_LOAD_RECORD entries match the persisted build manifest's normalized exact module path, SHA-256, size and capture ID. Each PID joins exactly one actual NODE_CHILD_CRASH record:

| PID | Phase | Run | Attempt | Aggregate |
|---|---|---|---|---|
| 27356 | before aggregate COMMIT | 2f0f7a34-cef3-44e9-946f-30dff5f719c6 | 21a5692c-c636-43fa-a8f8-2e4e65ac3221 | C-REC-4 |
| 45004 | after aggregate COMMIT | 2f0f7a34-cef3-44e9-946f-30dff5f719c6 | 21a5692c-c636-43fa-a8f8-2e4e65ac3221 | C-REC-4 |

Both events record SIGKILL. The build label is now supported by persisted output bytes and an explicit comparison; it is no longer the only connection to the earlier build.

### The verifier makes the required comparisons

Inspected `tools/Verify-BuildRuntimeBinding.ps1:8` through line 16 rather than accepting its PASS label:

- Recomputes the persisted manifest digest and compares sidecar/build command binding.
- Checks actual HEAD, successful build/test/manifest exits, build capture ID and test manifest digest.
- Checks build-finish/manifest-create/test-start order.
- Checks six source entries for build/test before/after equality and recorded blobs against both accepted product pin and actual gate HEAD.
- Parses exactly two load records and exactly two crash records, compares module path/hash/size to the manifest, joins each by PID, and requires before/after phases, one run, one attempt, C-REC-4 and SIGKILL.

The actual `captures/verification/runtime-binding-verification.json:2` records PASS and the same manifest, output and runtime cohort. This result agrees with the independent manifest and raw-child-log comparisons above.

The verifier's comparison loop covers 24 build/test source records; it also captures 12 records around verification. Its JSON explicitly says `source_records_across_build_test: 24`. The report's shorthand reference to 36 is interpreted as the total captured records, not as that loop's comparison count. This reviewer independently checked all 36 as described below, so the full captured source binding is established without overstating the script's internal coverage.

## Evidence and quality checks

- Independently recomputed raw SHA-256, LF-normalized SHA-256, byte size and Git blob SHA-1 for six explicit source files against before/after saved records for build, focused-test and verification: 36/36 match. All six source contents remain identical to those accepted in round 1. The controller separately checked recorded blobs against both 55bc0ea and 4bc2ebf; the reviewed verifier performs that two-pin comparison for its 24 build/test records as well.
- Independently hashed the actual new evidence-manifest.json: `15bc0234d2a5a1aa6c229cbd74e5ef40a7dba5da93fc8f5aeacb0c3c8fa5c326`, matching the supplied expected value. Its `copies` field lists 22 explicit source-to-unique-destination pairs, including the build manifest/sidecar, command captures and brackets, helper scripts, verifier result and PostgreSQL lifecycle. The controller independently verified original and copied sizes/hashes for 22/22; this reviewer does not claim that controller operation as its own.
- `captures/build/command.json:11`, `captures/focused-test/command.json:14`, and `captures/verification/command.json:11` record exit 0 at actual HEAD 4bc2ebf. Focused stdout names all four tests and reports 4/4. No new typecheck or broad suite is claimed; the accepted product/test sources are unchanged.
- Build and verifier stderr are empty. Focused stderr contains the two intentional afterAggregateCommit fixture failures at test source lines 281 and 541, creating the customer/order recovery originals. They are retained and qualified rather than represented as empty output or unexplained failures.
- The renewed SEALED lease observation and four successful test names are preserved in focused stdout. This round does not reopen those prior accepted assertions; the fresh full focused result remains consistent with them.
- `captures/verification/runtime-binding-verification.json:55` records later PID absence observations at `09:33:43.3624440Z` and `09:33:43.3627694Z`. They establish absence at observation time only; no exact exit timestamp is inferred.
- `runtime/postgres-lifecycle.jsonl:1` records the actual owned container `a6ae6b9857bdbebfe12f966b1e67c94717e016bb68737ea44a276f989aff9e47`, pinned postgres image digest `029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`, image observation, owned removal and absence-after-removal. No resource check or cleanup was performed by this reviewer.
- No blocked b1f directory or other policy-listed target was read, enumerated or altered. No old evidence was regenerated, relabeled or rewritten. Evidence reads used exact authorized package paths; the differing external `test` and packaged `focused-test` folders were resolved from the actual mapping.

## Assessment

The remaining P2 is closed by a fresh pre-test build manifest and a concrete byte comparison to both child imports. The four product/test findings and required partial-original/source-writer gap remain closed from round 1; this evidence-only range introduces no new product change or material evidence defect. No further task-scoped fix is required.

This is an E1a1 local task acceptance only. Whole M1/E integration, formal 48, site/Hermes/production, E1a2/API-023/024/remap/cutover, deployment, merge and push remain outside this verdict and unclaimed.
