# M1-3 independent Spec + Quality review

**Spec: FAIL. Quality: Needs fixes.** Five source findings remain: one P1 and four P2. Missing regression coverage is listed separately below.

## Pin, authority, and method

- Reviewed product range: `ca32853e931ff8e0c2fdf147bd2e0c962ddf656c..90ce1940a32d3bf6bf4a1573b61f66a94452604a`. Source/test implementation ends at `ab7cfe565766c60e4de5ac8cfa2b5ab7f2334db5`; subsequent commits in the range contain documentation/evidence. During review, working HEAD was `0a493f4c594b76f42adfea6bcfc2667705c37b05`; `git diff 90ce194..HEAD -- integration-service` was empty. Findings and line numbers refer to the requested review pin.
- Authorities read: authoritative task-3 brief, including its final public order empty-lines addendum; workspace and public task-3 reports; public M1 plan; applicable PRD lifecycle, schema, REST, digest, transaction and API-015–018 sections. The brief calls the digest section PRD §13.3; the supplied PRD actually labels the formula under §13.2. This review uses the exact supplied formula and the brief's lexical-preservation rulings.
- Read both M1 and older M0 policy-blocked-host-artifacts guards before further repository inspection. No applicable AGENTS.md was found in the checked ancestor/relevant repository paths. Used the code-review skill's two review axes; the explicit independent-review/no-subagent instruction overrides its delegation workflow.
- Inspected all changed product source/config/test paths, migration 007, existing authority/assertion and security-fence/approval interfaces. `git diff --exit-code BASE HEAD --` the six historical migration paths exited 0: migrations 001–006 are unchanged.
- No product/Git mutation, test-suite/typecheck/build rerun, Docker operation, source network probe, Compose operation, or resource lifecycle action was performed. Two narrow read-only Node probes transpiled only `strict-contract.ts` in memory using the installed TypeScript package, then exercised synthetic inputs. No generated file or resource was created by those probes. The explicit Task3 evidence-root variable was set for these probes.

## Actual source defects

### M1-3-R1 — P1 — Enum coercion admits invalid order images and bypasses the final empty-lines rule

**Location:** `integration-service/ingestion-api/strict-contract.ts:250` and `:253` (downstream check `:255`).

Order status/currency are checked with `includes(String(value))`, then the original values are retained. A JSON array such as `status:["CONFIRMED"]` passes the status check. Because the later empty-lines check compares the original array to a string, this also accepts `lines:[]`. Similarly `currency:["CNY"]` passes and is retained as an array. The item table stores `public_record` as an object without validating these nested types, so these invalid images can reach durable acceptance. An object-valued status instead raises TypeError, which maps to retryable 503 rather than schema 422.

The source-only probe returned `ACCEPTED` for both array status and array currency, and TypeError for object status. This violates strict hub.v1 enums, PRD §9.1, and the final brief requirement that CONFIRMED/COMPLETED have 1–200 lines. Require actual string enum members before retaining them; malformed values must return 422 with no intake rows.

### M1-3-R2 — P2 — Valid record ordering can make a batch fail the database timestamp constraint

**Location:** `integration-service/ingestion-api/strict-ingestion.ts:216`; constraint `integration-service/migrations/007_durable_ingestion_jobs.sql:94`.

The inserted `first_source_updated_at` and `last_source_updated_at` are the first and last array elements' timestamps. Migration 007 requires `first_source_updated_at <= last_source_updated_at`. Neither the public contract nor the validator requires records to be ordered by source time, and request canonicalization explicitly preserves submitted array order. Two valid records ordered October 22 then October 21 therefore validate, but the job insert fails the CHECK and the handler returns retryable 503, rolling the whole receipt back. If middle elements have earlier/later timestamps, the exposed range can also be wrong without triggering the CHECK.

