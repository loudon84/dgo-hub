# Alpha.1 execution status

Updated 2026-10-23. E:/git/dgo-hub, feat/alpha1-implementation. Current execution: M0 Task1 local implementation is complete and awaiting GPT-6.1 Sol review. Task0 I1/I2 corrections are included in this Task1 work and await that same review before the Task0 gate can close. This status is local engineering progress, not product release.

## W0 disposition

| Work | Implementation / review | Product acceptance |
|---|---|---|
| Tasks0–4 | implemented; individual spec/quality reviews approved | NOT_RUN/BLOCKED |
| Final fix wave | local Windows85, Linux31+1skip; I1/I2/I4/M1/M2 addressed | NOT_RUN/BLOCKED |
| W0-R1 | Important trim-normalization bypass; Task0 correction independently confirmed ADDRESSED by Sol | ADDRESSED |
| W0-R2 | evidence-scope wording corrected; compiled anchor uses review memory probe evidence | no product claim |

See [W0 handoff](w0-closure.md), [scoped review](reviews/w0-final-fix-review.md), [final fix report](w0-final-fix-report.md), and [retained logs](w0-final-fix-evidence/). W0 is not described as all-approved while R1 remains open.

## M0 local implementation

Six detailed tasks prepared: prerequisite/versions migration runner; identity and credential storage; OIDC/current-user APIs; strict MCP/source boundaries; independent deployment and rejection probes; evidence/M1 handoff. [Published plan](../../plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md) governs. Task1 implementation and local verification are recorded in [Task1 report](m0-task-1-report.md); independent Sol review is pending. Task0 I1/I2 are corrected by commit `2549a13cb48c815cd5553c23a015e0946d561407` and remain open until the combined review. Task2/3 have not started. No M0 behavior is called verified merely because its plan exists.

## Product gate

- M0–M6 formal acceptance remains BLOCKED/NOT_RUN; all48 required A/N/FI rows remain NOT_RUN.
- Site IdP/config/bindings, source contracts/approved real input, authority records, observed eight-component lock and Golden Consumer are unavailable. Local engineering proceeds under user authorization.
- Hermes Agent v0.22.1 is user-reported installed on another machine; installed build/Profile/handshake/tool names and authorized answers remain unobserved. [Compatibility assumptions](../../../integration-service/docs/hermes-v0.22.1-compatibility.md).
- Earlier example entry, synthetic release lock and local_check Gate runs all returned BLOCKED/exit2; source identities and inputs remain as recorded in [Task4 report](w0-task-4-report.md). No replacement site materials were invented.
- Artificial release-shaped fixtures exercise validator branches only. Source pins are anchored outside bundle. W0-R1 trim behavior is confirmed ADDRESSED; neither artificial PASS nor unit count proves product acceptance.
- Existing backlog remains assigned: trusted auth M0; source/version/ETL M1; relationship/deletion/query/publish recovery M2; metadata/ontology M3; real Hermes M4; UI/workflow M5; evidence/recovery/release M6.

[API/page gap matrix](../../../integration-service/contracts/api-gap-matrix.md) retains59 APIs/12 pages/48 acceptance IDs; [implementation baseline](../../../integration-service/docs/implementation-baseline.md) and [upstream assumptions](../../../integration-service/docs/upstream-api-assumptions.md) retain static-vs-runtime boundaries.
