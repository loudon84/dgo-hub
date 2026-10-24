# M1-5B connector preflight — approved PostgreSQL source and order lines

**Status:** Read-only plan for the B connector slice; no implementation authorization. Source is read only at `git show b6177cc8b10537d07c0d25ec6654475045036f1e:<path>`. Do not use the mutable checkout as evidence; Phase A may be changing it. No tests, source connection, credential resolution, runtime environment, fixture, or network operation was performed. Root ruling (2026-10-24): preserve the existing opaque-secret password contract; keep approved endpoint profile as the sole host/user/database authority; allow explicitly approved enterprise-private destinations under deployment egress policy.

## Exact current seams at the B pin

`integration-service/source-registry/capability-probe.ts` declares:

```ts
type EntityProfile = Readonly<{
  table?: string;
  version_field: string;
  delete_field?: string;
  version_type?: 'integer' | 'number' | 'text';
  delete_type?: 'boolean' | 'timestamp';
}>;

export type EndpointProfile = Readonly<{
  revision: string;
  connector: 'rest' | 'postgresql' | 'sqlserver';
  protocol: 'https:' | 'http:' | 'postgres:' | 'mssql:';
  host: string;
  port: number;
  allow_loopback_http?: boolean;
  allow_loopback_plaintext?: boolean;
  path?: string;
  schema_version?: string;
  source_identity?: string;
  database?: string;
  user?: string;
  schema?: string;
  entities: Readonly<Partial<Record<SourceEntity, EntityProfile>>>;
}>;
```

The profile checker requires PostgreSQL protocol `postgres:`, valid `database`, `schema`, and `user` identifiers, and a `table`, `version_field`, and optional `delete_field` for every configured entity. Identifiers match `^[A-Za-z_][A-Za-z0-9_]{0,62}$`; `quoteIdentifier` validates and double-quotes each separately. `allow_loopback_plaintext` is accepted only for local-lab loopback. The checker validates the hostname string and does not resolve/pin DNS answers or enforce destination egress policy.

`source-registry/service.ts` exports the existing `SourceConfig`, `FieldMapping`, `IdentityMapping`, `SecretResolver`, `EndpointAllowlist`, `CapabilityProbe`, and `SourceRegistryDependencies` contracts. `SourceConfig` includes `endpoint_allowlist_ref`, `secret_ref`, connector/mode/version domain, `allowed_entities`, `delete_contract`, and a stored resolved `endpoint_profile`. `FieldMapping` is currently `(entity: 'customer'|'order', source_field, target_field, transform)`; its order targets are header fields only. `SecretResolver.resolve(reference)` returns a string; `EndpointAllowlist.resolve(reference)` returns an approved profile. The approved endpoint profile is canonicalized into the config digest; the existing `source_test_report` and `source_owner_approval` store `endpoint_profile_digest`, while mapping revision/test/approval rows store mapping digests.

`createBoundedCapabilityProbe` uses a direct `pg.Client` with `host`, `port`, `database`, `user` from the profile and `password` from the resolved secret. It enables TLS with `rejectUnauthorized: true` unless local-lab loopback plaintext was explicitly allowed, and caps connect/query/statement time at 3 seconds. It opens `BEGIN READ ONLY`, verifies `current_database()` and rejects superuser/CREATEDB/CREATEROLE/schema CREATE/database CREATE, checks required mapped/version/delete columns via `information_schema.columns`, rejects table write/column write privileges, and runs a `LIMIT 0` projection with quoted identifiers. It does not scan all rows, prove an aggregate snapshot, validate order lines, enforce DNS pinning/controlled egress, or own a reusable connection factory. `sqlserver` is explicitly unavailable at this probe.

## Minimal approved order-line contract

The current profile has no line relation, and current `FieldMapping`/mapping validation does not cover line rows. Do not infer conventional CRM/ERP table names or join keys. Preserve existing `allowed_entities = ['customer','order']` and permission scopes. Extend the approved PostgreSQL profile only for `entities.order` with one nested line contract:

```ts
entities: {
  customer: { table, source_pk, version_field, delete_field? },
  order: {
    table, source_pk, version_field, delete_field?,
    lines: { table, source_pk, order_fk }
  }
}
```

`source_pk` and `order_fk` are validated/quoted identifiers. The unique logical line identity is `(order source_pk, line source_pk)`; `order_fk` must reference the configured order table's `source_pk` under the same read-only source snapshot. Reject duplicate header PKs, duplicate `(order FK,line PK)`, orphan lines, and any line FK ambiguity. If orders are enabled, lines are required and every source line required by the canonical aggregate must be present. Customer-only remains valid.

Add an explicit line mapping contract in the same approved mapping revision, not as a new entity scope. Recommended minimal shape is separate `order_line_mappings` entries `{source_field,target_field,transform}` with target allowlist `source_line_id`, `product_code`, `product_name`, `quantity`, `unit_price`, and `line_amount`; header mappings remain the existing `FieldMapping[]`. Validate uniqueness/completeness and allowed transforms against the PRD line contract. Include the nested relation in `EndpointProfile` validation and canonical digest; include the line mappings in `source_mapping_revision.mapping_digest`. Existing test/approval persistence already binds both hashes, so no secret or unapproved mapping can be recovered by a run. Store the tested/approved complete contract in `source_test_report` and `source_owner_approval` through their existing digest proof. Keep REST's profile and mapping semantics unchanged.

