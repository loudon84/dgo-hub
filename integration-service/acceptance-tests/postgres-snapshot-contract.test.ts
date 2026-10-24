import { describe, expect, it } from 'vitest';
import { validateEndpointProfile, type EndpointProfile } from '../source-registry/capability-probe.js';
import type { SourceConfig } from '../source-registry/service.js';

const observationConfig: SourceConfig = {
  name: 'fixture', connector: 'postgresql', mode: 'FULL_SNAPSHOT', version_domain: 'SNAPSHOT_OBSERVATION',
  endpoint_allowlist_ref: 'fixture', secret_ref: 'vault:/fixture/source', allowed_entities: ['customer'], delete_contract: 'hard_delete',
};

function customerProfile(overrides: Record<string, unknown> = {}): EndpointProfile {
  return ({
    revision: 'fixture-v1', connector: 'postgresql', protocol: 'postgres:', host: '127.0.0.1', port: 5432,
    allow_loopback_plaintext: true, database: 'source_db', user: 'source_reader', schema: 'public',
    entities: { customer: { table: 'customers', source_pk: 'customer_id', updated_at_field: 'updated_at', ...overrides } },
  }) as unknown as EndpointProfile;
}

describe('approved PostgreSQL snapshot profile contract', () => {
  it('requires an explicit source primary key for each enabled entity', () => {
    expect(() => validateEndpointProfile(observationConfig, customerProfile({ source_pk: undefined }), { environmentKind: 'local_lab' }))
      .toThrow('PROFILE_INVALID');
  });

  it('requires an approved order line table and header foreign key when orders are enabled', () => {
    const config: SourceConfig = { ...observationConfig, allowed_entities: ['customer', 'order'] };
    const profile = ({
      ...customerProfile(),
      entities: {
        customer: { table: 'customers', source_pk: 'customer_id', updated_at_field: 'updated_at' },
        order: { table: 'orders', source_pk: 'order_id', updated_at_field: 'updated_at' },
      },
    }) as unknown as EndpointProfile;
    expect(() => validateEndpointProfile(config, profile, { environmentKind: 'local_lab' })).toThrow('PROFILE_INVALID');
  });

  it('requires an explicit owner assertion that SOURCE_VERSION covers order line changes', () => {
    const config: SourceConfig = { ...observationConfig, version_domain: 'SOURCE_VERSION', allowed_entities: ['order'] };
    const profile = ({
      ...customerProfile(),
      entities: { order: { table: 'orders', source_pk: 'order_id', updated_at_field: 'updated_at', version_field: 'version',
        lines: { table: 'order_lines', order_fk: 'order_id' }, customer_source_id: 'crm-main' } },
    }) as unknown as EndpointProfile;
    expect(() => validateEndpointProfile(config, profile, { environmentKind: 'local_lab' })).toThrow('PROFILE_INVALID');
  });

  it('allows a missing source version field for SNAPSHOT_OBSERVATION only', () => {
    expect(() => validateEndpointProfile(observationConfig, customerProfile(), { environmentKind: 'local_lab' })).not.toThrow();
    const versionedConfig: SourceConfig = { ...observationConfig, version_domain: 'SOURCE_VERSION' };
    expect(() => validateEndpointProfile(versionedConfig, customerProfile({ version_field: undefined }), { environmentKind: 'local_lab' }))
      .toThrow('PROFILE_INVALID');
  });

  it('requires and validates the customer source ID for an order-only snapshot', () => {
    const config: SourceConfig = { ...observationConfig, allowed_entities: ['order'] };
    const order = { table: 'orders', source_pk: 'order_id', updated_at_field: 'updated_at', lines: { table: 'order_lines', order_fk: 'order_id' } };
    expect(() => validateEndpointProfile(config, { ...customerProfile(), entities: { order } } as unknown as EndpointProfile,
      { environmentKind: 'local_lab' })).toThrow('PROFILE_INVALID');
    expect(() => validateEndpointProfile(config, { ...customerProfile(), entities: { order: { ...order, customer_source_id: 'bad/source' } } } as unknown as EndpointProfile,
      { environmentKind: 'local_lab' })).toThrow('PROFILE_INVALID');
    expect(() => validateEndpointProfile(config, { ...customerProfile(), entities: { order: { ...order, customer_source_id: 'crm-main' } } } as unknown as EndpointProfile,
      { environmentKind: 'local_lab' })).not.toThrow();
  });
});
