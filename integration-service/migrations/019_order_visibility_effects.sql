-- Private order counterpart of 018's frozen customer proof validation. The
-- customer proof function and its callers remain unchanged.
CREATE FUNCTION control.canonical_order_proof_internal(p_tenant text,p_source text,p_credential_id uuid,
 p_channel_id uuid,p_channel_epoch bigint,p_version_domain text,p_admitted_fence bigint,p_owner_approval_id uuid,
 p_test_report_id uuid,p_mapping_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE v_actor text; v_mappings jsonb; v_config jsonb; v_fence bigint; v_credential_id uuid;
 v_channel_state text; v_channel_connector text; v_channel_mode text; v_channel_domain text; v_channel_epoch bigint;
BEGIN
 v_fence:=control.acquire_security_barrier_guard_internal();
 IF p_credential_id IS NULL OR p_channel_id IS NULL OR p_channel_epoch IS NULL OR p_admitted_fence IS NULL
  OR p_owner_approval_id IS NULL OR p_test_report_id IS NULL OR p_admitted_fence<0 OR p_admitted_fence>v_fence
  OR p_mapping_revision IS NULL OR p_mapping_revision<=0 OR p_version_domain IS DISTINCT FROM 'SOURCE_VERSION' THEN
  RAISE EXCEPTION 'invalid order change proof' USING ERRCODE='42501'; END IF;
 SELECT a.owner_user_id,m.mappings,c.config INTO v_actor,v_mappings,v_config
 FROM control.source_owner_approval a
 JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id)=(a.test_report_id,a.tenant_key,a.source_id)
 JOIN control.source_identity_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(a.tenant_key,a.source_id,a.identity_mapping_revision)
 JOIN control.source_config_revision c ON (c.tenant_key,c.source_id,c.revision)=(a.tenant_key,a.source_id,a.config_revision)
 JOIN control.source_mapping_revision fm ON (fm.tenant_key,fm.source_id,fm.revision)=(a.tenant_key,a.source_id,a.mapping_revision)
 WHERE a.id=p_owner_approval_id AND a.test_report_id=p_test_report_id AND a.tenant_key=p_tenant AND a.source_id=p_source
  AND a.identity_mapping_revision=p_mapping_revision AND t.status='PASS'
  AND t.config_revision=a.config_revision AND t.mapping_revision=a.mapping_revision AND t.identity_mapping_revision=a.identity_mapping_revision
  AND t.config_digest=a.config_digest AND t.mapping_digest=a.mapping_digest AND t.identity_mapping_digest=a.identity_mapping_digest
  AND t.source_credential_revision=a.source_credential_revision AND t.credential_generation=a.credential_generation
  AND ((c.config->>'connector'='SIMULATED_IMPORT' AND t.endpoint_profile_digest IS NULL AND a.endpoint_profile_digest IS NULL AND t.sample_digest IS NOT NULL AND t.sample_digest=a.sample_digest)
    OR (c.config->>'connector'<>'SIMULATED_IMPORT' AND t.endpoint_profile_digest IS NOT NULL AND t.endpoint_profile_digest=a.endpoint_profile_digest))
  AND t.data_contract_ref=a.data_contract_ref AND m.mapping_digest=a.identity_mapping_digest AND c.config_digest=a.config_digest
  AND fm.mapping_digest=a.mapping_digest AND c.config->'allowed_entities' ? 'order';
 IF NOT FOUND OR v_actor IS NULL OR jsonb_typeof(v_mappings)<>'array' OR jsonb_typeof(v_config)<>'object' THEN
  RAISE EXCEPTION 'approved order mapping required' USING ERRCODE='42501'; END IF;
 SELECT id INTO v_credential_id FROM control.lock_source_credential(p_tenant,p_source);
 IF v_credential_id IS DISTINCT FROM p_credential_id THEN RAISE EXCEPTION 'source credential proof does not match' USING ERRCODE='42501'; END IF;
 SELECT state,connector,mode,version_domain,channel_epoch INTO v_channel_state,v_channel_connector,v_channel_mode,v_channel_domain,v_channel_epoch
 FROM control.source_channel WHERE id=p_channel_id AND tenant_key=p_tenant AND source_id=p_source AND entity='order';
 IF NOT FOUND OR v_channel_state<>'active' OR v_channel_epoch<>p_channel_epoch OR v_channel_domain<>p_version_domain
  OR v_channel_connector IS DISTINCT FROM v_config->>'connector' OR v_channel_mode IS DISTINCT FROM v_config->>'mode'
  OR v_channel_domain IS DISTINCT FROM v_config->>'version_domain' THEN
  RAISE EXCEPTION 'source channel proof does not match' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=p_tenant AND b.effective_fence>p_admitted_fence
  AND (b.source_id IS NULL OR b.source_id=p_source) AND (b.credential_id IS NULL OR b.credential_id=p_credential_id)
  AND (b.entity IS NULL OR b.entity='order') AND (b.channel_id IS NULL OR b.channel_id=p_channel_id)
  AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')) THEN
  RAISE EXCEPTION 'security barrier blocks order change' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('actor',v_actor,'mappings',v_mappings);
