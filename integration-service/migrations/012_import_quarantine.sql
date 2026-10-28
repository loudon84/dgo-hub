-- Extend the immutable quarantine index without changing historical migrations.
DO $body$
DECLARE r record;
BEGIN
 FOR r IN SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='control.ingestion_quarantine_index'::regclass AND contype='c' LOOP
   IF r.def LIKE '%origin_kind%' AND r.def LIKE '%SNAPSHOT%' THEN
     EXECUTE format('ALTER TABLE control.ingestion_quarantine_index DROP CONSTRAINT %I',r.conname);
   END IF;
 END LOOP;
END;
$body$;
ALTER TABLE control.ingestion_quarantine_index ADD CONSTRAINT ingestion_quarantine_origin_v012 CHECK (origin_kind IN ('REST','SNAPSHOT','IMPORT'));
ALTER TABLE control.ingestion_quarantine_index ADD CONSTRAINT ingestion_quarantine_shape_v012 CHECK(
    (origin_kind='REST' AND job_id IS NOT NULL AND ordinal IS NOT NULL AND event_id IS NOT NULL AND
      run_id IS NULL AND attempt_id IS NULL AND outcome_id IS NULL AND relation IS NULL AND parent_source_pk IS NULL AND
      owner_approval_id IS NOT NULL AND owner_revision IS NOT NULL AND channel_id IS NOT NULL AND channel_epoch IS NOT NULL AND
      config_revision IS NOT NULL AND config_digest IS NOT NULL AND mapping_revision IS NOT NULL AND mapping_digest IS NOT NULL AND
      identity_mapping_revision IS NOT NULL AND identity_mapping_digest IS NOT NULL AND endpoint_profile_digest IS NOT NULL AND
      test_report_id IS NOT NULL AND approval_security_fence IS NOT NULL AND security_barrier_fence_at_admission IS NOT NULL AND
      aggregate_digest IS NULL AND proof_scope_digest IS NULL)
    OR
    (origin_kind='IMPORT' AND job_id IS NOT NULL AND ordinal IS NOT NULL AND event_id IS NOT NULL AND
      run_id IS NULL AND attempt_id IS NULL AND outcome_id IS NULL AND relation IS NULL AND parent_source_pk IS NULL AND
      owner_approval_id IS NOT NULL AND owner_revision IS NOT NULL AND channel_id IS NOT NULL AND channel_epoch IS NOT NULL AND
      config_revision IS NOT NULL AND config_digest IS NOT NULL AND mapping_revision IS NOT NULL AND mapping_digest IS NOT NULL AND
      identity_mapping_revision IS NOT NULL AND identity_mapping_digest IS NOT NULL AND endpoint_profile_digest IS NULL AND
      test_report_id IS NOT NULL AND approval_security_fence IS NOT NULL AND security_barrier_fence_at_admission IS NOT NULL AND
      aggregate_digest IS NULL AND proof_scope_digest IS NULL)
    OR
    (origin_kind='SNAPSHOT' AND job_id IS NULL AND ordinal IS NULL AND event_id IS NULL AND source_pk IS NOT NULL AND
      run_id IS NOT NULL AND attempt_id IS NOT NULL AND outcome_id IS NOT NULL AND entity=relation AND
      parent_source_pk IS NOT NULL AND owner_approval_id IS NULL AND owner_revision IS NULL AND channel_id IS NULL AND channel_epoch IS NULL AND
      config_revision IS NULL AND config_digest IS NULL AND mapping_revision IS NULL AND mapping_digest IS NULL AND
      identity_mapping_revision IS NULL AND identity_mapping_digest IS NULL AND endpoint_profile_digest IS NULL AND test_report_id IS NULL AND
      approval_security_fence IS NULL AND security_barrier_fence_at_admission IS NULL AND
      aggregate_digest IS NOT NULL AND octet_length(aggregate_digest)=32 AND proof_scope_digest IS NOT NULL AND octet_length(proof_scope_digest)=32)
  );
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_quarantine_import_origin_key ON control.ingestion_quarantine_index(tenant_key,source_id,job_id,ordinal) WHERE origin_kind='IMPORT';

