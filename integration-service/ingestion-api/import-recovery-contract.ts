import { createHash } from 'node:crypto';
import { AuthError } from '../auth/errors.js';
import { customerReferenceMappingKey } from '../source-registry/import-sample.js';
import { canonicalJson, parseStrictJson } from './strict-contract.js';
import type { ImportRecoveryBindingInput } from './import-recovery-plan.js';

export const IMPORT_RECOVERY_BODY_LIMIT=16384;
export const IMPORT_RECOVERY_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type CustomerBinding={kind:'user'|'department';external_id:string;target_id:string};
type OrderBinding={kind:'customer';source_id:string;source_pk:string;target_id:string};
export type ExternalBinding=CustomerBinding|OrderBinding;
export type ImportRecoveryRequest={expected_state:string;expected_source_revision:string;identity_mapping_revision:string;
 identity_mapping_digest:string;bindings:ExternalBinding[];reason:string};

function invalid():never {throw new AuthError('AUTH_INPUT_INVALID');}
function object(value:unknown):Record<string,unknown> {
 if(!value || typeof value!=='object' || Array.isArray(value)) return invalid();
 return value as Record<string,unknown>;
}
function keys(value:Record<string,unknown>,expected:string):boolean {return Object.keys(value).sort().join(',')===expected;}
function positiveBigint(value:unknown):value is string {
 return typeof value==='string' && /^[1-9][0-9]*$/.test(value) && value.length<=19 && BigInt(value)<=9223372036854775807n;
}
function identifier(value:unknown):value is string {
 return typeof value==='string' && value.length<=128 && /^(?!\s)[\s\S]{1,128}(?<!\s)$/u.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}
function textTarget(value:unknown):value is string {
 return typeof value==='string' && value.length>0 && value.length<=256 && !/[\u0000-\u001f\u007f]/.test(value);
}
export function importRecoveryExpectedState(id:string):string {
 return Buffer.from(JSON.stringify({v:1,kind:'IMPORT_RECOVERY',quarantine_id:id,generation:'0'}),'utf8').toString('base64url');
}
export function parseImportRecoveryRequest(raw:unknown):ImportRecoveryRequest {
 if(!Buffer.isBuffer(raw) || raw.length>IMPORT_RECOVERY_BODY_LIMIT) return invalid();
 let value:unknown;try {value=parseStrictJson(raw);} catch {return invalid();}
 const body=object(value);
 if(!keys(body,'bindings,expected_source_revision,expected_state,identity_mapping_digest,identity_mapping_revision,reason') ||
   typeof body.expected_state!=='string' || !/^[A-Za-z0-9_-]+$/.test(body.expected_state) ||
   !positiveBigint(body.expected_source_revision) || !positiveBigint(body.identity_mapping_revision) ||
   typeof body.identity_mapping_digest!=='string' || !/^[0-9a-f]{64}$/.test(body.identity_mapping_digest) ||
   !Array.isArray(body.bindings) || body.bindings.length<1 || body.bindings.length>2 || typeof body.reason!=='string') return invalid();
 let token:Record<string,unknown>;
 try {
  const bytes=Buffer.from(body.expected_state,'base64url');
  if(bytes.toString('base64url')!==body.expected_state) return invalid();
  token=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 } catch {return invalid();}
 if(Object.keys(token).join(',')!=='v,kind,quarantine_id,generation' || token.v!==1 || token.kind!=='IMPORT_RECOVERY' ||
   typeof token.quarantine_id!=='string' || !IMPORT_RECOVERY_UUID.test(token.quarantine_id) || token.generation!=='0' ||
   importRecoveryExpectedState(token.quarantine_id)!==body.expected_state) return invalid();
 const bindings:ExternalBinding[]=[],seen=new Set<string>();
 for(const rawBinding of body.bindings) {
  const b=object(rawBinding);
  if(b.kind==='user' || b.kind==='department') {
   if(!keys(b,'external_id,kind,target_id') || !identifier(b.external_id) || !textTarget(b.target_id)) return invalid();
   const identity=JSON.stringify([b.kind,b.external_id]);if(seen.has(identity)) return invalid();seen.add(identity);
   bindings.push({kind:b.kind,external_id:b.external_id,target_id:b.target_id});
  } else if(b.kind==='customer') {
   if(!keys(b,'kind,source_id,source_pk,target_id') || typeof b.source_id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(b.source_id) ||
     !identifier(b.source_pk) || typeof b.target_id!=='string' || !IMPORT_RECOVERY_UUID.test(b.target_id) || seen.size) return invalid();
   seen.add('customer');bindings.push({kind:'customer',source_id:b.source_id,source_pk:b.source_pk,target_id:b.target_id});
  } else return invalid();
 }
 if(seen.has('customer') && bindings.length!==1) return invalid();
 bindings.sort((a,b)=>(a.kind==='user'?0:a.kind==='department'?1:2)-(b.kind==='user'?0:b.kind==='department'?1:2));
 const reason=body.reason.trim();
 if(reason.includes('\u0000') || Array.from(reason).length<1 || Array.from(reason).length>1000) return invalid();
 return {expected_state:body.expected_state,expected_source_revision:body.expected_source_revision,
  identity_mapping_revision:body.identity_mapping_revision,identity_mapping_digest:body.identity_mapping_digest,bindings,reason};
}
export function bindingInput(value:ImportRecoveryRequest):ImportRecoveryBindingInput {
 return {expectedSourceRevision:value.expected_source_revision,identityMappingRevision:value.identity_mapping_revision,
  identityMappingDigest:value.identity_mapping_digest,bindings:value.bindings.map(b=>b.kind==='customer'
   ?{kind:b.kind,sourceId:b.source_id,sourcePk:b.source_pk,externalId:customerReferenceMappingKey(b.source_id,b.source_pk),targetId:b.target_id}
   :{kind:b.kind,externalId:b.external_id,targetId:b.target_id})};
}
export function importRecoveryDigest(tenant:string,source:string,route:string,id:string,value:ImportRecoveryRequest):Buffer {
 const hash=createHash('sha256');
 for(const field of ['hub.import-recovery','1',tenant,source,route,id,value.expected_state,value.expected_source_revision,
  value.identity_mapping_revision,value.identity_mapping_digest,canonicalJson(value.bindings),value.reason]) {
  const bytes=Buffer.from(field,'utf8'),length=Buffer.allocUnsafe(4);length.writeUInt32BE(bytes.length);hash.update(length).update(bytes);
 }
 return hash.digest();
}
