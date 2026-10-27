CREATE UNIQUE INDEX source_credential_snapshot_scope_idx ON control.source_credential(tenant_key,source_id,id);
CREATE UNIQUE INDEX source_config_snapshot_proof_idx ON control.source_config_revision(tenant_key,source_id,revision,config_digest);
CREATE UNIQUE INDEX source_mapping_snapshot_proof_idx ON control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest);
CREATE UNIQUE INDEX source_identity_mapping_snapshot_proof_idx
  ON control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest);
CREATE UNIQUE INDEX source_test_snapshot_proof_idx
  ON control.source_test_report(id,tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision);
CREATE UNIQUE INDEX source_approval_snapshot_proof_idx
  ON control.source_owner_approval(id,tenant_key,source_id,owner_user_id,owner_revision,config_revision,mapping_revision,
    identity_mapping_revision,test_report_id);

CREATE TABLE control.etl_run (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  run_mode text NOT NULL CHECK (run_mode = 'FULL_SNAPSHOT'),
  request_kind text NOT NULL CHECK (request_kind IN ('MANUAL','SCHEDULED')),
  request_route text NOT NULL CHECK (request_route IN ('API-019','DUE_GATE')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SCANNING','VALIDATING','READY','APPLYING','COMPLETE','FAILED','INCOMPLETE','CANCELLED')),
  credential_id uuid NOT NULL,
  credential_revision bigint NOT NULL CHECK (credential_revision > 0),
  credential_generation bigint NOT NULL CHECK (credential_generation > 0),
  source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
  admission_source_epoch bigint NOT NULL CHECK (admission_source_epoch >= 0),
  expected_entities text[] NOT NULL CHECK (cardinality(expected_entities)>0 AND expected_entities <@ ARRAY['customer','order']::text[]),
  entity_channel_proof jsonb NOT NULL CHECK (jsonb_typeof(entity_channel_proof)='object'),
  config_revision bigint NOT NULL CHECK (config_revision > 0),
  config_digest bytea NOT NULL CHECK (octet_length(config_digest)=32),
  mapping_revision bigint NOT NULL CHECK (mapping_revision > 0),
  mapping_digest bytea NOT NULL CHECK (octet_length(mapping_digest)=32),
  identity_mapping_revision bigint NOT NULL CHECK (identity_mapping_revision > 0),
  identity_mapping_digest bytea NOT NULL CHECK (octet_length(identity_mapping_digest)=32),
  endpoint_profile_digest bytea NOT NULL CHECK (octet_length(endpoint_profile_digest)=32),
  test_report_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  data_contract_ref text NOT NULL CHECK (length(data_contract_ref) BETWEEN 1 AND 256),
  delete_contract text NOT NULL CHECK (delete_contract IN ('tombstone','hard_delete')),
  security_barrier_fence bigint NOT NULL CHECK (security_barrier_fence >= 0),
  owner_user_id text NOT NULL,
  owner_revision bigint NOT NULL CHECK (owner_revision > 0),
  schedule_revision bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  extracted_count bigint NOT NULL DEFAULT 0 CHECK (extracted_count >= 0),
  applied_count bigint NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  quarantined_count bigint NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_:-]{1,96}$'),
  completeness_summary jsonb,
  checkpoint_summary jsonb,
  UNIQUE (tenant_key,source_id,run_id),
  UNIQUE (tenant_key,source_id,request_route,idempotency_key),
  FOREIGN KEY (tenant_key,source_id) REFERENCES control.source_registry(tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,credential_id) REFERENCES control.source_credential(tenant_key,source_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,config_revision,config_digest)
    REFERENCES control.source_config_revision(tenant_key,source_id,revision,config_digest) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,mapping_revision,mapping_digest)
    REFERENCES control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,identity_mapping_revision,identity_mapping_digest)
    REFERENCES control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (test_report_id,tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision)
    REFERENCES control.source_test_report(id,tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approval_id,tenant_key,source_id,owner_user_id,owner_revision,config_revision,mapping_revision,
    identity_mapping_revision,test_report_id)
    REFERENCES control.source_owner_approval(id,tenant_key,source_id,owner_user_id,owner_revision,config_revision,mapping_revision,
      identity_mapping_revision,test_report_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX etl_run_one_active_source_idx ON control.etl_run(tenant_key,source_id)
  WHERE status IN ('QUEUED','SCANNING','VALIDATING','READY','APPLYING');
CREATE INDEX etl_run_list_idx ON control.etl_run(tenant_key,created_at DESC,run_id DESC);

CREATE TABLE control.etl_run_attempt (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  run_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal=1),
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','INCOMPLETE','FAILED','COMPLETE')),
  source_snapshot_identity text,
  started_at timestamptz,
  ended_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_:-]{1,96}$'),
  UNIQUE (run_id,ordinal),
  UNIQUE (operation_id),
  FOREIGN KEY (tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.etl_snapshot_schedule (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  interval_seconds integer NOT NULL DEFAULT 300 CHECK (interval_seconds=300),
  next_due_at timestamptz NOT NULL,
  schedule_revision bigint NOT NULL CHECK (schedule_revision > 0),
  active_run_id uuid,
  last_run_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id),
  FOREIGN KEY (tenant_key,source_id) REFERENCES control.source_registry(tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,active_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,last_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX etl_snapshot_schedule_due_idx ON control.etl_snapshot_schedule(next_due_at,tenant_key,source_id) WHERE enabled;

CREATE FUNCTION control.guard_etl_run_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF (NEW.run_id,NEW.tenant_key,NEW.source_id,NEW.run_mode,NEW.request_kind,NEW.request_route,NEW.idempotency_key,NEW.request_digest,
      NEW.credential_id,NEW.credential_revision,NEW.credential_generation,NEW.source_epoch,NEW.admission_source_epoch,
      NEW.expected_entities,NEW.entity_channel_proof,NEW.config_revision,NEW.config_digest,NEW.mapping_revision,NEW.mapping_digest,
      NEW.identity_mapping_revision,NEW.identity_mapping_digest,NEW.endpoint_profile_digest,NEW.test_report_id,NEW.approval_id,
      NEW.data_contract_ref,NEW.delete_contract,NEW.security_barrier_fence,NEW.owner_user_id,NEW.owner_revision,NEW.schedule_revision,NEW.created_at)
     IS DISTINCT FROM
     (OLD.run_id,OLD.tenant_key,OLD.source_id,OLD.run_mode,OLD.request_kind,OLD.request_route,OLD.idempotency_key,OLD.request_digest,
      OLD.credential_id,OLD.credential_revision,OLD.credential_generation,OLD.source_epoch,OLD.admission_source_epoch,
      OLD.expected_entities,OLD.entity_channel_proof,OLD.config_revision,OLD.config_digest,OLD.mapping_revision,OLD.mapping_digest,
      OLD.identity_mapping_revision,OLD.identity_mapping_digest,OLD.endpoint_profile_digest,OLD.test_report_id,OLD.approval_id,
      OLD.data_contract_ref,OLD.delete_contract,OLD.security_barrier_fence,OLD.owner_user_id,OLD.owner_revision,OLD.schedule_revision,OLD.created_at) THEN
    RAISE EXCEPTION 'immutable ETL run proof' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER etl_run_proof_immutable BEFORE UPDATE ON control.etl_run
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_run_update();

CREATE FUNCTION control.lock_etl_snapshot_source(p_tenant_key text,p_source_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  PERFORM 1 FROM control.source_registry WHERE tenant_key=p_tenant_key AND source_id=p_source_id FOR UPDATE;
  RETURN FOUND;
END;
$body$;
ALTER FUNCTION control.lock_etl_snapshot_source(text,text) OWNER TO CURRENT_USER;

REVOKE ALL ON control.etl_run,control.etl_run_attempt,control.etl_snapshot_schedule FROM PUBLIC;
REVOKE ALL ON FUNCTION control.guard_etl_run_update() FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.lock_etl_snapshot_source(text,text) FROM PUBLIC,hub_mcp,hub_publisher,hub_hasura_read;
GRANT USAGE ON SCHEMA control TO hub_api,hub_worker;
GRANT SELECT (run_id,tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,request_digest,status,expected_entities,
  extracted_count,applied_count,quarantined_count,created_at,started_at,completed_at,config_revision,mapping_revision,
  identity_mapping_revision,completeness_summary,checkpoint_summary) ON control.etl_run TO hub_api;
GRANT SELECT (tenant_key,source_id,schedule_revision,enabled,active_run_id,last_run_id,next_due_at,interval_seconds)
  ON control.etl_snapshot_schedule TO hub_api;
GRANT INSERT (tenant_key,source_id,enabled,interval_seconds,next_due_at,schedule_revision)
  ON control.etl_snapshot_schedule TO hub_api;
GRANT INSERT (tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,request_digest,credential_id,
  credential_revision,credential_generation,source_epoch,admission_source_epoch,expected_entities,entity_channel_proof,
  config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
  endpoint_profile_digest,test_report_id,approval_id,data_contract_ref,delete_contract,security_barrier_fence,owner_user_id,
  owner_revision,schedule_revision) ON control.etl_run TO hub_api;
GRANT SELECT (tenant_key,source_id,run_id,ordinal,operation_id,status,started_at,ended_at,error_code) ON control.etl_run_attempt TO hub_api;
GRANT SELECT ON control.etl_run,control.etl_run_attempt,control.etl_snapshot_schedule TO hub_worker;
GRANT INSERT (tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,request_digest,credential_id,
  credential_revision,credential_generation,source_epoch,admission_source_epoch,expected_entities,entity_channel_proof,
  config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
  endpoint_profile_digest,test_report_id,approval_id,data_contract_ref,delete_contract,security_barrier_fence,owner_user_id,
  owner_revision,schedule_revision) ON control.etl_run TO hub_worker;
GRANT SELECT (tenant_key,source_id,lifecycle,current_config_revision,mapping_revision,identity_mapping_revision,
  data_owner_user_id,owner_revision) ON control.source_registry TO hub_worker;
GRANT SELECT (id,tenant_key,source_id,enabled,allowed_entities,revision,source_epoch,credential_generation)
  ON control.source_credential TO hub_worker;
GRANT SELECT (tenant_key,enabled) ON control.tenant TO hub_worker;
GRANT SELECT (tenant_key,user_id,enabled) ON control.auth_subject TO hub_worker;
GRANT EXECUTE ON FUNCTION control.lock_etl_snapshot_source(text,text) TO hub_api,hub_worker;
GRANT EXECUTE ON FUNCTION control.lock_source_credential(text,text),control.lock_source_channel(text,text,text) TO hub_worker;
GRANT INSERT (tenant_key,source_id,run_id,ordinal,operation_id,status) ON control.etl_run_attempt TO hub_api,hub_worker;
GRANT UPDATE (active_run_id,last_run_id,next_due_at,updated_at,enabled,schedule_revision,interval_seconds) ON control.etl_snapshot_schedule TO hub_api;
GRANT UPDATE (active_run_id,last_run_id,next_due_at,updated_at) ON control.etl_snapshot_schedule TO hub_worker;
GRANT UPDATE (status,started_at,completed_at,extracted_count,applied_count,quarantined_count,error_code,completeness_summary,checkpoint_summary)
  ON control.etl_run TO hub_worker;
GRANT UPDATE (status,started_at,ended_at,error_code,source_snapshot_identity) ON control.etl_run_attempt TO hub_worker;

-- M1-5B snapshot extraction is a separate lease and attempt domain from the
-- 008 ingestion-item lease. Claiming a run does not create an attempt.
ALTER TABLE control.etl_run_attempt DROP CONSTRAINT etl_run_attempt_ordinal_check;
ALTER TABLE control.etl_run_attempt ADD CONSTRAINT etl_run_attempt_ordinal_check CHECK (ordinal BETWEEN 1 AND 4);
ALTER TABLE control.etl_run_attempt ADD COLUMN claim_token uuid;
ALTER TABLE control.etl_run_attempt ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE control.etl_run_attempt ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE control.etl_run ADD COLUMN snapshot_claim_token uuid;
ALTER TABLE control.etl_run ADD COLUMN snapshot_lease_expires_at timestamptz;
ALTER TABLE control.etl_run ADD COLUMN snapshot_available_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE TABLE control.etl_snapshot_stage_page (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  relation text NOT NULL CHECK (relation IN ('customer','order','order_line')),
  page_no integer NOT NULL CHECK (page_no > 0),
  row_count integer NOT NULL CHECK (row_count > 0),
  first_key text NOT NULL,
  last_key text NOT NULL,
  page_digest bytea NOT NULL CHECK (octet_length(page_digest)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,run_id,attempt_id,entity,relation,page_no),
  FOREIGN KEY (tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES control.etl_run_attempt(attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((relation='customer' AND entity='customer') OR (relation IN ('order','order_line') AND entity='order'))
);
CREATE TABLE control.etl_snapshot_stage_record (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  relation text NOT NULL CHECK (relation IN ('customer','order','order_line')),
  parent_source_pk text NOT NULL DEFAULT '',
  source_pk text NOT NULL CHECK (length(source_pk)>0),
  source_version text,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk),
  FOREIGN KEY (tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES control.etl_run_attempt(attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((relation='customer' AND entity='customer' AND parent_source_pk='') OR
    (relation='order' AND entity='order' AND parent_source_pk='') OR
    (relation='order_line' AND entity='order' AND parent_source_pk<>''))
);
CREATE INDEX etl_snapshot_stage_record_lookup_idx ON control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation);
CREATE TABLE control.etl_snapshot_manifest (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  state text NOT NULL CHECK (state='EXTRACTED'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest)=32),
  source_snapshot_identity text NOT NULL CHECK (manifest->>'source_snapshot_identity'=source_snapshot_identity),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,run_id,attempt_id),
  UNIQUE (attempt_id),
  FOREIGN KEY (tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES control.etl_run_attempt(attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION control.reject_snapshot_stage_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
BEGIN
  RAISE EXCEPTION 'snapshot stage is immutable' USING ERRCODE='55000';
END;
$body$;
CREATE TRIGGER etl_snapshot_page_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_stage_page
FOR EACH ROW EXECUTE FUNCTION control.reject_snapshot_stage_mutation();
CREATE TRIGGER etl_snapshot_record_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_stage_record
FOR EACH ROW EXECUTE FUNCTION control.reject_snapshot_stage_mutation();
CREATE TRIGGER etl_snapshot_manifest_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_manifest
FOR EACH ROW EXECUTE FUNCTION control.reject_snapshot_stage_mutation();

REVOKE ALL ON control.etl_snapshot_stage_page,control.etl_snapshot_stage_record,control.etl_snapshot_manifest FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.reject_snapshot_stage_mutation() FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

-- Freeze the unredacted source profile and mappings only for the dedicated worker.
GRANT SELECT (tenant_key,source_id,revision,config_digest,config) ON control.source_config_revision TO hub_worker;
GRANT SELECT (tenant_key,source_id,revision,mapping_digest,mappings) ON control.source_mapping_revision TO hub_worker;
GRANT SELECT (tenant_key,source_id,revision,mapping_digest) ON control.source_identity_mapping_revision TO hub_worker;
REVOKE ALL ON control.etl_run,control.etl_run_attempt,control.etl_snapshot_schedule FROM hub_worker;
REVOKE INSERT ON control.etl_run FROM hub_worker;
GRANT SELECT (run_id,tenant_key,source_id,status,expected_entities,credential_id,config_revision,config_digest,mapping_revision,
  mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,entity_channel_proof,
  delete_contract,security_barrier_fence,run_mode,request_kind,request_route,idempotency_key,request_digest,
  owner_user_id,owner_revision,schedule_revision,created_at,started_at,completed_at,extracted_count,applied_count,
  quarantined_count,completeness_summary,checkpoint_summary,snapshot_claim_token,snapshot_lease_expires_at,snapshot_available_at)
  ON control.etl_run TO hub_worker;
GRANT SELECT (attempt_id,tenant_key,source_id,run_id,ordinal,operation_id,status,source_snapshot_identity,started_at,ended_at,
  error_code,claim_token,lease_expires_at,available_at) ON control.etl_run_attempt TO hub_worker;
GRANT SELECT (tenant_key,source_id,enabled,interval_seconds,next_due_at,active_run_id,last_run_id,schedule_revision)
  ON control.etl_snapshot_schedule TO hub_worker;
-- Preserve A's existing due-admission gate, which creates API-019-equivalent
-- runs and marks the schedule's active run under the same Hub transaction.
GRANT INSERT (tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,request_digest,credential_id,
  credential_revision,credential_generation,source_epoch,admission_source_epoch,expected_entities,entity_channel_proof,
  config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
  endpoint_profile_digest,test_report_id,approval_id,data_contract_ref,delete_contract,security_barrier_fence,owner_user_id,
  owner_revision,schedule_revision) ON control.etl_run TO hub_worker;
GRANT INSERT (tenant_key,source_id,run_id,ordinal,operation_id,status) ON control.etl_run_attempt TO hub_worker;
GRANT UPDATE (active_run_id,last_run_id,next_due_at,updated_at) ON control.etl_snapshot_schedule TO hub_worker;

CREATE FUNCTION control.assert_etl_snapshot_claim(p_tenant_key text,p_source_id text,p_run_id uuid,p_claim_token uuid)
RETURNS control.etl_run LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE run_row control.etl_run%ROWTYPE;
BEGIN
  PERFORM control.lock_security_barrier_fence();
  SELECT * INTO run_row FROM control.etl_run r WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id AND r.run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR run_row.snapshot_claim_token IS DISTINCT FROM p_claim_token OR
     run_row.snapshot_lease_expires_at IS NULL OR run_row.snapshot_lease_expires_at<=clock_timestamp() OR
     run_row.status<>'SCANNING' THEN RAISE EXCEPTION 'snapshot claim lost' USING ERRCODE='40001'; END IF;
  IF EXISTS (SELECT 1 FROM control.source_security_barrier b
      WHERE b.tenant_key=run_row.tenant_key AND b.effective_fence>run_row.security_barrier_fence
        AND (b.source_id IS NULL OR b.source_id=run_row.source_id)
        AND (b.credential_id IS NULL OR b.credential_id=run_row.credential_id)
        AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')
        AND ((b.entity IS NULL AND b.channel_id IS NULL) OR EXISTS (SELECT 1 FROM jsonb_each(run_row.entity_channel_proof) proof
          WHERE (b.entity IS NULL OR proof.key=b.entity) AND (b.channel_id IS NULL OR proof.value->>'channel_id'=b.channel_id::text)))) THEN
    RAISE EXCEPTION 'snapshot security barrier' USING ERRCODE='42501';
  END IF;
  RETURN run_row;
END;
$body$;

CREATE FUNCTION control.claim_etl_snapshot_run(p_tenant_key text,p_source_id text,p_lease_seconds integer)
RETURNS TABLE(run_id uuid,claim_token uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE run_row control.etl_run%ROWTYPE; current_attempt control.etl_run_attempt%ROWTYPE; token uuid;
  retry_seconds integer[] := ARRAY[5,30,120];
BEGIN
  IF p_lease_seconds<10 OR p_lease_seconds>900 THEN RAISE EXCEPTION 'snapshot lease invalid' USING ERRCODE='22023'; END IF;
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  SELECT * INTO run_row FROM control.etl_run r WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id
    AND r.status IN ('QUEUED','SCANNING') AND r.snapshot_available_at<=clock_timestamp()
    AND (r.snapshot_claim_token IS NULL OR r.snapshot_lease_expires_at<=clock_timestamp())
    ORDER BY r.created_at,r.run_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=run_row.tenant_key
      AND b.effective_fence>run_row.security_barrier_fence AND (b.source_id IS NULL OR b.source_id=run_row.source_id)
      AND (b.credential_id IS NULL OR b.credential_id=run_row.credential_id)
      AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')
      AND ((b.entity IS NULL AND b.channel_id IS NULL) OR EXISTS (SELECT 1 FROM jsonb_each(run_row.entity_channel_proof) proof
        WHERE (b.entity IS NULL OR proof.key=b.entity) AND (b.channel_id IS NULL OR proof.value->>'channel_id'=b.channel_id::text)))) THEN
    UPDATE control.etl_run SET status='FAILED',completed_at=clock_timestamp(),error_code='SNAPSHOT_SECURITY_BARRIER',
      snapshot_claim_token=NULL,snapshot_lease_expires_at=NULL WHERE etl_run.run_id=run_row.run_id;
    UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,next_due_at=GREATEST(next_due_at,run_row.created_at+interval '300 seconds'),
      updated_at=clock_timestamp() WHERE tenant_key=run_row.tenant_key AND source_id=run_row.source_id AND active_run_id=run_row.run_id;
    RETURN;
  END IF;
  IF run_row.snapshot_claim_token IS NOT NULL AND run_row.snapshot_lease_expires_at<=clock_timestamp() THEN
    SELECT * INTO current_attempt FROM control.etl_run_attempt a WHERE a.run_id=run_row.run_id AND a.status='RUNNING' ORDER BY a.ordinal DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE control.etl_run_attempt SET status='INCOMPLETE',ended_at=clock_timestamp(),error_code='SNAPSHOT_LEASE_EXPIRED',
        claim_token=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+make_interval(secs=>retry_seconds[LEAST(current_attempt.ordinal,3)])
        WHERE attempt_id=current_attempt.attempt_id;
      IF current_attempt.ordinal>=4 THEN
        UPDATE control.etl_run SET status='FAILED',completed_at=clock_timestamp(),error_code='SNAPSHOT_ATTEMPTS_EXHAUSTED',
          snapshot_claim_token=NULL,snapshot_lease_expires_at=NULL WHERE etl_run.run_id=run_row.run_id;
        UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,next_due_at=GREATEST(next_due_at,run_row.created_at+interval '300 seconds'),
          updated_at=clock_timestamp() WHERE tenant_key=run_row.tenant_key AND source_id=run_row.source_id AND active_run_id=run_row.run_id;
      ELSE
        UPDATE control.etl_run SET snapshot_claim_token=NULL,snapshot_lease_expires_at=NULL,
          snapshot_available_at=clock_timestamp()+make_interval(secs=>retry_seconds[LEAST(current_attempt.ordinal,3)])
          WHERE etl_run.run_id=run_row.run_id;
      END IF;
      RETURN;
    END IF;
  END IF;
  token:=gen_random_uuid();
  UPDATE control.etl_run SET status='SCANNING',snapshot_claim_token=token,
    snapshot_lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    started_at=COALESCE(started_at,clock_timestamp()) WHERE etl_run.run_id=run_row.run_id;
  run_id:=run_row.run_id; claim_token:=token; RETURN NEXT;
END;
$body$;

CREATE FUNCTION control.begin_etl_snapshot_attempt(p_tenant_key text,p_source_id text,p_run_id uuid,p_claim_token uuid,p_lease_seconds integer)
RETURNS TABLE(attempt_id uuid,ordinal smallint,operation_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE run_row control.etl_run%ROWTYPE; next_ordinal integer; new_attempt control.etl_run_attempt%ROWTYPE;
BEGIN
  run_row:=control.assert_etl_snapshot_claim(p_tenant_key,p_source_id,p_run_id,p_claim_token);
  SELECT * INTO new_attempt FROM control.etl_run_attempt a WHERE a.run_id=p_run_id AND a.status='QUEUED' ORDER BY a.ordinal LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE control.etl_run_attempt AS a SET status='RUNNING',started_at=clock_timestamp(),claim_token=p_claim_token,
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds) WHERE a.attempt_id=new_attempt.attempt_id RETURNING a.* INTO new_attempt;
    attempt_id:=new_attempt.attempt_id; ordinal:=new_attempt.ordinal; operation_id:=new_attempt.operation_id; RETURN NEXT; RETURN;
  END IF;
  SELECT COALESCE(MAX(a.ordinal),0)+1 INTO next_ordinal FROM control.etl_run_attempt a WHERE a.run_id=p_run_id;
  IF next_ordinal>4 THEN RAISE EXCEPTION 'snapshot attempts exhausted' USING ERRCODE='54000'; END IF;
  INSERT INTO control.etl_run_attempt(tenant_key,source_id,run_id,ordinal,operation_id,status,started_at,claim_token,lease_expires_at)
    VALUES(p_tenant_key,p_source_id,p_run_id,next_ordinal,gen_random_uuid(),'RUNNING',clock_timestamp(),p_claim_token,
      clock_timestamp()+make_interval(secs=>p_lease_seconds)) RETURNING * INTO new_attempt;
  attempt_id:=new_attempt.attempt_id; ordinal:=new_attempt.ordinal; operation_id:=new_attempt.operation_id; RETURN NEXT;
END;
$body$;

CREATE FUNCTION control.heartbeat_etl_snapshot_run(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,
  p_claim_token uuid,p_lease_seconds integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  PERFORM control.assert_etl_snapshot_claim(p_tenant_key,p_source_id,p_run_id,p_claim_token);
  UPDATE control.etl_run SET snapshot_lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    WHERE run_id=p_run_id AND snapshot_claim_token=p_claim_token;
  UPDATE control.etl_run_attempt SET lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    WHERE attempt_id=p_attempt_id AND run_id=p_run_id AND claim_token=p_claim_token AND status='RUNNING';
  RETURN FOUND;
END;
$body$;

CREATE FUNCTION control.write_etl_snapshot_page(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_entity text,p_relation text,p_page_no integer,p_first_key text,p_last_key text,p_digest bytea,p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE run_row control.etl_run%ROWTYPE; n integer; last_page integer;
BEGIN
  run_row:=control.assert_etl_snapshot_claim(p_tenant_key,p_source_id,p_run_id,p_claim_token);
  IF p_attempt_id IS NULL OR p_page_no<1 OR octet_length(p_digest)<>32 OR jsonb_typeof(p_rows)<>'array' OR
     (p_relation='customer' AND p_entity<>'customer') OR (p_relation IN ('order','order_line') AND p_entity<>'order') OR
     p_relation NOT IN ('customer','order','order_line') THEN RAISE EXCEPTION 'snapshot page invalid' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM control.etl_run_attempt WHERE attempt_id=p_attempt_id AND run_id=p_run_id AND status='RUNNING'
      AND claim_token=p_claim_token AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'snapshot attempt lost' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(MAX(page_no),0) INTO last_page FROM control.etl_snapshot_stage_page
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id AND entity=p_entity AND relation=p_relation;
  IF p_page_no<>last_page+1 THEN RAISE EXCEPTION 'snapshot page sequence invalid' USING ERRCODE='22023'; END IF;
  n:=jsonb_array_length(p_rows);
  IF n<1 THEN RAISE EXCEPTION 'snapshot page empty' USING ERRCODE='22023'; END IF;
  INSERT INTO control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,source_version,facts)
  SELECT p_tenant_key,p_source_id,p_run_id,p_attempt_id,x.entity,x.relation,COALESCE(x.parent_source_pk,''),x.source_pk,x.source_version,x.facts
    FROM jsonb_to_recordset(p_rows) AS x(entity text,relation text,parent_source_pk text,source_pk text,source_version text,facts jsonb);
  INSERT INTO control.etl_snapshot_stage_page(tenant_key,source_id,run_id,attempt_id,entity,relation,page_no,row_count,first_key,last_key,page_digest)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_entity,p_relation,p_page_no,n,p_first_key,p_last_key,p_digest);
  RETURN n;
END;
$body$;

CREATE FUNCTION control.fail_etl_snapshot_attempt(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_error_code text,p_retryable boolean) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE run_row control.etl_run%ROWTYPE; attempt_row control.etl_run_attempt%ROWTYPE; retry_seconds integer[]:=ARRAY[5,30,120]; retry boolean;
BEGIN
  PERFORM control.lock_security_barrier_fence();
  SELECT * INTO run_row FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR run_row.snapshot_claim_token IS DISTINCT FROM p_claim_token OR run_row.snapshot_lease_expires_at<=clock_timestamp() THEN RETURN 'STALE'; END IF;
  SELECT * INTO attempt_row FROM control.etl_run_attempt WHERE attempt_id=p_attempt_id AND run_id=p_run_id AND status='RUNNING'
    AND claim_token=p_claim_token FOR UPDATE;
  IF NOT FOUND THEN RETURN 'STALE'; END IF;
  retry:=p_retryable AND attempt_row.ordinal<4;
  UPDATE control.etl_run_attempt SET status=CASE WHEN retry THEN 'INCOMPLETE' ELSE 'FAILED' END,ended_at=clock_timestamp(),
    error_code=p_error_code,claim_token=NULL,lease_expires_at=NULL,
    available_at=CASE WHEN retry THEN clock_timestamp()+make_interval(secs=>retry_seconds[attempt_row.ordinal]) ELSE available_at END
    WHERE attempt_id=p_attempt_id;
  IF retry THEN
    UPDATE control.etl_run SET snapshot_claim_token=NULL,snapshot_lease_expires_at=NULL,
      snapshot_available_at=clock_timestamp()+make_interval(secs=>retry_seconds[attempt_row.ordinal]) WHERE run_id=p_run_id;
    RETURN 'RETRY';
  END IF;
  UPDATE control.etl_run SET status='FAILED',completed_at=clock_timestamp(),error_code=p_error_code,
    snapshot_claim_token=NULL,snapshot_lease_expires_at=NULL WHERE run_id=p_run_id;
  UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,next_due_at=GREATEST(next_due_at,run_row.created_at+interval '300 seconds'),
    updated_at=clock_timestamp() WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND active_run_id=p_run_id;
  RETURN 'FAILED';
END;
$body$;

CREATE FUNCTION control.complete_etl_snapshot_manifest(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_manifest jsonb,p_digest bytea) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE run_row control.etl_run%ROWTYPE; relation_row record; expected_relations text[]; total_rows bigint; manifest_rows bigint;
BEGIN
  run_row:=control.assert_etl_snapshot_claim(p_tenant_key,p_source_id,p_run_id,p_claim_token);
  IF p_digest IS NULL OR octet_length(p_digest)<>32 OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR
     p_manifest->>'profile_digest' IS DISTINCT FROM encode(run_row.endpoint_profile_digest,'hex') OR
     p_manifest->>'mapping_digest' IS DISTINCT FROM encode(run_row.mapping_digest,'hex') OR
     p_manifest->>'config_digest' IS DISTINCT FROM encode(run_row.config_digest,'hex') OR
     p_manifest->>'identity_mapping_digest' IS DISTINCT FROM encode(run_row.identity_mapping_digest,'hex') OR
     p_manifest->>'attempt_id' IS DISTINCT FROM p_attempt_id::text OR
     jsonb_typeof(p_manifest->'config_digest') IS DISTINCT FROM 'string' OR
     jsonb_typeof(p_manifest->'identity_mapping_digest') IS DISTINCT FROM 'string' OR
     jsonb_typeof(p_manifest->'relations') IS DISTINCT FROM 'array' OR
     jsonb_typeof(p_manifest->'relation_counts') IS DISTINCT FROM 'array' OR
     jsonb_typeof(p_manifest->'source_snapshot_identity') IS DISTINCT FROM 'string' OR
     p_manifest->>'source_snapshot_identity' !~ '^[0-9a-f]{64}$' OR
     NOT EXISTS (SELECT 1 FROM control.etl_run_attempt WHERE attempt_id=p_attempt_id AND run_id=p_run_id AND status='RUNNING'
       AND operation_id::text IS NOT DISTINCT FROM p_manifest->>'operation_id'
       AND claim_token=p_claim_token AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'snapshot manifest proof invalid' USING ERRCODE='22023'; END IF;
  expected_relations:=ARRAY[]::text[];
  IF 'customer'=ANY(run_row.expected_entities) THEN expected_relations:=array_append(expected_relations,'customer'); END IF;
  IF 'order'=ANY(run_row.expected_entities) THEN expected_relations:=array_append(expected_relations,'order'); expected_relations:=array_append(expected_relations,'order_line'); END IF;
  IF (SELECT array_agg(value ORDER BY value) FROM jsonb_array_elements_text(p_manifest->'relations') AS rel(value)) IS DISTINCT FROM
     (SELECT array_agg(value ORDER BY value) FROM unnest(expected_relations) AS rel(value)) THEN RAISE EXCEPTION 'snapshot relation coverage invalid' USING ERRCODE='22023'; END IF;
  FOR relation_row IN SELECT * FROM jsonb_to_recordset(p_manifest->'relation_counts') AS r(relation text,row_count bigint,page_count integer,page_digests jsonb) LOOP
    IF relation_row.relation IS NULL OR relation_row.relation <> ALL(expected_relations) OR
       relation_row.row_count IS NULL OR relation_row.row_count<0 OR relation_row.page_count IS NULL OR relation_row.page_count<0 OR
       jsonb_typeof(relation_row.page_digests) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'snapshot relation count invalid' USING ERRCODE='22023';
    END IF;
    IF (SELECT COALESCE(sum(row_count),0) FROM control.etl_snapshot_stage_page WHERE tenant_key=p_tenant_key AND source_id=p_source_id
        AND run_id=p_run_id AND attempt_id=p_attempt_id AND relation=relation_row.relation)<>relation_row.row_count OR
       (SELECT count(*) FROM control.etl_snapshot_stage_page WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id
        AND attempt_id=p_attempt_id AND relation=relation_row.relation)<>relation_row.page_count OR
       (relation_row.page_count>0 AND (SELECT (min(page_no),max(page_no)) FROM control.etl_snapshot_stage_page WHERE tenant_key=p_tenant_key
        AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id AND relation=relation_row.relation)
        IS DISTINCT FROM (1,relation_row.page_count)) OR relation_row.page_digests IS DISTINCT FROM
        (SELECT COALESCE(jsonb_agg(encode(page_digest,'hex') ORDER BY page_no),'[]'::jsonb) FROM control.etl_snapshot_stage_page
          WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id AND relation=relation_row.relation)
       THEN RAISE EXCEPTION 'snapshot page receipt mismatch' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF jsonb_array_length(p_manifest->'relation_counts')<>cardinality(expected_relations) OR
     (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_manifest->'relation_counts') AS item(value))<>cardinality(expected_relations) OR
     (SELECT array_agg(relation ORDER BY relation) FROM jsonb_to_recordset(p_manifest->'relation_counts') AS r(relation text))
       IS DISTINCT FROM (SELECT array_agg(value ORDER BY value) FROM unnest(expected_relations) AS rel(value))
     THEN RAISE EXCEPTION 'snapshot relation count set invalid' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM control.etl_snapshot_stage_page WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id
      AND attempt_id=p_attempt_id AND relation<>ALL(expected_relations)) THEN RAISE EXCEPTION 'snapshot unexpected relation' USING ERRCODE='22023'; END IF;
  IF 'order'=ANY(run_row.expected_entities) AND EXISTS (SELECT 1 FROM control.etl_snapshot_stage_record line
      LEFT JOIN control.etl_snapshot_stage_record header ON header.tenant_key=line.tenant_key AND header.source_id=line.source_id
        AND header.run_id=line.run_id AND header.attempt_id=line.attempt_id AND header.entity='order' AND header.relation='order'
        AND header.parent_source_pk='' AND header.source_pk=line.parent_source_pk
      WHERE line.tenant_key=p_tenant_key AND line.source_id=p_source_id AND line.run_id=p_run_id AND line.attempt_id=p_attempt_id
        AND line.relation='order_line' AND header.source_pk IS NULL) THEN RAISE EXCEPTION 'snapshot orphan line' USING ERRCODE='23503'; END IF;
  IF EXISTS (SELECT 1 FROM control.etl_snapshot_stage_record line WHERE line.tenant_key=p_tenant_key AND line.source_id=p_source_id
       AND line.run_id=p_run_id AND line.attempt_id=p_attempt_id AND line.relation='order_line'
       AND NOT (line.facts ?& ARRAY['lines.source_line_id','lines.product_code','lines.product_name','lines.quantity','lines.unit_price','lines.line_amount']))
    THEN RAISE EXCEPTION 'snapshot incomplete line facts' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO total_rows FROM control.etl_snapshot_stage_record WHERE tenant_key=p_tenant_key AND source_id=p_source_id
    AND run_id=p_run_id AND attempt_id=p_attempt_id;
  manifest_rows:=NULLIF(p_manifest->>'row_count','')::bigint;
  IF manifest_rows IS DISTINCT FROM total_rows THEN RAISE EXCEPTION 'snapshot manifest row count mismatch' USING ERRCODE='22023'; END IF;
  IF NULLIF(p_manifest->>'page_count','')::bigint IS DISTINCT FROM
     (SELECT count(*) FROM control.etl_snapshot_stage_page WHERE tenant_key=p_tenant_key AND source_id=p_source_id
       AND run_id=p_run_id AND attempt_id=p_attempt_id) THEN
    RAISE EXCEPTION 'snapshot manifest page count mismatch' USING ERRCODE='22023';
  END IF;
  INSERT INTO control.etl_snapshot_manifest(tenant_key,source_id,run_id,attempt_id,state,manifest,manifest_digest,source_snapshot_identity)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,'EXTRACTED',p_manifest,p_digest,p_manifest->>'source_snapshot_identity');
  UPDATE control.etl_run_attempt SET status='COMPLETE',ended_at=clock_timestamp(),claim_token=NULL,lease_expires_at=NULL,
    source_snapshot_identity=p_manifest->>'source_snapshot_identity' WHERE attempt_id=p_attempt_id;
  UPDATE control.etl_run SET status='VALIDATING',extracted_count=total_rows,snapshot_claim_token=NULL,snapshot_lease_expires_at=NULL,
    completeness_summary=jsonb_build_object('status','EXTRACTED','manifest_digest',encode(p_digest,'hex'),'attempt_id',p_attempt_id)
    WHERE run_id=p_run_id;
  RETURN total_rows;
END;
$body$;

REVOKE ALL ON FUNCTION control.assert_etl_snapshot_claim(text,text,uuid,uuid),
  control.claim_etl_snapshot_run(text,text,integer),control.begin_etl_snapshot_attempt(text,text,uuid,uuid,integer),
  control.heartbeat_etl_snapshot_run(text,text,uuid,uuid,uuid,integer),
  control.write_etl_snapshot_page(text,text,uuid,uuid,uuid,text,text,integer,text,text,bytea,jsonb),
  control.fail_etl_snapshot_attempt(text,text,uuid,uuid,uuid,text,boolean),
  control.complete_etl_snapshot_manifest(text,text,uuid,uuid,uuid,jsonb,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.claim_etl_snapshot_run(text,text,integer),
  control.begin_etl_snapshot_attempt(text,text,uuid,uuid,integer),
  control.heartbeat_etl_snapshot_run(text,text,uuid,uuid,uuid,integer),
  control.write_etl_snapshot_page(text,text,uuid,uuid,uuid,text,text,integer,text,text,bytea,jsonb),
  control.fail_etl_snapshot_attempt(text,text,uuid,uuid,uuid,text,boolean),
  control.complete_etl_snapshot_manifest(text,text,uuid,uuid,uuid,jsonb,bytea) TO hub_worker;