CREATE OR REPLACE FUNCTION control.capture_rest_ingestion_quarantine_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF NEW.status IS DISTINCT FROM 'QUARANTINED' OR OLD.status IS NOT DISTINCT FROM 'QUARANTINED' THEN RETURN NEW; END IF;
  INSERT INTO control.ingestion_quarantine_index(origin_kind,tenant_key,source_id,entity,job_id,ordinal,event_id,source_pk,
    status,error_code,created_at,owner_approval_id,owner_revision,channel_id,channel_epoch,config_revision,config_digest,
    mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,
    approval_security_fence,security_barrier_fence_at_admission)
  SELECT CASE WHEN j.route='/hub/v1/admin/sources/'||j.source_id||'/import/'||j.entity AND j.endpoint_profile_digest IS NULL THEN 'IMPORT' WHEN j.route IN ('/hub/v1/ingest/crm/customers','/hub/v1/ingest/orders/orders') AND j.endpoint_profile_digest IS NOT NULL THEN 'REST' ELSE NULL END,j.tenant_key,j.source_id,j.entity,NEW.job_id,NEW.ordinal,NEW.event_id,NEW.source_pk,
    'QUARANTINED',CASE WHEN NEW.error_code IS NOT NULL AND char_length(NEW.error_code)<=96 AND NEW.error_code ~ '^[A-Z0-9_:-]+$' THEN NEW.error_code ELSE NULL END,
    NEW.updated_at,j.owner_approval_id,j.owner_revision,j.channel_id,j.channel_epoch,j.config_revision,j.config_digest,
    j.mapping_revision,j.mapping_digest,j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,
    j.approval_security_fence,j.security_barrier_fence_at_admission
    FROM control.ingestion_job j WHERE j.id=NEW.job_id AND j.tenant_key IS NOT NULL;
  RETURN NEW;
END;
$body$;

CREATE OR REPLACE FUNCTION control.list_ingestion_quarantine_current_owner(
  p_tenant_key text,p_source_id text,p_user_id text,p_issuer text,p_subject text,p_auth_epoch bigint,p_owner_revision bigint,
  p_origin_kind text,p_error_code text,p_after_created_at timestamptz,p_after_quarantine_id uuid,p_limit integer)
