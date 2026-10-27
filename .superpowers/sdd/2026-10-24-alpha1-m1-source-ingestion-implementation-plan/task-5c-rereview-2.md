# M1-5C Fixround 2 independent re-review

**Spec compliance: Pass.**

**Quality: Approved.**

Scope: the remaining C5C-R4, C5C-F1, G1 and E1 items from Fixround 1, and material regressions introduced by their fixes. The other nine original findings retain their prior addressed dispositions. This is C task approval within the accepted brief; it does not complete D/E or the whole M1-5 gate.

Review BASE: `2d4770762c2f63b5d878c471ae1ca9d078e4eb52`. Supplied review HEAD: `96afe89a3487fb37bcde9a30d9e8483c77680729`. Product/test commit: `e46a938ee10c0764c6899eef329af1b02cccfc10`, parent `a5d6ea0ec3578526c25d16c5ff5ae6b9d2fd8bca`. The complete 415-line `context/task-5c-fix2-review-package.txt` and appended Fixround 2 report were read. Current HEAD observed during read-only checks was `9ce7a8786ae85a02e7f195e4491067d25fe9e5ef`; actual captured source blobs, current raw bytes and sizes were checked against the stated product commit, with no product drift.

No required findings remain in this scoped diff. No suites, compiler commands, databases or child processes were rerun by this reviewer. No product, Git, index or HEAD mutations were made; this report is the only reviewer write.

## Dispositions

| Item | Disposition | Reviewed evidence |
| --- | --- | --- |
| **C5C-R4 — NULL business role** | **ADDRESSED** | `integration-service/migrations/009_snapshot_runs_and_recovery.sql:965` uses `business_role IS DISTINCT FROM 'sales'`, so NULL now rejects explicitly. The regression at `integration-service/acceptance-tests/snapshot-runs.test.ts:595` supplies an enabled mapped subject with NULL role and matching department, and checks FAILED with zero seals, observations, outcomes, ranges and checkpoints, unchanged canonical customer/receipt version and unchanged outbox count. The existing missing-identity batch case remains present. |
| **C5C-F1 — heartbeat transient error** | **ADDRESSED** | `integration-service/etl-worker/snapshot-apply-worker.ts:174` preserves the original exception and returns one shared in-flight renewal; lines 180–183 retain/rethrow that exception, and line 191 passes it to the existing retry classifier at the next effect boundary. An authoritative false claim remains a lost-lease result. The owned real heartbeat-backend termination case begins at `integration-service/acceptance-tests/snapshot-runs.test.ts:628`: C1 is APPLIED first; the actual driver error is preserved; the live run remains APPLYING/active, token clears, a positive DB-clock retry delay of at most five seconds is persisted, and the next start completes with the same observation and exact committed C1 attempt/outcome/digest/outbox identity. Outbox cardinality increases once and no source connection is opened for recovery. The existing expired-token failure fence remains unchanged. |
| **G1 — changed-data process crash atomicity** | **ADDRESSED** | `integration-service/acceptance-tests/snapshot-runs.test.ts:902` changes C1's business value and source timestamp separately for each child case. The IPC boundary, SIGKILL and exit-signal checks remain real. Assertions at lines 958–983 and 1001–1035 now inspect canonical value/time, exact source receipt/version/digest, ordered outbox rows/cardinality, APPLIED outcome, exact range identity/digest, checkpoint, immutable attempt/manifest and bound observation across restart. Details below. |
| **E1 — historical child source binding** | **ADDRESSED** | The two report copies' Fixround 1 text and the old evidence `commit-binding.json:6` explicitly distinguish six byte-exact captures from the 1804-byte captured child versus 1803-byte committed child, including both original hashes/blobs and the sole terminal blank-line difference. Historical source manifests remain unchanged. New Fixround 2 child captures bind the actual 1803-byte committed file exactly. |

C5C-R1, R2, R3 and R5–R10 retain their **ADDRESSED** dispositions from the preceding re-review. The Fixround 2 product diff changes only the NULL-safe predicate and heartbeat error handling, plus focused acceptance tests. No new material regression was found in those changes.

## G1 checks

The reviewer read the actual assertions and retained final lifecycle, independently of the implementation summary:

