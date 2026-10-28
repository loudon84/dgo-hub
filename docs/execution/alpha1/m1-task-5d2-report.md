# M1-5D2 implementation report

Status: implemented and locally verified at product commit `0871e857fe00b866fdf9a8b51a19641ebfb11d33` (`Implement source delete candidate approval API`). The schema and function contract was recorded before product edits and committed with the source. Report and runtime evidence are kept separate from that commit.

## Implemented behavior

- Migration 009 freezes the ordered, full source-qualified baseline membership and UUID digest with each D1 candidate. The candidate digest includes this fingerprint; D2 recomputes it at approval. Reservation identity/proof facts allow the legal initial D1 bind/freeze/finalize transitions and become immutable after freeze.
- API-021 exposes a safe D summary and exact candidate members only to a current Owner with `source:read` and `source:approve`. Member keys include tenant, source, entity, and source primary key; canonical UUIDs are not returned. Pagination uses a strict candidate and full-key bound cursor.
- API-060 creates an immutable approval and audit record only. It rechecks the current Owner, scope, OIDC binding, database auth epoch, candidate digest, baseline membership, denominator, and current members under guard-first locks. Same-key/same-body replay returns the durable original approval; changed body conflicts. Audit failure rolls back approval and idempotency records.
- Approving a candidate does not change canonical customers/orders, receipts, or outbox records. Each above-threshold entity set has a separate approval. Approval does not release source busy state, unpause the source, or enable its schedule.
- Direct `hub_api` writes to approval/audit tables are denied. Approval and audit update/delete immutability triggers reject privileged DML.

## Verification

All commands below were run from `E:\git\dgo-hub\integration-service` with a fresh UUID evidence root and `M0_RUN_EVIDENCE_ROOT` set to that exact absolute root. Each gate captured its exact command, stdout, stderr, exit code, actual HEAD, and before/after source manifests containing raw and LF hashes, byte sizes, and Git blob IDs.

| Command | Result | Captured actual HEAD | Evidence root |
| --- | --- | --- | --- |
| `npm exec vitest run -- acceptance-tests/snapshot-runs.test.ts` | 26 passed, 0 skipped, exit 0 | `0871e857fe00b866fdf9a8b51a19641ebfb11d33` | `E:\m1t5-runtime\474a4e3c-df66-41d4-994f-cd0c67235271` |
| `npm exec vitest run -- acceptance-tests/snapshot-runs.test.ts -t "upgrades populated 001-008 registry facts through 009 and preserves every prior checksum"` | 1 passed, exit 0; populated 001–008 upgrade, assembled 009, and identical reapply | `7c8d815d81e015f1594c6990ee7853cc3ef7543c` (precommit) | `E:\m1t5-runtime\730b5e8a-c187-4f53-8f87-146264522371` |
| `npm exec vitest run -- acceptance-tests/snapshot-runs.test.ts -t "restarts after terminating its owned PostgreSQL reader and publishes a fresh full scan"` | 1 passed, exit 0 | `7c8d815d81e015f1594c6990ee7853cc3ef7543c` (precommit) | `E:\m1t5-runtime\bda6d1d5-a234-4b1e-82df-d589f5e35aae` |
| `npm run typecheck` | exit 0 | `0871e857fe00b866fdf9a8b51a19641ebfb11d33` | `E:\m1t5-runtime\1e9709ca-855c-4a5d-b2c2-f5c38f9ea1f2` |
| `npm run build` | exit 0 | `0871e857fe00b866fdf9a8b51a19641ebfb11d33` | `E:\m1t5-runtime\b265b52c-ad75-468d-b7ee-77422ac0ea4c` |

The 26 count is the existing file’s test count, not a count of internal assertions. Its D2 HTTP/API-role scenario verifies default-page request handling, explicit two-page cursor use, scope-bound cursor rejection, malformed/out-of-mode query rejection, limit 100 acceptance and 101 rejection, cross-source, cross-tenant, non-Owner, and missing-approval-scope denies. It verifies same-count live baseline substitution returns 409 without an approval; disabled and rebound OIDC identities cannot replay; the stored approval epoch equals the current database epoch; read-audit and approval-audit failures fail closed; direct API-role DML returns 42501; privileged approval/audit mutation returns 55000; two above-threshold entity candidates require separate approvals; source remains busy, paused, and unscheduled after each; and canonical/receipt/outbox counts match before and after approval.

