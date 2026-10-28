-- Shared private ordinary-proof validation. Both callers derive their proof
-- from their own authority boundary before invoking the shared effects below.
CREATE FUNCTION control.canonical_owner_proof_internal(p_tenant text,p_source text,p_credential_id uuid,
 p_channel_id uuid,p_channel_epoch bigint,p_version_domain text,p_admitted_fence bigint,p_owner_approval_id uuid,
 p_test_report_id uuid,p_mapping_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE v_actor text; v_mappings jsonb; v_config jsonb; v_fence bigint; v_credential_id uuid;
 v_channel_state text; v_channel_connector text; v_channel_mode text; v_channel_domain text; v_channel_epoch bigint;
BEGIN
 v_fence:=control.acquire_security_barrier_guard_internal();
 IF p_credential_id IS NULL OR p_channel_id IS NULL OR p_channel_epoch IS NULL OR p_admitted_fence IS NULL
  OR p_owner_approval_id IS NULL OR p_test_report_id IS NULL OR p_admitted_fence<0 OR p_admitted_fence>v_fence OR p_mapping_revision<=0
  OR p_version_domain NOT IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION') THEN
  RAISE EXCEPTION 'invalid source ownership change proof' USING ERRCODE='42501'; END IF;
 SELECT a.owner_user_id,m.mappings,c.config INTO v_actor,v_mappings,v_config
 FROM control.source_owner_approval a
 JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id)=(a.test_report_id,a.tenant_key,a.source_id)
 JOIN control.source_identity_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(a.tenant_key,a.source_id,a.identity_mapping_revision)
 JOIN control.source_config_revision c ON (c.tenant_key,c.source_id,c.revision)=(a.tenant_key,a.source_id,a.config_revision)
 WHERE a.id=p_owner_approval_id AND a.test_report_id=p_test_report_id AND a.tenant_key=p_tenant AND a.source_id=p_source
  AND a.identity_mapping_revision=p_mapping_revision AND t.status='PASS'
  AND t.config_revision=a.config_revision AND t.mapping_revision=a.mapping_revision AND t.identity_mapping_revision=a.identity_mapping_revision
  AND t.config_digest=a.config_digest AND t.mapping_digest=a.mapping_digest AND t.identity_mapping_digest=a.identity_mapping_digest
  AND t.source_credential_revision=a.source_credential_revision AND t.credential_generation=a.credential_generation
  AND ((c.config->>'connector'='SIMULATED_IMPORT' AND t.endpoint_profile_digest IS NULL AND a.endpoint_profile_digest IS NULL AND t.sample_digest IS NOT NULL AND t.sample_digest=a.sample_digest)
    OR (c.config->>'connector'<>'SIMULATED_IMPORT' AND t.endpoint_profile_digest IS NOT NULL AND t.endpoint_profile_digest=a.endpoint_profile_digest))
  AND t.data_contract_ref=a.data_contract_ref AND m.mapping_digest=a.identity_mapping_digest AND c.config_digest=a.config_digest;
 IF NOT FOUND OR v_actor IS NULL OR jsonb_typeof(v_mappings)<>'array' OR jsonb_typeof(v_config)<>'object' THEN
  RAISE EXCEPTION 'approved source ownership mapping required' USING ERRCODE='42501'; END IF;
 SELECT id INTO v_credential_id FROM control.lock_source_credential(p_tenant,p_source);
 IF v_credential_id IS DISTINCT FROM p_credential_id THEN RAISE EXCEPTION 'source credential proof does not match' USING ERRCODE='42501'; END IF;
 SELECT state,connector,mode,version_domain,channel_epoch INTO v_channel_state,v_channel_connector,v_channel_mode,v_channel_domain,v_channel_epoch
 FROM control.source_channel WHERE id=p_channel_id AND tenant_key=p_tenant AND source_id=p_source AND entity='customer';
 IF NOT FOUND OR v_channel_state<>'active' OR v_channel_epoch<>p_channel_epoch OR v_channel_domain<>p_version_domain
  OR v_channel_connector IS DISTINCT FROM v_config->>'connector' OR v_channel_mode IS DISTINCT FROM v_config->>'mode'
  OR v_channel_domain IS DISTINCT FROM v_config->>'version_domain' THEN
  RAISE EXCEPTION 'source channel proof does not match' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=p_tenant AND b.effective_fence>p_admitted_fence
  AND (b.source_id IS NULL OR b.source_id=p_source) AND (b.credential_id IS NULL OR b.credential_id=p_credential_id)
  AND (b.entity IS NULL OR b.entity='customer') AND (b.channel_id IS NULL OR b.channel_id=p_channel_id)
  AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')) THEN
  RAISE EXCEPTION 'security barrier blocks source ownership change' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('actor',v_actor,'mappings',v_mappings);
