# M1-5B independent task review

## Spec Compliance

**Needs fixes.** The implementation meets the central B boundary, but R1, R2, R4 and R5 leave binding runtime, publication, cancellation and acceptance requirements unmet. R3 is a blocking quality issue for full scans.

Reviewed BASE `8283a39cde0cda9468cdbb5d77862f45b973f240` through HEAD `8d9f1dca3bda9c0a58a410168005a39183206561` using the supplied complete integration-service review package. The initially clipped package output was recovered in bounded sections. No suite was rerun and no source/database connection was opened by this review.

## Strengths

- `integration-service/etl-worker/postgres-snapshot-connector.ts:197`: customer, header and line reads share one dedicated REPEATABLE READ READ ONLY source transaction; UTC, text projections and non-HOLD cursors preserve exact source values. Source COMMIT precedes the connector result at line 231, and manifest publication follows that result in `snapshot-worker.ts:102`.
- `integration-service/etl-worker/snapshot-stage-store.ts:34`: each destination mutation uses a short guard-first Hub transaction, while source I/O occurs in the connector after those calls return. `integration-service/migrations/009_snapshot_runs_and_recovery.sql:287` checks the original admission fence and current claim, and line 397 inserts records and receipts atomically without conflict-ignore.
- `integration-service/migrations/009_snapshot_runs_and_recovery.sql:339`: expired starts become durable diagnostic attempts; the recovery and observed-failure paths persist database-clock retry availability and retain active SCANNING. `snapshot-worker.ts:98` publishes EXTRACTED and the SQL completion path at line 501 stops the run in VALIDATING.
- `integration-service/acceptance-tests/postgres-snapshot-source.test.ts:90` exercises a distinct reader/writer fixture, concurrent source mutation, exact bigint/decimal/microsecond text and denied source writes. `integration-service/acceptance-tests/snapshot-runs.test.ts:144` covers disconnect/restart through the strict worker loop, retaining the first attempt's page.

## Issues

### Critical

None found.

### Important

1. **R1 — P1: Wire due admission into the strict snapshot runtime.** `integration-service/etl-worker/worker.ts:384`; `integration-service/etl-worker/snapshot-worker.ts:31`. The loop only scans already admitted QUEUED/SCANNING runs. Its candidate query cannot see a source that has an enabled, due schedule but no run. A focused call-site search finds `admitDueSnapshotRun` only at its export and in acceptance tests; no production caller invokes it. Consequently activation never causes the promised automatic 300-second scan through this entry path, even with valid injected dependencies. Invoke the existing guarded due-admission gate from the strict runtime before selecting scan candidates, preserve active-run/cadence constraints, and add a strict-loop test starting with a due schedule and no manual API-019 run.

