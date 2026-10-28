-- Keep ordinary retries away from recovery children without granting a
-- whole-row read or the discriminator column to the application role.
CREATE FUNCTION control.find_ordinary_ingestion_job(p_tenant text,p_source text,p_route text,p_key text)
RETURNS TABLE(id uuid,request_digest bytea,status text,received_count integer,applied_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
 IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN
  RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM control.ingestion_job j WHERE j.tenant_key=p_tenant AND j.source_id=p_source AND j.route=p_route
  AND j.idempotency_key=p_key AND j.import_recovery_operation_id IS NOT NULL) THEN
  RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
 RETURN QUERY SELECT j.id,j.request_digest,j.status,j.received_count,j.applied_count FROM control.ingestion_job j
  WHERE j.tenant_key=p_tenant AND j.source_id=p_source AND j.route=p_route AND j.idempotency_key=p_key
   AND j.import_recovery_operation_id IS NULL;
END $body$;
REVOKE ALL ON FUNCTION control.find_ordinary_ingestion_job(text,text,text,text) FROM PUBLIC,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.find_ordinary_ingestion_job(text,text,text,text) TO hub_api;

-- Private service boundary: the caller is the existing OIDC-authenticated Hub
-- service. SQL checks its current scoped principal; strings are not JWT proof.
CREATE FUNCTION control.lookup_import_recovery(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint,p_scope text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE envelope jsonb; src text; result jsonb;
BEGIN
 envelope:=control.import_recovery_authorize_internal(p_tenant,p_quarantine,p_user,p_issuer,p_subject,p_epoch,p_scope);
 IF envelope IS NULL THEN RETURN NULL; END IF;
 SELECT q.source_id INTO src FROM control.ingestion_quarantine_index q WHERE q.tenant_key=p_tenant AND q.quarantine_id=p_quarantine;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT pg_catalog.jsonb_build_object('operationId',o.operation_id::text,'childJobId',o.child_job_id::text,
  'idempotencyKey',o.idempotency_key,'requestDigest',pg_catalog.encode(o.request_digest,'hex'),
  'itemStatus',i.status,'jobStatus',j.status,'entity',j.entity,'batchId',j.batch_id::text,'record',i.public_record,
  'receipt',CASE WHEN i.status='APPLIED' THEN
   (SELECT pg_catalog.jsonb_build_object('channelId',r.channel_id::text,'channelEpoch',r.channel_epoch::text,
     'sourceVersion',r.source_version::text,'canonicalObjectId',r.canonical_object_id::text,
     'contentDigest',pg_catalog.encode(r.source_content_digest,'hex'))
    FROM control.source_version_receipt r WHERE (r.tenant_key,r.source_id,r.channel_id,r.channel_epoch,r.entity,r.source_pk,r.source_version,r.canonical_object_id)
     =(o.tenant_key,o.source_id,j.channel_id,j.channel_epoch,o.entity,o.source_pk,i.source_version,o.reserved_object_id))
   ELSE NULL END)
 INTO result FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.child_job_id
 JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(j.id,0)
 WHERE o.tenant_key=p_tenant AND o.quarantine_id=p_quarantine;
 RETURN pg_catalog.jsonb_build_object('sourceId',src,'operation',result);
END $body$;
REVOKE ALL ON FUNCTION control.lookup_import_recovery(text,uuid,text,text,text,bigint,text) FROM PUBLIC,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.lookup_import_recovery(text,uuid,text,text,text,bigint,text) TO hub_api;

-- P2 must run on this same transaction before this scoped writer. It derives
-- original and binding proof rows rather than accepting a caller-supplied plan.
CREATE FUNCTION control.admit_import_recovery(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint,
 p_key text,p_digest bytea,p_state text,p_reason text,p_source_revision bigint,p_identity_revision bigint,p_identity_digest bytea,
 p_bindings jsonb,p_operation uuid,p_child uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE envelope jsonb; src text; q control.ingestion_quarantine_index%ROWTYPE; j control.ingestion_job%ROWTYPE;
 i control.ingestion_job_item%ROWTYPE; reg control.source_registry%ROWTYPE; cred control.source_credential%ROWTYPE;
 ch control.source_channel%ROWTYPE; approval control.source_owner_approval%ROWTYPE; own uuid; fence bigint;
 expected text;
BEGIN
 envelope:=control.import_recovery_authorize_internal(p_tenant,p_quarantine,p_user,p_issuer,p_subject,p_epoch,'source:approve');
 IF envelope IS NULL OR envelope->'facts' IS NULL OR envelope->'facts'='null'::jsonb THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_CONFLICT' USING ERRCODE='P0001'; END IF;
 SELECT * INTO q FROM control.ingestion_quarantine_index WHERE tenant_key=p_tenant AND quarantine_id=p_quarantine;
 src:=q.source_id;
 SELECT * INTO j FROM control.ingestion_job WHERE id=q.job_id AND tenant_key=p_tenant AND source_id=src;
 SELECT * INTO i FROM control.ingestion_job_item WHERE job_id=j.id AND ordinal=q.ordinal;
 SELECT * INTO reg FROM control.source_registry WHERE tenant_key=p_tenant AND source_id=src;
 SELECT * INTO cred FROM control.source_credential WHERE tenant_key=p_tenant AND source_id=src;
 SELECT * INTO ch FROM control.source_channel WHERE tenant_key=p_tenant AND source_id=src AND entity=q.entity AND state='active';
 SELECT a.* INTO approval FROM control.source_owner_approval a WHERE a.tenant_key=p_tenant AND a.source_id=src
  AND a.owner_revision=reg.owner_revision AND a.config_revision=reg.current_config_revision
  AND a.mapping_revision=reg.mapping_revision AND a.identity_mapping_revision=reg.identity_mapping_revision
  ORDER BY a.approval_security_fence DESC,a.created_at DESC,a.id DESC LIMIT 1;
 expected:=pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(pg_catalog.convert_to('{"v":1,"kind":"IMPORT_RECOVERY","quarantine_id":"'||p_quarantine::text||'","generation":"0"}','UTF8'),'base64'),'+/','-_'),'=');
 -- PostgreSQL's base64 encoder inserts line breaks; canonical base64url does not.
 expected:=pg_catalog.replace(expected,E'\n','');
 IF src IS NULL OR j.id IS NULL OR i.job_id IS NULL OR reg.lifecycle IS DISTINCT FROM 'ACTIVE'
  OR reg.data_owner_user_id IS DISTINCT FROM p_user OR reg.current_config_revision IS DISTINCT FROM p_source_revision
  OR reg.identity_mapping_revision IS DISTINCT FROM p_identity_revision OR approval.id IS NULL
  OR approval.owner_user_id IS DISTINCT FROM p_user OR approval.identity_mapping_digest IS DISTINCT FROM p_identity_digest
  OR NOT cred.enabled OR NOT q.entity=ANY(cred.allowed_entities) OR ch.id IS NULL
  OR p_state IS DISTINCT FROM expected OR p_operation IS NULL OR p_child IS NULL OR p_operation=p_child
  OR p_key !~ '^[A-Za-z0-9._:-]{1,128}$' OR pg_catalog.octet_length(p_digest)<>32
  OR pg_catalog.jsonb_typeof(p_bindings) IS DISTINCT FROM 'array'
  OR EXISTS(SELECT 1 FROM control.import_recovery_operation WHERE quarantine_id=p_quarantine)
 THEN RAISE EXCEPTION 'IMPORT_RECOVERY_CONFLICT' USING ERRCODE='P0001'; END IF;
 fence:=control.lock_security_barrier_fence();
 -- The 014 original-facts resolver already took the sorted tuple advisory
 -- locks, including this absent identity, using the ordinary writer's key.
 SELECT canonical_object_id INTO own FROM control.canonical_source_identity
  WHERE (tenant_key,source_id,entity,source_pk)=(p_tenant,src,q.entity,q.source_pk) FOR UPDATE;
 IF own IS NULL THEN
  INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk)
   VALUES(p_tenant,src,q.entity,q.source_pk) ON CONFLICT(tenant_key,source_id,entity,source_pk) DO NOTHING;
  SELECT canonical_object_id INTO own FROM control.canonical_source_identity
   WHERE (tenant_key,source_id,entity,source_pk)=(p_tenant,src,q.entity,q.source_pk) FOR UPDATE;
 END IF;
 IF own IS NULL THEN RAISE EXCEPTION 'IMPORT_RECOVERY_CONFLICT' USING ERRCODE='P0001'; END IF;
 INSERT INTO control.import_recovery_operation(operation_id,tenant_key,source_id,entity,quarantine_id,original_job_id,original_ordinal,source_pk,
  reserved_object_id,child_job_id,route,idempotency_key,request_digest,expected_state,reason,actor_user_id,actor_issuer,actor_subject,actor_auth_epoch,owner_revision,
  binding_proof_version,binding_approval_id,binding_test_report_id,binding_config_revision,binding_config_digest,binding_mapping_revision,binding_mapping_digest,
  binding_identity_mapping_revision,binding_identity_mapping_digest,binding_sample_digest,binding_credential_id,binding_source_epoch,binding_credential_revision,
  binding_credential_generation,binding_channel_id,binding_channel_epoch,binding_approval_security_fence,binding_security_fence,confirmed_bindings)
 VALUES(p_operation,p_tenant,src,q.entity,p_quarantine,j.id,i.ordinal,i.source_pk,own,p_child,
  '/hub/v1/admin/quarantine/'||p_quarantine::text||'/import-recovery',p_key,p_digest,p_state,p_reason,p_user,p_issuer,p_subject,p_epoch,reg.owner_revision,
  1,approval.id,approval.test_report_id,approval.config_revision,approval.config_digest,approval.mapping_revision,approval.mapping_digest,
  approval.identity_mapping_revision,approval.identity_mapping_digest,approval.sample_digest,cred.id,cred.source_epoch,cred.revision,
  cred.credential_generation,ch.id,ch.channel_epoch,approval.approval_security_fence,fence,p_bindings);
 INSERT INTO control.ingestion_job(id,tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,request_digest,status,received_count,applied_count,
  credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,channel_id,channel_epoch,version_domain,
  owner_approval_id,owner_user_id,owner_revision,approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,
  identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,
  first_source_updated_at,last_source_updated_at,import_recovery_operation_id)
 VALUES(p_child,j.tenant_key,j.source_id,j.entity,j.route,j.batch_id,j.raw_batch_id,'import-recovery-'||p_child::text,j.request_digest,'RECEIVED',1,0,
  j.credential_id,j.source_epoch_at_admission,j.credential_revision_at_admission,j.credential_generation_at_admission,j.channel_id,j.channel_epoch,j.version_domain,
  j.owner_approval_id,j.owner_user_id,j.owner_revision,j.approval_security_fence,j.config_revision,j.config_digest,j.mapping_revision,j.mapping_digest,
  j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,j.security_barrier_fence_at_admission,
  i.source_updated_at,i.source_updated_at,p_operation);
 INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status)
 VALUES(p_child,0,i.event_id,i.source_pk,i.source_version,i.operation,i.source_updated_at,i.public_record,'RECEIVED');
 INSERT INTO control.ingestion_processing_outbox(job_id) VALUES(p_child);
