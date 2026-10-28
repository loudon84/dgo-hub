# Alpha.1 execution status

Updated 2026-10-24. E:/git/dgo-hub, `feat/alpha1-implementation`. M0 Tasks0–4 have passed their individual local engineering Spec/Quality reviews. The [Task4 initial review](reviews/m0-task-4-review.md) confirmed the carried Task3 I1 correction. The Task4 fix source `f9ede840` and evidence `73d9ce92` close I1/I2/I3; the [independent scoped re-review](reviews/m0-task-4-rereview-1.md) marks all three ADDRESSED with Spec PASS / Quality PASS. The whole-M0 review at `caf026a7` passed local runtime/identity/isolation and required one Task5 docs correction wave for M0-F-I1/I2/M1. Corrected rules, M1 plan links, and documentation checks are recorded in the [Task5 report](m0-task-5-report.md); [scoped Sol re-review](reviews/m0-final-rereview.md) now marks all three findings ADDRESSED and Task5 Spec/Quality plus M0 local engineering closure PASS. No product release, formal M0 completion, or site readiness is asserted.

## Current readiness

- Final local checks: reused the Task4 fixed run after verifying all six current `integration-service` runtime/test/migration entries match its manifest (0/6 mismatches). The record is runner exit 0, typecheck/test/build exit 0, 12 files / 191 tests; its recorded HEAD `9724f627` is only the recorder base. The run's captured dirty source bytes were later committed as `135b7f1`; the report preserves the full 24-file source manifest. Task4 fix1 probe changes have separate focused/live evidence and did not change these six runtime files. See [Task4 report](m0-task-4-report.md) and [Task5 report](m0-task-5-report.md).
- Fresh PostgreSQL initialization applied migrations 001–004; 27 real runtime role checks passed. Local TLS, network isolation, five MCP tools, closed-gate auditing, and distinct-credential revocation have retained probe evidence.
- Fix1 verification: all 114 original raw logs are now durably tracked with unchanged hashes; focused probe tests passed 2/2. Correct-host TLS and classified certificate negatives passed; ten exact direct addresses were live from the allowed side before/after and denied from sales. These are fix-specific results, distinct from the earlier 191-test record.
- Current M1 step: M1-1 has passed independent review. M1-2 implementation is complete and undergoing independent Sol review; M1-3 intake planning is read-only until that gate closes. Formal site acceptance remains blocked.
- Owned Docker resources were confirmed removed. Seven generated host secret/certificate/env paths remain after policy rejected deletion; the Task4 report lists them. They are excluded from tracked evidence and Docker context. Do not retry cleanup or include them in archives.

## M1 local implementation

M1-1 Source Registry, mappings and current-source authorization passed independent Spec/Quality review at `0afcd73b`, after source fixes `6cf6f8ee` and `75d6640a`. All ten cumulative findings are closed in the [round 2 review](reviews/m1-task-1-rereview-2.md). The original full 210-test record remains separate from fix1 focused 27 and fix2 focused 29 results; final typecheck/build passed. REST/PostgreSQL capability evidence is local only; runtime providers remain deployment-controlled and fail closed by default. User/department identity confirmation works; canonical customer target lookup is explicitly assigned to M1-2. M1-2 passed independent review after four fix rounds; M1-3 intake is in implementation and worker/snapshot completion is not claimed.

## W0 disposition

| Work | Implementation / review | Product acceptance |
|---|---|---|
| Tasks0–4 | implemented; individual spec/quality reviews approved | NOT_RUN/BLOCKED |
| Final fix wave | local Windows85, Linux31+1skip; I1/I2/I4/M1/M2 addressed | NOT_RUN/BLOCKED |
| W0-R1 | Important trim-normalization bypass; Task0 correction independently confirmed ADDRESSED by Sol | no product claim |
| W0-R2 | evidence-scope wording corrected; compiled anchor uses review memory probe evidence | no product claim |

See [W0 handoff](w0-closure.md), [scoped review](reviews/w0-final-fix-review.md), [final fix report](w0-final-fix-report.md), and [retained logs](w0-final-fix-evidence/). The carried W0-R1 engineering finding is now closed through the Task0 correction and independent Sol review.