RETURNS TABLE(quarantine_id uuid,origin_kind text,source_id text,entity text,relation text,parent_source_pk text,job_id uuid,ordinal integer,
  event_id uuid,run_id uuid,attempt_id uuid,outcome_id uuid,source_pk text,status text,error_code text,created_at text,proof jsonb,
  dependency_status text,dependency_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE source_row control.source_registry%ROWTYPE; current_epoch bigint; scopes text[];
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_tenant_key IS NULL OR p_source_id IS NULL OR p_user_id IS NULL OR p_issuer IS NULL OR p_subject IS NULL OR
     p_auth_epoch IS NULL OR p_owner_revision IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR
     (p_origin_kind IS NOT NULL AND p_origin_kind NOT IN ('REST','SNAPSHOT','IMPORT')) OR
     (p_error_code IS NOT NULL AND (char_length(p_error_code) NOT BETWEEN 1 AND 96 OR p_error_code !~ '^[A-Z0-9_:-]+$')) OR
     ((p_after_created_at IS NULL) <> (p_after_quarantine_id IS NULL)) THEN RETURN; END IF;
  PERFORM control.lock_security_barrier_fence();
  PERFORM * FROM control.lock_source_credential(p_tenant_key,p_source_id);
  SELECT * INTO source_row FROM control.source_registry r WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id FOR UPDATE;
  IF NOT FOUND OR source_row.data_owner_user_id IS DISTINCT FROM p_user_id OR source_row.owner_revision IS DISTINCT FROM p_owner_revision THEN RETURN; END IF;
  SELECT s.auth_epoch,s.management_scopes INTO current_epoch,scopes
    FROM control.auth_subject s JOIN control.tenant t ON t.tenant_key=s.tenant_key
    JOIN control.identity_binding b ON (b.tenant_key,b.user_id)=(s.tenant_key,s.user_id)
    WHERE s.tenant_key=p_tenant_key AND s.user_id=p_user_id AND b.issuer=p_issuer AND b.subject=p_subject
      AND t.enabled AND s.enabled AND b.enabled FOR UPDATE OF t,s,b;
  IF NOT FOUND OR current_epoch IS DISTINCT FROM p_auth_epoch OR NOT (scopes @> ARRAY['source:read']::text[]) THEN RETURN; END IF;
  RETURN QUERY
  SELECT i.quarantine_id,i.origin_kind,i.source_id,i.entity,i.relation,i.parent_source_pk,i.job_id,i.ordinal,i.event_id,
    i.run_id,i.attempt_id,i.outcome_id,i.source_pk,i.status,i.error_code,
    to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    CASE WHEN i.origin_kind IN ('REST','IMPORT') THEN jsonb_build_object(
      'owner_approval_id',i.owner_approval_id::text,'owner_revision',i.owner_revision::text,'channel_id',i.channel_id::text,
      'channel_epoch',i.channel_epoch::text,'config_revision',i.config_revision::text,'config_digest',encode(i.config_digest,'hex'),
      'mapping_revision',i.mapping_revision::text,'mapping_digest',encode(i.mapping_digest,'hex'),
      'identity_mapping_revision',i.identity_mapping_revision::text,'identity_mapping_digest',encode(i.identity_mapping_digest,'hex'),
      'endpoint_profile_digest',encode(i.endpoint_profile_digest,'hex'),'test_report_id',i.test_report_id::text,
      'approval_security_fence',i.approval_security_fence::text,'security_barrier_fence_at_admission',i.security_barrier_fence_at_admission::text)
    ELSE jsonb_build_object('aggregate_digest',encode(i.aggregate_digest,'hex'),'proof_scope_digest',encode(i.proof_scope_digest,'hex')) END,
    i.dependency_status,i.dependency_code
  FROM control.ingestion_quarantine_index i
  WHERE i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND (p_origin_kind IS NULL OR i.origin_kind=p_origin_kind)
    AND (p_error_code IS NULL OR i.error_code=p_error_code)
    AND (p_after_created_at IS NULL OR i.created_at<p_after_created_at OR
      (i.created_at=p_after_created_at AND i.quarantine_id<p_after_quarantine_id))
  ORDER BY i.created_at DESC,i.quarantine_id DESC LIMIT p_limit+1;
END;
$body$;

CREATE OR REPLACE FUNCTION control.list_quarantine_retry_state(p_tenant text,p_source text,p_user text,p_issuer text,p_subject text,
  p_epoch bigint,p_owner_revision bigint,p_ids uuid[]) RETURNS TABLE(quarantine_id uuid,state text,operation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE reg control.source_registry%ROWTYPE; epoch bigint; scopes text[];
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM control.lock_security_barrier_fence();
  PERFORM * FROM control.lock_source_credential(p_tenant,p_source);
  SELECT * INTO reg FROM control.source_registry r WHERE r.tenant_key=p_tenant AND r.source_id=p_source FOR UPDATE;
  IF NOT FOUND OR reg.data_owner_user_id IS DISTINCT FROM p_user OR reg.owner_revision IS DISTINCT FROM p_owner_revision THEN RETURN; END IF;
  SELECT s.auth_epoch,s.management_scopes INTO epoch,scopes FROM control.auth_subject s JOIN control.tenant t ON t.tenant_key=s.tenant_key
    JOIN control.identity_binding b ON (b.tenant_key,b.user_id)=(s.tenant_key,s.user_id)
    WHERE s.tenant_key=p_tenant AND s.user_id=p_user AND b.issuer=p_issuer AND b.subject=p_subject AND t.enabled AND s.enabled AND b.enabled
    FOR UPDATE OF t,s,b;
  IF NOT FOUND OR epoch IS DISTINCT FROM p_epoch OR NOT (scopes @> ARRAY['source:read']::text[]) THEN RETURN; END IF;
  RETURN QUERY SELECT q.quarantine_id,CASE WHEN q.origin_kind IN ('SNAPSHOT','IMPORT') THEN 'SCOPE_UNAVAILABLE'
    WHEN r.operation_id IS NULL THEN 'AVAILABLE' ELSE 'ACCEPTED' END,r.operation_id
    FROM control.ingestion_quarantine_index q LEFT JOIN control.ingestion_recovery_operation r ON r.quarantine_id=q.quarantine_id
    WHERE q.tenant_key=p_tenant AND q.source_id=p_source AND q.quarantine_id=ANY(p_ids);
END;
$body$;

CREATE OR REPLACE FUNCTION control.create_rest_recovery(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint,
  p_owner_revision bigint,p_key text,p_digest bytea,p_expected text,p_mapping bigint,p_reason text,p_operation uuid,p_child uuid,p_child_key text)
RETURNS TABLE(code text,operation_id uuid,child_job_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub AS $body$
DECLARE resolved record; q control.ingestion_quarantine_index%ROWTYPE; j control.ingestion_job%ROWTYPE; i control.ingestion_job_item%ROWTYPE;
  existing control.ingestion_recovery_operation%ROWTYPE; binding jsonb; child_digest bytea;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO resolved FROM control.resolve_recovery_owner_origin(p_tenant,p_quarantine,p_user,p_issuer,p_subject,p_epoch);
  IF NOT FOUND OR resolved.owner_revision IS DISTINCT FROM p_owner_revision THEN RETURN QUERY SELECT 'SOURCE_NOT_FOUND',NULL::uuid,NULL::uuid; RETURN; END IF;
  SELECT * INTO q FROM control.ingestion_quarantine_index WHERE quarantine_id=p_quarantine AND tenant_key=p_tenant AND source_id=resolved.source_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'SOURCE_NOT_FOUND',NULL::uuid,NULL::uuid; RETURN; END IF;
  IF q.origin_kind<>'REST' THEN RETURN QUERY SELECT 'RECOVERY_SCOPE_UNAVAILABLE',NULL::uuid,NULL::uuid; RETURN; END IF;
  IF p_key !~ '^[A-Za-z0-9._:-]{1,128}$' OR p_child_key !~ '^[A-Za-z0-9._:-]{1,128}$' OR octet_length(p_digest)<>32
    OR p_operation IS NULL OR p_child IS NULL OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 2 AND 6002 THEN
    RETURN QUERY SELECT 'AUTH_INPUT_INVALID',NULL::uuid,NULL::uuid; RETURN; END IF;
  IF p_digest IS DISTINCT FROM control.recovery_child_digest_internal(ARRAY['hub.recovery.api024.v1',p_tenant,q.source_id,
    '/hub/v1/admin/quarantine/{quarantine_id}/retry',p_quarantine::text,p_expected,p_mapping::text,p_reason]) THEN
    RETURN QUERY SELECT 'AUTH_INPUT_INVALID',NULL::uuid,NULL::uuid; RETURN; END IF;
  SELECT * INTO existing FROM control.ingestion_recovery_operation WHERE tenant_key=p_tenant AND source_id=q.source_id
    AND route='/hub/v1/admin/quarantine/{quarantine_id}/retry' AND idempotency_key=p_key;
  IF FOUND AND (existing.request_digest IS DISTINCT FROM p_digest OR existing.quarantine_id<>p_quarantine) THEN
    RETURN QUERY SELECT 'IDEMPOTENCY_CONFLICT',NULL::uuid,NULL::uuid; RETURN; END IF;
  IF p_mapping IS DISTINCT FROM q.mapping_revision OR p_expected IS DISTINCT FROM
    translate(rtrim(replace(encode(convert_to('{"v":1,"quarantine_id":"'||p_quarantine::text||'","generation":"0"}','UTF8'),'base64'),E'\n',''),'='),'+/','-_') THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT',NULL::uuid,NULL::uuid; RETURN; END IF;
  binding:=control.recovery_binding_internal(p_quarantine);
  IF binding IS NULL THEN RETURN QUERY SELECT 'RECOVERY_TARGET_CONFLICT',NULL::uuid,NULL::uuid; RETURN; END IF;
  IF existing.operation_id IS NOT NULL AND (existing.approved_by,existing.approved_owner_revision)
      IS DISTINCT FROM (p_user,p_owner_revision) THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT',NULL::uuid,NULL::uuid; RETURN; END IF;
  IF existing.operation_id IS NOT NULL THEN
    IF (existing.binding_kind,existing.own_object_id::text,existing.user_external_id,existing.user_target_id,
        existing.department_external_id,existing.department_target_id,existing.customer_source_id,existing.customer_source_pk,existing.customer_object_id::text)
      IS DISTINCT FROM (binding->>'kind',binding->>'own',binding->>'user_external',binding->>'user_target',
        binding->>'department_external',binding->>'department_target',binding->>'customer_source',binding->>'customer_pk',binding->>'customer_object') THEN
      RETURN QUERY SELECT 'RECOVERY_TARGET_CONFLICT',NULL::uuid,NULL::uuid; RETURN; END IF;
    RETURN QUERY SELECT 'ACCEPTED',existing.operation_id,existing.child_job_id; RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM control.ingestion_recovery_operation WHERE quarantine_id=p_quarantine) THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT',NULL::uuid,NULL::uuid; RETURN; END IF;
  SELECT * INTO j FROM control.ingestion_job WHERE id=q.job_id;
  SELECT * INTO i FROM control.ingestion_job_item WHERE job_id=q.job_id AND ordinal=q.ordinal;
  child_digest:=control.recovery_child_digest_internal(ARRAY['hub.recovery.rest.v1',j.tenant_key,j.source_id,j.route,p_quarantine::text,
    p_operation::text,j.id::text,i.ordinal::text,i.event_id::text,i.source_pk,i.source_version::text,i.operation,j.channel_id::text,
    j.channel_epoch::text,j.owner_approval_id::text,encode(j.config_digest,'hex'),encode(j.mapping_digest,'hex'),encode(j.identity_mapping_digest,'hex')]);
  INSERT INTO control.ingestion_job(id,tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,request_digest,status,received_count,
    applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,channel_id,channel_epoch,
    version_domain,owner_approval_id,owner_user_id,owner_revision,approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,
    identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at)
  VALUES(p_child,j.tenant_key,j.source_id,j.entity,j.route,j.batch_id,j.raw_batch_id,p_child_key,child_digest,'RECEIVED',1,0,j.credential_id,
    j.source_epoch_at_admission,j.credential_revision_at_admission,j.credential_generation_at_admission,j.channel_id,j.channel_epoch,j.version_domain,
    j.owner_approval_id,j.owner_user_id,j.owner_revision,j.approval_security_fence,j.config_revision,j.config_digest,j.mapping_revision,j.mapping_digest,
    j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,j.security_barrier_fence_at_admission,i.source_updated_at,i.source_updated_at);
  INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status,operation_id)
    VALUES(p_child,0,i.event_id,i.source_pk,i.source_version,i.operation,i.source_updated_at,i.public_record,'RECEIVED',p_operation);
  INSERT INTO control.ingestion_recovery_operation(operation_id,quarantine_id,tenant_key,source_id,entity,origin_job_id,origin_ordinal,event_id,source_pk,origin_operation,
    child_job_id,child_ordinal,route,idempotency_key,request_digest,expected_state,mapping_revision,reason_json,approved_by,approved_owner_revision,
    own_object_id,binding_kind,user_external_id,user_target_id,department_external_id,department_target_id,customer_source_id,customer_source_pk,customer_object_id)
  VALUES(p_operation,p_quarantine,p_tenant,j.source_id,j.entity,j.id,i.ordinal,i.event_id,i.source_pk,i.operation,p_child,0,
    '/hub/v1/admin/quarantine/{quarantine_id}/retry',p_key,p_digest,p_expected,p_mapping,p_reason,p_user,p_owner_revision,
    (binding->>'own')::uuid,binding->>'kind',binding->>'user_external',binding->>'user_target',binding->>'department_external',binding->>'department_target',
    binding->>'customer_source',binding->>'customer_pk',(binding->>'customer_object')::uuid);
  INSERT INTO control.ingestion_processing_outbox(job_id) VALUES(p_child);
  RETURN QUERY SELECT 'ACCEPTED',p_operation,p_child;
END;
$body$;
CREATE OR REPLACE FUNCTION control.validate_import_quarantine_proof() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
BEGIN
 IF NEW.origin_kind IN ('REST','IMPORT') AND NOT EXISTS (
  SELECT 1 FROM control.ingestion_job j
  JOIN control.source_config_revision c ON (c.tenant_key,c.source_id,c.revision)=(j.tenant_key,j.source_id,j.config_revision)
  WHERE j.id=NEW.job_id AND j.tenant_key=NEW.tenant_key AND j.source_id=NEW.source_id AND j.entity=NEW.entity
   AND ((NEW.origin_kind='IMPORT' AND j.route='/hub/v1/admin/sources/'||j.source_id||'/import/'||j.entity AND c.config->>'connector'='SIMULATED_IMPORT' AND j.endpoint_profile_digest IS NULL)
     OR (NEW.origin_kind='REST' AND j.route IN ('/hub/v1/ingest/crm/customers','/hub/v1/ingest/orders/orders') AND c.config->>'connector'<>'SIMULATED_IMPORT' AND j.endpoint_profile_digest IS NOT NULL))
   AND NEW.endpoint_profile_digest IS NOT DISTINCT FROM j.endpoint_profile_digest
   AND (NEW.owner_approval_id,NEW.owner_revision,NEW.channel_id,NEW.channel_epoch,NEW.config_revision,NEW.config_digest,
        NEW.mapping_revision,NEW.mapping_digest,NEW.identity_mapping_revision,NEW.identity_mapping_digest,NEW.test_report_id,
        NEW.approval_security_fence,NEW.security_barrier_fence_at_admission)
      IS NOT DISTINCT FROM
       (j.owner_approval_id,j.owner_revision,j.channel_id,j.channel_epoch,j.config_revision,j.config_digest,
        j.mapping_revision,j.mapping_digest,j.identity_mapping_revision,j.identity_mapping_digest,j.test_report_id,
        j.approval_security_fence,j.security_barrier_fence_at_admission)
 ) THEN RAISE EXCEPTION 'invalid import quarantine proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION control.validate_import_quarantine_proof() FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
DROP TRIGGER IF EXISTS validate_import_quarantine_proof ON control.ingestion_quarantine_index;
CREATE TRIGGER validate_import_quarantine_proof BEFORE INSERT ON control.ingestion_quarantine_index
 FOR EACH ROW EXECUTE FUNCTION control.validate_import_quarantine_proof();
