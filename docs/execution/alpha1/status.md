# Alpha.1 execution status

Updated 2026-10-24. E:/git/dgo-hub, `feat/alpha1-implementation`. M0 Tasks0–4 have passed their individual local engineering Spec/Quality reviews. The [Task4 initial review](reviews/m0-task-4-review.md) confirmed the carried Task3 I1 correction. The Task4 fix source `f9ede840` and evidence `73d9ce92` close I1/I2/I3; the [independent scoped re-review](reviews/m0-task-4-rereview-1.md) marks all three ADDRESSED with Spec PASS / Quality PASS. The whole-M0 review at `caf026a7` passed local runtime/identity/isolation and required one Task5 docs correction wave for M0-F-I1/I2/M1. Corrected rules, M1 plan links, and documentation checks are recorded in the [Task5 report](m0-task-5-report.md); [scoped Sol re-review](reviews/m0-final-rereview.md) now marks all three findings ADDRESSED and Task5 Spec/Quality plus M0 local engineering closure PASS. No product release, formal M0 completion, or site readiness is asserted.

## Current readiness

- Final local checks: reused the Task4 fixed run after verifying all six current `integration-service` runtime/test/migration entries match its manifest (0/6 mismatches). The record is runner exit 0, typecheck/test/build exit 0, 12 files / 191 tests; its recorded HEAD `9724f627` is only the recorder base. The run's captured dirty source bytes were later committed as `135b7f1`; the report preserves the full 24-file source manifest. Task4 fix1 probe changes have separate focused/live evidence and did not change these six runtime files. See [Task4 report](m0-task-4-report.md) and [Task5 report](m0-task-5-report.md).
- Fresh PostgreSQL initialization applied migrations 001–004; 27 real runtime role checks passed. Local TLS, network isolation, five MCP tools, closed-gate auditing, and distinct-credential revocation have retained probe evidence.
- Fix1 verification: all 114 original raw logs are now durably tracked with unchanged hashes; focused probe tests passed 2/2. Correct-host TLS and classified certificate negatives passed; ten exact direct addresses were live from the allowed side before/after and denied from sales. These are fix-specific results, distinct from the earlier 191-test record.
- Next step: sequential local M1-1 Source Registry, mappings, and source authorization implementation, followed by independent Sol review. The controller freezes the exact post-closure Git base at dispatch. Formal site acceptance remains blocked.
- Owned Docker resources were confirmed removed. Seven generated host secret/certificate/env paths remain after policy rejected deletion; the Task4 report lists them. They are excluded from tracked evidence and Docker context. Do not retry cleanup or include them in archives.

## M1 implementation in progress

M1-1 source code is committed at `24f2af62`, with initial evidence at `7866b99f`. Its initial full checks passed 210 tests, typecheck and build, but the [independent review](reviews/m1-task-1-review.md) found nine runtime/contract/evidence issues. The original Luna implementer is correcting all nine in fix round 1; M1-1 is not approved and M1-2 coding has not started. New focused fix results remain separate from the original 210-test record. M1-2 has an immutable-baseline planning brief only and must refresh the reviewed M1-1 seams before dispatch.

## W0 disposition

| Work | Implementation / review | Product acceptance |
|---|---|---|
| Tasks0–4 | implemented; individual spec/quality reviews approved | NOT_RUN/BLOCKED |
| Final fix wave | local Windows85, Linux31+1skip; I1/I2/I4/M1/M2 addressed | NOT_RUN/BLOCKED |
| W0-R1 | Important trim-normalization bypass; Task0 correction independently confirmed ADDRESSED by Sol | no product claim |
| W0-R2 | evidence-scope wording corrected; compiled anchor uses review memory probe evidence | no product claim |

See [W0 handoff](w0-closure.md), [scoped review](reviews/w0-final-fix-review.md), [final fix report](w0-final-fix-report.md), and [retained logs](w0-final-fix-evidence/). The carried W0-R1 engineering finding is now closed through the Task0 correction and independent Sol review.

## M0 local implementation

The six-task M0 plan is implemented task-by-task: migration runner; identity/credentials; OIDC/current-user APIs; strict MCP boundary; isolated deployment/probes; evidence handoff. The [published plan](../../plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md) and [Task5 report](m0-task-5-report.md) record each source identity and test record separately. Task1's 149-test initial full run and 54-test focused correction run, Task2's 168-test initial full run and 14-test focused correction, Task3's 185-test initial full run and 20-test focused correction, and Task4's dirty-source 191-test final run are not blended as if they tested one SHA. Task4 fix1 has separate 2-test focused and live evidence. Task5 reuse verification checked the six current `integration-service` files in the old 24-file manifest and found zero mismatches; it does not relabel the recorded base HEAD as the full source identity. Task4's scoped re-review closes its three findings. Whole-M0 review at `caf026a7` passed local runtime/identity/isolation and found two material M1 plan rules plus one reference correction; the combined Task5 docs-only fix is complete and its scoped re-review is pending. No site acceptance is inferred.

## Product gate

- M0–M6 formal acceptance remains BLOCKED/NOT_RUN; all 48 required A/N/FI rows remain NOT_RUN.
- Site IdP/config/bindings, source contracts/approved real input, authority records, observed eight-component lock and Golden Consumer are unavailable. Local engineering proceeds under user authorization.
- Hermes Agent v0.22.1 is user-reported installed on another machine; installed build/Profile/handshake/tool names and authorized answers remain unobserved. [Compatibility assumptions](../../../integration-service/docs/hermes-v0.22.1-compatibility.md).
- Task5 re-ran the site-kind entry check using the tracked signoff/environment examples, release-lock validation using the tracked synthetic lock/pins, and the release Gate against the existing fixed local-check run. All three returned BLOCKED/exit2 with the missing real approvals, observed deployment values, and seven formal evidence inputs listed verbatim in the [Task5 report](m0-task-5-report.md); no site materials were invented.
- Artificial release-shaped fixtures exercise validator branches only. Source pins are anchored outside bundle. W0-R1 trim behavior is confirmed ADDRESSED; neither artificial PASS nor unit count proves product acceptance.
- Existing backlog remains assigned: trusted auth M0; source/version/ETL M1; relationship/deletion/query/publish recovery M2; metadata/ontology M3; real Hermes M4; UI/workflow M5; evidence/recovery/release M6.

[API/page gap matrix](../../../integration-service/contracts/api-gap-matrix.md) retains the original 59 APIs, 12 pages, and 48 acceptance IDs, plus the one explicitly planned M1 extension API-060; [implementation baseline](../../../integration-service/docs/implementation-baseline.md) and [upstream assumptions](../../../integration-service/docs/upstream-api-assumptions.md) retain static-vs-runtime boundaries. The [M1 detailed implementation plan](../../plans/2026-10-24-alpha1-m1-source-ingestion-implementation-plan.md) and first builder brief are prepared; M1 code has not started.