## M0 local implementation

The six-task M0 plan is implemented task-by-task: migration runner; identity/credentials; OIDC/current-user APIs; strict MCP boundary; isolated deployment/probes; evidence handoff. The [published plan](../../plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md) and [Task5 report](m0-task-5-report.md) record each source identity and test record separately. Task1's 149-test initial full run and 54-test focused correction run, Task2's 168-test initial full run and 14-test focused correction, Task3's 185-test initial full run and 20-test focused correction, and Task4's dirty-source 191-test final run are not blended as if they tested one SHA. Task4 fix1 has separate 2-test focused and live evidence. Task5 reuse verification checked the six current `integration-service` files in the old 24-file manifest and found zero mismatches; it does not relabel the recorded base HEAD as the full source identity. Task4's scoped re-review closes its three findings. Whole-M0 review at `caf026a7` passed local runtime/identity/isolation and found two material M1 plan rules plus one reference correction; the combined Task5 docs-only fix and scoped re-review are complete; all three findings are closed and whole-M0 local engineering review passed. No site acceptance is inferred.

## Product gate

- M0–M6 formal acceptance remains BLOCKED/NOT_RUN; all 48 required A/N/FI rows remain NOT_RUN.
- Site IdP/config/bindings, source contracts/approved real input, authority records, observed eight-component lock and Golden Consumer are unavailable. Local engineering proceeds under user authorization.
- Hermes Agent v0.22.1 is user-reported installed on another machine; installed build/Profile/handshake/tool names and authorized answers remain unobserved. [Compatibility assumptions](../../../integration-service/docs/hermes-v0.22.1-compatibility.md).
- Task5 re-ran the site-kind entry check using the tracked signoff/environment examples, release-lock validation using the tracked synthetic lock/pins, and the release Gate against the existing fixed local-check run. All three returned BLOCKED/exit2 with the missing real approvals, observed deployment values, and seven formal evidence inputs listed verbatim in the [Task5 report](m0-task-5-report.md); no site materials were invented.
- Artificial release-shaped fixtures exercise validator branches only. Source pins are anchored outside bundle. W0-R1 trim behavior is confirmed ADDRESSED; neither artificial PASS nor unit count proves product acceptance.
- Existing backlog remains assigned: trusted auth M0; source/version/ETL M1; relationship/deletion/query/publish recovery M2; metadata/ontology M3; real Hermes M4; UI/workflow M5; evidence/recovery/release M6.

[API/page gap matrix](../../../integration-service/contracts/api-gap-matrix.md) retains the original 59 APIs, 12 pages, and 48 acceptance IDs, plus the one explicitly planned M1 extension API-060; [implementation baseline](../../../integration-service/docs/implementation-baseline.md) and [upstream assumptions](../../../integration-service/docs/upstream-api-assumptions.md) retain static-vs-runtime boundaries. The [M1 detailed implementation plan](../../plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md) records the sequential work: M1-1 is approved, M1-2 is under review, and later tasks remain pending.

## M1-2 review in progress — 2026-10-24

Canonical customer/order apply implementation is committed at 6bec79c3; evidence and resource-inventory correction are committed through 89c6f458. The final source gate passed typecheck, 240 tests across 15 files, and build; the focused canonical/source-registry set passed 49 tests. All 47 PostgreSQL fixture lifecycle records confirm ownership and absence after removal; all 15 HTTP fixtures report closure. An earlier stale inventory row was corrected from existing records without retrying any cleanup. See [implementation report](m1-task-2-report.md). Independent GPT-6.1 Sol Spec/Quality review is pending. M1-3 implementation has not started. These are local engineering checks, with no change to the formal NOT_RUN/BLOCKED gate.

M1-2 independent [initial review](reviews/m1-task-2-review.md) returned Spec FAIL / Quality Needs fixes. Eleven blocking findings are in the first Luna fix round; the earlier 240-test run is retained as historical evidence and is not proof of these repairs. M1-3 code remains pending review closure; its implementation brief is prepared provisionally.

## Latest M1 checkpoint — 2026-10-24

