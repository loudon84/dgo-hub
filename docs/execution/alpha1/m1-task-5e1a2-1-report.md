# M1-5E1a2-1 implementation report

## Pins and scope

- Task base: `ccbb312c8d1abd0b5fb6fe6b77ce543d809a65ff`.
- Accepted E1a1 implementation/interface: `55bc0ea1605952baa967ec81c6a4cc90564879c6`; accepted evidence pin: `023dde50e12e86da985ce494039113437caf54e4`.
- Product commit: `b7ca6b3a19577de42efd0dcb1fbed5202eb1063e` (`feat: add quarantine identity index and listing`).
- Implemented API-023 and its required immutable index, REST/snapshot live capture, backfill and documentation. API-024, retry/remap, pending/cutover, source-system writes, deploy, merge and push are outside this slice. Migrations 001–008 and the accepted prefix of 009 were not changed.

## Product result

`GET /hub/v1/admin/quarantine` is registered in the strict ingestion API with verified OIDC identity, current `source:read`, current exact Owner, strict query/cursor validation, six-digit UTC timestamp seeking, stable descending pagination, and safe metadata-only responses. Every page rechecks authority under the held security-barrier/source/auth locks. Current Owner metadata listing remains available when source admission is DRAFT/PAUSED or the source credential is disabled. The continuation context binds filters, page size, tenant/source, verified principal and current auth/Owner revisions; it is not an authorization token.

Migration 009's phase-owned additive suffix adds the private quarantine identity index, safe code filtering, complete tuple constraints and REST/snapshot capture/backfill. Snapshot capture occurs after the range insert and joins the already-inserted quarantined outcome, so an index failure rolls back outcome and range in the same transaction. REST item FKs bind event and source key; the snapshot outcome/range constraints bind both IDs and the full natural key/digests. Runtime roles have no direct index or payload/stage read grant; the API gets only the narrow definer loader. `mapping_revision` and `identity_mapping_revision` remain distinct. PostgreSQL bigint proof/context values stay canonical decimal strings, including values above 2^53. Unsafe or oversized stored error codes are omitted as NULL without changing the original.

The API gap matrix and product architecture document now describe API-023 as implemented locally and API-024 as still unimplemented. The schema/API contract is recorded at `.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/context/m1-task5e1a2-1-schema-contract.md`.

## Verification at the product commit

All three final gates ran with HEAD before and after equal to `b7ca6b3a19577de42efd0dcb1fbed5202eb1063e`. Their command records, stdout/stderr, source captures, build manifest and lifecycle records are copied under `E:\m1t5-runtime\aec30467-3f5c-42cd-a943-2e878d2a1858`. `package-manifest.json` records each original and copy SHA-256 and byte size; every copied pair was checked equal. Package manifest SHA-256: `3b01cf94aa9bd9ca930d1ac3ec02f471019948c9090c712a60f68a627873cd6e`.

| Gate | Command and working directory | Evidence root | Result |
|---|---|---|---|
| Build | `npm run build` — `E:\git\dgo-hub\integration-service` | `E:\m1t5-runtime\4796b285-5d88-407f-b298-0b8a9ec51646` | exit 0; TypeScript build completed. Persisted manifest SHA-256 `b029c5fed470733fc940ca6585286ad4abf6f1b01a84fc5adc67ba14524dbe7b`. |
| Typecheck | `npm run typecheck` — `E:\git\dgo-hub\integration-service` | `E:\m1t5-runtime\f1dbcefc-3d4f-480d-a9a3-b0635a7791f3` | exit 0. |
| Focused acceptance | `npm run test -- acceptance-tests/quarantine-read.test.ts --reporter=dot` — `E:\git\dgo-hub\integration-service` | `E:\m1t5-runtime\a41b1869-d962-4351-86ab-86b5c263fb8f` | exit 0; 1 file, 17/17 tests passed. Pretest build manifest was persisted before the run and its SHA-256 matched the successful build manifest above. |

The 17 checks cover the exact bigint representation boundary; both upgrade/backfill paths; Owner reads on a non-admitting source; real REST and C worker capture; same-source 24-origin paging, microsecond ties and parentless snapshot sentinel; maximum page size, filters and stale cursor context; runtime role grants and payload exclusion; full tuple mismatch and same-transaction capture rollback; malformed query forms; exact Owner and current authority changes; unsafe stored error-code omission; and runner checksum reentry. Real REST capture used the ordinary REST worker. Real C capture used the ordinary C worker: after the first customer committed, the existing after-aggregate-commit hook called the current-owner identity-map service to remap the shared dependency from valid Owner A to valid Owner B in the same department; the second customer's still-valid frozen proof was naturally classified `AUTHORITY_MAPPING_SUPERSEDED`, and its real outcome/range trigger populated the index. No worker guard or production classification was changed. Other snapshot paging origins are explicitly schema-seeded historical backfill fixtures, not claimed as worker outcomes.

