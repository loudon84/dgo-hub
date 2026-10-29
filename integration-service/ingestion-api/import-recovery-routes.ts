import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { AuthError } from '../auth/errors.js';
import type { AuthService } from '../auth/types.js';
import type { OidcAuthenticator } from '../auth/oidc.js';
import { sourceToken } from './strict-ingestion.js';
import { IMPORT_RECOVERY_BODY_LIMIT, IMPORT_RECOVERY_UUID, parseImportRecoveryRequest } from './import-recovery-contract.js';
import { getImportRecovery, ImportRecoveryError, postImportRecovery } from './import-recovery-admission.js';

type Options=Readonly<{pool:Pool;authService:Pick<AuthService,'assertCurrentPrincipal'>;authenticator:OidcAuthenticator}>;
function header(request:FastifyRequest,name:string,authentication=false):string {
 let count=0;for(let i=0;i<request.raw.rawHeaders.length;i+=2) if(request.raw.rawHeaders[i]?.toLowerCase()===name) count++;
 const value=request.headers[name];
 if(count!==1 || typeof value!=='string') throw new AuthError(authentication?'AUTH_INVALID':'AUTH_INPUT_INVALID');
 return value;
}
async function authenticate(request:FastifyRequest,options:Options) {
 const match=/^Bearer ([A-Za-z0-9._~-]{1,16384})$/.exec(header(request,'authorization',true));
 if(!match || sourceToken(match[1]!)) throw new AuthError('AUTH_INVALID');
 return options.authenticator(match[1]!);
}
function failure(request:FastifyRequest,reply:FastifyReply,error:unknown) {
 const code=error instanceof AuthError || error instanceof ImportRecoveryError ? error.code : 'AUTH_UNAVAILABLE';
 const status=error instanceof AuthError?error.status:error instanceof ImportRecoveryError?409:503;
 return reply.code(status).send({request_id:request.id,error:{code,message:code,retryable:status===503,details:{}}});
}
/** Local candidate registrar; stop or upgrade incompatible claimants before enabling these routes. */
export async function registerImportRecoveryRoutes(app:FastifyInstance,options:Options):Promise<void> {
 app.register(async scope=>{
  scope.removeContentTypeParser('application/json');
  scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
  scope.setErrorHandler((_error,request,reply)=>failure(request,reply,new AuthError('AUTH_INPUT_INVALID')));
  scope.get<{Params:{id:string}}>('/hub/v1/admin/quarantine/:id/import-recovery',async(request,reply)=>{
   try {
    if(!IMPORT_RECOVERY_UUID.test(request.params.id)) throw new AuthError('AUTH_INPUT_INVALID');
    const principal=await authenticate(request,options);
    return reply.send({request_id:request.id,data:await getImportRecovery(options,principal,request.params.id)});
   } catch(error) {return failure(request,reply,error);}
  });
  scope.post<{Params:{id:string}}>('/hub/v1/admin/quarantine/:id/import-recovery',{bodyLimit:IMPORT_RECOVERY_BODY_LIMIT},async(request,reply)=>{
   try {
    if(!IMPORT_RECOVERY_UUID.test(request.params.id)) throw new AuthError('AUTH_INPUT_INVALID');
    const principal=await authenticate(request,options);
    if(header(request,'content-type').split(';')[0]?.trim().toLowerCase()!=='application/json') throw new AuthError('AUTH_INPUT_INVALID');
    const key=header(request,'idempotency-key');if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new AuthError('AUTH_INPUT_INVALID');
    const body=parseImportRecoveryRequest(request.body);
    const data=await postImportRecovery(options,principal,request.params.id,key,body);
    return reply.code(202).send({request_id:request.id,data});
   } catch(error) {return failure(request,reply,error);}
  });
 });
}
