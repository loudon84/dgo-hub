import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

describe('strict hub.v1 ingestion parser', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('rejects duplicate keys at any nesting depth before source authentication', async () => {
    app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/hub/v1/ingest/crm/customers',
      headers: { 'content-type': 'application/json', authorization: 'Bearer invalid', 'idempotency-key': 'red-first' },
      payload: '{"schema_version":"hub.v1","batch_id":"00000000-0000-4000-8000-000000000001","records":[{"event_id":"00000000-0000-4000-8000-000000000002","source_pk":"C1","source_version":"1","operation":"UPSERT","source_updated_at":"2026-01-01T00:00:00Z","data":{"customer_name":"A","customer_name":"B","owner_external_id":"owner","department_external_id":"dept","status":"ACTIVE"}}]}',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      request_id: expect.any(String),
      error: { code: 'INGEST_JSON_DUPLICATE_KEY', retryable: false, details: { path: expect.any(String) } },
    });
    expect(response.body).not.toContain('"A"');
    expect(response.body).not.toContain('"B"');
  });

  it('does not reflect duplicate private property names in errors before authentication', async () => {
    app = await buildApp();
    for (const payload of [
      '{"SYNTHETIC_PRIVATE_MARKER":1,"SYNTHETIC_PRIVATE_MARKER":2}',
    ]) {
      const response = await app.inject({ method: 'POST', url: '/hub/v1/ingest/crm/customers',
        headers: { 'content-type': 'application/json', authorization: 'Bearer invalid', 'idempotency-key': 'safe-path' }, payload });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.retryable).toBe(false);
      expect(response.body).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    }
  });

  it('rejects deep JSON below the byte limit as a nonretryable client error', async () => {
    app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/hub/v1/ingest/crm/customers',
      headers: { 'content-type': 'application/json', authorization: 'Bearer invalid', 'idempotency-key': 'deep-json' },
      payload: '['.repeat(5000) + '0' + ']'.repeat(5000) });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: 'INGEST_INPUT_INVALID', retryable: false });
  });
});