- **Before COMMIT:** owned child PID **39324** reached the aggregate hook and was SIGKILLed. Canonical business state, receipt and ordered outbox state equal the pre-state; C1 has no outcome/range/checkpoint effect. Restart applies changed C1 once, preserves the bound observation **11** and immutable attempt/manifest, finishes all three ranges, and opens no new source connection.
- **After COMMIT:** owned child PID **27708** was SIGKILLed after COMMIT. The new C1 value/source time, receipt version, one additional outbox row, APPLIED outcome, matching range and checkpoint are present together before restart. Digests agree across receipt/range/outbox. Restart preserves the exact committed C1 range/outcome and outbox rows while completing the remaining aggregates, retains observation **12**, and opens no new source connection.
- The append-only outbox oracle is correct: existing ordered rows remain an unchanged prefix, exactly one new matching row is appended, and its ID increases. The before-COMMIT test allows an abandoned sequence allocation to leave a gap; it does not demand reuse of a rolled-back event ID. After-COMMIT recovery asserts the complete outbox row set is unchanged.
- Final customer checkpoint is C2/count 2 and total outcomes/ranges are 3. C1's APPLIED status proves these are changed-data cases rather than the earlier duplicate-only exercise.

The child executable remains the previously reviewed owned worker fixture. New captured child bytes match its committed blob exactly. PostgreSQL backend termination and Node process SIGKILL remain correctly described as distinct tests.

## Evidence verification

The following final command/stdout/stderr/exit captures were independently read from `docs/execution/alpha1/m1-task-5c-evidence/66be77ca-455f-48ab-973c-1558dcf0a158/`:

| Gate | Result |
| --- | --- |
| `24f5c09d-c0c5-4b07-a4cb-f13cdf08f117`: `npm test -- acceptance-tests/snapshot-runs.test.ts --testTimeout=180000` | **1 file, 24/24 passed; exit 0** |
| `8f0f14a0-eea7-41ca-82d9-863371e65684`: `npm run typecheck` | **exit 0** |
| `6f5d8dbe-6559-48c5-bb54-edb0a8d42d58`: `npm run build` | **exit 0** |

All three final stderr files are empty. Before/after manifests retain actual test-time HEAD `a5d6ea0ec3578526c25d16c5ff5ae6b9d2fd8bca`; their four selected source-item records are equal across each gate. The reviewer compared **all 24 actual captured records** (not just binding booleans) against product-commit Git blobs, current raw SHA-256 and byte sizes: **zero mismatches**. This includes the child fixture, SHA-256 `3cf0063eb6016fb8c0a08a6c3f295d97bc817b45b82dbecb9efa46a639ce9ce3`, blob `84f0b638a8d1c3f71145d793c11c7ea462866d75`, 1803 bytes.

For E1, the reviewer separately recomputed the old final-main source-before/source-after file hashes and confirmed they remain `e563661038ddf16158fddde3f2d622250794fc892c67434b6caecce750409ba6` and `78c4b5022cac911d2cd77a7c3ca2e87fb77c1ef0dfbac377eeaf2062f331b494`, respectively. The corrected binding note preserves the historical captured child SHA `6a82b1091509bd19017f63911523af8a6b4ee073c5b8c9aba45de87d199dca0b`/blob `d7815bf553b4427a86270435ffe4fa386b624fff`; it does not relabel that capture as the committed child.

Both implementation report copies were independently hashed and are identical: SHA-256 `13f1eaa30e773d1813285af0baffe6c295e08773d3bd402ec302e70e4a7e2c94`. Controller supplied the complete new 107-artifact and revised old 200-artifact SHA/size checks with zero mismatches; those entire package audits were not redundantly rerun by the reviewer. No retained failed/diagnostic capture or historical 65/11 result was relabeled as the latest Fixround 2 gate.

## Assurance boundary

This closes the independently identified C findings and required G1 acceptance within the scoped implementation. The full DB permission matrix, formal 48-case acceptance and whole M1-5 integration/review remain separate outstanding gates. No live upstream, production, deployment, query-gate, UI, D or E acceptance is inferred. No additional test rerun is requested for this scoped approval.