END $body$;
REVOKE ALL ON FUNCTION control.canonical_order_proof_internal(text,text,uuid,uuid,bigint,text,bigint,uuid,uuid,bigint)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

-- Only independently validated entry points may call this function. The old
-- persisted reference remains locked until its audited replacement here.
CREATE FUNCTION control.canonical_order_customer_effects_internal(p_tenant text,p_source text,p_source_pk text,
 p_channel_id uuid,p_actor text,p_external_id text,p_new_customer uuid,p_mapping_revision bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE v_order uuid; v_customer uuid; v_revision bigint; v_version numeric; v_old_target text; v_old uuid;
 v_old_owner text; v_new_owner text; v_old_dept text; v_new_dept text; v_user text; v_xid xid8;
BEGIN
 SELECT i.order_id,o.customer_id,o.hub_revision,o.source_version INTO v_order,v_customer,v_revision,v_version
 FROM control.canonical_source_identity i JOIN hub.canonical_order o ON (o.tenant_id,o.id)=(i.tenant_key,i.order_id)
 WHERE (i.tenant_key,i.source_id,i.entity,i.source_pk)=(p_tenant,p_source,'order',p_source_pk)
  AND o.deleted_at IS NULL FOR UPDATE OF i,o;
 IF NOT FOUND OR v_customer IS DISTINCT FROM p_new_customer THEN RAISE EXCEPTION 'order projection mismatch' USING ERRCODE='42501'; END IF;
 SELECT target_id INTO v_old_target FROM control.canonical_identity_reference r
 WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk,r.kind)=(p_tenant,p_source,'order',p_source_pk,'customer') FOR UPDATE;
 IF NOT FOUND OR v_old_target !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'old order customer reference missing' USING ERRCODE='42501'; END IF;
 v_old:=v_old_target::uuid;
 IF v_old=p_new_customer THEN RETURN; END IF;
 v_xid:=pg_catalog.pg_current_xact_id();
 IF NOT EXISTS(SELECT 1 FROM control.source_version_receipt r JOIN control.canonical_apply_outbox o
  ON (o.tenant_key,o.source_id,o.channel_id,o.entity,o.canonical_object_id,o.hub_revision,o.projection_digest,o.source_content_digest)=
   (r.tenant_key,r.source_id,r.channel_id,r.entity,r.canonical_object_id,v_revision,r.projection_digest,r.source_content_digest)
  WHERE (r.tenant_key,r.source_id,r.channel_id,r.entity,r.source_pk,r.canonical_object_id)=(p_tenant,p_source,p_channel_id,'order',p_source_pk,v_order)
   AND r.source_version=v_version AND NOT r.deleted AND r.apply_xid=v_xid AND o.apply_xid=v_xid AND o.operation='UPSERT'
   AND r.projection_digest=control.canonical_projection_digest(r.source_content_digest,v_order,jsonb_build_object('customer_id',p_new_customer::text))) THEN
  RAISE EXCEPTION 'order change has no current canonical apply' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hub.canonical_customer c WHERE c.tenant_id=p_tenant AND c.id IN (v_old,p_new_customer) ORDER BY c.id FOR UPDATE;
 SELECT owner_user_id,dept_id INTO v_old_owner,v_old_dept FROM hub.canonical_customer WHERE tenant_id=p_tenant AND id=v_old;
 IF NOT FOUND THEN RAISE EXCEPTION 'old customer missing' USING ERRCODE='42501'; END IF;
 SELECT owner_user_id,dept_id INTO v_new_owner,v_new_dept FROM hub.canonical_customer WHERE tenant_id=p_tenant AND id=p_new_customer AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'new customer missing' USING ERRCODE='42501'; END IF;
 FOR v_user IN SELECT s.user_id FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND
  ((v_old_owner IS DISTINCT FROM v_new_owner AND s.user_id IN (v_old_owner,v_new_owner)) OR
   (v_old_dept IS DISTINCT FROM v_new_dept AND s.enabled AND s.business_role='sales_manager' AND s.department_id IN (v_old_dept,v_new_dept)))
  ORDER BY s.user_id COLLATE "C" FOR UPDATE
 LOOP
  UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=p_tenant AND user_id=v_user;
 END LOOP;
 INSERT INTO control.canonical_ownership_audit(tenant_key,source_id,entity,source_pk,kind,external_id,old_target_id,new_target_id,identity_mapping_revision,actor_user_id,reason)
 VALUES(p_tenant,p_source,'order',p_source_pk,'customer',p_external_id,v_old::text,p_new_customer::text,p_mapping_revision,p_actor,'source projection changed customer');
 UPDATE control.canonical_identity_reference SET external_id=p_external_id,target_id=p_new_customer::text
 WHERE (tenant_key,source_id,entity,source_pk,kind)=(p_tenant,p_source,'order',p_source_pk,'customer');
