-- Private original facts and row locks. Only a separately authorized definer may call this.
CREATE FUNCTION control.import_recovery_original_facts_internal(p_tenant text,p_quarantine uuid,p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE q control.ingestion_quarantine_index%ROWTYPE; j control.ingestion_job%ROWTYPE; i control.ingestion_job_item%ROWTYPE;
 a control.source_owner_approval%ROWTYPE; reg control.source_registry%ROWTYPE; mappings jsonb; data jsonb;
 user_key text; dept_key text; customer_source text; customer_pk text; customer_key text;
 user_target text; dept_target text; customer_target text; own_id uuid; ref_id uuid; ref_customer uuid;
 user_ok boolean:=false; user_dept text; dept_ok boolean:=false; customer_ok boolean:=false; result jsonb; tup record;
BEGIN
 SELECT * INTO q FROM control.ingestion_quarantine_index WHERE quarantine_id=p_quarantine AND tenant_key=p_tenant AND source_id=p_source;
 IF NOT FOUND OR q.origin_kind<>'IMPORT' OR q.status<>'QUARANTINED' THEN RETURN NULL; END IF;
 SELECT * INTO j FROM control.ingestion_job WHERE id=q.job_id AND tenant_key=p_tenant AND source_id=p_source AND entity=q.entity;
 IF NOT FOUND OR j.route<>'/hub/v1/admin/sources/'||p_source||'/import/'||j.entity OR j.endpoint_profile_digest IS NOT NULL
   OR j.version_domain<>'SOURCE_VERSION' OR q.ordinal NOT BETWEEN 0 AND 99 OR q.ordinal>=j.received_count
   OR NOT EXISTS(SELECT 1 FROM control.ingestion_management_admission_audit x WHERE (x.job_id,x.tenant_key,x.source_id)=(j.id,p_tenant,p_source)) THEN RETURN NULL; END IF;
 SELECT * INTO i FROM control.ingestion_job_item WHERE job_id=j.id AND ordinal=q.ordinal;
 IF NOT FOUND OR i.status<>'QUARANTINED' OR i.operation<>'UPSERT' OR (i.event_id,i.source_pk,i.error_code) IS DISTINCT FROM (q.event_id,q.source_pk,q.error_code)
   OR NOT ((j.entity='customer' AND q.error_code='IDENTITY_MAPPING_REQUIRED') OR (j.entity='order' AND q.error_code IN ('IDENTITY_MAPPING_REQUIRED','IDENTITY_MAPPING_TARGET_INVALID'))) THEN RETURN NULL; END IF;
 IF (q.owner_approval_id,q.owner_revision,q.channel_id,q.channel_epoch,q.config_revision,q.config_digest,q.mapping_revision,q.mapping_digest,
     q.identity_mapping_revision,q.identity_mapping_digest,q.endpoint_profile_digest,q.test_report_id,q.approval_security_fence,q.security_barrier_fence_at_admission)
    IS DISTINCT FROM (j.owner_approval_id,j.owner_revision,j.channel_id,j.channel_epoch,j.config_revision,j.config_digest,j.mapping_revision,j.mapping_digest,
     j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,j.approval_security_fence,j.security_barrier_fence_at_admission) THEN RETURN NULL; END IF;
 SELECT * INTO a FROM control.source_owner_approval WHERE id=j.owner_approval_id AND tenant_key=p_tenant AND source_id=p_source;
 IF NOT FOUND OR a.approval_security_fence IS DISTINCT FROM j.approval_security_fence THEN RETURN NULL; END IF;
 SELECT * INTO reg FROM control.source_registry WHERE tenant_key=p_tenant AND source_id=p_source;
 SELECT m.mappings INTO mappings FROM control.source_identity_mapping_revision m WHERE (m.tenant_key,m.source_id,m.revision)=(p_tenant,p_source,j.identity_mapping_revision);
 data:=i.public_record->'data';
 IF j.entity='customer' THEN
   user_key:=data->>'owner_external_id'; dept_key:=data->>'department_external_id';
 ELSE
   customer_source:=data->'customer_ref'->>'source_id'; customer_pk:=data->'customer_ref'->>'source_pk';
   -- The TS layer supplies and validates the accepted full-tuple key, avoiding a SQL reimplementation of the hash.
 END IF;
 -- Own and referenced identities are locked in tuple order, including absent rows.
 FOR tup IN SELECT source_id,entity,source_pk FROM (SELECT DISTINCT source_id,entity,source_pk FROM (VALUES(p_source,j.entity,i.source_pk),(customer_source,'customer',customer_pk)) v(source_id,entity,source_pk)
   WHERE source_id IS NOT NULL AND source_pk IS NOT NULL) tuples ORDER BY source_id COLLATE "C",entity COLLATE "C",source_pk COLLATE "C" LOOP
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_tenant),pg_catalog.hashtext('['||pg_catalog.to_json(tup.source_id)::text||','||pg_catalog.to_json(tup.entity)::text||','||pg_catalog.to_json(tup.source_pk)::text||']'));
   PERFORM 1 FROM control.canonical_source_identity c WHERE (c.tenant_key,c.source_id,c.entity,c.source_pk)=(p_tenant,tup.source_id,tup.entity,tup.source_pk) FOR UPDATE;
 END LOOP;
 SELECT c.canonical_object_id INTO own_id FROM control.canonical_source_identity c WHERE (c.tenant_key,c.source_id,c.entity,c.source_pk)=(p_tenant,p_source,j.entity,i.source_pk);
 IF pg_catalog.jsonb_typeof(mappings)='array' THEN
   SELECT x->>'target_id' INTO user_target FROM pg_catalog.jsonb_array_elements(mappings) x WHERE x->>'kind'='user' AND x->>'external_id'=user_key LIMIT 1;
   SELECT x->>'target_id' INTO dept_target FROM pg_catalog.jsonb_array_elements(mappings) x WHERE x->>'kind'='department' AND x->>'external_id'=dept_key LIMIT 1;
 END IF;
 -- Lock all exact owner and department subjects in deterministic order before testing eligibility.
 PERFORM 1 FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND (s.user_id=user_target OR s.department_id=dept_target) ORDER BY s.user_id COLLATE "C" FOR UPDATE;
 SELECT (s.enabled AND s.business_role='sales' AND s.department_id IS NOT NULL),s.department_id INTO user_ok,user_dept
   FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.user_id=user_target;
 SELECT EXISTS(SELECT 1 FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.enabled AND s.department_id=dept_target) INTO dept_ok;
 SELECT c.canonical_object_id,c.customer_id INTO ref_id,ref_customer FROM control.canonical_source_identity c
   WHERE (c.tenant_key,c.source_id,c.entity,c.source_pk)=(p_tenant,customer_source,'customer',customer_pk);
 IF ref_customer IS NOT NULL THEN
   PERFORM 1 FROM hub.canonical_customer c WHERE c.tenant_id=p_tenant AND c.id=ref_customer FOR UPDATE;
   SELECT EXISTS(SELECT 1 FROM hub.canonical_customer c WHERE c.tenant_id=p_tenant AND c.id=ref_customer AND c.deleted_at IS NULL) INTO customer_ok;
 END IF;
 SELECT pg_catalog.jsonb_build_object(
 'quarantineId',q.quarantine_id::text,'jobId',j.id::text,'ordinal',i.ordinal,'tenantId',j.tenant_key,'sourceId',j.source_id,'entity',j.entity,
 'rawBatchId',j.raw_batch_id::text,'batchId',j.batch_id::text,'requestDigest',pg_catalog.encode(j.request_digest,'hex'),
 'eventId',i.event_id::text,'sourcePk',i.source_pk,'sourceVersion',i.source_version::text,'operation',i.operation,
 'sourceUpdatedAt',pg_catalog.to_char(i.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'publicRecord',i.public_record,
 'proof',pg_catalog.jsonb_build_object('credentialId',j.credential_id::text,'sourceEpoch',j.source_epoch_at_admission::text,
  'credentialRevision',j.credential_revision_at_admission::text,'credentialGeneration',j.credential_generation_at_admission::text,
  'channelId',j.channel_id::text,'channelEpoch',j.channel_epoch::text,'ownerUserId',j.owner_user_id,'ownerRevision',j.owner_revision::text,
  'approvalId',j.owner_approval_id::text,'approvalSecurityFence',j.approval_security_fence::text,'configRevision',j.config_revision::text,
  'configDigest',pg_catalog.encode(j.config_digest,'hex'),'mappingRevision',j.mapping_revision::text,'mappingDigest',pg_catalog.encode(j.mapping_digest,'hex'),
  'identityMappingRevision',j.identity_mapping_revision::text,'identityMappingDigest',pg_catalog.encode(j.identity_mapping_digest,'hex'),
  'endpointProfileDigest',NULL,'testReportId',j.test_report_id::text,'sampleDigest',pg_catalog.encode(a.sample_digest,'hex'),
  'securityFence',j.security_barrier_fence_at_admission::text),
 'current',pg_catalog.jsonb_build_object('sourceRevision',reg.current_config_revision::text,'identityMappingRevision',reg.identity_mapping_revision::text,
   'identityMappingDigest',(SELECT pg_catalog.encode(x.mapping_digest,'hex') FROM control.source_identity_mapping_revision x WHERE (x.tenant_key,x.source_id,x.revision)=(p_tenant,p_source,reg.identity_mapping_revision))),
 'ownObjectId',own_id::text,'userOk',coalesce(user_ok,false),'userDepartment',user_dept,'departmentOk',dept_ok,
 'referenceObjectId',ref_id::text,'referenceCustomerId',ref_customer::text,'customerOk',customer_ok,
 'fences',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind',f.kind,'externalId',f.external_id,'revision',f.identity_mapping_revision::text))
   FROM control.source_identity_remap_fence f WHERE f.tenant_key=p_tenant AND f.source_id=p_source AND
    ((f.kind='user' AND f.external_id=user_key) OR (f.kind='department' AND f.external_id=dept_key))), '[]'::jsonb)) INTO result;
 RETURN result;