END $body$;
REVOKE ALL ON FUNCTION control.admit_import_recovery(text,uuid,text,text,text,bigint,text,bytea,text,text,bigint,bigint,bytea,jsonb,uuid,uuid)
 FROM PUBLIC,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.admit_import_recovery(text,uuid,text,text,text,bigint,text,bytea,text,text,bigint,bigint,bytea,jsonb,uuid,uuid) TO hub_api;

-- 015's POSIX locale classes differ from the existing JavaScript contract.
-- PostgreSQL text/JSONB already excludes U+0000; list all remaining C0 and
-- DEL explicitly, and use the ECMAScript WhiteSpace/LineTerminator set for
-- edges. No source spelling is normalized here.
CREATE FUNCTION control.import_recovery_has_c0_del(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $body$
 SELECT p_value<>pg_catalog.translate(p_value,
  U&'\0001\0002\0003\0004\0005\0006\0007\0008\0009\000A\000B\000C\000D\000E\000F\0010\0011\0012\0013\0014\0015\0016\0017\0018\0019\001A\001B\001C\001D\001E\001F\007F','')
$body$;
CREATE FUNCTION control.import_recovery_is_js_trimmed(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $body$
 SELECT p_value=pg_catalog.btrim(p_value,
  U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$body$;
REVOKE ALL ON FUNCTION control.import_recovery_has_c0_del(text),control.import_recovery_is_js_trimmed(text)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

ALTER TABLE control.import_recovery_operation
 DROP CONSTRAINT import_recovery_operation_reason_check,
 ADD CONSTRAINT import_recovery_operation_reason_check CHECK (char_length(reason) BETWEEN 1 AND 1000 AND control.import_recovery_is_js_trimmed(reason)),
 DROP CONSTRAINT import_recovery_operation_actor_issuer_check,
 ADD CONSTRAINT import_recovery_operation_actor_issuer_check CHECK (char_length(actor_issuer) BETWEEN 1 AND 2048),
 DROP CONSTRAINT import_recovery_operation_actor_subject_check,
 ADD CONSTRAINT import_recovery_operation_actor_subject_check CHECK (char_length(actor_subject) BETWEEN 1 AND 2048);

-- The following checker is the 015 body with only the three identified
-- locale-dependent binding predicates replaced by the explicit rules above.
CREATE OR REPLACE FUNCTION control.check_import_recovery_cycle(p_operation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE o control.import_recovery_operation%ROWTYPE; j control.ingestion_job%ROWTYPE; c control.ingestion_job%ROWTYPE;
 i control.ingestion_job_item%ROWTYPE; ci control.ingestion_job_item%ROWTYPE; q control.ingestion_quarantine_index%ROWTYPE;
 b jsonb; maps jsonb; n integer; k text;
BEGIN
 SELECT * INTO o FROM control.import_recovery_operation WHERE operation_id=p_operation;
 IF NOT FOUND THEN RAISE EXCEPTION 'missing import recovery operation' USING ERRCODE='23514'; END IF;
 SELECT * INTO j FROM control.ingestion_job WHERE id=o.original_job_id;
 SELECT * INTO i FROM control.ingestion_job_item WHERE job_id=o.original_job_id AND ordinal=o.original_ordinal;
 SELECT * INTO q FROM control.ingestion_quarantine_index WHERE quarantine_id=o.quarantine_id;
 SELECT * INTO c FROM control.ingestion_job WHERE id=o.child_job_id;
 SELECT * INTO ci FROM control.ingestion_job_item WHERE job_id=o.child_job_id AND ordinal=0;
 IF j.id IS NULL OR i.job_id IS NULL OR q.quarantine_id IS NULL OR c.id IS NULL OR ci.job_id IS NULL
  OR j.import_recovery_operation_id IS NOT NULL OR c.import_recovery_operation_id IS DISTINCT FROM o.operation_id
  OR (c.tenant_key,c.source_id,c.entity) IS DISTINCT FROM (o.tenant_key,o.source_id,o.entity)
  OR (q.origin_kind,q.status,q.job_id,q.ordinal,q.source_pk) IS DISTINCT FROM ('IMPORT','QUARANTINED',j.id,i.ordinal,i.source_pk)
  OR (i.event_id,i.source_pk,i.error_code) IS DISTINCT FROM (q.event_id,q.source_pk,q.error_code)
  OR i.status<>'QUARANTINED' OR i.operation<>'UPSERT' OR i.ordinal>=j.received_count
  OR (((j.entity='customer' AND q.error_code='IDENTITY_MAPPING_REQUIRED') OR
          (j.entity='order' AND q.error_code IN ('IDENTITY_MAPPING_REQUIRED','IDENTITY_MAPPING_TARGET_INVALID'))) IS NOT TRUE)
  OR j.route IS DISTINCT FROM '/hub/v1/admin/sources/'||j.source_id||'/import/'||j.entity
  OR j.endpoint_profile_digest IS NOT NULL OR j.version_domain<>'SOURCE_VERSION'
  OR NOT EXISTS (SELECT 1 FROM control.ingestion_management_admission_audit a WHERE (a.job_id,a.tenant_key,a.source_id)=(j.id,j.tenant_key,j.source_id))
  OR EXISTS (SELECT 1 FROM control.ingestion_management_admission_audit a WHERE a.job_id=c.id)
  OR (q.owner_approval_id,q.owner_revision,q.channel_id,q.channel_epoch,q.config_revision,q.config_digest,q.mapping_revision,q.mapping_digest,
      q.identity_mapping_revision,q.identity_mapping_digest,q.endpoint_profile_digest,q.test_report_id,q.approval_security_fence,q.security_barrier_fence_at_admission)
    IS DISTINCT FROM (j.owner_approval_id,j.owner_revision,j.channel_id,j.channel_epoch,j.config_revision,j.config_digest,j.mapping_revision,j.mapping_digest,
      j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,j.approval_security_fence,j.security_barrier_fence_at_admission)
 THEN RAISE EXCEPTION 'invalid import recovery origin or child' USING ERRCODE='23514'; END IF;
 IF c.received_count<>1 OR (SELECT count(*) FROM control.ingestion_job_item x WHERE x.job_id=c.id)<>1
  OR (SELECT count(*) FROM control.ingestion_processing_outbox x WHERE x.job_id=c.id)<>1
  OR (SELECT count(*) FROM control.ingestion_job x WHERE x.import_recovery_operation_id=o.operation_id)<>1
  OR ci.operation_id=i.operation_id
  OR (ci.event_id,ci.source_pk,ci.source_version,ci.operation,ci.source_updated_at,ci.public_record)
    IS DISTINCT FROM (i.event_id,i.source_pk,i.source_version,i.operation,i.source_updated_at,i.public_record)
  OR (c.route,c.batch_id,c.raw_batch_id,c.request_digest,c.credential_id,c.source_epoch_at_admission,c.credential_revision_at_admission,
      c.credential_generation_at_admission,c.channel_id,c.channel_epoch,c.version_domain,c.owner_approval_id,c.owner_user_id,c.owner_revision,
      c.approval_security_fence,c.config_revision,c.config_digest,c.mapping_revision,c.mapping_digest,c.identity_mapping_revision,
      c.identity_mapping_digest,c.endpoint_profile_digest,c.test_report_id,c.security_barrier_fence_at_admission,c.first_source_updated_at,c.last_source_updated_at)
    IS DISTINCT FROM (j.route,j.batch_id,j.raw_batch_id,j.request_digest,j.credential_id,j.source_epoch_at_admission,j.credential_revision_at_admission,
      j.credential_generation_at_admission,j.channel_id,j.channel_epoch,j.version_domain,j.owner_approval_id,j.owner_user_id,j.owner_revision,
      j.approval_security_fence,j.config_revision,j.config_digest,j.mapping_revision,j.mapping_digest,j.identity_mapping_revision,
      j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,j.security_barrier_fence_at_admission,i.source_updated_at,i.source_updated_at)
 THEN RAISE EXCEPTION 'invalid import recovery child facts or cardinality' USING ERRCODE='23514'; END IF;

 IF NOT EXISTS (
  SELECT 1 FROM control.source_owner_approval a
  JOIN control.source_test_report t ON (t.tenant_key,t.source_id,t.id)=(a.tenant_key,a.source_id,a.test_report_id)
  JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(a.tenant_key,a.source_id,a.config_revision)
  JOIN control.source_mapping_revision mr ON (mr.tenant_key,mr.source_id,mr.revision)=(a.tenant_key,a.source_id,a.mapping_revision)
  JOIN control.source_identity_mapping_revision im ON (im.tenant_key,im.source_id,im.revision)=(a.tenant_key,a.source_id,a.identity_mapping_revision)
  JOIN control.source_channel ch ON (ch.id,ch.tenant_key,ch.source_id,ch.entity,ch.channel_epoch)=(o.binding_channel_id,o.tenant_key,o.source_id,o.entity,o.binding_channel_epoch)
  JOIN control.source_credential cred ON (cred.id,cred.tenant_key,cred.source_id)=(o.binding_credential_id,o.tenant_key,o.source_id)
  WHERE (a.tenant_key,a.source_id,a.id)=(o.tenant_key,o.source_id,o.binding_approval_id)
   AND (a.owner_user_id,a.owner_revision,a.test_report_id,a.approval_security_fence)=(o.actor_user_id,o.owner_revision,o.binding_test_report_id,o.binding_approval_security_fence)
   AND (a.config_revision,a.config_digest,a.mapping_revision,a.mapping_digest,a.identity_mapping_revision,a.identity_mapping_digest,
        a.source_credential_revision,a.credential_generation,a.sample_digest)
     =(o.binding_config_revision,o.binding_config_digest,o.binding_mapping_revision,o.binding_mapping_digest,o.binding_identity_mapping_revision,o.binding_identity_mapping_digest,
        o.binding_credential_revision,o.binding_credential_generation,o.binding_sample_digest)
   AND (t.config_revision,t.config_digest,t.mapping_revision,t.mapping_digest,t.identity_mapping_revision,t.identity_mapping_digest,
        t.source_credential_revision,t.credential_generation,t.sample_digest,t.data_contract_ref)
     =(a.config_revision,a.config_digest,a.mapping_revision,a.mapping_digest,a.identity_mapping_revision,a.identity_mapping_digest,
        a.source_credential_revision,a.credential_generation,a.sample_digest,a.data_contract_ref)
   AND t.status='PASS' AND t.endpoint_profile_digest IS NULL AND a.endpoint_profile_digest IS NULL
   AND (cr.config_digest,mr.mapping_digest,im.mapping_digest)=(o.binding_config_digest,o.binding_mapping_digest,o.binding_identity_mapping_digest)
   AND cr.config->>'connector'='SIMULATED_IMPORT' AND cr.config->>'mode'='INCREMENTAL' AND cr.config->>'version_domain'='SOURCE_VERSION'
   AND cr.config->'allowed_entities' ? o.entity AND ch.connector='SIMULATED_IMPORT' AND ch.mode='INCREMENTAL' AND ch.version_domain='SOURCE_VERSION'
   AND cred.authority_kind='SIMULATED_IMPORT'
 ) THEN RAISE EXCEPTION 'invalid import recovery binding proof' USING ERRCODE='23514'; END IF;

 IF pg_catalog.jsonb_typeof(o.confirmed_bindings) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'invalid import recovery bindings' USING ERRCODE='23514'; END IF;
 n:=pg_catalog.jsonb_array_length(o.confirmed_bindings);
 IF n NOT BETWEEN 1 AND 2 OR (o.entity='order' AND n<>1) THEN
  RAISE EXCEPTION 'invalid import recovery bindings' USING ERRCODE='23514'; END IF;
 SELECT m.mappings INTO maps FROM control.source_identity_mapping_revision m
  WHERE (m.tenant_key,m.source_id,m.revision)=(o.tenant_key,o.source_id,o.binding_identity_mapping_revision);
 IF pg_catalog.jsonb_typeof(maps) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid import recovery mappings' USING ERRCODE='23514'; END IF;
 FOR b IN SELECT value FROM pg_catalog.jsonb_array_elements(o.confirmed_bindings) LOOP
  k:=b->>'kind';
  IF pg_catalog.jsonb_typeof(b) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(b->'kind') IS DISTINCT FROM 'string'
   OR pg_catalog.jsonb_typeof(b->'externalId') IS DISTINCT FROM 'string' OR pg_catalog.jsonb_typeof(b->'targetId') IS DISTINCT FROM 'string'
   OR char_length(b->>'externalId') NOT BETWEEN 1 AND 256 OR char_length(b->>'targetId') NOT BETWEEN 1 AND 256
   OR control.import_recovery_has_c0_del(b->>'externalId') OR control.import_recovery_has_c0_del(b->>'targetId')
  THEN RAISE EXCEPTION 'invalid import recovery binding' USING ERRCODE='23514'; END IF;
  IF o.entity='customer' THEN
   IF k NOT IN ('user','department') OR b - 'kind' - 'externalId' - 'targetId' <> '{}'::jsonb
    OR char_length(b->>'externalId')>128 OR NOT control.import_recovery_is_js_trimmed(b->>'externalId')
    OR (k='user' AND b->>'externalId' IS DISTINCT FROM i.public_record->'data'->>'owner_external_id')
    OR (k='department' AND b->>'externalId' IS DISTINCT FROM i.public_record->'data'->>'department_external_id')
   THEN RAISE EXCEPTION 'invalid import recovery customer binding' USING ERRCODE='23514'; END IF;
  ELSE
   IF k IS DISTINCT FROM 'customer' OR b - 'kind' - 'sourceId' - 'sourcePk' - 'externalId' - 'targetId' <> '{}'::jsonb
    OR pg_catalog.jsonb_typeof(b->'sourceId') IS DISTINCT FROM 'string' OR pg_catalog.jsonb_typeof(b->'sourcePk') IS DISTINCT FROM 'string'
    OR (b->>'sourceId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR char_length(b->>'sourcePk') NOT BETWEEN 1 AND 128
    OR control.import_recovery_has_c0_del(b->>'sourcePk') OR NOT control.import_recovery_is_js_trimmed(b->>'sourcePk')
    OR (b->>'targetId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (b->>'sourceId',b->>'sourcePk') IS DISTINCT FROM (i.public_record->'data'->'customer_ref'->>'source_id',i.public_record->'data'->'customer_ref'->>'source_pk')
   THEN RAISE EXCEPTION 'invalid import recovery order binding' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(maps) m WHERE (m->>'kind',m->>'external_id',m->>'target_id')=(k,b->>'externalId',b->>'targetId')) THEN
   RAISE EXCEPTION 'invalid import recovery binding' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF n=2 AND (o.confirmed_bindings->0->>'kind',o.confirmed_bindings->1->>'kind') IS DISTINCT FROM ('user','department') THEN
  RAISE EXCEPTION 'invalid import recovery binding order' USING ERRCODE='23514'; END IF;
END $body$;
REVOKE ALL ON FUNCTION control.check_import_recovery_cycle(uuid)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