| Task | Local engineering state |
|---|---|
| M1-1 Source Registry / mappings / admission authority | Independent Spec/Quality PASS |
| M1-2 canonical model / caller-transaction apply / ownership effects | Independent Spec PASS / Quality Approved; all I1–I16 closed |
| M1-3 strict REST / durable intake jobs | R1–R5 repaired; scoped Sol re-review PASS/Approved; post-fix focused 33/33 and typecheck/build exit 0; earlier assurance gaps retained |
| M1-4 reliable worker / retry | Implemented; R1–R3 closed by scoped Sol PASS/Approved at 7ea2e94; post-fix focused 5 tests + typecheck/build passed; assurance limits retained |
| M1-5 PostgreSQL snapshot / recovery | In progress; A/B/C approved locally; C source e46a938e passed scoped Sol review; D/E and whole-phase verification pending |
| M1-6 SQL Server adapter | Not started; real integration conditional |
| M1-7 OpenMetadata UI / FI / Oracle | Not started |

M1-2 initial review raised twelve issues. The [first scoped review](reviews/m1-task-2-rereview-1.md) closed eleven and retained I6, adding helper issues I13/I14. Fix2 source is `06155415862691175c45f294d7ecb792b7dba713`, report/evidence `891fd892e2a9179cebad8aa33cd0d82c726f94aa`. The last canonical-apply run passed 27/27, typecheck and build exited 0; the preceding 25/27 query-typing failure remains in the evidence. The prior full 255-test result belongs to fix1, not the fix2 source. At that fix2 checkpoint the task was pending review; the later M1-2 closure below supersedes that state. M1 as a whole remains incomplete.

Fix2's eleven PostgreSQL fixtures are confirmed removed and absent. Fix1 HTTP fixture count is corrected to 17, combined earlier/fix1 HTTP total 32. A duplicate untracked scratch directory `m1-task-2-fix2-evidence-9d38414e-45c4-4aee-8c57-4b9ee6e59bf3` remains after two pre-execution policy rejections; no further cleanup attempt is allowed. The reviewed fix2 evidence is the explicit-whitelist `m1-task-2-fix2-evidence-b7f3213d-4e57-4c39-95ee-fd59e20ff853` package. Raw/untracked scratch roots are excluded from delivery archives.

Site IdP, real upstream CRM/orders, SQL Server and remote Hermes remain unverified; all 48 formal acceptance rows retain NOT_RUN. The global all-tenant security guard has no throughput measurement. Local continuation remains authorized.
## M1-2 closed; M1-3 dispatch ready

Independent [round 4 review](reviews/m1-task-2-rereview-4.md) passed Spec and Quality. All cumulative I1–I16 findings are closed. Approved source is e6cfa2f; migration 006 is now immutable. Latest canonical-apply evidence is 31/31 plus typecheck/build exit 0; no new whole-suite count is claimed. M1-3 builder details are finalized for strict REST batches and durable jobs; its exact base is frozen at dispatch. Worker/snapshot/SQL Server/UI work and all formal site acceptance remain pending.
M1-3 implementation started under Luna at exact base ca32853e931ff8e0c2fdf147bd2e0c962ddf656c, after M1-2 review closure. API-015–018 and migration 007 are the active scope. No M1-3 completion/test result is claimed yet.


## M1-3 implementation checkpoint — 2026-10-24

API-015–018 and migration 007 are implemented. Source/test changes end at ab7cfe565766c60e4de5ac8cfa2b5ab7f2334db5; the independent review covers ca32853..90ce1940. The retained current-source capture at actual runner HEAD eb47494f records typecheck exit 0, 18 test files / 288 passed tests, and build exit 0, with unchanged source manifests. Historical missing raw logs remain NOT_RETAINED. See [Task3 implementation report](m1-task-3-report.md). GPT-6.1 Sol review has been dispatched; no review approval is claimed. M1-4 preflight is prepared but implementation has not started. M1 overall is incomplete, and all 48 formal acceptance rows remain NOT_RUN.

## M1-3 repair review closed — 2026-10-24

