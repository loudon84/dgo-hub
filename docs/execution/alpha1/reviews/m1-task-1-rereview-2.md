# M1-1 scoped re-review, fix round 2

Reviewer: GPT-6.1 Sol. Date: 2026-10-24. FIXBASE `7dedc3f77094b4c6cb56ecfd8c70dad80765e56c`; source commit `75d6640a57939791477203b7a196abbdde34dcee`; reviewed HEAD `0afcd73b2ae9b72f27966a1488bcb87a326387b2`.

**Spec gate: PASS. Quality gate: PASS, for the scoped M1-1 review.** I2, I5 and I10 are ADDRESSED. The seven prior closures I1/I3/I4/I6/I7/I8/I9 remain intact. No new Important or Critical breakage was found in the fix diff. No M1-1 finding remains open.

## Scope and method

Reviewed the full-range fix2 package, actual changed SQL/routes/tests and their existing service/AuthService seams, appended public/private reports, retained RED/GREEN/typecheck/build outputs, exact source bytes and fixture lifecycle evidence. The only source changes in this range are migration 005, the sample_ref route response, and source-registry acceptance tests. Migrations 001–004 and other runtime/deployment source are unchanged.

Initial/final Git status showed only the controller-owned M1 progress log dirty. The blocked-host-artifact guard was read. No product edits, commits, subagents, ambient configuration/secret reads, external requests, new fixtures, broad suites or build reruns were needed.

## Spec verdicts

### M1-T1-I2 — ADDRESSED

**Locations:** `integration-service/migrations/005_source_registry.sql:166–186`, `:235–260`, `:268–295`; new scope regression in `integration-service/acceptance-tests/source-registry.test.ts:340`.

Both controlled credential mutations now compare all admission/approval applicability fields: material/reference, enabled state, entity scope and config revision. An effective change advances credential_generation and source_epoch once, under the credential row lock. Registry lifecycle invalidation is in the same transaction; ACTIVE/PAUSED stays PAUSED, other states become DRAFT. No-op updates return without incrementing generation/epoch. Ordinary manager pause/resume still changes admission epoch separately and retains a valid approval.

The current-source definer now joins the selected immutable config revision and an active entity channel, requires credential revision = current config revision, requires the requested entity in both credential scope and config allowed_entities, compares channel connector/mode/version domain with that config, and locks credential/tenant/registry/channel rows on the supplied client. Missing or mismatched entity/channel authority returns no current-source proof; AuthService rejects it. The config revision contents are immutable under the API role, so those contents need no mutable config-row lock.

The retained real PostgreSQL regression covers scope extension pausing the source and changing generation, stale approval rejection, order denial before and after customer-config reapproval, successful supported customer admission, stable no-op generation, and scope removal. Existing focused tests retain current-source/pause serialization and unchanged approved pause/resume. This directly corrects the demonstrated fresh-principal bypass rather than relying on an epoch mismatch that a fresh principal would not have.

### M1-T1-I5 — ADDRESSED

**Location:** `integration-service/source-registry/routes.ts:151`; focused HTTP assertion in `integration-service/acceptance-tests/source-registry.test.ts:506`.

Unsupported sample_ref now returns HTTP 422 with request_id and a sanitized Hub error envelope. The retained GREEN suite checks 422, while preserving malformed JSON 400, media type 415 and body-size 413 checks. The shared mapping/physical-type preflight corrections were already closed in substance; this round closes the remaining explicit status contract.

### M1-T1-I10 — ADDRESSED

**Location:** `integration-service/migrations/005_source_registry.sql:251–260`; pre-registry rotation regression in `integration-service/acceptance-tests/source-registry.test.ts:395`.

Credential rotation updates the authoritative credential and its generation/epoch regardless of registry onboarding. Lifecycle update/audit insertion is now conditional on finding the corresponding registry row. The composite FK is retained. The focused regression provisions and rotates a credential before any source_registry row exists, verifies exactly one epoch/generation increment and confirms that no registry was manufactured. Registered ACTIVE rotation remains covered by the existing test.

## Quality gate and retained verification

