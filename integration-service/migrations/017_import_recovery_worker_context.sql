-- Worker-only operation and live-claim bound context. No recovery application.
CREATE FUNCTION control.read_import_recovery_worker_context(
 p_tenant text,p_source text,p_job uuid,p_ordinal integer,p_item_operation uuid,p_claim uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE j control.ingestion_job%ROWTYPE; i control.ingestion_job_item%ROWTYPE;
 o control.import_recovery_operation%ROWTYPE; reg control.source_registry%ROWTYPE;
 epoch bigint; scopes text[]; facts jsonb; fence bigint; failure text;
BEGIN
 IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' THEN
  RAISE EXCEPTION 'worker role required' USING ERRCODE='42501';
 END IF;
 fence:=control.lock_security_barrier_fence();
 SELECT * INTO j FROM control.ingestion_job WHERE (id,tenant_key,source_id)=(p_job,p_tenant,p_source);
 IF NOT FOUND OR j.import_recovery_operation_id IS NULL THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001';
 END IF;
 PERFORM 1 FROM control.ingestion_processing_outbox b
  WHERE b.job_id=j.id AND b.claim_token=p_claim AND b.lease_expires_at>clock_timestamp()
   AND b.acknowledged_at IS NULL FOR UPDATE OF b;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_CLAIM_LOST' USING ERRCODE='P0001'; END IF;
 SELECT * INTO i FROM control.ingestion_job_item x WHERE x.job_id=j.id AND x.ordinal=p_ordinal FOR UPDATE OF x;
 IF NOT FOUND OR p_ordinal IS DISTINCT FROM 0 OR i.operation_id IS DISTINCT FROM p_item_operation
  OR i.status IS DISTINCT FROM 'APPLYING' OR j.status IS DISTINCT FROM 'PROCESSING' THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001';
 END IF;
 SELECT * INTO o FROM control.import_recovery_operation x
  WHERE (x.operation_id,x.child_job_id,x.tenant_key,x.source_id,x.entity)=(j.import_recovery_operation_id,j.id,j.tenant_key,j.source_id,j.entity);
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001'; END IF;
 PERFORM * FROM control.lock_source_credential(p_tenant,p_source);
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001'; END IF;
 SELECT * INTO reg FROM control.source_registry r WHERE (r.tenant_key,r.source_id)=(p_tenant,p_source) FOR UPDATE OF r;
 IF NOT FOUND OR reg.data_owner_user_id IS DISTINCT FROM o.actor_user_id OR reg.owner_revision IS DISTINCT FROM o.owner_revision THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_AUTHORITY_INVALID' USING ERRCODE='P0001';
 END IF;
 PERFORM 1 FROM control.source_channel c WHERE c.tenant_key=p_tenant AND c.source_id=p_source
  AND c.id IN (j.channel_id,o.binding_channel_id) ORDER BY c.id FOR UPDATE OF c;
 SELECT s.auth_epoch,s.management_scopes INTO epoch,scopes FROM control.auth_subject s
  JOIN control.tenant t ON t.tenant_key=s.tenant_key
  JOIN control.identity_binding b ON (b.tenant_key,b.user_id)=(s.tenant_key,s.user_id)
  WHERE s.tenant_key=p_tenant AND s.user_id=o.actor_user_id AND b.issuer=o.actor_issuer AND b.subject=o.actor_subject
   AND t.enabled AND s.enabled AND b.enabled FOR UPDATE OF t,s,b;
 IF NOT FOUND OR epoch IS DISTINCT FROM o.actor_auth_epoch OR NOT (scopes @> ARRAY['source:approve']::text[]) THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_AUTHORITY_INVALID' USING ERRCODE='P0001';
 END IF;
 BEGIN
  PERFORM control.check_import_recovery_cycle(o.operation_id);
 EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT;
  IF failure='invalid import recovery binding proof' THEN
   RAISE EXCEPTION 'IMPORT_RECOVERY_PROOF_INVALID' USING ERRCODE='P0001';
  END IF;
  RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001';
 END;
 facts:=control.import_recovery_original_facts_internal(p_tenant,o.quarantine_id,p_source);
 IF facts IS NULL OR facts->>'jobId' IS DISTINCT FROM o.original_job_id::text
  OR (facts->>'ordinal')::integer IS DISTINCT FROM o.original_ordinal
  OR facts->>'sourcePk' IS DISTINCT FROM o.source_pk
  OR facts->>'ownObjectId' IS DISTINCT FROM o.reserved_object_id::text THEN
  RAISE EXCEPTION 'IMPORT_RECOVERY_CONTEXT_INVALID' USING ERRCODE='P0001';
 END IF;
 -- Row locks prevent claim replacement, but they do not stop the lease clock.
 PERFORM 1 FROM control.ingestion_processing_outbox b JOIN control.ingestion_job scoped ON scoped.id=b.job_id
  WHERE b.job_id=p_job AND scoped.tenant_key=p_tenant AND scoped.source_id=p_source
   AND b.claim_token=p_claim AND b.acknowledged_at IS NULL AND b.lease_expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_CLAIM_LOST' USING ERRCODE='P0001'; END IF;
 RETURN pg_catalog.jsonb_build_object(
  'operationId',o.operation_id::text,'reservedObjectId',o.reserved_object_id::text,'entity',o.entity,
  'actor',pg_catalog.jsonb_build_object('userId',o.actor_user_id,'issuer',o.actor_issuer,'subject',o.actor_subject,
    'authEpoch',o.actor_auth_epoch::text,'ownerRevision',o.owner_revision::text),
  'observedFence',fence::text,'confirmedBindings',o.confirmed_bindings,
  'original',pg_catalog.jsonb_build_object('quarantineId',facts->'quarantineId','jobId',facts->'jobId','ordinal',facts->'ordinal',
    'batchId',facts->'batchId','eventId',facts->'eventId','sourcePk',facts->'sourcePk','sourceVersion',facts->'sourceVersion',
    'sourceUpdatedAt',facts->'sourceUpdatedAt','publicRecord',facts->'publicRecord','proof',facts->'proof'),
  'bindingProof',pg_catalog.jsonb_build_object('credentialId',o.binding_credential_id::text,'sourceEpoch',o.binding_source_epoch::text,
    'credentialRevision',o.binding_credential_revision::text,'credentialGeneration',o.binding_credential_generation::text,
    'channelId',o.binding_channel_id::text,'channelEpoch',o.binding_channel_epoch::text,'ownerUserId',o.actor_user_id,
    'ownerRevision',o.owner_revision::text,'approvalId',o.binding_approval_id::text,'approvalSecurityFence',o.binding_approval_security_fence::text,
    'configRevision',o.binding_config_revision::text,'configDigest',pg_catalog.encode(o.binding_config_digest,'hex'),
    'mappingRevision',o.binding_mapping_revision::text,'mappingDigest',pg_catalog.encode(o.binding_mapping_digest,'hex'),
    'identityMappingRevision',o.binding_identity_mapping_revision::text,'identityMappingDigest',pg_catalog.encode(o.binding_identity_mapping_digest,'hex'),
    'endpointProfileDigest',NULL,'testReportId',o.binding_test_report_id::text,'sampleDigest',pg_catalog.encode(o.binding_sample_digest,'hex'),
    'securityFence',o.binding_security_fence::text));
END $body$;
REVOKE ALL ON FUNCTION control.read_import_recovery_worker_context(text,text,uuid,integer,uuid,uuid)
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.read_import_recovery_worker_context(text,text,uuid,integer,uuid,uuid) TO hub_worker;
