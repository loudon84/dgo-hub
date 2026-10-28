# M1-5E1a1 API-022 implementation report

**Status: DONE_WITH_CONCERNS**
**Final source pin:** `a724c25fee95669bdeb2ceb9d88ec065cf0a4234`
**Product commits:** `fec4daa12e5c4fa47d9bf1e7bcbc96949cfe0b12` (API-022 implementation), `64e73023669375b0abc646a5c31d9a635db837b5` (two-line order recovery fixture and contract updates), `a724c25fee95669bdeb2ceb9d88ec065cf0a4234` (structured JSONB checkpoint assertion).

## Implemented

API-022 now accepts only a positive canonical PostgreSQL bigint string in `failed_version`, a `reason` of at most 1,000 Unicode code points, and an `Idempotency-Key`. It checks global security barriers before identity-row locking, then enforces current authority and current source lifecycle/security checks. A child run and its first response attempt ID are reserved immutably in the admission transaction; the first worker begin consumes that reserved attempt ID. Same-key replay returns the immutable saved result after current authorization/security checks.

Recovery creates a linked child run without rewriting the original run. `FRESH_SCAN` obtains a new complete snapshot proof from the source. `SEALED_STAGE` binds a new child manifest to the original manifest/semantic proof while preserving original source facts, ordering, decimal/text precision, observations, and receipts. Its copied proof references the original observation and does not allocate a child observation or a second absence reservation. Child progress uses exact live non-null claims and leases; original successful outcomes are skipped only through their matching durable receipts. The frozen design and SQL signatures are recorded in [m1-task5e1a1-schema-contract.md](.superpowers/sdd/2026-10-24-alpha1-m1-source-ingestion-implementation-plan/context/m1-task5e1a1-schema-contract.md).

The new owned PostgreSQL case covers a real `order` aggregate with two lines. Original O100 is applied with its two lines, receipt and outbox effect; O200 remains unapplied. API-022 creates a SEALED child with zero source connections. Continuation reuses O100 through its exact original outcome and applies O200 atomically with both lines and exact decimal text. The original manifest/facts/observation remain unchanged; the child has no new observation or D reservation. The recovery outbox retains the original prefix and adds only the new O200 effect.

Existing controlled customer recovery tests also cover a fresh complete child, actual owner-authorized HTTP, idempotency/concurrent admission, stale/wrong-parent conflicts, strict input bounds including bigint overflow and Unicode code points, role/grant separation, NULL/expired/old claim denial, ordinary source pause and revision/config/credential drift with frozen proof reuse, and retired-channel/typed barriers. The authenticated `hub_api` path admits requests; the worker-only proof loaders remain unavailable to that role.

Two actual Node worker processes were killed at the C-REC-2 aggregate boundary. The before-COMMIT run observed no new canonical identity/object, outcome, range, receipt, or outbox row and retained the C1 checkpoint. The after-COMMIT run observed all six records together and the C2 checkpoint; the expired claim was reclaimed and continuation completed. Captured child PIDs were `40740` (before) and `25100` (after), both with `SIGKILL`; test run ID `cb7df164-86ba-413a-bbf7-8eee82726fd6`.

Migration verification is within the focused PostgreSQL fixture: populated migrations 001–008 are installed, additive 009 is applied and reapplied, and application/worker grants are checked under actual roles. The pinned database image was `postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297`. The captured lifecycle identifies container `63c892196e9b6081e37f34cceb24b0eca0ce1c1406aed7d6e5e47aab37980353`, confirms its pinned image, records owned removal, and records absence after removal.

## Verification

All final gates ran after source pin `a724c25fee95669bdeb2ceb9d88ec065cf0a4234`, with `M0_RUN_EVIDENCE_ROOT` set to a fresh absolute `E:\m1t5-runtime\<UUID>` for each command. Each capture records cwd, command/arguments, exit code, actual HEAD, and before/after raw SHA-256, LF-normalized SHA-256, size, and Git blob for the same 14 explicit source/document paths. Each gate had identical before/after snapshots and the same HEAD.

| Command | Result | Capture |
|---|---|---|
| `npm.cmd --prefix integration-service run build` | Exit 0; `tsc -p tsconfig.json` | `E:\m1t5-runtime\2d38489d-1b00-4c77-9fe0-d23182dcfb29\final-build` |
| `npm.cmd --prefix integration-service run typecheck` | Exit 0; `tsc --noEmit -p tsconfig.json` | `E:\m1t5-runtime\0d334fbb-2a2f-4918-8ff1-72d843f38ad7\final-typecheck` |
| `npm.cmd --prefix integration-service test -- acceptance-tests/snapshot-recovery.test.ts` | Exit 0; 4 tests passed | `E:\m1t5-runtime\ef2d8618-ad0f-4b81-9bde-15b31261a8a4\final-snapshot-recovery` |

The focused suite’s earlier run at pin `64e7302` had 3 passing tests and one assertion failure because PostgreSQL `jsonb::text` property ordering/spacing differed. The assertion now compares parsed JSONB values, preserving exact text comparisons for source decimal/version/timestamp values. The final focused run at `a724c25` passed 4/4. The first genuine API-022 red was the expected HTTP 404 before route implementation (`e672d3f7-2dc5-44e3-a08a-9af6976bb3b5`, `api022-genuine-red`); preliminary fixture diagnostics are not counted as product RED evidence.

The source-level API gap matrix and existing product API table now record API-022 behavior. No generated OpenAPI document or separate error catalog exists in this repository; runtime errors remain mapped in `integration-service/auth/errors.ts`. No duplicate static schema was added.

## Evidence and scope limits

The raw command captures, lifecycle log, historical genuine 404 RED, intermediate JSONB assertion failure, and the PowerShell capture wrapper are copied to [evidence-manifest.json](docs/execution/alpha1/m1-task-5e1a1-evidence/b1f6295c-6bb2-4c46-b12b-b544d8c03a66/evidence-manifest.json). It lists each exact original-to-destination path and verifies original and copy byte lengths and SHA-256 values. Final captures bind the implementation to the source pin through 14 matching source records for each gate.

Not run: the broad formal 48-case suite, E1a2/API-023/API-024, formal site acceptance or a 48-hour claim, external/live source systems, external DNS/IdP/Hermes, deployment, merge, push, or real cutover. The test evidence is owned local PostgreSQL plus controlled HTTP/worker fixtures only. These limits are why this implementation is marked `DONE_WITH_CONCERNS` pending the designated independent review and later formal gates.