END $body$;
REVOKE ALL ON FUNCTION control.import_recovery_original_facts_internal(text,uuid,text) FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE FUNCTION control.read_import_recovery_original(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE src text; reg control.source_registry%ROWTYPE; epoch bigint; scopes text[];
BEGIN
 IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM control.lock_security_barrier_fence();
 SELECT q.source_id INTO src FROM control.ingestion_quarantine_index q WHERE q.tenant_key=p_tenant AND q.quarantine_id=p_quarantine;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM * FROM control.lock_source_credential(p_tenant,src);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO reg FROM control.source_registry r WHERE r.tenant_key=p_tenant AND r.source_id=src FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF reg.data_owner_user_id IS DISTINCT FROM p_user THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM control.source_channel c JOIN control.ingestion_quarantine_index q ON q.channel_id=c.id
  WHERE q.quarantine_id=p_quarantine AND q.tenant_key=p_tenant AND q.source_id=src FOR UPDATE OF c;
 SELECT s.auth_epoch,s.management_scopes INTO epoch,scopes FROM control.auth_subject s JOIN control.tenant t ON t.tenant_key=s.tenant_key
 JOIN control.identity_binding b ON (b.tenant_key,b.user_id)=(s.tenant_key,s.user_id)
 WHERE s.tenant_key=p_tenant AND s.user_id=p_user AND b.issuer=p_issuer AND b.subject=p_subject AND t.enabled AND s.enabled AND b.enabled FOR UPDATE OF t,s,b;
 IF NOT FOUND OR epoch IS DISTINCT FROM p_epoch THEN RAISE EXCEPTION 'AUTH_CONTEXT_CHANGED' USING ERRCODE='P0001'; END IF;
 IF NOT (scopes @> ARRAY['source:read']::text[]) THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN pg_catalog.jsonb_build_object('facts',control.import_recovery_original_facts_internal(p_tenant,p_quarantine,src));
END $body$;
REVOKE ALL ON FUNCTION control.read_import_recovery_original(text,uuid,text,text,text,bigint) FROM PUBLIC,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.read_import_recovery_original(text,uuid,text,text,text,bigint) TO hub_api;