The real API fixture has two customer candidate members. The default-limit HTTP path is exercised with no `limit`, and the implementation defaults it to 20, but this fixture does not prove truncation at 20 for a set larger than 20. The limit 100 path was accepted with those two members; large-set pagination pressure was not tested. Strict limit-1 cursor paging and cursor binding were exercised.

## Evidence and source binding

The final full-test `before.json` and `after.json` bind all six product-owned paths to actual HEAD `0871e857fe00b866fdf9a8b51a19641ebfb11d33`; manifests are identical across the gate. Exact per-file raw/LF SHA-256, byte size, and Git blob values are in those captured manifests and listed below. The reviewable evidence package is [m1-task-5d2-evidence/db42b6ea-751a-4379-bda9-b67da6d52c24](docs/execution/alpha1/m1-task-5d2-evidence/db42b6ea-751a-4379-bda9-b67da6d52c24/manifest.json); its explicit manifest has 39 whitelisted artifact copies, preserves each gate and original evidence-root path, records exact `M0_RUN_EVIDENCE_ROOT` and captured HEAD per gate, and has SHA-256 `e702f30efd294e5f83606190502c4fb8bc9513c513ad066c2df898ec9db601d9`. Each copied artifact was checked against the original path, byte count, and SHA-256. No recursive copy was used.

The committed source bindings in both final manifests are:

| Path | Bytes | Raw SHA-256 | LF SHA-256 | Git blob |
| --- | ---: | --- | --- | --- |
| `integration-service/acceptance-tests/snapshot-runs.test.ts` | 196022 | `c70e20bc891b9e9879fb99ed3cabcca59b791f44b5d55271b87d935a1a98f019` | same | `4b1c841f216d96e48bccb6e9b68a8ec69dd4f763` |
| `integration-service/etl-worker/snapshot-runs.ts` | 29801 | `894ff433d270d7e2d5ddf56464ff84f825602d4fa856c3b2bd79eb0082fbd806` | same | `a625ae853769330460f76b5d43483dc4ada0a5dc` |
| `integration-service/etl-worker/snapshot-delete-api.ts` | 3469 | `db0f31de4c2e217c958522c26558c56c37f811ca460125cbb3eb2d800703f908` | same | `1bf807f7471e0e5d8fa8d9efa8e69d899ab0c529` |
| `integration-service/ingestion-api/snapshot-routes.ts` | 8460 | `de288863b8b6d29574e359c8ee5c5a79606f62e65868e3ac96dd8010348eed61` | same | `7c7028db9632b00c43c2bd890f6e94a14737a85b` |
| `integration-service/migrations/009_snapshot_runs_and_recovery.sql` | 171386 | `d2d34ca473487fc303256f1fe7c1bb9659d7884d233f97f2dc049abd2bf2197a` | `42b3304e109460c205be25693fe0e86f2473ba6bc2a6e82f4e609b31cf81ee3f` | `6a174076e6e2629c66732c8882ad1f70b00964a7` |
| `.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/context/m1-task5d2-schema-contract.md` | 7576 | `3a6d612359b345352f18d504a510f1f412999a9d2de79dca62bdb95d953fa313` | `11231c4c9300d9bfefedd5ed44034bdd1fb6a5f8d5b693a216bb88a62074a7f0` | `d9c829a581b82322b98cef4d68671d711a20d5ec` |

The full-suite PostgreSQL lifecycle records identify three owned containers, all pinned to image `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`: run labels `7051a0ac-522f-47aa-a518-8c7b23ae3afb` / container `bddbf9fea5c0126c074279de804a48b759034b9b9349b315cb6c454682ebf59a`, `839d0e54-b9be-4acb-8028-6d5a55477b8f` / `0615b49ae7fdf6348d57c3abd058bc5d612addd209a1470f29c229ad92e268ec`, and `9354fe7b-f529-4ce1-9023-0495231ffe68` / `667b5f3b35f035e2ed094172825b59f3f28d4c81b5d6655e6e103c5e86c109db`. Each lifecycle record reports ownership confirmed and exact container absence after removal. The Node lifecycle file records only test-created continuation children, their labels/PIDs, termination, and recovery observations.

Earlier failed attempts remain preserved under their original external UUID roots, including migration SQLSTATE 42830 and native API SQL errors 42702, 42703, and 42P01; fixes were applied before the final green gates. The transient test-fixture C validation failure was traced to a scope update clearing the fixture Owner’s `sales-east` department and `sales` role; the fixture now preserves both while changing the auth epoch, and the full file passes.

Formal 48 gates, Sites, Hermes, and production/live-source verification are `NOT_RUN`. Testing used owned local PostgreSQL fixtures only. No production verification is claimed.
