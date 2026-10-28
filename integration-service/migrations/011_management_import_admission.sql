ALTER TABLE raw.ingestion_batch DROP CONSTRAINT ingestion_batch_route_check;
ALTER TABLE raw.ingestion_batch ADD CONSTRAINT ingestion_batch_route_check CHECK (route IN ('/hub/v1/ingest/crm/customers','/hub/v1/ingest/orders/orders') OR route IN ('/hub/v1/admin/sources/'||source_id||'/import/customer','/hub/v1/admin/sources/'||source_id||'/import/order'));
ALTER TABLE control.ingestion_job DROP CONSTRAINT ingestion_job_route_check;
-- 007's first unnamed table check is the applied-count bound; the second is route/entity.
-- Verify the historical definition before replacing it, so a different schema fails closed.
DO $body$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='control.ingestion_job'::regclass AND conname='ingestion_job_check1'
   AND pg_get_constraintdef(oid) LIKE '%/hub/v1/ingest/crm/customers%' AND pg_get_constraintdef(oid) LIKE '%/hub/v1/ingest/orders/orders%')
 OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='control.ingestion_job'::regclass AND conname='ingestion_job_check'
   AND pg_get_constraintdef(oid) LIKE '%applied_count <= received_count%') THEN
  RAISE EXCEPTION 'unexpected historical ingestion_job checks';
 END IF;
