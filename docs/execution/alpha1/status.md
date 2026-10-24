# Alpha.1 execution status

Updated 2026-10-24. E:/git/dgo-hub, feat/alpha1-implementation. M0 Tasks0/1/2 passed local GPT-6.1 Sol Spec/Quality review. The [Task4 initial review](reviews/m0-task-4-review.md) confirmed the carried Task3 I1 correction and found three Task4 evidence/probe issues. At the user's request, GPT-6.1 Sol corrected these in source `f9ede840` and evidence `73d9ce92`; independent scoped re-review is in progress. No Task4 gate approval or product release is asserted.

## Current readiness

- Final local checks: typecheck/test/build each exited 0; 12 test files and 191 tests passed. The recorder started at `9724f627` with Task4 changes present; identical pre/post byte manifests identify the code subsequently committed at `135b7f1`. See [Task4 report](m0-task-4-report.md).
- Fresh PostgreSQL initialization applied migrations 001–004; 27 real runtime role checks passed. Local TLS, network isolation, five MCP tools, closed-gate auditing, and distinct-credential revocation have retained probe evidence.
- Fix1 verification: all 114 original raw logs are now durably tracked with unchanged hashes; focused probe tests passed 2/2. Correct-host TLS and classified certificate negatives passed; ten exact direct addresses were live from the allowed side before/after and denied from sales. These are fix-specific results, distinct from the earlier 191-test record.
- Next local step: independent Task4 scoped re-review, followed by Task5 evidence consolidation and M1 detailed handoff. M1 local implementation can begin after engineering review/closure; formal site acceptance remains blocked.
- Owned Docker resources were confirmed removed. Seven generated host secret/certificate/env paths remain after policy rejected deletion; the Task4 report lists them. They are excluded from tracked evidence and Docker context. Do not retry cleanup or include them in archives.

## W0 disposition

| Work | Implementation / review | Product acceptance |
|---|---|---|
| Tasks0–4 | implemented; individual spec/quality reviews approved | NOT_RUN/BLOCKED |
| Final fix wave | local Windows85, Linux31+1skip; I1/I2/I4/M1/M2 addressed | NOT_RUN/BLOCKED |
| W0-R1 | Important trim-normalization bypass; Task0 correction independently confirmed ADDRESSED by Sol | no product claim |
| W0-R2 | evidence-scope wording corrected; compiled anchor uses review memory probe evidence | no product claim |

See [W0 handoff](w0-closure.md), [scoped review](reviews/w0-final-fix-review.md), [final fix report](w0-final-fix-report.md), and [retained logs](w0-final-fix-evidence/). The carried W0-R1 engineering finding is now closed through the Task0 correction and independent Sol review.

## M0 local implementation

Six detailed tasks prepared: prerequisite/versions migration runner; identity and credential storage; OIDC/current-user APIs; strict MCP/source boundaries; independent deployment and rejection probes; evidence/M1 handoff. [Published plan](../../plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md) governs. [Task1 report](m0-task-1-report.md) and [scoped review](reviews/m0-task-1-rereview-1.md) close migration, cleanup and credential pagination findings. [Task2 report](m0-task-2-report.md) records initial168 full tests and14 fix-focused tests at their respective source versions; its [scoped review](reviews/m0-task-2-rereview-1.md) approves OIDC/current-user APIs after request-ID/logging fixes. [Task3 report](m0-task-3-report.md) separates the original185 full tests from20 fix-focused tests. Its [scoped review](reviews/m0-task-3-rereview-1.md) leaves I1 open; Task4 carries it as the first prerequisite, then implements isolated deployment and least privilege. No M0 behavior is called verified merely because its plan exists.

## Product gate

- M0–M6 formal acceptance remains BLOCKED/NOT_RUN; all48 required A/N/FI rows remain NOT_RUN.
- Site IdP/config/bindings, source contracts/approved real input, authority records, observed eight-component lock and Golden Consumer are unavailable. Local engineering proceeds under user authorization.
- Hermes Agent v0.22.1 is user-reported installed on another machine; installed build/Profile/handshake/tool names and authorized answers remain unobserved. [Compatibility assumptions](../../../integration-service/docs/hermes-v0.22.1-compatibility.md).
- Earlier example entry, synthetic release lock and local_check Gate runs all returned BLOCKED/exit2; source identities and inputs remain as recorded in [Task4 report](w0-task-4-report.md). No replacement site materials were invented.
- Artificial release-shaped fixtures exercise validator branches only. Source pins are anchored outside bundle. W0-R1 trim behavior is confirmed ADDRESSED; neither artificial PASS nor unit count proves product acceptance.
- Existing backlog remains assigned: trusted auth M0; source/version/ETL M1; relationship/deletion/query/publish recovery M2; metadata/ontology M3; real Hermes M4; UI/workflow M5; evidence/recovery/release M6.

[API/page gap matrix](../../../integration-service/contracts/api-gap-matrix.md) retains59 APIs/12 pages/48 acceptance IDs; [implementation baseline](../../../integration-service/docs/implementation-baseline.md) and [upstream assumptions](../../../integration-service/docs/upstream-api-assumptions.md) retain static-vs-runtime boundaries.