END $body$;
REVOKE ALL ON FUNCTION control.canonical_owner_proof_internal(text,text,uuid,uuid,bigint,text,bigint,uuid,uuid,bigint)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

-- The only effect engine. Its callers supply internally validated selections;
-- it is never directly executable by any application role.
CREATE FUNCTION control.canonical_owner_effects_internal(p_tenant text,p_source text,p_source_pk text,p_channel_id uuid,p_actor text,p_changes jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE v_customer_id uuid; v_owner text; v_department text; v_hub_revision bigint; v_source_version numeric;
 v_change record; v_new_target text; v_old_target text; v_old_external text; v_affected_users text[]:=ARRAY[]::text[];
 v_lock_users text[]:=ARRAY[]::text[]; v_user text; v_needs_apply boolean:=false; v_apply_xid xid8;
 v_subject_enabled boolean; v_subject_role text; v_subject_department text;
BEGIN
 SELECT i.customer_id,c.owner_user_id,c.dept_id,c.hub_revision,c.source_version INTO v_customer_id,v_owner,v_department,v_hub_revision,v_source_version
 FROM control.canonical_source_identity i JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(i.tenant_key,i.customer_id)
 WHERE i.tenant_key=p_tenant AND i.source_id=p_source AND i.entity='customer' AND i.source_pk=p_source_pk FOR UPDATE OF i,c;
 IF NOT FOUND OR v_customer_id IS NULL THEN RAISE EXCEPTION 'source ownership change has no canonical customer' USING ERRCODE='42501'; END IF;
 FOR v_change IN SELECT * FROM jsonb_to_recordset(p_changes) AS x(kind text,external_id text,target_id text,identity_mapping_revision bigint) LOOP
  v_new_target:=v_change.target_id;
  SELECT r.external_id,r.target_id INTO v_old_external,v_old_target FROM control.canonical_identity_reference r
   WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.entity='customer' AND r.source_pk=p_source_pk AND r.kind=v_change.kind FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source ownership reference missing' USING ERRCODE='42501'; END IF;
  IF (v_change.kind='user' AND v_owner<>v_new_target) OR (v_change.kind='department' AND v_department<>v_new_target) THEN
   RAISE EXCEPTION 'source ownership change does not match current projection' USING ERRCODE='42501'; END IF;
  IF v_change.kind='user' THEN
   v_lock_users:=array_append(v_lock_users,v_new_target);
   IF v_old_target IS DISTINCT FROM v_new_target THEN
    v_lock_users:=array_append(v_lock_users,v_old_target);
    v_affected_users:=array_append(v_affected_users,v_old_target);v_affected_users:=array_append(v_affected_users,v_new_target);
   END IF;
  ELSE
   v_lock_users:=array_append(v_lock_users,v_owner);
   IF v_old_target IS DISTINCT FROM v_new_target THEN v_affected_users:=array_append(v_affected_users,v_owner); END IF;
  END IF;
  IF v_old_external IS DISTINCT FROM v_change.external_id OR v_old_target IS DISTINCT FROM v_new_target THEN v_needs_apply:=true; END IF;
 END LOOP;
 IF NOT v_needs_apply THEN RETURN; END IF;
 v_apply_xid:=pg_catalog.pg_current_xact_id();
 IF NOT EXISTS(SELECT 1 FROM control.source_version_receipt r JOIN control.canonical_apply_outbox o
  ON (o.tenant_key,o.source_id,o.channel_id,o.entity,o.canonical_object_id,o.hub_revision,o.projection_digest,o.source_content_digest)=
   (r.tenant_key,r.source_id,r.channel_id,r.entity,r.canonical_object_id,v_hub_revision,r.projection_digest,r.source_content_digest)
  WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.channel_id=p_channel_id AND r.entity='customer'
   AND r.source_pk=p_source_pk AND r.canonical_object_id=v_customer_id AND r.source_version=v_source_version AND NOT r.deleted
   AND r.apply_xid=v_apply_xid AND o.apply_xid=v_apply_xid AND o.operation='UPSERT'
   AND r.projection_digest=control.canonical_projection_digest(r.source_content_digest,v_customer_id,jsonb_build_object('owner_user_id',v_owner,'department_id',v_department))) THEN
  RAISE EXCEPTION 'source ownership change has no current canonical apply' USING ERRCODE='42501'; END IF;
 FOR v_user IN SELECT DISTINCT u COLLATE "C" AS u FROM unnest(v_lock_users) AS affected(u) ORDER BY u LOOP
  PERFORM 1 FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'affected owner subject missing' USING ERRCODE='42501'; END IF;
 END LOOP;
 FOR v_change IN SELECT * FROM jsonb_to_recordset(p_changes) AS x(kind text,external_id text,target_id text,identity_mapping_revision bigint) LOOP
  v_new_target:=v_change.target_id;
  IF v_change.kind='user' THEN
   SELECT enabled,business_role,department_id INTO v_subject_enabled,v_subject_role,v_subject_department FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_new_target;
   IF NOT FOUND OR NOT v_subject_enabled OR v_subject_role IS DISTINCT FROM 'sales' OR v_subject_department IS DISTINCT FROM v_department THEN
    RAISE EXCEPTION 'eligible owner not found' USING ERRCODE='42501'; END IF;
  ELSE
   SELECT enabled,business_role,department_id INTO v_subject_enabled,v_subject_role,v_subject_department FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_owner;
   IF NOT FOUND OR NOT v_subject_enabled OR v_subject_role IS DISTINCT FROM 'sales' OR v_subject_department IS DISTINCT FROM v_new_target THEN
    RAISE EXCEPTION 'eligible owner not found' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT r.external_id,r.target_id INTO v_old_external,v_old_target FROM control.canonical_identity_reference r
   WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.entity='customer' AND r.source_pk=p_source_pk AND r.kind=v_change.kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'source ownership reference missing' USING ERRCODE='42501'; END IF;
  IF v_old_target<>v_new_target THEN
   INSERT INTO control.canonical_ownership_audit(tenant_key,source_id,entity,source_pk,kind,external_id,old_target_id,new_target_id,identity_mapping_revision,actor_user_id,reason)
   VALUES(p_tenant,p_source,'customer',p_source_pk,v_change.kind,v_change.external_id,v_old_target,v_new_target,v_change.identity_mapping_revision,p_actor,'source projection changed ownership');
  END IF;
  UPDATE control.canonical_identity_reference SET external_id=v_change.external_id,target_id=v_new_target
   WHERE tenant_key=p_tenant AND source_id=p_source AND entity='customer' AND source_pk=p_source_pk AND kind=v_change.kind;
 END LOOP;
 FOR v_user IN SELECT DISTINCT u FROM unnest(v_affected_users) AS affected(u) ORDER BY u LOOP
  UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=p_tenant AND user_id=v_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'affected owner subject missing' USING ERRCODE='42501'; END IF;
 END LOOP;
END $body$;
REVOKE ALL ON FUNCTION control.canonical_owner_effects_internal(text,text,text,uuid,text,jsonb)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE OR REPLACE FUNCTION control.record_canonical_customer_owner_change(p_tenant text,p_source text,p_source_pk text,p_credential_id uuid,
 p_channel_id uuid,p_channel_epoch bigint,p_version_domain text,p_admitted_fence bigint,p_owner_approval_id uuid,
 p_test_report_id uuid,p_mapping_revision bigint,p_changes jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE proof jsonb; selected jsonb:='[]'::jsonb; change record; n integer; target text;
BEGIN
 IF coalesce(jsonb_typeof(p_changes)<>'array',true) OR jsonb_array_length(p_changes)=0 OR jsonb_array_length(p_changes)>2
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) e WHERE jsonb_typeof(e)<>'object' OR NOT (e ? 'kind') OR NOT (e ? 'external_id')
   OR (e-'kind'-'external_id')<>'{}'::jsonb OR e->>'kind' NOT IN ('user','department') OR coalesce(e->>'external_id','')='')
  OR (SELECT count(DISTINCT e->>'kind') FROM jsonb_array_elements(p_changes) e)<>(SELECT count(*) FROM jsonb_array_elements(p_changes)) THEN
  RAISE EXCEPTION 'invalid source ownership change proof' USING ERRCODE='42501'; END IF;
 proof:=control.canonical_owner_proof_internal(p_tenant,p_source,p_credential_id,p_channel_id,p_channel_epoch,p_version_domain,p_admitted_fence,p_owner_approval_id,p_test_report_id,p_mapping_revision);
 FOR change IN SELECT e->>'kind' AS kind,e->>'external_id' AS external_id FROM jsonb_array_elements(p_changes) e LOOP
  IF EXISTS(SELECT 1 FROM control.source_identity_remap_fence f WHERE f.tenant_key=p_tenant AND f.source_id=p_source AND f.kind=change.kind AND f.external_id=change.external_id AND f.identity_mapping_revision>p_mapping_revision) THEN
   RAISE EXCEPTION 'identity mapping was superseded' USING ERRCODE='42501'; END IF;
  SELECT count(*),min(e->>'target_id') INTO n,target FROM jsonb_array_elements(proof->'mappings') e WHERE e->>'kind'=change.kind AND e->>'external_id'=change.external_id;
  IF n<>1 OR target IS NULL THEN RAISE EXCEPTION 'approved source ownership mapping required' USING ERRCODE='42501'; END IF;
  selected:=selected||jsonb_build_array(jsonb_build_object('kind',change.kind,'external_id',change.external_id,'target_id',target,'identity_mapping_revision',p_mapping_revision));
 END LOOP;
 PERFORM control.canonical_owner_effects_internal(p_tenant,p_source,p_source_pk,p_channel_id,proof->>'actor',selected);
