import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createCredential, deriveExecutionRole, digestCredential, parseCredential } from '../auth/credentials.js';

describe('opaque credential codec', () => {
  it('generates canonical unpadded base64url for exactly 32 random bytes', () => {
    const first = createCredential();
    const second = createCredential();
    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.secret).not.toBe(second.secret);
    expect(parseCredential(first.secret)).toHaveLength(32);
    expect(digestCredential(first.secret)).toEqual(first.digest);
    expect(first.digest).toHaveLength(32);
  });

  it.each([
    '', 'x'.repeat(42), 'x'.repeat(44), `${'A'.repeat(42)}=`, `${'A'.repeat(42)}+`, `${'A'.repeat(42)}/`,
    `${'A'.repeat(42)} `, `${'A'.repeat(42)}B`,
  ])('rejects noncanonical secret shape %j', token => {
    expect(() => parseCredential(token)).toThrow();
    expect(() => digestCredential(token)).toThrow();
  });

  it('hashes decoded bytes instead of the UTF-8 representation', () => {
    const credential = createCredential();
    const expected = createHash('sha256').update(Buffer.from(credential.secret, 'base64url')).digest();
    const wrong = createHash('sha256').update(credential.secret, 'utf8').digest();
    expect(credential.digest).toEqual(expected);
    expect(credential.digest).not.toEqual(wrong);
  });

  it('derives the PRD execution role from a registered tenant key and trusted business role', () => {
    expect(deriveExecutionRole('t01', 'sales')).toBe('hub_t01_sales');
    expect(deriveExecutionRole('t_north2', 'sales_manager')).toBe('hub_t_north2_sales_manager');
    expect(() => deriveExecutionRole('Tenant-North', 'sales')).toThrow();
  });
});