Evidence root: `docs/execution/alpha1/m1-task-1-fix2-evidence-20261024-0eb98c9e4866453d9a38c3ad465038fa/`.

| Retained command, cwd integration-service | Raw output | Verified result |
|---|---|---|
| `npm test -- --run acceptance-tests/source-registry.test.ts` before fixes | `red-fix2-regressions.log` | 26 passed / 3 intended failures; embedded EXIT=1 |
| Same focused command after fixes | `green-fix2-regressions.log` | 29/29 passed, one file; embedded EXIT=0 |
| `npm run typecheck` | `final-typecheck.log` | clean output, embedded EXIT=0 |
| `npm run build` | `final-build.log` | clean output, embedded EXIT=0 |

The RED failures are the scope lifecycle bypass, pre-registry rotation failure and wrong sample_ref status. The GREEN assertions exercise their corrected behavior. The earlier 210/210 full suite is historical and is not relabeled as a run against this source. No equivalent 29/210 suite, typecheck, build or Compose build was repeated by the reviewer. Existing evidence plus code inspection resolved the scoped risks without another resource probe.

All three working raw hashes, LF-normalized hashes, lengths and committed Git blob IDs independently match the fix2 manifest:

| File | Raw SHA-256 | Committed LF SHA-256 / Git blob |
|---|---|---|
| migration 005 | `7085104c2ef23033398ade93441def385fc04b67bd3d39c73bf7e5cfe90a3f7f` | same / `b59b25d1e9b08790eec943e9b159e39ee3593158` |
| source-registry/routes.ts | `29cee7ca7773e0042037ce0ec12f101ee45119bb5d1ad9e655cabe69e0504069` | same / `d1b36862bae0ac5ce33f8759813afff58f3c92d1` |
| source-registry.test.ts | `4df59596929563c42bf37307fa80dde548418e6fc52a667552b5c5ce1cec4183` | `76b9b14f43b147b22a078e36ad1f12bf737a41a9714c411d8d1fd7d28484968e` / `f4328fc799037d714c9d6697fdf88b85ad55cc2b` |

Raw byte lengths are respectively 22,627 / 10,180 / 61,561. The test file's mixed newline convention is disclosed rather than treated as a different source version.

### Retained fixture cleanup

Both raw PostgreSQL lifecycle files identify `postgres:16.10-alpine`, task label m1task1 and repo/runtime digest `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`, with ownershipConfirmed and containerAbsentAfterRemoval true:

| Run | Full container ID |
|---|---|
| RED `1e061809-db85-4ed4-972c-52afbb58f57a` | `9446d70999b0e1d7376b89edfaa2ad6226d34bb03062035d23748c190ab931b4` |
| GREEN `a77603b0-01a6-4f6e-b493-00c9876ad704` | `04697093c9d76d735a6605f2c25eb87bc18a0f260a84869fd3b2de9842e1398b` |

Their respective capability-http-resource-summary.json files record closed/released loopback fixtures `0778f0fc-dce0-4fb8-aeb5-f81f270c232f` on 62164 and `cf676afa-a396-4d4a-8638-0f340d885a3e` on 62299. No review resource was created.

## M1-2 entry assessment and limits

**M1-2 may proceed from the reviewed fix2 source after the controller records the accepted base.** Carry forward the frozen contracts: use the existing credential authority and caller-owned transaction proof; preserve accepted jobs under ordinary frozen config/mapping/channel contracts; enforce durable security barriers separately from admission epoch; retain exact current Owner binding and revision checks. M1-2 must wire the existing identity confirmation workflow to real same-tenant canonical customer targets; customer confirmation remains explicitly unresolved/fail closed until that target exists, as the controller ruled.

This is scoped implementation approval, not site/product acceptance. Production secret/endpoint providers and the current startApp deployment injection remain unverified/fail closed. No real enterprise IdP/source/egress, SQL Server, full snapshot, canonical apply/worker, UI, remote Hermes or site runtime was exercised. SQL Server and channel switching remain unavailable at their existing gates. Migration-before-original-RED chronology and the stale historical hash disclosure remain preserved. All 48 required product acceptance rows remain NOT_RUN.
