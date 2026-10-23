import type { Pool, PoolClient, QueryResult } from 'pg';
import { AuthError } from './errors.js';

export type AuthQueryable = Pick<PoolClient, 'query'>;

export async function withAuthTransaction<T>(
  pool: Pool,
  suppliedClient: PoolClient | undefined,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client = suppliedClient;
  let ownsClient = false;
  if (!client) {
    try {
      client = await pool.connect();
      ownsClient = true;
    } catch {
      throw new AuthError('AUTH_UNAVAILABLE');
    }
  }
  if (!ownsClient) {
    try { return await operation(client); }
    catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('AUTH_UNAVAILABLE');
    }
  }

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the stable public error below. */ }
    if (error instanceof AuthError) throw error;
    throw new AuthError('AUTH_UNAVAILABLE');
  } finally {
    client.release();
  }
}

export async function authQuery<T extends Record<string, unknown>>(
  operation: () => Promise<QueryResult<T>>,
): Promise<QueryResult<T>> {
  try { return await operation(); }
  catch { throw new AuthError('AUTH_UNAVAILABLE'); }
}

export function decimalBigint(value: unknown): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new AuthError('AUTH_UNAVAILABLE');
  return text;
}
