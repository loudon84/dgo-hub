import { createHash, randomBytes } from 'node:crypto';
import { AuthError } from './errors.js';

const CANONICAL_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;

export type GeneratedCredential = Readonly<{ secret: string; digest: Buffer }>;

export function parseCredential(secret: string): Buffer {
  if (typeof secret !== 'string' || !CANONICAL_CREDENTIAL.test(secret)) throw new AuthError('AUTH_INVALID');
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== secret) throw new AuthError('AUTH_INVALID');
  return decoded;
}

export function digestCredential(secret: string): Buffer {
  return createHash('sha256').update(parseCredential(secret)).digest();
}

export function createCredential(): GeneratedCredential {
  const bytes = randomBytes(32);
  return { secret: bytes.toString('base64url'), digest: createHash('sha256').update(bytes).digest() };
}

export function deriveExecutionRole(tenantKey: string, businessRole: 'sales' | 'sales_manager'): string {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(tenantKey)) throw new AuthError('AUTH_INPUT_INVALID');
  if (businessRole !== 'sales' && businessRole !== 'sales_manager') throw new AuthError('AUTH_INPUT_INVALID');
  return `hub_${tenantKey}_${businessRole}`;
}
