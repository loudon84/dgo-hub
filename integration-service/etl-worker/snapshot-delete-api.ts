import type { Pool, PoolClient } from 'pg';
import { AuthError, type AuthErrorCode } from '../auth/errors.js';
import type { UserPrincipal } from '../auth/types.js';

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const REVISION = /^[1-9][0-9]*$/;

function fail(code: AuthErrorCode): never { throw new AuthError(code); }

function mapDatabaseError(error: unknown): never {
  if (error instanceof AuthError) throw error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    const safeCode=error.message.match(/^(AUTH_FORBIDDEN|AUTH_INPUT_INVALID|SOURCE_CONFLICT|SOURCE_NOT_FOUND|IDEMPOTENCY_CONFLICT)$/)?.[1];
    if(safeCode) return fail(safeCode as AuthErrorCode);
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if(error.code==='42501') return fail('AUTH_FORBIDDEN');
    if(error.code==='22023') return fail('AUTH_INPUT_INVALID');
    if(error.code==='23505') return fail('SOURCE_CONFLICT');
  }
  return fail('AUTH_UNAVAILABLE');
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try { client=await pool.connect(); } catch { return fail('AUTH_UNAVAILABLE'); }
  try {
    await client.query('BEGIN');
    const result=await operation(client);
    await client.query('COMMIT');
    return result;
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    return mapDatabaseError(error);
  } finally { client.release(); }
}

export type DeleteCandidateApprovalInput = Readonly<{
  run_id: string;
  candidate_revision: number;
  candidate_digest: string;
  expected_owner_revision: string;
  reason: string;
}>;

export async function approveSnapshotDeleteCandidate(pool: Pool, principal: UserPrincipal, sourceId: string,
  candidateId: string, input: DeleteCandidateApprovalInput, idempotencyKey: string, requestId: string) {
  if(!SOURCE_ID.test(sourceId) || !UUID.test(candidateId) || !UUID.test(input.run_id) ||
    !Number.isSafeInteger(input.candidate_revision) || input.candidate_revision<1 || !DIGEST.test(input.candidate_digest) ||
    !REVISION.test(input.expected_owner_revision) || BigInt(input.expected_owner_revision)>9223372036854775807n ||
    typeof input.reason!=='string' || input.reason.trim().length<1 || input.reason.length>1000 || /[\u0000-\u001f\u007f]/.test(input.reason) ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey) || typeof requestId!=='string' || requestId.length<1 || requestId.length>256) {
    return fail('AUTH_INPUT_INVALID');
  }
  if(!principal.managementScopes.includes('source:approve')) return fail('AUTH_FORBIDDEN');
  return transaction(pool,async client=>{
    const result=await client.query<{result:Record<string,unknown>}>(
      `SELECT control.api060_approve_delete_candidate($1,$2,$3::uuid,$4::uuid,$5,$6::bytea,$7::bigint,$8,$9,$10,$11,$12,$13,$14) AS result`,
      [principal.tenantId,sourceId,candidateId.toLowerCase(),input.run_id.toLowerCase(),input.candidate_revision,
        Buffer.from(input.candidate_digest,'hex'),input.expected_owner_revision,input.reason,idempotencyKey,
        principal.tenantId,principal.userId,principal.issuer,principal.subject,requestId]);
    if(!result.rows[0]?.result) return fail('AUTH_UNAVAILABLE');
    return Object.freeze(result.rows[0].result);
  });
}
