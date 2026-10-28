# Simulated import source contract (M1-I1)

This contract covers source configuration, sample validation, Owner approval and activation. It does not submit an ingestion job or write the standard replica. Durable batch intake and worker processing belong to M1-I2; G1/platform acceptance is a separate gate.

## Configuration and identity

Create a source using the existing `POST /hub/v1/admin/sources` management API. Its strict `config` has `name`, `connector: "SIMULATED_IMPORT"`, `mode: "INCREMENTAL"`, `version_domain: "SOURCE_VERSION"`, a nonempty unique `allowed_entities` array containing `customer` and/or `order`, and `delete_contract: "tombstone"`. Endpoint, endpoint profile and external secret fields are forbidden. Tenant and actor come from the authenticated management identity. The server retains an internal source authority for revocation; its generated verifier is not exposed and cannot authenticate source-token ingestion or job reads.

Use the existing source mapping and identity-mapping management APIs. Source mappings are explicit; no same-name inference occurs. Customer `customer_name`, `owner_user_id`, `dept_id`, `status` and optional `phone` map to public customer fields; owner and department targets are external identities confirmed by the Owner against enabled subjects in the same tenant. Order `customer_id`, `order_no`, `status`, `order_at`, `amount`, `currency` and all six `lines.*` targets are required. Allowed transforms are `identity`, `trim`, `decimal-string` and `source-id` under the existing mapping rules. A source field is a direct property of `data`, except `lines.<field>`, which reads each object in `data.lines`.

## Samples and references

`POST /hub/v1/admin/sources/:id/test` accepts `{ "expected_revision": "1", "samples": { "customer": "<JSON text>", "order": "<JSON text>" } }`, with exactly the configured entities present. Each text is a `hub.v1` batch with UUID `batch_id`, 1–100 `records`, and the existing public event metadata (`event_id`, `source_pk`, `source_version`, `operation`, `source_updated_at`, `data`). The complete UTF-8 HTTP request must not exceed 4 MiB. The external-source test limit remains 2 MiB, measured from actual request bytes. Duplicate JSON keys, unknown states and invalid timestamps, versions, decimals or line structures fail validation. `DELETE` uses a null `data` value and follows the tombstone contract.

For an order's mapped `customer_id`, a string means a customer key in the current source. An `identity` mapping may instead provide the explicit typed object `{ "source_id": "...", "source_pk": "..." }`. A same-source key is valid when an UPSERT customer with that key occurs in the submitted customer sample. Otherwise, including order-only sources and foreign references, an Owner must confirm an existing customer mapping using the existing identity-mapping candidate and revisioned confirmation APIs:

- Form the mapping `external_id` as `c:` followed by the unpadded base64url encoding of the SHA-256 digest of the UTF-8 bytes of `JSON.stringify([source_id, source_pk])`.
- Confirm the mapping to a nondeleted canonical customer UUID in the authenticated tenant. That UUID must equal the canonical source identity for the exact `(tenant, source_id, customer, source_pk)` tuple.
- No customer name matching, implicit source conversion or cross-tenant mapping is performed. A same-source string with no matching submitted customer uses this same typed-reference mapping fallback.

The test stores the sample digest, bounded results, current config/mapping/identity/credential proofs, and the consumed customer reference tuples needed for activation rechecking; it does not store the complete sample or apply its records.

## Lifecycle and compatibility

The existing lifecycle is `DRAFT → TESTED → APPROVED → ACTIVE`. A passing sample and current field and identity mappings are required before the configured current Owner can approve. Activation verifies the latest passing report, Owner, revisions and digests, current authority, and any consumed customer references. Editing configuration or mappings invalidates prior proof; editing an active source pauses it. Connector/mode switching remains unavailable.

Import report and approval proofs contain a sample digest and a NULL endpoint-profile digest. External connector proofs retain a real endpoint-profile digest. Before M1-I2 enables import intake, the immutable migration 006 proof consumer must be replaced additively with a connector-aware NULL-safe comparison, preserving the existing credential identity, epoch, channel and security-fence checks. I1 activation alone is not evidence of ingestion or platform acceptance.