END $body$;
ALTER TABLE control.ingestion_job DROP CONSTRAINT ingestion_job_check1;
ALTER TABLE control.ingestion_job ALTER COLUMN endpoint_profile_digest DROP NOT NULL;
ALTER TABLE control.ingestion_job ADD CONSTRAINT ingestion_job_route_check CHECK (route IN ('/hub/v1/ingest/crm/customers','/hub/v1/ingest/orders/orders') OR route='/hub/v1/admin/sources/'||source_id||'/import/'||entity);
ALTER TABLE control.ingestion_job ADD CONSTRAINT ingestion_job_route_entity_check CHECK ((entity='customer' AND route='/hub/v1/ingest/crm/customers') OR (entity='order' AND route='/hub/v1/ingest/orders/orders') OR route='/hub/v1/admin/sources/'||source_id||'/import/'||entity);
ALTER TABLE control.ingestion_job ADD CONSTRAINT ingestion_job_profile_type CHECK ((route='/hub/v1/admin/sources/'||source_id||'/import/'||entity AND endpoint_profile_digest IS NULL) OR (route IN ('/hub/v1/ingest/crm/customers','/hub/v1/ingest/orders/orders') AND endpoint_profile_digest IS NOT NULL));
ALTER TABLE control.ingestion_job ADD CONSTRAINT ingestion_job_audit_scope_unique UNIQUE (id,tenant_key,source_id);
CREATE TABLE control.ingestion_management_admission_audit (
 job_id uuid PRIMARY KEY, tenant_key text NOT NULL, source_id text NOT NULL, actor_user_id text NOT NULL,
 actor_issuer text NOT NULL, actor_subject text NOT NULL, actor_auth_epoch bigint NOT NULL,
 request_id text NOT NULL, admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(job_id,tenant_key,source_id) REFERENCES control.ingestion_job(id,tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE FUNCTION control.reject_management_admission_audit_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,control AS $body$
BEGIN RAISE EXCEPTION 'immutable management admission audit' USING ERRCODE='55000'; END $body$;
CREATE TRIGGER ingestion_management_admission_audit_immutable BEFORE UPDATE OR DELETE ON control.ingestion_management_admission_audit FOR EACH ROW EXECUTE FUNCTION control.reject_management_admission_audit_mutation();
REVOKE ALL ON control.ingestion_management_admission_audit FROM PUBLIC,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.reject_management_admission_audit_mutation() FROM PUBLIC;
GRANT INSERT ON control.ingestion_management_admission_audit TO hub_api;
CREATE FUNCTION control.check_import_job_proof() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
BEGIN
 IF NEW.endpoint_profile_digest IS NULL AND NOT EXISTS (
  SELECT 1 FROM control.source_owner_approval a
  JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id)=(a.test_report_id,a.tenant_key,a.source_id)
  JOIN control.source_config_revision c ON (c.tenant_key,c.source_id,c.revision)=(a.tenant_key,a.source_id,a.config_revision)
  JOIN control.source_channel ch ON (ch.id,ch.tenant_key,ch.source_id,ch.entity,ch.channel_epoch)=(NEW.channel_id,NEW.tenant_key,NEW.source_id,NEW.entity,NEW.channel_epoch)
  JOIN control.source_credential cred ON (cred.id,cred.tenant_key,cred.source_id)=(NEW.credential_id,NEW.tenant_key,NEW.source_id)
  WHERE (a.id,a.tenant_key,a.source_id)=(NEW.owner_approval_id,NEW.tenant_key,NEW.source_id)
   AND a.test_report_id=NEW.test_report_id AND a.owner_user_id=NEW.owner_user_id AND a.owner_revision=NEW.owner_revision
   AND a.approval_security_fence=NEW.approval_security_fence AND a.config_revision=NEW.config_revision AND a.config_digest=NEW.config_digest
   AND a.mapping_revision=NEW.mapping_revision AND a.mapping_digest=NEW.mapping_digest
   AND a.identity_mapping_revision=NEW.identity_mapping_revision AND a.identity_mapping_digest=NEW.identity_mapping_digest
   AND a.source_credential_revision=NEW.credential_revision_at_admission AND a.credential_generation=NEW.credential_generation_at_admission
   AND t.status='PASS' AND t.config_revision=a.config_revision AND t.mapping_revision=a.mapping_revision AND t.identity_mapping_revision=a.identity_mapping_revision
   AND t.config_digest=a.config_digest AND t.mapping_digest=a.mapping_digest AND t.identity_mapping_digest=a.identity_mapping_digest
   AND t.source_credential_revision=a.source_credential_revision AND t.credential_generation=a.credential_generation
   AND t.data_contract_ref=a.data_contract_ref AND t.endpoint_profile_digest IS NULL AND a.endpoint_profile_digest IS NULL
   AND t.sample_digest IS NOT NULL AND t.sample_digest=a.sample_digest
   AND c.config_digest=a.config_digest AND c.config->>'connector'='SIMULATED_IMPORT' AND c.config->>'mode'='INCREMENTAL'
   AND c.config->>'version_domain'='SOURCE_VERSION' AND c.config->'allowed_entities' ? NEW.entity
   AND ch.connector='SIMULATED_IMPORT' AND ch.mode='INCREMENTAL' AND ch.version_domain='SOURCE_VERSION' AND ch.state='active'
   AND NEW.version_domain='SOURCE_VERSION' AND cred.authority_kind='SIMULATED_IMPORT'
 ) THEN RAISE EXCEPTION 'invalid import job proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION control.check_import_job_proof() FROM PUBLIC;
CREATE TRIGGER ingestion_job_import_proof BEFORE INSERT ON control.ingestion_job FOR EACH ROW EXECUTE FUNCTION control.check_import_job_proof();
CREATE OR REPLACE FUNCTION control.record_canonical_customer_owner_change(p_tenant text,p_source text,p_source_pk text,p_credential_id uuid,
  p_channel_id uuid,p_channel_epoch bigint,p_version_domain text,p_admitted_fence bigint,p_owner_approval_id uuid,
  p_test_report_id uuid,p_mapping_revision bigint,p_changes jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
DECLARE
  v_actor text;
  v_mappings jsonb;
  v_config jsonb;
  v_fence bigint;
  v_credential_id uuid;
  v_channel_state text;
  v_channel_connector text;
  v_channel_mode text;
  v_channel_domain text;
  v_channel_epoch bigint;
  v_customer_id uuid;
  v_owner text;
  v_department text;
  v_hub_revision bigint;
  v_source_version numeric;
  v_change record;
  v_new_target text;
  v_old_target text;
  v_old_external text;
  v_affected_users text[] := ARRAY[]::text[];
  v_lock_users text[] := ARRAY[]::text[];
  v_user text;
  v_count integer;
  v_needs_apply boolean := false;
  v_apply_xid xid8;
  v_subject_enabled boolean;
  v_subject_role text;
  v_subject_department text;
BEGIN
  v_fence:=control.acquire_security_barrier_guard_internal();
  IF p_credential_id IS NULL OR p_channel_id IS NULL OR p_channel_epoch IS NULL OR p_admitted_fence IS NULL
     OR p_owner_approval_id IS NULL OR p_test_report_id IS NULL OR p_admitted_fence<0 OR p_admitted_fence>v_fence OR p_mapping_revision<=0
     OR p_version_domain NOT IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')
     OR coalesce(jsonb_typeof(p_changes)<>'array',true) OR jsonb_array_length(p_changes)=0
     OR jsonb_array_length(p_changes)>2
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) e
       WHERE jsonb_typeof(e)<>'object' OR NOT (e ? 'kind') OR NOT (e ? 'external_id')
         OR (e - 'kind' - 'external_id')<>'{}'::jsonb
         OR e->>'kind' NOT IN ('user','department') OR coalesce(e->>'external_id','')='')
     OR (SELECT count(DISTINCT e->>'kind') FROM jsonb_array_elements(p_changes) e)<>
        (SELECT count(*) FROM jsonb_array_elements(p_changes)) THEN
    RAISE EXCEPTION 'invalid source ownership change proof' USING ERRCODE='42501';
  END IF;

  -- The caller's ordinary source job remains authorized by its immutable
  -- approval/report/mapping tuple. Current Data Owner changes are admission
  -- changes and do not cancel this already accepted proof.
  SELECT a.owner_user_id,m.mappings,c.config INTO v_actor,v_mappings,v_config
    FROM control.source_owner_approval a
    JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id)=(a.test_report_id,a.tenant_key,a.source_id)
    JOIN control.source_identity_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=
      (a.tenant_key,a.source_id,a.identity_mapping_revision)
    JOIN control.source_config_revision c ON (c.tenant_key,c.source_id,c.revision)=(a.tenant_key,a.source_id,a.config_revision)
   WHERE a.id=p_owner_approval_id AND a.test_report_id=p_test_report_id
     AND a.tenant_key=p_tenant AND a.source_id=p_source AND a.identity_mapping_revision=p_mapping_revision
     AND t.status='PASS' AND t.config_revision=a.config_revision AND t.mapping_revision=a.mapping_revision
     AND t.identity_mapping_revision=a.identity_mapping_revision
     AND t.config_digest=a.config_digest AND t.mapping_digest=a.mapping_digest
     AND t.identity_mapping_digest=a.identity_mapping_digest
     AND t.source_credential_revision=a.source_credential_revision
     AND t.credential_generation=a.credential_generation
     AND ((c.config->>'connector'='SIMULATED_IMPORT' AND t.endpoint_profile_digest IS NULL AND a.endpoint_profile_digest IS NULL AND t.sample_digest IS NOT NULL AND t.sample_digest=a.sample_digest) OR (c.config->>'connector'<>'SIMULATED_IMPORT' AND t.endpoint_profile_digest IS NOT NULL AND t.endpoint_profile_digest=a.endpoint_profile_digest)) AND t.data_contract_ref=a.data_contract_ref
     AND m.mapping_digest=a.identity_mapping_digest AND c.config_digest=a.config_digest;
  IF NOT FOUND OR v_actor IS NULL OR jsonb_typeof(v_mappings)<>'array' OR jsonb_typeof(v_config)<>'object' THEN
    RAISE EXCEPTION 'approved source ownership mapping required' USING ERRCODE='42501';
  END IF;

  SELECT id INTO v_credential_id FROM control.lock_source_credential(p_tenant,p_source);
  IF v_credential_id IS DISTINCT FROM p_credential_id THEN
    RAISE EXCEPTION 'source credential proof does not match' USING ERRCODE='42501';
  END IF;
  SELECT state,connector,mode,version_domain,channel_epoch INTO
    v_channel_state,v_channel_connector,v_channel_mode,v_channel_domain,v_channel_epoch
    FROM control.source_channel WHERE id=p_channel_id AND tenant_key=p_tenant AND source_id=p_source AND entity='customer';
  IF NOT FOUND OR v_channel_state<>'active' OR v_channel_epoch<>p_channel_epoch OR v_channel_domain<>p_version_domain
     OR v_channel_connector IS DISTINCT FROM v_config->>'connector' OR v_channel_mode IS DISTINCT FROM v_config->>'mode'
     OR v_channel_domain IS DISTINCT FROM v_config->>'version_domain' THEN
    RAISE EXCEPTION 'source channel proof does not match' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM control.source_security_barrier b
     WHERE b.tenant_key=p_tenant AND b.effective_fence>p_admitted_fence
       AND (b.source_id IS NULL OR b.source_id=p_source)
       AND (b.credential_id IS NULL OR b.credential_id=p_credential_id)
       AND (b.entity IS NULL OR b.entity='customer')
       AND (b.channel_id IS NULL OR b.channel_id=p_channel_id)
       AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')) THEN
    RAISE EXCEPTION 'security barrier blocks source ownership change' USING ERRCODE='42501';
  END IF;

  SELECT i.customer_id,c.owner_user_id,c.dept_id,c.hub_revision,c.source_version
    INTO v_customer_id,v_owner,v_department,v_hub_revision,v_source_version
    FROM control.canonical_source_identity i
    JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(i.tenant_key,i.customer_id)
   WHERE i.tenant_key=p_tenant AND i.source_id=p_source AND i.entity='customer' AND i.source_pk=p_source_pk
   FOR UPDATE OF i,c;
  IF NOT FOUND OR v_customer_id IS NULL THEN
    RAISE EXCEPTION 'source ownership change has no canonical customer' USING ERRCODE='42501';
  END IF;

  -- Resolve and lock every affected identity reference before deciding whether
  -- this is an already-consumed replay or a new apply effect.
  FOR v_change IN SELECT e->>'kind' AS kind,e->>'external_id' AS external_id FROM jsonb_array_elements(p_changes) e
  LOOP
    IF EXISTS(SELECT 1 FROM control.source_identity_remap_fence f
        WHERE f.tenant_key=p_tenant AND f.source_id=p_source AND f.kind=v_change.kind AND f.external_id=v_change.external_id
          AND f.identity_mapping_revision>p_mapping_revision) THEN
      RAISE EXCEPTION 'identity mapping was superseded' USING ERRCODE='42501';
    END IF;
    SELECT count(*),min(e->>'target_id') INTO v_count,v_new_target
      FROM jsonb_array_elements(v_mappings) e
     WHERE e->>'kind'=v_change.kind AND e->>'external_id'=v_change.external_id;
    IF v_count<>1 OR v_new_target IS NULL THEN
      RAISE EXCEPTION 'approved source ownership mapping required' USING ERRCODE='42501';
    END IF;
    SELECT r.external_id,r.target_id INTO v_old_external,v_old_target
      FROM control.canonical_identity_reference r
     WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.entity='customer' AND r.source_pk=p_source_pk
       AND r.kind=v_change.kind
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source ownership reference missing' USING ERRCODE='42501'; END IF;

    IF (v_change.kind='user' AND v_owner<>v_new_target) OR
       (v_change.kind='department' AND v_department<>v_new_target) THEN
      RAISE EXCEPTION 'source ownership change does not match current projection' USING ERRCODE='42501';
    END IF;

    IF v_change.kind='user' THEN
      v_lock_users:=array_append(v_lock_users,v_new_target);
      IF v_old_target IS DISTINCT FROM v_new_target THEN
        v_lock_users:=array_append(v_lock_users,v_old_target);
        v_affected_users:=array_append(v_affected_users,v_old_target);
        v_affected_users:=array_append(v_affected_users,v_new_target);
      END IF;
    ELSE
      v_lock_users:=array_append(v_lock_users,v_owner);
      IF v_old_target IS DISTINCT FROM v_new_target THEN
        v_affected_users:=array_append(v_affected_users,v_owner);
      END IF;
    END IF;
    IF v_old_external IS DISTINCT FROM v_change.external_id OR v_old_target IS DISTINCT FROM v_new_target THEN
      v_needs_apply:=true;
    END IF;
  END LOOP;

  -- An exact replay after the reference was already consumed has no permission
  -- effects and remains safe without asking for a fresh apply artifact.
  IF NOT v_needs_apply THEN RETURN; END IF;

  v_apply_xid:=pg_catalog.pg_current_xact_id();
  IF NOT EXISTS(
    SELECT 1 FROM control.source_version_receipt r
    JOIN control.canonical_apply_outbox o ON (o.tenant_key,o.source_id,o.channel_id,o.entity,o.canonical_object_id,
      o.hub_revision,o.projection_digest,o.source_content_digest)=(r.tenant_key,r.source_id,r.channel_id,r.entity,
      r.canonical_object_id,v_hub_revision,r.projection_digest,r.source_content_digest)
    WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.channel_id=p_channel_id AND r.entity='customer'
      AND r.source_pk=p_source_pk AND r.canonical_object_id=v_customer_id AND r.source_version=v_source_version
      AND NOT r.deleted AND r.apply_xid=v_apply_xid AND o.apply_xid=v_apply_xid AND o.operation='UPSERT'
      AND r.projection_digest=control.canonical_projection_digest(r.source_content_digest,v_customer_id,
        jsonb_build_object('owner_user_id',v_owner,'department_id',v_department))
  ) THEN
    RAISE EXCEPTION 'source ownership change has no current canonical apply' USING ERRCODE='42501';
  END IF;

  -- Lock all affected authorization subjects in one stable order before
  -- relying on their eligibility. M0 changes serialize on these same rows.
  FOR v_user IN SELECT DISTINCT u COLLATE "C" AS u FROM unnest(v_lock_users) AS affected(u) ORDER BY u
  LOOP
    PERFORM 1 FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'affected owner subject missing' USING ERRCODE='42501'; END IF;
  END LOOP;

  FOR v_change IN SELECT e->>'kind' AS kind,e->>'external_id' AS external_id FROM jsonb_array_elements(p_changes) e
  LOOP
    SELECT min(e->>'target_id') INTO v_new_target FROM jsonb_array_elements(v_mappings) e
     WHERE e->>'kind'=v_change.kind AND e->>'external_id'=v_change.external_id;
    IF v_change.kind='user' THEN
      SELECT enabled,business_role,department_id INTO v_subject_enabled,v_subject_role,v_subject_department
        FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_new_target;
      IF NOT FOUND OR NOT v_subject_enabled OR v_subject_role IS DISTINCT FROM 'sales' OR v_subject_department IS DISTINCT FROM v_department THEN
        RAISE EXCEPTION 'eligible owner not found' USING ERRCODE='42501';
      END IF;
    ELSE
      SELECT enabled,business_role,department_id INTO v_subject_enabled,v_subject_role,v_subject_department
        FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_owner;
      IF NOT FOUND OR NOT v_subject_enabled OR v_subject_role IS DISTINCT FROM 'sales' OR v_subject_department IS DISTINCT FROM v_new_target THEN
        RAISE EXCEPTION 'eligible owner not found' USING ERRCODE='42501';
      END IF;
    END IF;
    SELECT r.external_id,r.target_id INTO v_old_external,v_old_target
      FROM control.canonical_identity_reference r
     WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.entity='customer' AND r.source_pk=p_source_pk
       AND r.kind=v_change.kind;
    IF NOT FOUND THEN RAISE EXCEPTION 'source ownership reference missing' USING ERRCODE='42501'; END IF;

    IF v_old_target<>v_new_target THEN
      INSERT INTO control.canonical_ownership_audit(tenant_key,source_id,entity,source_pk,kind,external_id,old_target_id,new_target_id,
        identity_mapping_revision,actor_user_id,reason)
        VALUES(p_tenant,p_source,'customer',p_source_pk,v_change.kind,v_change.external_id,v_old_target,v_new_target,
          p_mapping_revision,v_actor,'source projection changed ownership');
    END IF;
    UPDATE control.canonical_identity_reference SET external_id=v_change.external_id,target_id=v_new_target
     WHERE tenant_key=p_tenant AND source_id=p_source AND entity='customer' AND source_pk=p_source_pk AND kind=v_change.kind;
  END LOOP;

  FOR v_user IN SELECT DISTINCT u FROM unnest(v_affected_users) AS affected(u) ORDER BY u
  LOOP
    UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=p_tenant AND user_id=v_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'affected owner subject missing' USING ERRCODE='42501'; END IF;
  END LOOP;
END;
$body$;