User-selected GPT-6 Sol repaired R1–R5 in ccab1a0; GPT-6.1 Sol [scoped re-review](reviews/m1-task-3-rereview-1.md) confirms all five ADDRESSED, Spec PASS / Quality Approved, without new material defects in the repair diff. Post-fix focused verification is 3 files / 33 tests plus typecheck/build exit 0. The pre-fix 288-test result is retained separately. Original distinct assurance gaps remain for M1 integration/final review. M1-4 has not started coding; formal site acceptance remains NOT_RUN.

## M1-4 local implementation and source-finding review closed — 2026-10-24

Durable Worker source 2189ad7 implemented job leases, fenced processing/ACK, atomic canonical and item outcomes, bounded retries and crash recovery. The initial full-suite gate passed 19 files / 312 tests. Independent review found three defects; source 7ea2e94 repairs populated 007-to-008 upgrade, failure-relative retry delay, and 1–256 source-ID integration. [Scoped re-review](reviews/m1-task-4-rereview-1.md) confirms all three ADDRESSED, Spec PASS / Quality Approved. Post-fix evidence is 5 focused tests plus typecheck/build exit 0; no post-fix full-suite execution is claimed. [Implementation report](m1-task-4-report.md).

Migration 008 is frozen at SHA-256 4fcd01d104945a16102034b906d8df5423bbc325f08b6105106b0383f5cd370a; migrations 001–007 remain unchanged. Snapshot/recovery work is M1-5 migration 009 and has not started. The original five worker assurance gaps and earlier Task3 limits remain for M1 integration/final review. Fix1 source binding uses a post-gate/pre-commit snapshot matched to the commit, with no independent pre-gate snapshot. Formal 48-row site acceptance remains NOT_RUN; M1 overall remains incomplete.

## M1-5B independent review active — 2026-10-25

Snapshot extraction/staging source is committed at 0e7d4bf2, followed by strict worker acceptance-test refinement 7e2cc26e; reports and explicit evidence package are committed at 8d9f1dca. Retained checks show 93 focused tests, 30 REST regressions, typecheck/build exit 0 on the earlier source, followed by strict-loop restart case and 21 snapshot-run tests on the acceptance-only follow-up. Root checked all 134 manifest entries with zero hash/size mismatches. Independent GPT-6.1 Sol Spec/Quality review is active; B approval is pending. C/D/E and whole-phase verification remain. Formal 48-case site acceptance remains NOT_RUN.


## M1-5B local repair review closed — 2026-10-27

Original R1–R5 are closed by Fix1 source e7856336; the new source-local schedule isolation defect N1 is closed by Fix2 source 8e6f1cfc. GPT-6.1 Sol [scoped re-review](reviews/m1-task-5b-rereview-2.md) records Spec Pass / Quality Approve with no new material breakage. Fix1 passed 28 focused tests plus typecheck/build; Fix2 passed its RED/GREEN regression (1 passed, 22 skipped on GREEN) plus typecheck/build. These are distinct gates, not a new full-suite run. Root verified both 51-artifact packages without hash/size mismatches; all five created repair fixtures have removal/absence records. The initial Docker outage created no container ID and remains recorded separately.

B ends at EXTRACTED/VALIDATING. C-owned page membership, semantic validation/application, deletion reconciliation, manual recovery/cutover, integrated M1-5 tests and whole-phase review remain pending. Migration 009 remains unreleased and phase-owned; 001–008 remain unchanged. Production DNS/TLS/egress and site integration are unverified; all 48 formal cases remain NOT_RUN. [Implementation and repair history](m1-task-5b-report.md).


## M1-5C local implementation and repair review closed — 2026-10-28

C implements complete-stage integrity/semantic validation, snapshot observation allocation and safe reuse, atomic customer/order aggregate application, continuation leases/retry, and checkpoint recovery. API-013 provides exact-Owner source-key discovery; API-014 remains the sole mapping confirmation. First load follows customer-only apply, Owner mapping confirmation, then approved combined customer/order snapshot.