END $body$;

-- No proof, identity, target or change JSON is supplied by the worker.
CREATE FUNCTION control.record_import_recovery_customer_owner_change(p_tenant text,p_source text,p_job uuid,p_ordinal integer,p_item_operation uuid,p_claim uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE envelope jsonb; orig jsonb; bound jsonb; op control.import_recovery_operation%ROWTYPE; j control.ingestion_job%ROWTYPE;
 item control.ingestion_job_item%ROWTYPE; original_maps jsonb; binding_maps jsonb; proof jsonb; k record;
 orig_n integer; binding_n integer; confirmed_n integer; orig_target text; binding_target text; confirmed_target text;
 chosen text; baseline bigint; selected jsonb:='[]'::jsonb; changes jsonb:='[]'::jsonb; old_target text;
 owner_target text; dept_target text; subject_enabled boolean; subject_role text; subject_department text;
BEGIN
 envelope:=control.read_import_recovery_worker_context(p_tenant,p_source,p_job,p_ordinal,p_item_operation,p_claim);
 IF envelope->>'entity'<>'customer' THEN RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001'; END IF;
 SELECT * INTO j FROM control.ingestion_job WHERE id=p_job;
 SELECT * INTO item FROM control.ingestion_job_item WHERE job_id=p_job AND ordinal=p_ordinal;
 SELECT * INTO op FROM control.import_recovery_operation WHERE operation_id=j.import_recovery_operation_id;
 orig:=envelope->'original'->'proof';bound:=envelope->'bindingProof';
 BEGIN
  proof:=control.canonical_owner_proof_internal(p_tenant,p_source,(orig->>'credentialId')::uuid,(orig->>'channelId')::uuid,(orig->>'channelEpoch')::bigint,'SOURCE_VERSION',(orig->>'securityFence')::bigint,(orig->>'approvalId')::uuid,(orig->>'testReportId')::uuid,(orig->>'identityMappingRevision')::bigint);
  original_maps:=proof->'mappings';
  proof:=control.canonical_owner_proof_internal(p_tenant,p_source,(bound->>'credentialId')::uuid,(bound->>'channelId')::uuid,(bound->>'channelEpoch')::bigint,'SOURCE_VERSION',(bound->>'securityFence')::bigint,(bound->>'approvalId')::uuid,(bound->>'testReportId')::uuid,(bound->>'identityMappingRevision')::bigint);
  binding_maps:=proof->'mappings';
 EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END;
 FOR k IN SELECT * FROM (VALUES('user',item.public_record->'data'->>'owner_external_id'),('department',item.public_record->'data'->>'department_external_id')) AS keys(kind,external_id) LOOP
  SELECT count(*),min(e->>'target_id') INTO orig_n,orig_target FROM jsonb_array_elements(original_maps) e WHERE e->>'kind'=k.kind AND e->>'external_id'=k.external_id;
  SELECT count(*),min(e->>'target_id') INTO binding_n,binding_target FROM jsonb_array_elements(binding_maps) e WHERE e->>'kind'=k.kind AND e->>'external_id'=k.external_id;
  SELECT count(*),min(e->>'targetId') INTO confirmed_n,confirmed_target FROM jsonb_array_elements(op.confirmed_bindings) e WHERE e->>'kind'=k.kind AND e->>'externalId'=k.external_id;
  IF orig_n>1 OR binding_n<>1 OR binding_target IS NULL OR confirmed_n>1 THEN RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
  IF orig_target IS NOT NULL THEN
   IF confirmed_n<>0 OR orig_target<>binding_target THEN RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
   chosen:=orig_target;baseline:=j.identity_mapping_revision;
  ELSE
   IF confirmed_n<>1 OR confirmed_target IS DISTINCT FROM binding_target THEN RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
   chosen:=binding_target;baseline:=op.binding_identity_mapping_revision;
  END IF;
  IF EXISTS(SELECT 1 FROM control.source_identity_remap_fence f WHERE (f.tenant_key,f.source_id,f.kind,f.external_id)=(p_tenant,p_source,k.kind,k.external_id) AND f.identity_mapping_revision>baseline) THEN
   RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
  IF k.kind='user' THEN owner_target:=chosen;ELSE dept_target:=chosen;END IF;
  selected:=selected||jsonb_build_array(jsonb_build_object('kind',k.kind,'external_id',k.external_id,'target_id',chosen,'identity_mapping_revision',baseline));
 END LOOP;
 IF jsonb_array_length(op.confirmed_bindings)<>(SELECT count(*) FROM jsonb_array_elements(selected) e WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(op.confirmed_bindings) b WHERE b->>'kind'=e->>'kind' AND b->>'externalId'=e->>'external_id')) THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
 SELECT enabled,business_role,department_id INTO subject_enabled,subject_role,subject_department FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=owner_target FOR UPDATE;
 IF NOT FOUND OR NOT subject_enabled OR subject_role IS DISTINCT FROM 'sales' OR subject_department IS DISTINCT FROM dept_target THEN RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM control.canonical_source_identity s JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id)
  WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk,s.canonical_object_id,s.customer_id)=(p_tenant,p_source,'customer',op.source_pk,op.reserved_object_id,op.reserved_object_id)
   AND c.owner_user_id=owner_target AND c.dept_id=dept_target AND c.source_version=item.source_version AND c.deleted_at IS NULL
   AND c.customer_name=item.public_record->'data'->>'customer_name' AND c.status=item.public_record->'data'->>'status'
   AND c.phone IS NOT DISTINCT FROM item.public_record->'data'->>'phone' AND c.source_updated_at=item.source_updated_at) THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001'; END IF;
 FOR k IN SELECT * FROM jsonb_to_recordset(selected) AS x(kind text,external_id text,target_id text,identity_mapping_revision bigint) LOOP
  SELECT r.target_id INTO old_target FROM control.canonical_identity_reference r WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk,r.kind)=(p_tenant,p_source,'customer',op.source_pk,k.kind) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001'; END IF;
  IF old_target IS DISTINCT FROM k.target_id THEN changes:=changes||jsonb_build_array(to_jsonb(k)); END IF;
 END LOOP;
 IF jsonb_array_length(changes)>0 THEN PERFORM control.canonical_owner_effects_internal(p_tenant,p_source,op.source_pk,j.channel_id,op.actor_user_id,changes); END IF;
 PERFORM 1 FROM control.ingestion_processing_outbox b WHERE b.job_id=p_job AND b.claim_token=p_claim AND b.acknowledged_at IS NULL AND b.lease_expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_CLAIM_LOST' USING ERRCODE='P0001'; END IF;
END $body$;
REVOKE ALL ON FUNCTION control.record_import_recovery_customer_owner_change(text,text,uuid,integer,uuid,uuid)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.record_import_recovery_customer_owner_change(text,text,uuid,integer,uuid,uuid) TO hub_worker;