The source-only probe confirmed validation accepts the descending example; the failing SQL path follows directly from the inserted parameters and CHECK. Compute the intended timestamp range over all records without changing record order or the digest. If these fields are intended to mean positional endpoints instead, remove the incompatible ordering invariant and document that meaning. Add a real PostgreSQL intake/read regression with unordered timestamps and differing offsets.

### M1-3-R3 — P2 — Customer external identifiers bypass the public identifier bounds

**Location:** `integration-service/ingestion-api/strict-contract.ts:232` (generic helper `:223–225`).

`owner_external_id` and `department_external_id` use the generic 2,048-character string validator, rather than the 128-character/no-surrounding-whitespace identifier validator already used for source keys. A customer with a 129-character Owner identifier or `department_external_id:" dept "` therefore passes strict validation and is eligible for durable receipt. Both were accepted by the source-only probe. PRD §9.1 states that identifiers are at most 128 characters and cannot have leading/trailing whitespace; these external identity mapping keys are identifiers. Apply the identifier contract to these fields while preserving accepted spelling and case. Reject with 422 and no writes, rather than leaving the invalid identity to later processing.

### M1-3-R4 — P2 — Error paths reflect arbitrary payload property names

**Location:** `integration-service/ingestion-api/strict-contract.ts:142–144`; response sink `integration-service/ingestion-api/strict-ingestion.ts:69`.

Duplicate detection constructs a JSON pointer from the untrusted property name and sends it verbatim in `error.details.path`. Unknown-key validation has the same path construction. For the synthetic request `{"SYNTHETIC_PRIVATE_MARKER":1,"SYNTHETIC_PRIVATE_MARKER":2}`, the probe produced `path:"/SYNTHETIC_PRIVATE_MARKER"`. Parsing happens before source authentication, so this response does not require a valid credential. An upstream mistakenly using sensitive data as a property name causes that data to be copied into the supposedly safe error, and property-name length is bounded only by the 4 MiB body.

The brief permits safe paths/reason codes and prohibits offending values or payload in errors. Return only trusted schema field segments and bounded array indexes; use a safe containing path for unknown/untrusted property segments. Test both duplicate unknown keys and unknown-field rejection with a synthetic private marker, asserting the marker is absent from the complete response.

### M1-3-R5 — P2 — Unbounded recursive JSON parsing turns invalid structure into retryable service failure

**Location:** `integration-service/ingestion-api/strict-contract.ts:150` and `:166` (recursive object/array value descent).

The custom reader has no depth limit. A roughly 10 KiB request containing 5,000 nested arrays throws RangeError before schema validation, despite being well below 4 MiB. The source-only probe reproduced this exception. `statusOf` treats this unrecognized error as 503 and marks it retryable. A deterministic invalid request should be 422, and unauthenticated clients can repeatedly force deep synchronous recursion and long path creation.

Bound nesting before recursive descent and raise the normal safe `INGEST_INPUT_INVALID` error when exceeded, or use an iterative reader with an explicit depth bound. Add an HTTP regression below the byte limit verifying 422, non-retryable error, and no durable writes. Merely catching every RangeError at the route would leave the parser's resource behavior unresolved.

## Reviewed implementation that conforms

