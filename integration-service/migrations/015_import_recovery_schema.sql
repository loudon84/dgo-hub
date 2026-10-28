-- An import-specific, immutable acceptance record. No runtime role may write it.
ALTER TABLE control.ingestion_job ADD COLUMN import_recovery_operation_id uuid;
CREATE UNIQUE INDEX import_recovery_quarantine_scope_key ON control.ingestion_quarantine_index
  (quarantine_id,tenant_key,source_id,entity,job_id,ordinal,source_pk);
CREATE UNIQUE INDEX import_recovery_channel_scope_key ON control.source_channel(id,tenant_key,source_id,entity,channel_epoch);

CREATE TABLE control.import_recovery_operation (
 operation_id uuid PRIMARY KEY,
 tenant_key text NOT NULL, source_id text NOT NULL, entity text NOT NULL CHECK (entity IN ('customer','order')),
 quarantine_id uuid NOT NULL UNIQUE, original_job_id uuid NOT NULL, original_ordinal integer NOT NULL CHECK (original_ordinal BETWEEN 0 AND 99),
 source_pk text NOT NULL, reserved_object_id uuid NOT NULL, child_job_id uuid NOT NULL UNIQUE,
 route text NOT NULL CHECK (route='/hub/v1/admin/quarantine/'||quarantine_id::text||'/import-recovery'),
 idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
 request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
 expected_state text NOT NULL CHECK (char_length(expected_state) BETWEEN 1 AND 2048 AND expected_state !~ '[[:cntrl:]]'),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000 AND reason !~ '^[[:space:]]|[[:space:]]$'),
 actor_user_id text NOT NULL CHECK (char_length(actor_user_id) BETWEEN 1 AND 256 AND actor_user_id !~ '[[:cntrl:]]'),
 actor_issuer text NOT NULL CHECK (char_length(actor_issuer) BETWEEN 1 AND 2048 AND actor_issuer !~ '[[:cntrl:]]'),
 actor_subject text NOT NULL CHECK (char_length(actor_subject) BETWEEN 1 AND 256 AND actor_subject !~ '[[:cntrl:]]'),
 actor_auth_epoch bigint NOT NULL CHECK (actor_auth_epoch>=0), owner_revision bigint NOT NULL CHECK (owner_revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 binding_proof_version integer NOT NULL CHECK (binding_proof_version=1),
 binding_approval_id uuid NOT NULL, binding_test_report_id uuid NOT NULL,
 binding_config_revision bigint NOT NULL CHECK (binding_config_revision>0), binding_config_digest bytea NOT NULL CHECK (octet_length(binding_config_digest)=32),
 binding_mapping_revision bigint NOT NULL CHECK (binding_mapping_revision>0), binding_mapping_digest bytea NOT NULL CHECK (octet_length(binding_mapping_digest)=32),
 binding_identity_mapping_revision bigint NOT NULL CHECK (binding_identity_mapping_revision>0), binding_identity_mapping_digest bytea NOT NULL CHECK (octet_length(binding_identity_mapping_digest)=32),
 binding_sample_digest bytea NOT NULL CHECK (octet_length(binding_sample_digest)=32), binding_credential_id uuid NOT NULL,
 binding_source_epoch bigint NOT NULL CHECK (binding_source_epoch>=0), binding_credential_revision bigint NOT NULL CHECK (binding_credential_revision>0),
 binding_credential_generation bigint NOT NULL CHECK (binding_credential_generation>0), binding_channel_id uuid NOT NULL,
 binding_channel_epoch bigint NOT NULL CHECK (binding_channel_epoch>0),
 binding_approval_security_fence bigint NOT NULL CHECK (binding_approval_security_fence>=0),
 binding_security_fence bigint NOT NULL CHECK (binding_security_fence>=binding_approval_security_fence),
 confirmed_bindings jsonb NOT NULL,
 UNIQUE (tenant_key,source_id,route,idempotency_key),
 UNIQUE (operation_id,child_job_id,tenant_key,source_id,entity),
 FOREIGN KEY (quarantine_id,tenant_key,source_id,entity,original_job_id,original_ordinal,source_pk)
  REFERENCES control.ingestion_quarantine_index(quarantine_id,tenant_key,source_id,entity,job_id,ordinal,source_pk) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (original_job_id,tenant_key,source_id,entity) REFERENCES control.ingestion_job(id,tenant_key,source_id,entity) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (original_job_id,original_ordinal) REFERENCES control.ingestion_job_item(job_id,ordinal) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (tenant_key,source_id,entity,source_pk,reserved_object_id)
  REFERENCES control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (tenant_key,source_id,binding_approval_id) REFERENCES control.source_owner_approval(tenant_key,source_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (tenant_key,source_id,binding_test_report_id) REFERENCES control.source_test_report(tenant_key,source_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (tenant_key,source_id,binding_config_revision) REFERENCES control.source_config_revision(tenant_key,source_id,revision) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (tenant_key,source_id,binding_mapping_revision) REFERENCES control.source_mapping_revision(tenant_key,source_id,revision) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (tenant_key,source_id,binding_identity_mapping_revision) REFERENCES control.source_identity_mapping_revision(tenant_key,source_id,revision) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (binding_credential_id,tenant_key,source_id) REFERENCES control.source_credential(id,tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (binding_channel_id,tenant_key,source_id,entity,binding_channel_epoch) REFERENCES control.source_channel(id,tenant_key,source_id,entity,channel_epoch) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY (child_job_id,tenant_key,source_id,entity) REFERENCES control.ingestion_job(id,tenant_key,source_id,entity)
  ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE control.ingestion_job ADD CONSTRAINT import_recovery_child_reverse_fk
 FOREIGN KEY (import_recovery_operation_id,id,tenant_key,source_id,entity)
 REFERENCES control.import_recovery_operation(operation_id,child_job_id,tenant_key,source_id,entity)
 ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
REVOKE ALL ON control.import_recovery_operation FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE FUNCTION control.reject_import_recovery_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'immutable import recovery operation' USING ERRCODE='55000'; END $body$;
CREATE TRIGGER import_recovery_operation_immutable BEFORE UPDATE OR DELETE ON control.import_recovery_operation
 FOR EACH ROW EXECUTE FUNCTION control.reject_import_recovery_mutation();
CREATE FUNCTION control.guard_import_recovery_discriminator() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
 IF NEW.import_recovery_operation_id IS DISTINCT FROM OLD.import_recovery_operation_id THEN
  RAISE EXCEPTION 'immutable import recovery discriminator' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER import_recovery_discriminator_immutable BEFORE UPDATE ON control.ingestion_job
 FOR EACH ROW EXECUTE FUNCTION control.guard_import_recovery_discriminator();
CREATE FUNCTION control.reject_import_recovery_child_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
 IF EXISTS (SELECT 1 FROM control.ingestion_job j WHERE j.id=NEW.job_id AND j.import_recovery_operation_id IS NOT NULL) THEN
  RAISE EXCEPTION 'import recovery child cannot have management admission audit' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER import_recovery_child_audit_guard BEFORE INSERT ON control.ingestion_management_admission_audit
 FOR EACH ROW EXECUTE FUNCTION control.reject_import_recovery_child_audit();
-- The BEFORE snapshot can miss an uncommitted child. Recheck after the audit
-- FK has resolved, including when constraints are made immediate.
CREATE CONSTRAINT TRIGGER import_recovery_child_audit_recheck AFTER INSERT ON control.ingestion_management_admission_audit
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control.reject_import_recovery_child_audit();
REVOKE ALL ON FUNCTION control.reject_import_recovery_mutation(),control.guard_import_recovery_discriminator(),control.reject_import_recovery_child_audit()
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

-- Only immutable facts are compared here. Current lifecycle, Owner, epoch and
-- credential generation are runtime authorization checks, not invariants.
CREATE FUNCTION control.check_import_recovery_cycle(p_operation uuid) RETURNS void
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
   OR (b->>'externalId') ~ '[[:cntrl:]]' OR (b->>'targetId') ~ '[[:cntrl:]]'
  THEN RAISE EXCEPTION 'invalid import recovery binding' USING ERRCODE='23514'; END IF;
  IF o.entity='customer' THEN
   IF k NOT IN ('user','department') OR b - 'kind' - 'externalId' - 'targetId' <> '{}'::jsonb
    OR char_length(b->>'externalId')>128 OR (b->>'externalId') ~ '^[[:space:]]|[[:space:]]$'
    OR (k='user' AND b->>'externalId' IS DISTINCT FROM i.public_record->'data'->>'owner_external_id')
    OR (k='department' AND b->>'externalId' IS DISTINCT FROM i.public_record->'data'->>'department_external_id')
   THEN RAISE EXCEPTION 'invalid import recovery customer binding' USING ERRCODE='23514'; END IF;
  ELSE
   IF k IS DISTINCT FROM 'customer' OR b - 'kind' - 'sourceId' - 'sourcePk' - 'externalId' - 'targetId' <> '{}'::jsonb
    OR pg_catalog.jsonb_typeof(b->'sourceId') IS DISTINCT FROM 'string' OR pg_catalog.jsonb_typeof(b->'sourcePk') IS DISTINCT FROM 'string'
    OR (b->>'sourceId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' OR char_length(b->>'sourcePk') NOT BETWEEN 1 AND 128
    OR (b->>'sourcePk') ~ '[[:cntrl:]]|^[[:space:]]|[[:space:]]$'
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

-- Serialize later cardinality changes against the operation before they occur.
CREATE FUNCTION control.lock_import_recovery_child() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE old_id uuid; new_id uuid; op uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN old_id:=OLD.job_id; END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW.job_id; END IF;
 FOR op IN SELECT DISTINCT j.import_recovery_operation_id FROM control.ingestion_job j
  WHERE j.id IN (old_id,new_id) AND j.import_recovery_operation_id IS NOT NULL ORDER BY j.import_recovery_operation_id LOOP
  PERFORM 1 FROM control.import_recovery_operation WHERE operation_id=op FOR UPDATE;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER import_recovery_item_lock BEFORE INSERT OR DELETE OR UPDATE OF job_id ON control.ingestion_job_item
 FOR EACH ROW EXECUTE FUNCTION control.lock_import_recovery_child();
CREATE TRIGGER import_recovery_outbox_lock BEFORE INSERT OR DELETE OR UPDATE OF job_id ON control.ingestion_processing_outbox
 FOR EACH ROW EXECUTE FUNCTION control.lock_import_recovery_child();

CREATE FUNCTION control.enforce_import_recovery_cycle() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE old_op uuid; new_op uuid;
BEGIN
 IF TG_TABLE_NAME='import_recovery_operation' THEN
  IF TG_OP<>'DELETE' THEN new_op:=NEW.operation_id; END IF;
  IF TG_OP<>'INSERT' THEN old_op:=OLD.operation_id; END IF;
 ELSIF TG_TABLE_NAME='ingestion_job' THEN
  IF TG_OP<>'DELETE' THEN new_op:=NEW.import_recovery_operation_id; END IF;
  IF TG_OP<>'INSERT' THEN old_op:=OLD.import_recovery_operation_id; END IF;
 ELSE
  IF TG_OP<>'DELETE' THEN SELECT import_recovery_operation_id INTO new_op FROM control.ingestion_job WHERE id=NEW.job_id; END IF;
  IF TG_OP<>'INSERT' THEN SELECT import_recovery_operation_id INTO old_op FROM control.ingestion_job WHERE id=OLD.job_id; END IF;
 END IF;
 IF old_op IS NOT NULL THEN PERFORM control.check_import_recovery_cycle(old_op); END IF;
 IF new_op IS NOT NULL AND new_op IS DISTINCT FROM old_op THEN PERFORM control.check_import_recovery_cycle(new_op); END IF;
 RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER import_recovery_operation_cycle AFTER INSERT OR UPDATE OR DELETE ON control.import_recovery_operation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control.enforce_import_recovery_cycle();
CREATE CONSTRAINT TRIGGER import_recovery_job_cycle AFTER INSERT OR UPDATE OR DELETE ON control.ingestion_job
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control.enforce_import_recovery_cycle();
CREATE CONSTRAINT TRIGGER import_recovery_item_cycle AFTER INSERT OR UPDATE OR DELETE ON control.ingestion_job_item
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control.enforce_import_recovery_cycle();
CREATE CONSTRAINT TRIGGER import_recovery_outbox_cycle AFTER INSERT OR UPDATE OR DELETE ON control.ingestion_processing_outbox
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control.enforce_import_recovery_cycle();
REVOKE ALL ON FUNCTION control.check_import_recovery_cycle(uuid),control.lock_import_recovery_child(),control.enforce_import_recovery_cycle()
 FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

-- Preserve the 013 private resolver, excluding every flagged original.
-- Private original facts and row locks. Only a separately authorized definer may call this.
CREATE OR REPLACE FUNCTION control.import_recovery_original_facts_internal(p_tenant text,p_quarantine uuid,p_source text)
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
 IF NOT FOUND OR j.import_recovery_operation_id IS NOT NULL OR j.route<>'/hub/v1/admin/sources/'||p_source||'/import/'||j.entity OR j.endpoint_profile_digest IS NOT NULL
   OR j.version_domain<>'SOURCE_VERSION' OR q.ordinal NOT BETWEEN 0 AND 99 OR q.ordinal>=j.received_count
   OR NOT EXISTS(SELECT 1 FROM control.ingestion_management_admission_audit x WHERE (x.job_id,x.tenant_key,x.source_id)=(j.id,p_tenant,p_source)) THEN RETURN NULL; END IF;
 SELECT * INTO i FROM control.ingestion_job_item WHERE job_id=j.id AND ordinal=q.ordinal;
 IF NOT FOUND OR i.status<>'QUARANTINED' OR i.operation<>'UPSERT' OR (i.event_id,i.source_pk,i.error_code) IS DISTINCT FROM (q.event_id,q.source_pk,q.error_code)
   OR (((j.entity='customer' AND q.error_code='IDENTITY_MAPPING_REQUIRED') OR (j.entity='order' AND q.error_code IN ('IDENTITY_MAPPING_REQUIRED','IDENTITY_MAPPING_TARGET_INVALID'))) IS NOT TRUE) THEN RETURN NULL; END IF;
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

CREATE FUNCTION control.import_recovery_candidate_filter(p_tenant text,p_quarantine uuid,p_envelope jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT CASE WHEN p_envelope IS NULL THEN NULL
  WHEN EXISTS (SELECT 1 FROM control.import_recovery_operation o WHERE o.tenant_key=p_tenant AND o.quarantine_id=p_quarantine)
   THEN pg_catalog.jsonb_set(p_envelope,'{facts}','null'::jsonb)
  ELSE p_envelope END
$body$;
REVOKE ALL ON FUNCTION control.import_recovery_candidate_filter(text,uuid,jsonb) FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
CREATE OR REPLACE FUNCTION control.read_import_recovery_original(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT control.import_recovery_candidate_filter(p_tenant,p_quarantine,
  control.import_recovery_authorize_internal(p_tenant,p_quarantine,p_user,p_issuer,p_subject,p_epoch,'source:read'))
$body$;
CREATE OR REPLACE FUNCTION control.read_import_recovery_for_approval(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT control.import_recovery_candidate_filter(p_tenant,p_quarantine,
  control.import_recovery_authorize_internal(p_tenant,p_quarantine,p_user,p_issuer,p_subject,p_epoch,'source:approve'))
$body$;