The source primary key columns also need to be explicit for customer and order snapshots. If existing REST capability contract cannot carry `source_pk`, make the new property PostgreSQL-only and optional at the shared type boundary but mandatory under `connector === 'postgresql'`; do not force a REST payload/config migration. Keep profile user and mapped line identifiers out of raw API responses.

## Credentials, endpoint enforcement, and connection factory

**Root credential ruling (2026-10-24):** preserve the current contract without introducing a provider JSON credential format or DSN authority. `EndpointProfile.host`, `port`, `database`, and `user` remain the approved connection coordinates and role. Call the existing `SecretResolver.resolve(secret_ref): Promise<string>` only in memory and pass its opaque returned string as PostgreSQL's password literal. A value that resembles a DSN is still only a password; it must not change the host, port, database, user, TLS, or connection options. Do not persist or log the resolved string, and do not alter the existing PostgreSQL probe credential contract unnecessarily. REST continues using the existing secret behavior.

Add a deployment-injected, narrow `PostgresSourceConnectionFactory` at the connector boundary. Input is only `(validated approved EndpointProfile, opaque in-memory password string returned by the existing SecretResolver, controlled egress policy, bounded pool options)`; it must not accept a URL/DSN, arbitrary host/port, env URL, or caller-supplied profile. It owns one source connection/pool with `max: 1`, bounded connect/statement/idle time, explicit TLS policy and deterministic `end()`/discard. Runtime service composition supplies the factory; tests supply an explicitly named `local_lab` fake limited to exact-loopback fixtures. Capability probing and extraction must use the same endpoint/TLS/DNS rules so a successful probe cannot authorize a broader connection path.

DNS and egress are not implemented by current `validateEndpointProfile`. The deployment-injected factory and egress policy must fail closed when required policy is unconfigured. Resolve A and AAAA for the approved hostname under that policy, bind the approved profile, TLS policy, and pinned peer address into the connection, and recheck the connected peer before queries to prevent DNS rebind/TOCTOU. Permit enterprise private addresses only when the deployment policy/profile explicitly approves them; do not blanket-reject private ranges. Reject unapproved loopback, link-local, and metadata destinations. For TLS, retain the approved hostname as SNI/certificate `servername` and verify the certificate. Do not create a default public-egress path or use ambient environment URLs. Local-lab injection is limited to exact loopback and only in `environmentKind='local_lab'`; it cannot widen configured deployment egress.

No product factory or test fixture was created in this preflight. The concrete seams to extend after dispatch are `EndpointProfile`/profile parsing and `validateEndpointProfile` in `source-registry/capability-probe.ts`; `SourceConfig`/mapping digest validation and dependency injection in `source-registry/service.ts`; bounded probe connection creation in `createBoundedCapabilityProbe`; the new PostgreSQL connector module used by strict worker runtime; and focused unit/acceptance coverage. Do not alter `AuthService`, introduce new source scopes, use the legacy `resolveWorkerSources`, or change REST endpoints/config interpretation.

## Snapshot extraction contract for B

Use a single owned PostgreSQL connection and one source transaction:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
```

Perform all customer, order-header, and order-line reads on this same session and transaction. Read one table/relation at a time, sequentially, with deterministic source-key ordering and bounded pages. Use an explicit `DECLARE ... NO SCROLL CURSOR WITHOUT HOLD` plus `FETCH FORWARD <bounded-size>`, or a same-transaction keyset strategy that provably keeps the same snapshot and strict stable ordering. Never use a holdable cursor or claim any source-side cursor survives a lost connection. Keep the source transaction open only for extraction/staging; on cancellation/disconnect, cancel pending query, rollback best-effort, close/discard the source connection, and mark the attempt incomplete. A retry starts a fresh full snapshot. Staged rows from an incomplete attempt are diagnostic only.

Every table/schema/column identifier comes from the exact frozen approved profile/mapping contract, passes the ASCII identifier validator, and is quoted individually. All predicates, values, limits, and range bounds are bound parameters; never interpolate user/config values into SQL. Validate source keys and source relations before any completion manifest is written. Cast `numeric`/decimal and potentially 20-digit aggregate versions to text in the source SELECT before `pg` parses them; validate exact grammar/scale in application code without JS `Number`. Cast timestamp values to text with session timezone UTC (or use an explicit UTC textual projection preserving fractional digits) and preserve the full PostgreSQL fractional precision; do not pass source time through JS millisecond `Date`. Validate header/line exact order key, line FK, and complete line set before promoting a full-stage manifest. Closing the read-only source transaction is required before any claim that the attempt can be restarted; only a completed, fully validated destination stage can resume apply.

PostgreSQL v16 transaction/cursor semantics were verified from the official docs by root on 2026-10-24: [Transaction Isolation, PostgreSQL 16](https://www.postgresql.org/docs/16/transaction-iso.html) and [DECLARE, PostgreSQL 16](https://www.postgresql.org/docs/16/sql-declare.html). REPEATABLE READ makes successive SELECTs see the same transaction snapshot. A non-HOLD cursor is transaction-bound; `WITH HOLD` survives commit by materializing its output in temp storage and does not provide a resumable upstream transaction. No live business-source network was used.