END $body$;
REVOKE ALL ON FUNCTION control.canonical_order_customer_effects_internal(text,text,text,uuid,text,text,uuid,bigint)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE FUNCTION control.record_canonical_order_customer_change(p_tenant text,p_source text,p_source_pk text,p_credential_id uuid,
 p_channel_id uuid,p_channel_epoch bigint,p_version_domain text,p_admitted_fence bigint,p_owner_approval_id uuid,
 p_test_report_id uuid,p_mapping_revision bigint,p_external_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE proof jsonb; n integer; target text;
BEGIN
 IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' THEN RAISE EXCEPTION 'worker role required' USING ERRCODE='42501'; END IF;
 proof:=control.canonical_order_proof_internal(p_tenant,p_source,p_credential_id,p_channel_id,p_channel_epoch,p_version_domain,p_admitted_fence,p_owner_approval_id,p_test_report_id,p_mapping_revision);
 SELECT count(*),min(e->>'target_id') INTO n,target FROM jsonb_array_elements(proof->'mappings') e WHERE e->>'kind'='customer' AND e->>'external_id'=p_external_id;
 IF n<>1 OR target IS NULL OR target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR
  EXISTS(SELECT 1 FROM control.source_identity_remap_fence f WHERE (f.tenant_key,f.source_id,f.kind,f.external_id)=(p_tenant,p_source,'customer',p_external_id) AND f.identity_mapping_revision>p_mapping_revision) THEN
  RAISE EXCEPTION 'approved order customer required' USING ERRCODE='42501'; END IF;
 PERFORM control.canonical_order_customer_effects_internal(p_tenant,p_source,p_source_pk,p_channel_id,proof->>'actor',p_external_id,target::uuid,p_mapping_revision);
END $body$;
REVOKE ALL ON FUNCTION control.record_canonical_order_customer_change(text,text,text,uuid,uuid,bigint,text,bigint,uuid,uuid,bigint,text)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.record_canonical_order_customer_change(text,text,text,uuid,uuid,bigint,text,bigint,uuid,uuid,bigint,text) TO hub_worker;

CREATE FUNCTION control.record_import_recovery_order_customer_change(p_tenant text,p_source text,p_job uuid,p_ordinal integer,p_item_operation uuid,p_claim uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE envelope jsonb; orig jsonb; bound jsonb; original_proof jsonb; binding_proof jsonb;
 op control.import_recovery_operation%ROWTYPE; j control.ingestion_job%ROWTYPE; item control.ingestion_job_item%ROWTYPE;
 b jsonb; key text; target text; original_n integer; original_target text; binding_n integer; binding_target text;
BEGIN
 envelope:=control.read_import_recovery_worker_context(p_tenant,p_source,p_job,p_ordinal,p_item_operation,p_claim);
 IF envelope->>'entity'<>'order' THEN RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001'; END IF;
 SELECT * INTO j FROM control.ingestion_job WHERE id=p_job;
 SELECT * INTO item FROM control.ingestion_job_item WHERE job_id=p_job AND ordinal=p_ordinal;
 SELECT * INTO op FROM control.import_recovery_operation WHERE operation_id=j.import_recovery_operation_id;
 orig:=envelope->'original'->'proof';bound:=envelope->'bindingProof';
 IF (orig->>'approvalSecurityFence')::bigint>(orig->>'securityFence')::bigint OR (bound->>'approvalSecurityFence')::bigint>(bound->>'securityFence')::bigint
  OR (orig->>'securityFence')::bigint>(envelope->>'observedFence')::bigint OR (bound->>'securityFence')::bigint>(envelope->>'observedFence')::bigint THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
 BEGIN
  original_proof:=control.canonical_order_proof_internal(p_tenant,p_source,(orig->>'credentialId')::uuid,(orig->>'channelId')::uuid,(orig->>'channelEpoch')::bigint,'SOURCE_VERSION',(orig->>'securityFence')::bigint,(orig->>'approvalId')::uuid,(orig->>'testReportId')::uuid,(orig->>'identityMappingRevision')::bigint);
  binding_proof:=control.canonical_order_proof_internal(p_tenant,p_source,(bound->>'credentialId')::uuid,(bound->>'channelId')::uuid,(bound->>'channelEpoch')::bigint,'SOURCE_VERSION',(bound->>'securityFence')::bigint,(bound->>'approvalId')::uuid,(bound->>'testReportId')::uuid,(bound->>'identityMappingRevision')::bigint);
 EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END;
 b:=op.confirmed_bindings->0;key:=b->>'externalId';target:=b->>'targetId';
 IF jsonb_array_length(op.confirmed_bindings)<>1 OR b->>'kind'<>'customer'
  OR jsonb_typeof(item.public_record->'data'->'customer_ref'->'source_id') IS DISTINCT FROM 'string'
  OR jsonb_typeof(item.public_record->'data'->'customer_ref'->'source_pk') IS DISTINCT FROM 'string'
  OR (b->>'sourceId',b->>'sourcePk') IS DISTINCT FROM (item.public_record->'data'->'customer_ref'->>'source_id',item.public_record->'data'->'customer_ref'->>'source_pk')
  OR key IS DISTINCT FROM 'c:'||pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(public.digest(pg_catalog.convert_to(
   '['||pg_catalog.to_json(item.public_record->'data'->'customer_ref'->>'source_id')::text||','||
   pg_catalog.to_json(item.public_record->'data'->'customer_ref'->>'source_pk')::text||']','UTF8'),'sha256'),'base64'),'+/','-_'),'=') THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
 SELECT count(*),min(e->>'target_id') INTO original_n,original_target FROM jsonb_array_elements(original_proof->'mappings') e WHERE e->>'kind'='customer' AND e->>'external_id'=key;
 SELECT count(*),min(e->>'target_id') INTO binding_n,binding_target FROM jsonb_array_elements(binding_proof->'mappings') e WHERE e->>'kind'='customer' AND e->>'external_id'=key;
 IF original_n>1 OR original_target IS NOT NULL OR binding_n<>1 OR binding_target IS DISTINCT FROM target
  OR EXISTS(SELECT 1 FROM control.source_identity_remap_fence f WHERE (f.tenant_key,f.source_id,f.kind,f.external_id)=(p_tenant,p_source,'customer',key) AND f.identity_mapping_revision>op.binding_identity_mapping_revision) THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM control.canonical_source_identity i JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(i.tenant_key,i.customer_id)
  WHERE (i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id,i.customer_id)=(p_tenant,b->>'sourceId','customer',b->>'sourcePk',target::uuid,target::uuid) AND c.deleted_at IS NULL) THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM control.canonical_source_identity s JOIN hub.canonical_order o ON (o.tenant_id,o.id)=(s.tenant_key,s.order_id)
  WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk,s.canonical_object_id,s.order_id)=(p_tenant,p_source,'order',op.source_pk,op.reserved_object_id,op.reserved_object_id)
   AND o.customer_id=target::uuid AND o.source_version=item.source_version AND o.deleted_at IS NULL
   AND (o.channel_epoch,o.version_domain)=(j.channel_epoch,j.version_domain)
   AND o.order_no=item.public_record->'data'->>'order_no' AND o.status=item.public_record->'data'->>'status'
   AND o.order_at=(item.public_record->'data'->>'order_at')::timestamptz AND o.amount=(item.public_record->'data'->>'amount')::numeric
   AND o.currency=item.public_record->'data'->>'currency' AND o.source_updated_at=item.source_updated_at) OR
  (SELECT count(*) FROM hub.canonical_order_line l WHERE (l.tenant_id,l.order_id)=(p_tenant,op.reserved_object_id) AND l.deleted_at IS NULL)<>jsonb_array_length(item.public_record->'data'->'lines') OR
  EXISTS(SELECT 1 FROM jsonb_array_elements(item.public_record->'data'->'lines') x LEFT JOIN hub.canonical_order_line l
   ON (l.tenant_id,l.order_id,l.source_line_id)=(p_tenant,op.reserved_object_id,x->>'source_line_id') AND l.deleted_at IS NULL
   WHERE l.id IS NULL OR l.product_code IS DISTINCT FROM x->>'product_code' OR l.product_name IS DISTINCT FROM x->>'product_name'
    OR l.quantity IS DISTINCT FROM (x->>'quantity')::numeric OR l.unit_price IS DISTINCT FROM (x->>'unit_price')::numeric
    OR l.line_amount IS DISTINCT FROM (x->>'line_amount')::numeric OR l.source_version IS DISTINCT FROM item.source_version
    OR l.channel_epoch IS DISTINCT FROM j.channel_epoch OR l.version_domain IS DISTINCT FROM j.version_domain
    OR l.source_updated_at IS DISTINCT FROM item.source_updated_at) THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001'; END IF;
 PERFORM control.canonical_order_customer_effects_internal(p_tenant,p_source,op.source_pk,j.channel_id,op.actor_user_id,key,target::uuid,op.binding_identity_mapping_revision);
 PERFORM 1 FROM control.ingestion_processing_outbox b WHERE b.job_id=p_job AND b.claim_token=p_claim AND b.acknowledged_at IS NULL AND b.lease_expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_CLAIM_LOST' USING ERRCODE='P0001'; END IF;
END $body$;
REVOKE ALL ON FUNCTION control.record_import_recovery_order_customer_change(text,text,uuid,integer,uuid,uuid)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.record_import_recovery_order_customer_change(text,text,uuid,integer,uuid,uuid) TO hub_worker;