Initial source b32b7469 passed historical 65 C/B/API tests and 11 connector tests. Independent review identified R1–R10; repairs 2ad5d36f and e46a938e close those and new F1. GPT-6.1 Sol [final scoped review](reviews/m1-task-5c-rereview-2.md) records Spec Pass / Quality Approved. Latest repair gate passed 24/24 snapshot-run tests, typecheck and build; earlier counts remain distinct source gates. Actual owned Node processes were killed before and after COMMIT with changed business data; recovery verifies canonical state, source receipt, append-only outbox, outcome, exact range and checkpoint together, preserving observation and avoiding source reconnection. [Implementation and repair history](m1-task-5c-report.md).

Root verified 107 Fix2 artifacts and the corrected 200-artifact Fix1 package without hash/size mismatches. Reviewer verified all 24 latest captured source records against product blobs/raw bytes. Earlier child trailing-blank-line capture discrepancy is explicitly qualified, with original hashes preserved. Migrations 001–008 are unchanged; 009 remains unreleased and owned by the full M1-5 phase.

D absence reconciliation/Owner approval, E manual recovery/cutover, integrated M1-5 verification and whole-phase review remain pending. Full DB permission-matrix assurance remains limited. Real upstream/Hermes/site integration and formal 48-case acceptance remain NOT_RUN; C approval is local engineering completion.

## M1-5D1 implementation awaiting independent review — 2026-10-28

D1 source `68bfa362` adds durable complete-run consumption, per-entity absence candidates and exact 5% threshold control, source-wide policy pause, and admission/activation reservation guards. Fresh local gates passed 26/26 snapshot tests, typecheck and build. Root verified 137 evidence artifacts and 21 before/after source-manifest pairs with no mismatches. Historical capture shortcomings are qualified in the [D1 report](m1-task-5d1-report.md); corrected captures supersede them. GPT-6.1 Sol independent Spec/Quality review is pending.

D2 Owner review/approval and D3 logical deletion have not started. Migration 009 remains phase-owned; formal site acceptance and real upstream/Hermes integration remain NOT_RUN.

### D1 first review repairs in progress

Independent review records five Important defects in scope initialization, delete-contract eligibility, bounded worker fairness, superseded capability-test proof, and stale AWAITING_OWNER handling. Luna is implementing focused repairs; D1 is not approved. D2/D3 coding remains gated on that approval.

### D1 review closed; D2 next

Source `634e0c84` closes all five D1 findings. GPT-6.1 Sol [scoped rereview](reviews/m1-task-5d1-rereview-1.md) records Spec PASS / Quality Approved with no new material defects. Final gates passed 26/26 snapshot tests, typecheck/build; 29 repair artifacts and all 21 source-manifest pairs verified. Earlier assurance limits remain explicit. D2 Owner candidate review and exact approval is next; D3 logical effects and E remain pending.

## M1-5D2 implementation under independent review — 2026-10-28

D2 source `0871e857` adds safe API-021 candidate summaries and exact-Owner member paging, plus API-060 immutable exact-set approval, audit and idempotency. It also adds freeze-time full baseline fingerprints and selective reservation guards. Latest local gates passed 26/26 snapshot tests, typecheck/build; the full file includes populated 001–008 upgrade and identical009 reapply. Root checked all 39 packaged artifacts and 18 source-manifest pairs without mismatch. Independent Sol review is pending. [D2 report](m1-task-5d2-report.md) records the two-member pagination limit and local-only scope.

D3 logical deletion and recovery remain unimplemented; D2 API approval performs no business deletion. E and integrated whole-phase verification remain pending.

### D2 repair review closed; D3 next

Source `23cac1b6` closes all three D2 findings. GPT-6.1 Sol [scoped rereview](reviews/m1-task-5d2-rereview-1.md) records Spec PASS / Quality Approved. Final gates: 26/26 snapshot tests, typecheck/build; 62 repair artifacts and all 12 final source-manifest pairs verified. API-021 long-key cursor roundtrip, empty summary and shared digest authority are corrected. The documented larger-page and existing maximum-source admission limits remain whole-phase assurance gaps.

D3 is next: worker logical tombstones, immutable per-member effect receipts, current-approval enforcement and process crash recovery. No D3 effects have been implemented at this checkpoint. E remains outside this request.
