# M1-5D2 — safe API-021 candidate review and API-060 approval

**Status:** Provisional builder brief for a later reviewed gate. Dispatch only after D1 implementation is independently accepted and the exact source pin is refreshed. One writer, then independent Sol Spec/Quality review. This slice records approval only; it performs no canonical business DML and no candidate apply.

## Goal

Expose safe D reconciliation summaries through existing API-021 and exact-set review only under explicit Owner authorization. Add API-060 to durably approve one exact immutable above-threshold candidate revision using existing source scope and idempotency/audit conventions.

## API-021 ordinary summary

Keep route `GET /hub/v1/admin/etl-runs/:id` and ordinary `source:read` authorization. Add only safe D summary fields: reconciliation status, candidate counts, candidate identifiers/revisions/digests, exact denominator/count/threshold state, and approval state. Never include candidate member keys in default detail. Preserve tenant-scoped run lookup, current principal validation, security-barrier guard, normal response envelope, paging/filter behavior, and safe errors.

Add strict optional `include=delete_candidates` query mode for exact set members. Unknown or malformed query fields fail safely. Require `source:approve`, the current principal, and the exact currently enabled Owner bound to this source in the same tenant at query time. Bind requested run/candidate to that principal's source and tenant. Recheck current Owner revision, proof, candidate revision, digest and scope before returning members. A user authorized for the ordinary summary must still be denied when this Owner/tenant/source binding is stale.

Return only full source-qualified identity keys for the exact requested scope. No business names, raw payloads, credentials, unrelated rows, or mapping edits. Page with default 20/max 100 and a stable C-collation-safe cursor. Audit this sensitive review read using the existing safe audit seam discovered at the refreshed pin. API-014 remains the sole identity-mapping confirmation/write path.

## API-060 exact approval

Add only:

`POST /hub/v1/admin/sources/{id}/delete-candidates/{candidate_id}/approve`

Require existing `source:approve`, exact currently enabled bound Owner identity/revision, the same tenant/source as the frozen candidate, and the already-approved `Idempotency-Key` scope convention. Strictly accept exactly the required JSON fields: `run_id`, `candidate_revision`, `candidate_digest`, `expected_owner_revision`, `reason`. Reject missing, unknown, malformed, oversized, or unsafe fields with the existing safe error envelope.

In one guarded Hub transaction, re-read current principal, source/current Owner, C frozen proof, D reservation/status, immutable candidate revision and server-recomputed canonical digest, exact denominator/membership, source pause and all above-threshold approval obligations. Only approve `AWAITING_OWNER` candidate state. Stale candidate, owner, proof, denominator, newer C run, source or barrier returns 409 and writes no approval. A caller digest only must match recomputed evidence. Same scoped idempotency key and same canonical request returns the original durable result; same key with different request conflicts. Success is HTTP 200 and includes durable approval ID and safe status. Persist approval, audit and idempotency evidence only.

Above-threshold gating is source-wide: every threshold-crossing entity set needs a separate approval before D3 may apply any candidate. API-060 never activates or unpauses the source. D status remains separate from C `COMPLETE`.

## Durable schema, grants, and authorization

Extend only phase-owned 009 from the reviewed D1/C artifact. Keep approval immutable and bound to candidate revision/digest, run(s), source, tenant, entity, denominator, full set proof, observation/time basis, Owner user/revision, request digest/idempotency scope, actor, reason and creation time. Give API the narrow procedure/column access required to write approval/audit/idempotency evidence and read authorized safe summary/member projection. Do not grant API canonical DML, worker candidate mutation, or direct broad access to `control.canonical_source_identity`. Worker alone transitions candidate application state. Use fixed search paths, explicit role checks and PUBLIC revokes for security-definer functions.

The refreshed D1 pin must confirm the safe API error-to-HTTP mapping, current-principal call, exact Owner lock, audit writer and scoped idempotency lock/table/function. Reuse existing conventions; do not create a new authorization scope or idempotency authority.

## Acceptance evidence

- Ordinary API-021 response remains safe under source:read and hides candidate members.
- Exact-set mode requires current principal + source:approve + current exact enabled Owner; test stale Owner/tenant/source, ordinary reader, source token, cross-source and cross-tenant denials.
- Strict query behavior; page size 20 and 100; stable cursor at C collation; no member leakage into ordinary logs/errors or unrelated runs.
- API-060 accepts exactly the required five fields, has safe errors for unknown/missing/malformed input, and no canonical business DML.
- Durable approval binds exact current candidate, revision, digest, run(s), denominator, proof, owner revision and reason; stale proof/membership/denominator/owner/newer run/barrier returns 409 with no approval.
- Same key/request replay returns durable original result; changed request under same key conflicts. Audit is safe and durable.
- Approval of one entity cannot release other above-threshold scopes. Source remains paused and due schedule stays disabled through approval; activation during unresolved D approval/action returns 409.
- Run C and D public interfaces under real API role plus negative-grant checks in the isolated local Hub fixture. Never claim live or production coverage.

Use fresh UUID-isolated evidence roots under absolute `M0_RUN_EVIDENCE_ROOT`, actual HEAD/source before-after manifests and exact command/output/exit capture. The complete phase-owned 009 must be tested against populated 001–008 and identical reapply after final assembly, not a changed body over an old ledger. Formal 48 gates remain `NOT_RUN` absent actual evidence.

## Review handoff

Submit the implementation commit and evidence to independent Sol review. D3 begins only after D2 acceptance. Refresh every relevant seam from the selected immutable pin before implementation, including API-021 route composition, auth currentness, audit and idempotency exact function signatures.