- The two strict POST routes have an encapsulated Buffer JSON parser and route-local 4 MiB body limits; unrelated routes retain the 2 MiB app limit. Fatal UTF-8 decoding, duplicate detection before schema acceptance, and unpaired-surrogate rejection are present. The canonical writer sorts keys by Unicode code point, preserves array order and public lexical strings, and uses the required authenticated scope/domain with NUL separators and SHA-256. One fixed digest vector and several relative distinction checks are present.
- Admission starts one PoolClient transaction, acquires the existing global security guard before other database locks/writes, checks scoped idempotency, binds current approved revision/digest facts, checks typed barriers against the approval fence, inserts raw/job/items/processing outbox, and performs the existing same-client current-source assertion immediately before COMMIT. No canonical apply or worker orchestration is introduced. The shared guard serializes relevant approved registry and barrier changes; migration 007 captures new approval fences through the existing guard.
- Replay returns the stored current status/counts after current source authentication and skips new-admission lifecycle/proof checks. New admission retains the full public customer_ref without identity resolution and freezes public record strings/null/absence in JSONB. Ordinary pause does not rewrite old proof. The scope-removal recovery test uses the same credential row, explicit re-enable and actual registry pause/test/approve/activate calls with an injected capability result; old job fences remain unchanged.
- Migration 007 gives API raw INSERT without raw SELECT, worker raw SELECT, narrow job/item columns and worker state updates, and no new intake/raw rights to MCP, publisher or Hasura roles. Mutation guards cover raw rows, stored item facts and admission proof. Job reads scope source credentials to tenant/source/entity and management readers to same tenant plus source:read; item reads expose summaries and canonical job-bound ordinal cursors.

## Missing tests / assurance limits, distinct from the source findings

The added strict-ingestion acceptance file has 10 tests. It does not establish all acceptance criteria in the brief:

- No strict-route negative matrix for another tenant/source, removed entity scope, disabled tenant, missing management scope, or unknown job versus unauthorized job, and no separate tenant/source/route idempotency-scope matrix. The read SQL has those filters; lack of these tests is not evidence of an isolation defect.
- No controlled stale-principal admission races against ordinary edit/rotation, tenant disable, scope withdrawal or channel retirement. The pause test directly changes lifecycle and exercises subsequent calls, rather than a racing final current-source assertion. Existing M1-2 tests do not substitute for the new TX-INTAKE boundary.
- No new HTTP assertions for absent raw-storage policy, raw/proof/item immutability mutation attempts, worker raw access using an actual worker session, or the complete malformed UUID/version/time/decimal/DELETE/201-line/customer-ref validation matrix. Role negatives do exercise API raw read and canonical INSERT denial; other roles are partly checked through privilege inspection.
- Atomic rollback is tested at outbox insertion, but not the separately required before-first-write/between-item-writes/final freshness-before-commit boundaries. No HTTP transport actually drops a committed response; the lost-response test repeats a successful injected request.
- Scope-removal recovery proves new admission and unchanged old proof, but does not execute an old accepted job through the M1-2 barrier check. Worker execution remains M1-4 scope; no worker/recovery completion claim is made here. Compromise recovery is not tested.

## Retained gate evidence and limits

Read retained `gate-captures/74ee7ba0-3902-4094-ab54-502999bc07ab/` command/exit records and stdout: typecheck exit 0; 18 test files / 288 tests passed, exit 0; build exit 0. The capture ran on actual HEAD `eb47494fcd98ca5a2bfb6acba7fe34d4d666b03b`, not the review HEAD. Its pre/post manifests each contain the same 15 source/test paths with matching raw hashes and Git clean blobs, originating at `ab7cfe5`; the source is unchanged through the review pin. Historical command summaries whose stdout/stderr were NOT_RETAINED were not treated as raw gate evidence.

The two review probes exited 0 and produced only synthetic case results in tool output; they were not database or full HTTP executions. The descending-time SQL result and durable array-enum consequence are source deductions, explicitly distinguished from executed validation probes above. Gate success does not cover the five missing regression cases.

The reviewed report preserves the safe 85-file evidence whitelist plus its manifest. Its local_lab raw-storage policy does not prove encryption at rest, and the injected capability fixture does not prove a real source network test. No resource cleanup or absence was newly audited by this review. External CRM/IdP/Hermes, SQL Server, UI, snapshot extraction, worker orchestration and formal 48-row site acceptance remain outside this review; formal acceptance stays NOT_RUN.

**Disposition:** address M1-3-R1 through R5 and the relevant regressions, then obtain a pinned independent re-review before closing M1-3. No product/progress/status change or commit was made by this reviewer.