2. **R2 — P1: Make manifest proof and relation-count validation fail closed.** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:458` and `:468`. Missing `profile_digest` or `mapping_digest` produces SQL NULL in the `<>` predicates, so the IF condition does not reject it. The relation-count loop validates each supplied entry and then only compares array length; it never requires a distinct entry for every expected relation. For an empty running customer/order attempt, a manifest can list all three expected relations, repeat the zero-count customer entry three times, omit both proof digests, supply row_count=0 and a snapshot identity, and reach immutable EXTRACTED publication. This is a malformed B/C completeness proof accepted by the worker-authorized database function. Require all proof fields and their types with NULL-safe comparisons, exact distinct equality of the relation-count set, non-null counts and matching receipt digest lists. Add direct hub_worker negative tests for omitted digests, duplicate/omitted relation counts and null counts; each must leave the attempt unpublished.

3. **R3 — P2: Release staged row payloads after each page.** `integration-service/etl-worker/snapshot-worker.ts:76` and `:90`. `pages.push(page)` retains every full page, including every row and its facts, until the entire scan finishes. A bounded FETCH therefore still accumulates the whole source dataset in the Node heap. A large snapshot can exhaust memory on every retry despite its pages already being durable. Keep only the receipt metadata/digests needed for the manifest, preferably accumulating per-relation counters during the scan; do not retain `rows`. Verify that a multi-page worker run retains metadata only while producing the same manifest.

4. **R4 — P2: Propagate abort/lease loss to outstanding source operations.** `integration-service/etl-worker/postgres-snapshot-connector.ts:29`, `:197` and `:216`; `integration-service/etl-worker/snapshot-worker.ts:80`. The heartbeat calls `abort.abort()`, but the connection factory and query interface receive no signal or cancellation mechanism. The connector checks the signal only before subsequent operations. A pending connect/FETCH keeps running until its own completion/timeout; rollback and close cannot begin until then. This misses the explicit cancellation requirement and can leave an obsolete source scan alive while recovery becomes eligible. Extend the injected connection contract to cancel/discard outstanding work on abort, then perform bounded best-effort rollback/close outside Hub transactions. Add a scripted pending-query test in which lease loss causes cancellation and cleanup without manually resolving the pending query, and confirms no manifest is published.

5. **R5 — P2: Supply the required SOURCE_VERSION aggregate fixture evidence.** `integration-service/acceptance-tests/postgres-snapshot-source.test.ts:19` and `:104`; `integration-service/acceptance-tests/postgres-snapshot-contract.test.ts:37`. The live mutation fixture is SNAPSHOT_OBSERVATION and its tables have no source-version columns. It changes a line's product name but cannot show that a relevant line change advances the parent order version. The contract test only checks the assertion flag. B now admits SOURCE_VERSION orders with that flag, while the brief explicitly requires the owned fixture to demonstrate the aggregate-version behavior under concurrent header/line mutation. Add a bounded owned fixture with the declared aggregate-version mechanism, assert version advancement for both kinds of mutation, and retain its command/output evidence. This does not require proving arbitrary production writers.

### Minor / B-C seam

6. **S1 — P3: Durable page membership is not reconstructible in general.** `integration-service/migrations/009_snapshot_runs_and_recovery.sql:206`; `integration-service/etl-worker/postgres-snapshot-connector.ts:224`. Record rows persist neither page number nor row ordinal, while page digests hash ordered row arrays. First/last text keys do not generally recover source numeric/collation order and page membership after restart. The B brief's minimal record schema does not explicitly demand C recompute each page digest, so this is not an additional B compliance blocker. C must explicitly decide how it will establish durable receipt-to-record membership if it validates those digests; immutable page coordinates and row ordinals written in the same transaction are a suitable seam.

## Checks and assurance limits

- **Retained gates inspected, not rerun:** `docs/execution/alpha1/m1-task-5b-evidence/35044d58-f640-4265-adfe-a7b0147429ab/captures/focused-b-suite-green/stdout.txt:10` records 93/93; `captures/strict-ingestion-rest-green/stdout.txt:160` records 30/30; `captures/strict-worker-loop-entry/stdout.txt:10` records 1/1 with 20 intentionally skipped; `captures/snapshot-runs-final/stdout.txt:10` records 21/21. Their retained exit files contain 0 and final stderr files are empty. Typecheck/build retained commands and exit files likewise show success. These preserve the report's chronology: compiler gates belong to the product implementation, followed by the test-only strict-loop acceptance change.
- **Diagnostic captures remain diagnostics:** the retained REST regression failure and first disconnect run's uncaught connection error were read as historical failed gates, not silently counted as current passes. The later retained final runs are clean.
- **Named outside-hunk checks:** inspected only due-admission production call sites, the unchanged admission-created QUEUED attempt, the worker CLI entry, and pre-append 009 grants when evaluating runtime composition and ACL risk. PostgreSQL's [REVOKE documentation](https://www.postgresql.org/docs/18/sql-revoke.html) confirms table revocation also removes corresponding column privileges, so the initially considered surviving-column-ACL hypothesis is rejected and is not a finding.
- **Cannot verify deployment assurance:** actual production DNS pinning, TLS peer identity, approved private-network policy and deployed dependency composition are not proven by the diff/owned fixtures. The default factory remains fail-closed (`integration-service/etl-worker/postgres-snapshot-connector.ts:249`); this acknowledged deployment limit is separate from R1's missing due-admission call with injected dependencies.
- **Scope assurance:** no C/D/E completion is inferred. B's new runtime has no observation allocation, canonical apply or delete-action path, and the formal 48-case suite remains NOT_RUN as required. The controller's separate 134-entry hash/size verification is not represented as a check rerun by this reviewer.

## Assessment

**Spec compliance: Needs fixes.**

**Task quality: Needs fixes.**

The main extraction and staging path has clear separation and useful owned-fixture evidence. Automatic scheduling, malformed manifest rejection, bounded-memory streaming and active cancellation need correction; the explicit aggregate-version acceptance gate also remains unsatisfied.