The focused test invokes the application/worker functions in-process under Vitest; it does not launch a Node child that loads `dist`. Therefore a child-loaded build hash is **N/A**. This gate uses the persisted pretest build manifest as the build identity instead.

## Upgrade evidence distinctions

- **REST facts pre-009:** a valid quarantined REST item was populated after migrations 001–008 and before the complete final 009. The full final 009 was run through the unchanged migration runner and backfilled that item. Fixture: job `0622c21e-b1b0-4072-8641-13c6ff153360`, event `42f841d0-b36b-4e5e-9223-9d0d56eefeb2`, source key `PRE009-REST-C-1`, resulting quarantine ID `68e20d3d-7f1d-4135-8acd-6e027880a879`. Full final 009 raw SHA-256 `824f12e74c9e5f3a2bca91c25b3d4bb5631bfeedb084c4c8ebeba7c656598db1`, 274351 bytes; LF SHA-256 `eb83fc993dc1b0a5d3c1d089b1ba225d9f9867e0a67fd403aadab3eb31d8bc6f`, 274347 bytes; Git blob `a9f9785aec7fccc0986de4d52525297ec894cd31`.
- **Snapshot facts pre-index:** snapshot facts were created on the accepted full 009 schema at E1a1 commit `55bc0ea1605952baa967ec81c6a4cc90564879c6`, before the API-023 additive index suffix. Baseline SQL raw/LF SHA-256 `0dc88c4348967e58e42d3539ae06eca5eb16190cf6df0637b7495f5f43f286b9`, 257503 bytes, Git blob `b7b3d6963f08abaafda21cfd2e11daa60bcc3112`. The additive suffix raw/LF SHA-256 is `095c52cf13ef92a4052fabf6f8eb8d2a5dcbf841d68494a9f634c922c6bd98a8`, 16843 bytes, Git blob `50dd03ef9727c405275a564e0b32839bae098a49`. Backfill and identical suffix reapply retained the same outcome `ec357390-2879-4e06-9cee-928ae1672b21` and unchanged source facts.
- **Runner reentry:** the populated-008 REST fixture re-invoked the unchanged runner with the byte-identical final 009 checksum; the runner skipped 009 and source facts/index IDs remained stable. The accepted full 009 has pre-existing plain non-idempotent DDL. Direct raw full-SQL re-execution is unsupported and was not run or reported as passed. Snapshot suffix replay is reported separately above; it is not a full 009 replay.

The fixture pin records are in `E:\m1t5-runtime\aec30467-3f5c-42cd-a943-2e878d2a1858\migration-fixtures-final-gate\` and duplicated from their original final-gate files with hashes in the package manifest. Focused test source captures (`before-sources.json`, `after-sources.json`) pin the tested files; stdout, stderr, gate metadata and pretest manifest are retained alongside them.

## PostgreSQL resource lifecycle

Each owned PostgreSQL container used by the final focused run used pinned image `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`; observed repo digest and runtime image ID matched. Each record shows exact ownership confirmed, removal and later absence. Lifecycle files are included separately under the evidence package.

| Fixture | Run UUID/label | Container ID | Lifecycle result |
|---|---|---|---|
| Snapshot pre-index migration fixture | `fa4d22fb-d1e2-4313-b08b-cd5059e66033` | `b6e983cf321ee0ec144d5ebaf8bd01fb503a4297ba27ef7163be1c82011edaec` | removed; absent after removal |
| Populated-008, pre-009 REST fixture | `a0783f46-20d8-44fc-a55d-809ab9817fc5` | `c2e8743b5c616922667952766d2371e5834b126e16f45feb2510ca49082ac0c5` | removed; absent after removal |
| Main 17-case acceptance fixture | `d2bf0962-82ad-490f-8eb6-80162749c5c4` | `beab8fe09201b68298b8bd49ce59df8b6ec179076e7e4d60f7bb5d88e43babdd` | removed; absent after removal |
| Initial valid-current-Owner missing-route RED fixture | `a294ac60-1ecd-40a4-93c9-defb52797a09` | `ccb61a3bf5a6e553e739ece34475ffec568531ff1049f3dffb758564ea709861` | removed; absent after removal |

No application Node child was started. The separate red check is qualified: at base HEAD it obtained a real valid-current-Owner authenticated 404 for the missing route (expected feature RED); it did not establish final behavior and is not counted as a passing implementation gate. Formal 48-hour observation and site gate: **NOT RUN**.

## Commits and remaining work

Product/source/test/docs/schema contract are in product commit `b7ca6b3a19577de42efd0dcb1fbed5202eb1063e`. This report and the identical execution copy are committed separately as the evidence/report commit. Root-owned progress and brief files remain outside these commits. No independent review, merge, push or deployment is claimed here.
