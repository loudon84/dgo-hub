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
CREATE UNIQUE INDEX etl_run_attempt_scope_idx ON control.etl_run_attempt(tenant_key,source_id,run_id,attempt_id);

CREATE TABLE control.etl_snapshot_schedule (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  interval_seconds integer NOT NULL DEFAULT 300 CHECK (interval_seconds=300),
  next_due_at timestamptz NOT NULL,
  schedule_revision bigint NOT NULL CHECK (schedule_revision > 0),
  active_run_id uuid,
  last_run_id uuid,
  last_successful_run_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id),
  FOREIGN KEY (tenant_key,source_id) REFERENCES control.source_registry(tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,active_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,last_successful_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
  page_no integer NOT NULL CHECK (page_no>0),
  row_ordinal integer NOT NULL CHECK (row_ordinal>0),
  source_version text,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk),
  FOREIGN KEY (tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES control.etl_run_attempt(attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,run_id,attempt_id,entity,relation,page_no)
    REFERENCES control.etl_snapshot_stage_page(tenant_key,source_id,run_id,attempt_id,entity,relation,page_no) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((relation='customer' AND entity='customer' AND parent_source_pk='') OR
    (relation='order' AND entity='order' AND parent_source_pk='') OR
    (relation='order_line' AND entity='order' AND parent_source_pk<>''))
);
CREATE UNIQUE INDEX etl_snapshot_stage_record_page_ordinal_idx ON control.etl_snapshot_stage_record
  (tenant_key,source_id,run_id,attempt_id,entity,relation,page_no,row_ordinal);
CREATE INDEX etl_snapshot_stage_record_lookup_idx ON control.etl_snapshot_stage_record
  (tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk);
CREATE INDEX etl_snapshot_stage_record_semantic_idx ON control.etl_snapshot_stage_record
  (tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk COLLATE "C",source_pk COLLATE "C");
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

-- C continuation state is separate from B extraction attempts and 008 item leases.
CREATE TABLE control.etl_snapshot_continuation (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  claim_token uuid,
  lease_until timestamptz,
  c_start_count integer NOT NULL DEFAULT 0 CHECK (c_start_count BETWEEN 0 AND 4),
  next_retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,run_id),
  FOREIGN KEY (tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,run_id,attempt_id) REFERENCES control.etl_run_attempt(tenant_key,source_id,run_id,attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((claim_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX etl_snapshot_continuation_due_idx ON control.etl_snapshot_continuation(next_retry_at,tenant_key,source_id,run_id);

CREATE TABLE control.etl_snapshot_validation (
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, attempt_id uuid NOT NULL,
  manifest_digest bytea NOT NULL CHECK(octet_length(manifest_digest)=32),
  proof_scope_digest bytea NOT NULL CHECK(octet_length(proof_scope_digest)=32),
  semantic_digest bytea NOT NULL CHECK(octet_length(semantic_digest)=32),
  coverage jsonb NOT NULL CHECK(jsonb_typeof(coverage)='object'),
  validated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_key,source_id,run_id,attempt_id),
  FOREIGN KEY(tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,run_id,attempt_id) REFERENCES control.etl_snapshot_manifest(tenant_key,source_id,run_id,attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.etl_snapshot_observation_sequence (
  tenant_key text NOT NULL, source_id text NOT NULL,
  next_value numeric(20,0) NOT NULL DEFAULT 1 CHECK(next_value BETWEEN 1 AND 99999999999999999999),
  PRIMARY KEY(tenant_key,source_id)
);
CREATE TABLE control.etl_snapshot_observation_allocation (
  tenant_key text NOT NULL, source_id text NOT NULL, sequence_value numeric(20,0) NOT NULL,
  semantic_digest bytea NOT NULL CHECK(octet_length(semantic_digest)=32),
  reuse_scope_digest bytea NOT NULL CHECK(octet_length(reuse_scope_digest)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_key,source_id,sequence_value),
  FOREIGN KEY(tenant_key,source_id) REFERENCES control.source_registry(tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX etl_snapshot_observation_reuse_idx ON control.etl_snapshot_observation_allocation
  (tenant_key,source_id,reuse_scope_digest,semantic_digest,sequence_value);
CREATE TABLE control.etl_snapshot_observation (
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, attempt_id uuid NOT NULL,
  sequence_value numeric(20,0) NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_key,source_id,run_id),
  UNIQUE(tenant_key,source_id,run_id,sequence_value),
  FOREIGN KEY(tenant_key,source_id,run_id,attempt_id) REFERENCES control.etl_snapshot_validation(tenant_key,source_id,run_id,attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,sequence_value) REFERENCES control.etl_snapshot_observation_allocation(tenant_key,source_id,sequence_value) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.etl_snapshot_apply_outcome (
  outcome_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, attempt_id uuid NOT NULL,
  entity text NOT NULL CHECK(entity IN ('customer','order')), relation text NOT NULL CHECK(relation IN ('customer','order')),
  parent_source_pk text NOT NULL DEFAULT '', source_pk text NOT NULL, aggregate_digest bytea NOT NULL CHECK(octet_length(aggregate_digest)=32),
  status text NOT NULL CHECK(status IN ('APPLIED','DUPLICATE','IGNORED_STALE','QUARANTINED','CHANNEL_EPOCH_RETIRED','FAILED')),
  error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk),
  UNIQUE(outcome_id,tenant_key,source_id,run_id,attempt_id),
  FOREIGN KEY(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk)
    REFERENCES control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,run_id,attempt_id) REFERENCES control.etl_snapshot_validation(tenant_key,source_id,run_id,attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE control.etl_snapshot_apply_range (
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, attempt_id uuid NOT NULL,
  entity text NOT NULL, relation text NOT NULL, parent_source_pk text NOT NULL DEFAULT '', source_pk text NOT NULL,
  aggregate_digest bytea NOT NULL CHECK(octet_length(aggregate_digest)=32), proof_scope_digest bytea NOT NULL CHECK(octet_length(proof_scope_digest)=32),
  outcome_id uuid NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk),
  FOREIGN KEY(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk)
    REFERENCES control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(outcome_id,tenant_key,source_id,run_id,attempt_id)
    REFERENCES control.etl_snapshot_apply_outcome(outcome_id,tenant_key,source_id,run_id,attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE control.etl_snapshot_checkpoint (
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, entity text NOT NULL CHECK(entity IN ('customer','order')),
  last_relation text, last_parent_source_pk text NOT NULL DEFAULT '', last_source_pk text, completed_count bigint NOT NULL DEFAULT 0 CHECK(completed_count>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_key,source_id,run_id,entity),
  FOREIGN KEY(tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION control.reject_etl_snapshot_c_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
BEGIN RAISE EXCEPTION 'snapshot C proof is immutable' USING ERRCODE='55000'; END;
$body$;
CREATE TRIGGER etl_snapshot_validation_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_validation
  FOR EACH ROW EXECUTE FUNCTION control.reject_etl_snapshot_c_mutation();
CREATE TRIGGER etl_snapshot_observation_allocation_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_observation_allocation
  FOR EACH ROW EXECUTE FUNCTION control.reject_etl_snapshot_c_mutation();
CREATE TRIGGER etl_snapshot_observation_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_observation
  FOR EACH ROW EXECUTE FUNCTION control.reject_etl_snapshot_c_mutation();
CREATE TRIGGER etl_snapshot_apply_outcome_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_apply_outcome
  FOR EACH ROW EXECUTE FUNCTION control.reject_etl_snapshot_c_mutation();
CREATE TRIGGER etl_snapshot_apply_range_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_apply_range
  FOR EACH ROW EXECUTE FUNCTION control.reject_etl_snapshot_c_mutation();

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
  INSERT INTO control.etl_snapshot_stage_page(tenant_key,source_id,run_id,attempt_id,entity,relation,page_no,row_count,first_key,last_key,page_digest)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_entity,p_relation,p_page_no,n,p_first_key,p_last_key,p_digest);
  INSERT INTO control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,page_no,row_ordinal,source_version,facts)
  SELECT p_tenant_key,p_source_id,p_run_id,p_attempt_id,r.entity,r.relation,COALESCE(r.parent_source_pk,''),r.source_pk,p_page_no,x.ordinality::integer,r.source_version,r.facts
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS x(value,ordinality)
    CROSS JOIN LATERAL jsonb_to_record(x.value) AS r(entity text,relation text,parent_source_pk text,source_pk text,source_version text,facts jsonb);
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

CREATE FUNCTION control.claim_etl_snapshot_continuation(p_tenant_key text,p_source_id text,p_lease_seconds integer)
RETURNS TABLE(tenant_key text,source_id text,run_id uuid,attempt_id uuid,claim_token uuid,status text,c_start_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE r control.etl_run%ROWTYPE; c control.etl_snapshot_continuation%ROWTYPE; a uuid; token uuid;
BEGIN
  PERFORM control.lock_security_barrier_fence();
  IF p_lease_seconds<10 OR p_lease_seconds>900 THEN RAISE EXCEPTION 'snapshot C lease invalid' USING ERRCODE='22023'; END IF;
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  SELECT er.* INTO r FROM control.etl_run er JOIN control.etl_snapshot_schedule s
    ON (s.tenant_key,s.source_id,s.active_run_id)=(er.tenant_key,er.source_id,er.run_id)
    WHERE er.tenant_key=p_tenant_key AND er.source_id=p_source_id AND er.status IN ('VALIDATING','APPLYING') FOR UPDATE OF er,s;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT m.attempt_id INTO a FROM control.etl_snapshot_manifest m WHERE m.tenant_key=p_tenant_key AND m.source_id=p_source_id
    AND m.run_id=r.run_id AND m.state='EXTRACTED' ORDER BY m.created_at DESC LIMIT 1;
  IF a IS NULL THEN RETURN; END IF;
  INSERT INTO control.etl_snapshot_continuation(tenant_key,source_id,run_id,attempt_id)
    VALUES(p_tenant_key,p_source_id,r.run_id,a) ON CONFLICT ON CONSTRAINT etl_snapshot_continuation_pkey DO NOTHING;
  SELECT * INTO c FROM control.etl_snapshot_continuation x WHERE x.tenant_key=p_tenant_key AND x.source_id=p_source_id AND x.run_id=r.run_id FOR UPDATE;
  IF c.attempt_id<>a THEN RAISE EXCEPTION 'snapshot C attempt changed' USING ERRCODE='55000'; END IF;
  IF c.lease_until IS NOT NULL AND c.lease_until<=clock_timestamp() AND c.c_start_count>0 THEN
    IF c.c_start_count>=4 THEN
      UPDATE control.etl_run AS er SET status='FAILED',completed_at=clock_timestamp(),quarantined_count=GREATEST(er.quarantined_count,1),
        completeness_summary=jsonb_build_object('status','FAILED','error_code','RETRY_BUDGET_EXHAUSTED') WHERE er.run_id=r.run_id;
      UPDATE control.etl_snapshot_schedule AS ss SET active_run_id=NULL,last_run_id=r.run_id,updated_at=clock_timestamp()
        WHERE ss.tenant_key=p_tenant_key AND ss.source_id=p_source_id AND ss.active_run_id=r.run_id;
      UPDATE control.etl_snapshot_continuation AS cc SET claim_token=NULL,lease_until=NULL,last_error_code='WORKER_LEASE_EXPIRED',updated_at=clock_timestamp()
        WHERE cc.tenant_key=p_tenant_key AND cc.source_id=p_source_id AND cc.run_id=r.run_id;
      RETURN;
    END IF;
    UPDATE control.etl_snapshot_continuation AS cc SET claim_token=NULL,lease_until=NULL,last_error_code='WORKER_LEASE_EXPIRED',
      next_retry_at=clock_timestamp()+make_interval(secs=>(ARRAY[5,30,120])[LEAST(c.c_start_count,3)]),updated_at=clock_timestamp()
      WHERE cc.tenant_key=p_tenant_key AND cc.source_id=p_source_id AND cc.run_id=r.run_id;
    RETURN;
  END IF;
  IF c.lease_until>clock_timestamp() OR c.next_retry_at>clock_timestamp() THEN RETURN; END IF;
  IF c.c_start_count>=4 THEN
    UPDATE control.etl_run AS er SET status='FAILED',completed_at=clock_timestamp(),quarantined_count=GREATEST(er.quarantined_count,1),
      completeness_summary=jsonb_build_object('status','FAILED','error_code','RETRY_BUDGET_EXHAUSTED') WHERE er.run_id=r.run_id;
    UPDATE control.etl_snapshot_schedule AS ss SET active_run_id=NULL,last_run_id=r.run_id,updated_at=clock_timestamp()
      WHERE ss.tenant_key=p_tenant_key AND ss.source_id=p_source_id AND ss.active_run_id=r.run_id;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=p_tenant_key AND b.effective_fence>r.security_barrier_fence
    AND (b.source_id IS NULL OR b.source_id=p_source_id)
    AND (b.credential_id IS NULL OR b.credential_id=r.credential_id)
    AND (b.entity IS NULL OR b.entity=ANY(r.expected_entities))
    AND (b.channel_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_each(r.entity_channel_proof) e
      WHERE (e.value->>'channel_id')::uuid=b.channel_id))
    AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')) THEN
    UPDATE control.etl_run AS er SET status='FAILED',completed_at=clock_timestamp(),quarantined_count=GREATEST(er.quarantined_count,1),
      completeness_summary=jsonb_build_object('status','FAILED','error_code','SECURITY_BARRIER_ACTIVE') WHERE er.run_id=r.run_id;
    UPDATE control.etl_snapshot_schedule AS ss SET active_run_id=NULL,last_run_id=r.run_id,updated_at=clock_timestamp()
      WHERE ss.tenant_key=p_tenant_key AND ss.source_id=p_source_id AND ss.active_run_id=r.run_id;
    RETURN;
  END IF;
  token:=gen_random_uuid();
  UPDATE control.etl_snapshot_continuation AS cc SET claim_token=token,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
    WHERE cc.tenant_key=p_tenant_key AND cc.source_id=p_source_id AND cc.run_id=r.run_id;
  RETURN QUERY SELECT p_tenant_key,p_source_id,r.run_id,a,token,r.status,c.c_start_count;
END;
$body$;

CREATE FUNCTION control.assert_etl_snapshot_continuation(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE r control.etl_run%ROWTYPE;
BEGIN
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  SELECT er.* INTO r FROM control.etl_run er JOIN control.etl_snapshot_continuation c
    ON (c.tenant_key,c.source_id,c.run_id)=(er.tenant_key,er.source_id,er.run_id)
    WHERE er.tenant_key=p_tenant_key AND er.source_id=p_source_id AND er.run_id=p_run_id AND er.status IN ('VALIDATING','APPLYING')
      AND c.attempt_id=p_attempt_id AND c.claim_token=p_claim_token AND c.lease_until>clock_timestamp() FOR UPDATE OF er,c;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=p_tenant_key AND b.effective_fence>r.security_barrier_fence
    AND (b.source_id IS NULL OR b.source_id=p_source_id) AND (b.credential_id IS NULL OR b.credential_id=r.credential_id)
    AND (b.entity IS NULL OR b.entity=ANY(r.expected_entities))
    AND (b.channel_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_each(r.entity_channel_proof) e
      WHERE (e.value->>'channel_id')::uuid=b.channel_id))
    AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')) THEN RETURN false; END IF;
  RETURN true;
END;
$body$;

CREATE FUNCTION control.assert_etl_snapshot_apply_claim(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  RETURN control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token);
END;
$body$;

CREATE FUNCTION control.lock_etl_snapshot_order_customer_reference(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,
  p_claim_token uuid,p_customer_source_id text,p_customer_source_pk text,p_identity_mappings jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub
AS $body$
DECLARE mapped_target text; tuple_target uuid; live_target uuid;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN false; END IF;
  IF jsonb_typeof(p_identity_mappings)<>'array' OR p_customer_source_pk IS NULL OR p_customer_source_pk='' THEN RETURN false; END IF;
  SELECT x->>'target_id' INTO mapped_target FROM jsonb_array_elements(p_identity_mappings) x
    WHERE x->>'kind'='customer' AND x->>'external_id'=p_customer_source_pk LIMIT 1;
  IF mapped_target IS NULL THEN RETURN false; END IF;
  SELECT customer_id INTO tuple_target FROM control.canonical_source_identity
    WHERE tenant_key=p_tenant_key AND source_id=p_customer_source_id AND entity='customer' AND source_pk=p_customer_source_pk
    FOR SHARE;
  IF NOT FOUND OR tuple_target::text<>mapped_target THEN RETURN false; END IF;
  SELECT id INTO live_target FROM hub.canonical_customer
    WHERE tenant_id=p_tenant_key AND id=tuple_target AND deleted_at IS NULL FOR SHARE;
  RETURN FOUND AND live_target=tuple_target;
END;
$body$;

CREATE FUNCTION control.begin_etl_snapshot_c_start(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE c control.etl_snapshot_continuation%ROWTYPE;
BEGIN
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  SELECT * INTO c FROM control.etl_snapshot_continuation WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id
    AND attempt_id=p_attempt_id AND claim_token=p_claim_token AND lease_until>clock_timestamp() AND next_retry_at<=clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF c.c_start_count>=4 THEN RETURN NULL; END IF;
  UPDATE control.etl_snapshot_continuation SET c_start_count=c_start_count+1,updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  RETURN c.c_start_count+1;
END;
$body$;

CREATE FUNCTION control.heartbeat_etl_snapshot_continuation(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,
  p_claim_token uuid,p_lease_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF p_lease_seconds<10 OR p_lease_seconds>900 THEN RETURN false; END IF;
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id
      AND claim_token=p_claim_token AND lease_until>clock_timestamp();
  RETURN FOUND;
END;
$body$;

CREATE FUNCTION control.fail_etl_snapshot_continuation(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,
  p_claim_token uuid,p_error_code text,p_retryable boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE c control.etl_snapshot_continuation%ROWTYPE; delay_seconds integer[]:=ARRAY[5,30,120];
BEGIN
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  SELECT * INTO c FROM control.etl_snapshot_continuation WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id
    AND attempt_id=p_attempt_id AND claim_token=p_claim_token AND lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'STALE'; END IF;
  UPDATE control.etl_snapshot_continuation SET claim_token=NULL,lease_until=NULL,last_error_code=left(p_error_code,96),
    next_retry_at=CASE WHEN p_retryable AND c.c_start_count<4 THEN clock_timestamp()+make_interval(secs=>delay_seconds[LEAST(c.c_start_count,3)]) ELSE clock_timestamp() END,
    updated_at=clock_timestamp() WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  IF NOT p_retryable OR c.c_start_count>=4 THEN
    UPDATE control.etl_run SET status='FAILED',completed_at=clock_timestamp(),quarantined_count=GREATEST(quarantined_count,1),
      completeness_summary=jsonb_build_object('status','FAILED','error_code',left(p_error_code,96)) WHERE run_id=p_run_id;
    UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,last_run_id=p_run_id,updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND active_run_id=p_run_id;
    RETURN 'FAILED';
  END IF;
  RETURN 'RETRY_PENDING';
END;
$body$;

CREATE FUNCTION control.read_etl_snapshot_stage_page(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_entity text,p_relation text,p_page_no integer)
RETURNS TABLE(row_count integer,page_digest bytea,record jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_manifest m WHERE m.tenant_key=p_tenant_key AND m.source_id=p_source_id AND m.run_id=p_run_id
      AND m.attempt_id=p_attempt_id AND m.state='EXTRACTED') THEN RETURN; END IF;
  RETURN QUERY SELECT p.row_count,p.page_digest,to_jsonb(r) FROM control.etl_snapshot_stage_page p
    JOIN control.etl_snapshot_stage_record r ON (r.tenant_key,r.source_id,r.run_id,r.attempt_id,r.entity,r.relation,r.page_no)=
      (p.tenant_key,p.source_id,p.run_id,p.attempt_id,p.entity,p.relation,p.page_no)
    WHERE p.tenant_key=p_tenant_key AND p.source_id=p_source_id AND p.run_id=p_run_id AND p.attempt_id=p_attempt_id
      AND p.entity=p_entity AND p.relation=p_relation AND p.page_no=p_page_no ORDER BY r.row_ordinal;
END;
$body$;

CREATE FUNCTION control.read_etl_snapshot_c_proof(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE result jsonb;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN NULL; END IF;
  SELECT jsonb_build_object(
    'tenant_key',r.tenant_key,'source_id',r.source_id,'run_id',r.run_id,'status',r.status,'expected_entities',r.expected_entities,
    'credential_id',r.credential_id,'credential_revision',r.credential_revision,'credential_generation',r.credential_generation,
    'admission_source_epoch',r.admission_source_epoch,'entity_channel_proof',r.entity_channel_proof,
    'config_revision',r.config_revision,'config_digest',encode(r.config_digest,'hex'),'config',c.config,
    'mapping_revision',r.mapping_revision,'mapping_digest',encode(r.mapping_digest,'hex'),'mappings',m.mappings,
    'identity_mapping_revision',r.identity_mapping_revision,'identity_mapping_digest',encode(r.identity_mapping_digest,'hex'),'identity_mappings',i.mappings,
    'endpoint_profile_digest',encode(r.endpoint_profile_digest,'hex'),'test_report_id',r.test_report_id,'approval_id',r.approval_id,
    'data_contract_ref',r.data_contract_ref,'delete_contract',r.delete_contract,'security_barrier_fence',r.security_barrier_fence,
    'owner_user_id',r.owner_user_id,'owner_revision',r.owner_revision,'manifest',jsonb_build_object('manifest',sm.manifest,'digest',encode(sm.manifest_digest,'hex')))
  INTO result FROM control.etl_run r JOIN control.source_config_revision c
      ON (c.tenant_key,c.source_id,c.revision,c.config_digest)=(r.tenant_key,r.source_id,r.config_revision,r.config_digest)
    JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision,m.mapping_digest)=(r.tenant_key,r.source_id,r.mapping_revision,r.mapping_digest)
    JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision,i.mapping_digest)=(r.tenant_key,r.source_id,r.identity_mapping_revision,r.identity_mapping_digest)
    JOIN control.source_owner_approval a ON (a.id,a.tenant_key,a.source_id,a.owner_user_id,a.owner_revision,a.config_revision,a.mapping_revision,
      a.identity_mapping_revision,a.test_report_id)=(r.approval_id,r.tenant_key,r.source_id,r.owner_user_id,r.owner_revision,r.config_revision,
      r.mapping_revision,r.identity_mapping_revision,r.test_report_id)
    JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id,t.config_revision,t.mapping_revision,t.identity_mapping_revision)=
      (r.test_report_id,r.tenant_key,r.source_id,r.config_revision,r.mapping_revision,r.identity_mapping_revision) AND t.status='PASS'
    JOIN control.etl_snapshot_manifest sm ON (sm.tenant_key,sm.source_id,sm.run_id,sm.attempt_id)=
      (r.tenant_key,r.source_id,r.run_id,p_attempt_id) AND sm.state='EXTRACTED'
    WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id AND r.run_id=p_run_id;
  RETURN result;
END;
$body$;

CREATE FUNCTION control.list_etl_snapshot_c_pages(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_relation text,p_after_page integer,p_limit integer)
RETURNS TABLE(entity text,relation text,page_no integer,row_count integer,first_key text,last_key text,page_digest bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN; END IF;
  IF p_relation NOT IN ('customer','order','order_line') OR p_after_page<0 OR p_limit<1 OR p_limit>1000 THEN RETURN; END IF;
  RETURN QUERY SELECT p.entity,p.relation,p.page_no,p.row_count,p.first_key,p.last_key,p.page_digest
    FROM control.etl_snapshot_manifest m JOIN control.etl_snapshot_stage_page p
      ON (p.tenant_key,p.source_id,p.run_id,p.attempt_id)=(m.tenant_key,m.source_id,m.run_id,m.attempt_id)
    WHERE m.tenant_key=p_tenant_key AND m.source_id=p_source_id AND m.run_id=p_run_id AND m.attempt_id=p_attempt_id AND m.state='EXTRACTED'
      AND p.relation=p_relation AND p.page_no>p_after_page ORDER BY p.page_no LIMIT p_limit;
END;
$body$;

CREATE FUNCTION control.validate_etl_snapshot_order_references(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,
  p_claim_token uuid,p_customer_source_id text,p_customer_included boolean,p_identity_mappings jsonb)
RETURNS TABLE(valid boolean,error_code text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub
AS $body$
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN
    RETURN QUERY SELECT false,'SNAPSHOT_CLAIM_LOST'; RETURN;
  END IF;
  IF jsonb_typeof(p_identity_mappings)<>'array' THEN RETURN QUERY SELECT false,'SNAPSHOT_PROOF_INVALID'; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_stage_record l LEFT JOIN control.etl_snapshot_stage_record h
    ON (h.tenant_key,h.source_id,h.run_id,h.attempt_id,h.entity,h.relation,h.parent_source_pk,h.source_pk)=
       (l.tenant_key,l.source_id,l.run_id,l.attempt_id,'order','order','',l.parent_source_pk)
    WHERE l.tenant_key=p_tenant_key AND l.source_id=p_source_id AND l.run_id=p_run_id AND l.attempt_id=p_attempt_id AND l.relation='order_line'
      AND h.source_pk IS NULL) THEN RETURN QUERY SELECT false,'SNAPSHOT_ORPHAN_LINE'; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_stage_record h WHERE h.tenant_key=p_tenant_key AND h.source_id=p_source_id
      AND h.run_id=p_run_id AND h.attempt_id=p_attempt_id AND h.relation='order'
      AND (SELECT count(*) FROM control.etl_snapshot_stage_record l WHERE l.tenant_key=h.tenant_key AND l.source_id=h.source_id
        AND l.run_id=h.run_id AND l.attempt_id=h.attempt_id AND l.entity='order' AND l.relation='order_line'
        AND l.parent_source_pk=h.source_pk)>200) THEN RETURN QUERY SELECT false,'SNAPSHOT_ORDER_LINES_INVALID'; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_stage_record o
    LEFT JOIN LATERAL (SELECT x->>'target_id' AS target_id FROM jsonb_array_elements(p_identity_mappings) x
      WHERE x->>'kind'='customer' AND x->>'external_id'=o.facts->>'customer_id' LIMIT 2) im ON true
    LEFT JOIN control.canonical_source_identity si ON si.tenant_key=p_tenant_key AND si.source_id=p_customer_source_id
      AND si.entity='customer' AND si.source_pk=o.facts->>'customer_id'
    LEFT JOIN hub.canonical_customer cc ON cc.tenant_id=p_tenant_key AND cc.id=si.customer_id AND cc.deleted_at IS NULL
    WHERE o.tenant_key=p_tenant_key AND o.source_id=p_source_id AND o.run_id=p_run_id AND o.attempt_id=p_attempt_id
      AND o.entity='order' AND o.relation='order' AND
      (o.facts->>'customer_id' IS NULL OR im.target_id IS NULL OR im.target_id<>cc.id::text OR cc.id IS NULL OR
        (p_customer_included AND p_customer_source_id=p_source_id AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_stage_record c
          WHERE c.tenant_key=p_tenant_key AND c.source_id=p_source_id AND c.run_id=p_run_id AND c.attempt_id=p_attempt_id
            AND c.entity='customer' AND c.relation='customer' AND c.source_pk=o.facts->>'customer_id'
            AND COALESCE(c.facts->>'deleted_at','false') IN ('false','')))))
    THEN RETURN QUERY SELECT false,'IDENTITY_MAPPING_TARGET_INVALID'; RETURN; END IF;
  RETURN QUERY SELECT true,NULL::text;
END;
$body$;

CREATE FUNCTION control.validate_etl_snapshot_customer_references(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,
  p_claim_token uuid,p_identity_mapping_revision bigint,p_identity_mappings jsonb)
RETURNS TABLE(valid boolean,error_code text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE customer_row record; owner_external text; department_external text; owner_target text; department_target text;
  owner_state record; tombstone text;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN
    RETURN QUERY SELECT false,'SNAPSHOT_CLAIM_LOST'; RETURN;
  END IF;
  IF p_identity_mapping_revision<1 OR jsonb_typeof(p_identity_mappings)<>'array' THEN
    RETURN QUERY SELECT false,'SNAPSHOT_C_PROOF_INVALID'; RETURN;
  END IF;
  FOR customer_row IN SELECT source_pk,facts FROM control.etl_snapshot_stage_record
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id
      AND entity='customer' AND relation='customer' ORDER BY source_pk COLLATE "C"
  LOOP
    tombstone:=customer_row.facts->>'deleted_at';
    IF tombstone IS NOT NULL AND tombstone NOT IN ('','false') THEN CONTINUE; END IF;
    owner_external:=customer_row.facts->>'owner_user_id';
    department_external:=customer_row.facts->>'dept_id';
    SELECT x->>'target_id' INTO owner_target FROM jsonb_array_elements(p_identity_mappings) x
      WHERE x->>'kind'='user' AND x->>'external_id'=owner_external LIMIT 1;
    SELECT x->>'target_id' INTO department_target FROM jsonb_array_elements(p_identity_mappings) x
      WHERE x->>'kind'='department' AND x->>'external_id'=department_external LIMIT 1;
    IF owner_external IS NULL OR department_external IS NULL OR owner_target IS NULL OR department_target IS NULL OR
      EXISTS(SELECT 1 FROM control.source_identity_remap_fence f WHERE f.tenant_key=p_tenant_key AND f.source_id=p_source_id
        AND ((f.kind='user' AND f.external_id=owner_external) OR (f.kind='department' AND f.external_id=department_external))
        AND f.identity_mapping_revision>p_identity_mapping_revision) THEN
      RETURN QUERY SELECT false,'SNAPSHOT_CUSTOMER_IDENTITY_INVALID'; RETURN;
    END IF;
    SELECT * INTO owner_state FROM control.lock_canonical_owner(p_tenant_key,owner_target);
    IF NOT FOUND OR NOT COALESCE(owner_state.enabled,false) OR owner_state.business_role IS DISTINCT FROM 'sales' OR
        owner_state.department_id IS NULL OR owner_state.department_id<>department_target THEN
      RETURN QUERY SELECT false,'SNAPSHOT_CUSTOMER_IDENTITY_INVALID'; RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT true,NULL::text;
END;
$body$;

CREATE FUNCTION control.read_etl_snapshot_order_lines(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,p_parent_source_pk text)
RETURNS SETOF control.etl_snapshot_stage_record LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN; END IF;
  RETURN QUERY SELECT r.* FROM control.etl_snapshot_stage_record r WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id
    AND r.run_id=p_run_id AND r.attempt_id=p_attempt_id AND r.entity='order' AND r.relation='order_line'
    AND r.parent_source_pk=p_parent_source_pk ORDER BY r.source_pk COLLATE "C" LIMIT 201;
END;
$body$;

CREATE FUNCTION control.read_etl_snapshot_semantic_chunk(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_entity text,p_relation text,p_after_parent text,p_after_source text,p_limit integer)
RETURNS SETOF control.etl_snapshot_stage_record LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN; END IF;
  IF p_limit<1 OR p_limit>1000 THEN RETURN; END IF;
  RETURN QUERY SELECT r.* FROM control.etl_snapshot_stage_record r WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id
    AND r.run_id=p_run_id AND r.attempt_id=p_attempt_id AND r.entity=p_entity AND r.relation=p_relation
    AND (r.parent_source_pk COLLATE "C",r.source_pk COLLATE "C")>(p_after_parent COLLATE "C",p_after_source COLLATE "C")
    ORDER BY r.parent_source_pk COLLATE "C",r.source_pk COLLATE "C" LIMIT p_limit;
END;
$body$;

CREATE FUNCTION control.get_etl_snapshot_apply_range(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_entity text,p_source_pk text)
RETURNS TABLE(aggregate_digest bytea,proof_scope_digest bytea,status text,error_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN; END IF;
  RETURN QUERY SELECT a.aggregate_digest,a.proof_scope_digest,o.status,o.error_code FROM control.etl_snapshot_apply_range a
    JOIN control.etl_snapshot_apply_outcome o ON o.outcome_id=a.outcome_id
    WHERE a.tenant_key=p_tenant_key AND a.source_id=p_source_id AND a.run_id=p_run_id AND a.attempt_id=p_attempt_id
      AND a.entity=p_entity AND a.relation=p_entity AND a.parent_source_pk='' AND a.source_pk=p_source_pk;
END;
$body$;

CREATE FUNCTION control.seal_etl_snapshot_validation(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_manifest_digest bytea,p_proof_scope_digest bytea,p_semantic_digest bytea,p_coverage jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE r control.etl_run%ROWTYPE; m control.etl_snapshot_manifest%ROWTYPE;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN false; END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  SELECT * INTO m FROM control.etl_snapshot_manifest WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id;
  IF m.state<>'EXTRACTED' OR m.manifest_digest<>p_manifest_digest OR octet_length(p_proof_scope_digest)<>32 OR
     octet_length(p_semantic_digest)<>32 OR jsonb_typeof(p_coverage)<>'object' THEN RETURN false; END IF;
  INSERT INTO control.etl_snapshot_validation(tenant_key,source_id,run_id,attempt_id,manifest_digest,proof_scope_digest,semantic_digest,coverage)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_manifest_digest,p_proof_scope_digest,p_semantic_digest,p_coverage)
    ON CONFLICT(tenant_key,source_id,run_id,attempt_id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id
      AND attempt_id=p_attempt_id AND manifest_digest=p_manifest_digest AND proof_scope_digest=p_proof_scope_digest AND semantic_digest=p_semantic_digest) THEN RETURN false; END IF;
  UPDATE control.etl_run SET status='APPLYING',completeness_summary=jsonb_build_object('status','VALIDATED','semantic_digest',encode(p_semantic_digest,'hex'))
    WHERE run_id=p_run_id AND status='VALIDATING';
  RETURN true;
END;
$body$;

CREATE FUNCTION control.persist_etl_snapshot_observation(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_semantic_digest bytea,p_reuse_scope_digest bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE existing numeric(20,0); chosen numeric(20,0); next numeric(20,0);
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation v WHERE v.tenant_key=p_tenant_key AND v.source_id=p_source_id AND v.run_id=p_run_id
      AND v.attempt_id=p_attempt_id AND v.semantic_digest=p_semantic_digest AND v.proof_scope_digest=p_reuse_scope_digest) THEN RETURN NULL; END IF;
  SELECT sequence_value INTO chosen FROM control.etl_snapshot_observation WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  IF chosen IS NOT NULL THEN RETURN chosen::text; END IF;
  SELECT a.sequence_value INTO existing FROM control.etl_snapshot_observation_sequence s
    JOIN control.etl_snapshot_observation_allocation a ON (a.tenant_key,a.source_id,a.sequence_value)=(s.tenant_key,s.source_id,s.next_value-1)
    WHERE s.tenant_key=p_tenant_key AND s.source_id=p_source_id AND a.semantic_digest=p_semantic_digest
      AND a.reuse_scope_digest=p_reuse_scope_digest
      AND EXISTS(SELECT 1 FROM control.etl_snapshot_observation b JOIN control.etl_run prior
        ON (prior.tenant_key,prior.source_id,prior.run_id)=(b.tenant_key,b.source_id,b.run_id)
        WHERE (b.tenant_key,b.source_id,b.sequence_value)=(a.tenant_key,a.source_id,a.sequence_value) AND prior.status='COMPLETE')
    ORDER BY a.sequence_value DESC LIMIT 1;
  IF existing IS NOT NULL THEN chosen:=existing;
  ELSE
    INSERT INTO control.etl_snapshot_observation_sequence(tenant_key,source_id) VALUES(p_tenant_key,p_source_id) ON CONFLICT DO NOTHING;
    SELECT next_value INTO next FROM control.etl_snapshot_observation_sequence WHERE tenant_key=p_tenant_key AND source_id=p_source_id FOR UPDATE;
    IF next>99999999999999999999 THEN RAISE EXCEPTION 'observation sequence exhausted' USING ERRCODE='22003'; END IF;
    chosen:=next;
    INSERT INTO control.etl_snapshot_observation_allocation(tenant_key,source_id,sequence_value,semantic_digest,reuse_scope_digest)
      VALUES(p_tenant_key,p_source_id,chosen,p_semantic_digest,p_reuse_scope_digest);
    UPDATE control.etl_snapshot_observation_sequence SET next_value=chosen+1 WHERE tenant_key=p_tenant_key AND source_id=p_source_id;
  END IF;
  INSERT INTO control.etl_snapshot_observation(tenant_key,source_id,run_id,attempt_id,sequence_value)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,chosen) ON CONFLICT(tenant_key,source_id,run_id) DO NOTHING;
  RETURN chosen::text;
END;
$body$;

CREATE FUNCTION control.record_etl_snapshot_aggregate(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_entity text,p_relation text,p_parent_source_pk text,p_source_pk text,p_aggregate_digest bytea,p_proof_scope_digest bytea,p_status text,p_error_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE prior control.etl_snapshot_checkpoint%ROWTYPE; outcome uuid;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation v WHERE v.tenant_key=p_tenant_key AND v.source_id=p_source_id AND v.run_id=p_run_id
    AND v.attempt_id=p_attempt_id AND v.proof_scope_digest=p_proof_scope_digest) THEN RETURN false; END IF;
  IF p_status NOT IN ('APPLIED','DUPLICATE','IGNORED_STALE','QUARANTINED','CHANNEL_EPOCH_RETIRED','FAILED') OR octet_length(p_aggregate_digest)<>32 THEN RETURN false; END IF;
  SELECT * INTO prior FROM control.etl_snapshot_checkpoint WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND entity=p_entity FOR UPDATE;
  IF prior.completed_count>0 AND prior.last_source_pk COLLATE "C">=p_source_pk COLLATE "C" THEN RETURN false; END IF;
  INSERT INTO control.etl_snapshot_apply_outcome(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,aggregate_digest,status,error_code)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_entity,p_relation,p_parent_source_pk,p_source_pk,p_aggregate_digest,p_status,p_error_code)
    RETURNING outcome_id INTO outcome;
  INSERT INTO control.etl_snapshot_apply_range(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,aggregate_digest,proof_scope_digest,outcome_id)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_entity,p_relation,p_parent_source_pk,p_source_pk,p_aggregate_digest,p_proof_scope_digest,outcome);
  INSERT INTO control.etl_snapshot_checkpoint(tenant_key,source_id,run_id,entity,last_relation,last_parent_source_pk,last_source_pk,completed_count)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_entity,p_relation,p_parent_source_pk,p_source_pk,1)
    ON CONFLICT(tenant_key,source_id,run_id,entity) DO UPDATE SET last_relation=EXCLUDED.last_relation,last_parent_source_pk=EXCLUDED.last_parent_source_pk,
      last_source_pk=EXCLUDED.last_source_pk,completed_count=control.etl_snapshot_checkpoint.completed_count+1,updated_at=clock_timestamp();
  UPDATE control.etl_run SET applied_count=applied_count+CASE WHEN p_status='APPLIED' THEN 1 ELSE 0 END,
    quarantined_count=quarantined_count+CASE WHEN p_status IN ('QUARANTINED','CHANNEL_EPOCH_RETIRED','FAILED') THEN 1 ELSE 0 END
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  RETURN true;
END;
$body$;

CREATE FUNCTION control.finish_etl_snapshot_run(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE expected bigint; done bigint; bad bigint; applied bigint;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id) THEN RETURN false; END IF;
  SELECT count(*) INTO expected FROM control.etl_snapshot_stage_record WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id AND relation IN ('customer','order');
  SELECT count(*),count(*) FILTER(WHERE status IN ('QUARANTINED','CHANNEL_EPOCH_RETIRED','FAILED')),
    count(*) FILTER(WHERE status='APPLIED') INTO done,bad,applied FROM control.etl_snapshot_apply_outcome
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id;
  IF done<>expected THEN RETURN false; END IF;
  IF bad=0 THEN
    UPDATE control.etl_run SET status='COMPLETE',completed_at=clock_timestamp(),applied_count=applied,
      completeness_summary=jsonb_build_object('status','COMPLETE','outcome_count',done) WHERE run_id=p_run_id AND status='APPLYING';
    UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,last_run_id=p_run_id,last_successful_run_id=p_run_id,
      next_due_at=clock_timestamp()+make_interval(secs=>interval_seconds),updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND active_run_id=p_run_id;
  ELSE
    UPDATE control.etl_run SET status='FAILED',completed_at=clock_timestamp(),quarantined_count=GREATEST(quarantined_count,bad),
      completeness_summary=jsonb_build_object('status','FAILED','outcome_count',done,'failed_count',bad) WHERE run_id=p_run_id AND status='APPLYING';
    UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,last_run_id=p_run_id,updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND active_run_id=p_run_id;
  END IF;
  UPDATE control.etl_snapshot_continuation SET claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND claim_token=p_claim_token;
  RETURN true;
END;
$body$;

REVOKE ALL ON control.etl_snapshot_continuation,control.etl_snapshot_validation,control.etl_snapshot_observation_sequence,
  control.etl_snapshot_observation_allocation,control.etl_snapshot_observation,control.etl_snapshot_apply_outcome,
  control.etl_snapshot_apply_range,control.etl_snapshot_checkpoint FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.claim_etl_snapshot_continuation(text,text,integer),
  control.assert_etl_snapshot_continuation(text,text,uuid,uuid,uuid),control.begin_etl_snapshot_c_start(text,text,uuid,uuid,uuid),
  control.assert_etl_snapshot_apply_claim(text,text,uuid,uuid,uuid),
  control.lock_etl_snapshot_order_customer_reference(text,text,uuid,uuid,uuid,text,text,jsonb),
  control.heartbeat_etl_snapshot_continuation(text,text,uuid,uuid,uuid,integer),control.fail_etl_snapshot_continuation(text,text,uuid,uuid,uuid,text,boolean),
  control.read_etl_snapshot_stage_page(text,text,uuid,uuid,uuid,text,text,integer),
  control.read_etl_snapshot_c_proof(text,text,uuid,uuid,uuid),control.list_etl_snapshot_c_pages(text,text,uuid,uuid,uuid,text,integer,integer),
  control.validate_etl_snapshot_order_references(text,text,uuid,uuid,uuid,text,boolean,jsonb),
  control.validate_etl_snapshot_customer_references(text,text,uuid,uuid,uuid,bigint,jsonb),
  control.read_etl_snapshot_order_lines(text,text,uuid,uuid,uuid,text),control.get_etl_snapshot_apply_range(text,text,uuid,uuid,uuid,text,text),
  control.read_etl_snapshot_semantic_chunk(text,text,uuid,uuid,uuid,text,text,text,text,integer),
  control.seal_etl_snapshot_validation(text,text,uuid,uuid,uuid,bytea,bytea,bytea,jsonb),
  control.persist_etl_snapshot_observation(text,text,uuid,uuid,uuid,bytea,bytea),
  control.record_etl_snapshot_aggregate(text,text,uuid,uuid,uuid,text,text,text,text,bytea,bytea,text,text),
  control.finish_etl_snapshot_run(text,text,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.claim_etl_snapshot_continuation(text,text,integer),
  control.begin_etl_snapshot_c_start(text,text,uuid,uuid,uuid),control.assert_etl_snapshot_apply_claim(text,text,uuid,uuid,uuid),
  control.lock_etl_snapshot_order_customer_reference(text,text,uuid,uuid,uuid,text,text,jsonb),
  control.heartbeat_etl_snapshot_continuation(text,text,uuid,uuid,uuid,integer),
  control.fail_etl_snapshot_continuation(text,text,uuid,uuid,uuid,text,boolean),
  control.validate_etl_snapshot_customer_references(text,text,uuid,uuid,uuid,bigint,jsonb),
  control.read_etl_snapshot_stage_page(text,text,uuid,uuid,uuid,text,text,integer),
  control.read_etl_snapshot_c_proof(text,text,uuid,uuid,uuid),control.list_etl_snapshot_c_pages(text,text,uuid,uuid,uuid,text,integer,integer),
  control.validate_etl_snapshot_order_references(text,text,uuid,uuid,uuid,text,boolean,jsonb),
  control.read_etl_snapshot_order_lines(text,text,uuid,uuid,uuid,text),control.get_etl_snapshot_apply_range(text,text,uuid,uuid,uuid,text,text),
  control.read_etl_snapshot_semantic_chunk(text,text,uuid,uuid,uuid,text,text,text,text,integer),
  control.seal_etl_snapshot_validation(text,text,uuid,uuid,uuid,bytea,bytea,bytea,jsonb),
  control.persist_etl_snapshot_observation(text,text,uuid,uuid,uuid,bytea,bytea),
  control.record_etl_snapshot_aggregate(text,text,uuid,uuid,uuid,text,text,text,text,bytea,bytea,text,text),
  control.finish_etl_snapshot_run(text,text,uuid,uuid,uuid) TO hub_worker;
GRANT SELECT (tenant_key,source_id,run_id,attempt_id,claim_token,lease_until,c_start_count,next_retry_at,last_error_code)
  ON control.etl_snapshot_continuation TO hub_worker;
GRANT SELECT (tenant_key,source_id,run_id,attempt_id,manifest_digest,proof_scope_digest,semantic_digest,coverage,validated_at)
  ON control.etl_snapshot_validation TO hub_worker;
GRANT SELECT (tenant_key,source_id,run_id,sequence_value) ON control.etl_snapshot_observation TO hub_worker;
GRANT SELECT (tenant_key,source_id,run_id,entity,last_relation,last_parent_source_pk,last_source_pk,completed_count)
  ON control.etl_snapshot_checkpoint TO hub_worker;

CREATE INDEX canonical_source_identity_customer_discovery_idx
  ON control.canonical_source_identity(tenant_key,source_id,source_pk COLLATE "C") WHERE entity='customer';
CREATE VIEW api.source_customer_identity_candidates AS
  SELECT si.tenant_key,si.source_id,si.source_pk,ci.id::text AS target_id
  FROM control.canonical_source_identity si
  JOIN control.source_registry sr ON (sr.tenant_key,sr.source_id)=(si.tenant_key,si.source_id)
  JOIN control.source_identity_mapping_revision im ON (im.tenant_key,im.source_id,im.revision)=
    (sr.tenant_key,sr.source_id,sr.identity_mapping_revision)
  JOIN api.canonical_customer_identity ci ON ci.tenant_id=si.tenant_key AND ci.id::text=si.canonical_object_id::text
  WHERE si.entity='customer' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(im.mappings) m
    WHERE m->>'kind'='customer' AND m->>'external_id'=si.source_pk AND m->>'target_id'=ci.id::text);
REVOKE ALL ON api.source_customer_identity_candidates FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT SELECT (tenant_key,source_id,source_pk,target_id) ON api.source_customer_identity_candidates TO hub_api;
-- M1-5D1 durable absence accounting. This extends the unreleased, phase-owned 009 only.
CREATE TABLE control.etl_snapshot_delete_run (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  reservation_ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','AWAITING_OWNER','APPLYING','STALE','COMPLETE','SKIPPED','FAILED')),
  scope_digest bytea NOT NULL DEFAULT digest(convert_to('{}','UTF8'),'sha256') CHECK (octet_length(scope_digest)=32),
  stable_scope_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stable_scope_json)='object'),
  sequence_value numeric(20,0) CHECK (sequence_value BETWEEN 0 AND 99999999999999999999),
  c_completed_at timestamptz,
  candidate_count bigint NOT NULL DEFAULT 0 CHECK (candidate_count>=0),
  above_threshold boolean NOT NULL DEFAULT false,
  pause_reason text,
  -- Mutable scheduling hint only; reservation and proof facts stay unchanged.
  last_worker_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,run_id),
  UNIQUE (tenant_key,source_id,run_id,attempt_id),
  FOREIGN KEY (tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,run_id,attempt_id) REFERENCES control.etl_run_attempt(tenant_key,source_id,run_id,attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX etl_snapshot_delete_run_busy_idx ON control.etl_snapshot_delete_run(tenant_key,source_id,status,created_at,run_id)
  WHERE status IN ('PENDING','AWAITING_OWNER','APPLYING');

CREATE TABLE control.etl_snapshot_delete_consumption (
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, attempt_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,run_id),
  FOREIGN KEY (tenant_key,source_id,run_id,attempt_id) REFERENCES control.etl_snapshot_delete_run(tenant_key,source_id,run_id,attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.etl_snapshot_delete_presence (
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, attempt_id uuid NOT NULL,
  entity text NOT NULL CHECK(entity IN ('customer','order')),
  relation text NOT NULL CHECK(relation IN ('customer','order')),
  parent_source_pk text COLLATE "C" NOT NULL DEFAULT '' CHECK(parent_source_pk=''),
  source_pk text COLLATE "C" NOT NULL CHECK(length(source_pk) BETWEEN 1 AND 128 AND source_pk !~ '^[[:space:]]|[[:space:]]$'),
  source_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(tenant_key,source_id,run_id,entity,source_pk),
  CHECK(relation=entity),
  FOREIGN KEY(tenant_key,source_id,run_id,attempt_id) REFERENCES control.etl_snapshot_delete_run(tenant_key,source_id,run_id,attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk)
    REFERENCES control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX etl_snapshot_delete_presence_key_idx
  ON control.etl_snapshot_delete_presence(tenant_key,source_id,entity,source_pk COLLATE "C",run_id);

CREATE TABLE control.etl_snapshot_delete_streak (
  tenant_key text NOT NULL, source_id text NOT NULL, entity text NOT NULL CHECK(entity IN ('customer','order')),
  source_pk text COLLATE "C" NOT NULL, scope_digest bytea NOT NULL CHECK(octet_length(scope_digest)=32),
  stable_scope_json jsonb NOT NULL CHECK(jsonb_typeof(stable_scope_json)='object'),
  last_processed_run_id uuid NOT NULL, last_presence_run_id uuid,
  first_absence_run_id uuid, second_absence_run_id uuid,
  absence_count smallint NOT NULL CHECK(absence_count BETWEEN 0 AND 2),
  last_presence_sequence numeric(20,0), second_absence_sequence numeric(20,0),
  second_absence_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_key,source_id,entity,source_pk,scope_digest),
  FOREIGN KEY(tenant_key,source_id,last_processed_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,last_presence_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,first_absence_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,second_absence_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((absence_count=0 AND first_absence_run_id IS NULL AND second_absence_run_id IS NULL) OR
         (absence_count=1 AND first_absence_run_id IS NOT NULL AND second_absence_run_id IS NULL) OR
         (absence_count=2 AND first_absence_run_id IS NOT NULL AND second_absence_run_id IS NOT NULL))
);
CREATE INDEX etl_snapshot_delete_streak_scope_idx ON control.etl_snapshot_delete_streak
  (tenant_key,source_id,scope_digest,entity,source_pk COLLATE "C");

CREATE TABLE control.etl_snapshot_delete_candidate (
  candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, entity text NOT NULL CHECK(entity IN ('customer','order')),
  candidate_revision integer NOT NULL CHECK(candidate_revision>0), scope_digest bytea NOT NULL CHECK(octet_length(scope_digest)=32),
  stable_scope_json jsonb NOT NULL CHECK(jsonb_typeof(stable_scope_json)='object'),
  baseline_count bigint NOT NULL CHECK(baseline_count>=0),
  baseline_membership_digest bytea NOT NULL CHECK(octet_length(baseline_membership_digest)=32),
  candidate_count bigint NOT NULL CHECK(candidate_count>=0), candidate_digest bytea NOT NULL CHECK(octet_length(candidate_digest)=32),
  frozen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_key,source_id,run_id,entity,candidate_revision),
  UNIQUE(candidate_id,tenant_key,source_id,run_id),
  UNIQUE(candidate_id,tenant_key,source_id,run_id,entity),
  FOREIGN KEY(tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX etl_snapshot_delete_candidate_run_idx
  ON control.etl_snapshot_delete_candidate(tenant_key,source_id,run_id,entity,candidate_revision);

CREATE TABLE control.etl_snapshot_delete_candidate_member (
  candidate_id uuid NOT NULL, tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL,
  entity text NOT NULL CHECK(entity IN ('customer','order')), source_pk text COLLATE "C" NOT NULL,
  canonical_object_id uuid NOT NULL, origin_run_id uuid NOT NULL, second_run_id uuid NOT NULL,
  sequence_value numeric(20,0) NOT NULL CHECK(sequence_value BETWEEN 0 AND 99999999999999999999),
  inferred_completed_at timestamptz NOT NULL,
  PRIMARY KEY(candidate_id,entity,source_pk),
  FOREIGN KEY(candidate_id,tenant_key,source_id,run_id,entity)
    REFERENCES control.etl_snapshot_delete_candidate(candidate_id,tenant_key,source_id,run_id,entity) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,origin_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,second_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,entity,source_pk,canonical_object_id)
    REFERENCES control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX etl_snapshot_delete_candidate_member_order_idx
  ON control.etl_snapshot_delete_candidate_member(candidate_id,source_pk COLLATE "C");

CREATE TABLE control.etl_snapshot_delete_policy_audit (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK(actor_kind='SYSTEM_POLICY'), database_worker_role text NOT NULL,
  reason_code text NOT NULL, candidate_digest bytea NOT NULL CHECK(octet_length(candidate_digest)=32),
  owner_user_id text NOT NULL, owner_revision bigint NOT NULL, approval_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION control.guard_etl_snapshot_delete_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable D reconciliation fact' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER etl_snapshot_delete_consumption_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_consumption
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_immutable();
CREATE TRIGGER etl_snapshot_delete_presence_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_presence
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_immutable();
CREATE TRIGGER etl_snapshot_delete_candidate_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_candidate
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_immutable();
CREATE TRIGGER etl_snapshot_delete_member_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_candidate_member
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_immutable();
CREATE TRIGGER etl_snapshot_delete_policy_audit_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_policy_audit
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_immutable();

CREATE FUNCTION control.etl_snapshot_delete_ratio_exceeds(p_candidate_count bigint,p_baseline_count bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,control
AS $body$
  SELECT p_candidate_count>0 AND p_candidate_count::numeric*100>p_baseline_count::numeric*5
$body$;

CREATE FUNCTION control.etl_snapshot_source_delete_busy(p_tenant_key text,p_source_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
  SELECT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_run d
    WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id AND d.status IN ('PENDING','AWAITING_OWNER','APPLYING'))
$body$;
ALTER FUNCTION control.etl_snapshot_source_delete_busy(text,text) OWNER TO CURRENT_USER;

CREATE FUNCTION control.reserve_etl_snapshot_delete_run(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE r control.etl_run%ROWTYPE; config_value jsonb; entity_domains_ok boolean; next_status text;
BEGIN
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status<>'COMPLETE' OR r.completed_at IS NULL OR NOT EXISTS(
    SELECT 1 FROM control.etl_run_attempt a WHERE a.tenant_key=p_tenant_key AND a.source_id=p_source_id AND a.run_id=p_run_id
      AND a.attempt_id=p_attempt_id AND a.status='COMPLETE') OR NOT EXISTS(
    SELECT 1 FROM control.etl_snapshot_manifest m JOIN control.etl_snapshot_validation v
      ON (v.tenant_key,v.source_id,v.run_id,v.attempt_id)=(m.tenant_key,m.source_id,m.run_id,m.attempt_id)
    WHERE m.tenant_key=p_tenant_key AND m.source_id=p_source_id AND m.run_id=p_run_id AND m.attempt_id=p_attempt_id AND m.state='EXTRACTED') THEN
    RAISE EXCEPTION 'D reservation requires exact successful C proof' USING ERRCODE='55000';
  END IF;
  SELECT config INTO config_value FROM control.source_config_revision
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND revision=r.config_revision AND config_digest=r.config_digest;
  SELECT coalesce(bool_and(value->>'version_domain'='SNAPSHOT_OBSERVATION'),false) INTO entity_domains_ok
    FROM jsonb_each(r.entity_channel_proof);
  next_status:=CASE WHEN config_value->>'mode'='FULL_SNAPSHOT' AND config_value->>'version_domain'='SNAPSHOT_OBSERVATION'
      AND config_value->>'delete_contract'='hard_delete' AND r.delete_contract='hard_delete'
      AND entity_domains_ok THEN 'PENDING' ELSE 'SKIPPED' END;
  INSERT INTO control.etl_snapshot_delete_run(tenant_key,source_id,run_id,attempt_id,status,sequence_value,c_completed_at)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,next_status,
      (SELECT sequence_value FROM control.etl_snapshot_observation WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id),
      r.completed_at)
    ON CONFLICT(tenant_key,source_id,run_id) DO NOTHING;
  RETURN true;
END;
$body$;
ALTER FUNCTION control.reserve_etl_snapshot_delete_run(text,text,uuid,uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.reserve_etl_snapshot_delete_run(text,text,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION control.finish_etl_snapshot_run(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE expected bigint; done bigint; bad bigint; applied bigint; completed timestamptz;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id) THEN RETURN false; END IF;
  SELECT count(*) INTO expected FROM control.etl_snapshot_stage_record WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id AND relation IN ('customer','order');
  SELECT count(*),count(*) FILTER(WHERE status IN ('QUARANTINED','CHANNEL_EPOCH_RETIRED','FAILED')),
    count(*) FILTER(WHERE status='APPLIED') INTO done,bad,applied FROM control.etl_snapshot_apply_outcome
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id;
  IF done<>expected THEN RETURN false; END IF;
  IF bad=0 THEN
    UPDATE control.etl_run SET status='COMPLETE',completed_at=clock_timestamp(),applied_count=applied,
      completeness_summary=jsonb_build_object('status','COMPLETE','outcome_count',done)
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND status='APPLYING'
      RETURNING completed_at INTO completed;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM control.reserve_etl_snapshot_delete_run(p_tenant_key,p_source_id,p_run_id,p_attempt_id);
    UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,last_run_id=p_run_id,last_successful_run_id=p_run_id,
      next_due_at=clock_timestamp()+make_interval(secs=>interval_seconds),updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND active_run_id=p_run_id;
  ELSE
    UPDATE control.etl_run SET status='FAILED',completed_at=clock_timestamp(),quarantined_count=GREATEST(quarantined_count,bad),
      completeness_summary=jsonb_build_object('status','FAILED','outcome_count',done,'failed_count',bad) WHERE run_id=p_run_id AND status='APPLYING';
    UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,last_run_id=p_run_id,updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND active_run_id=p_run_id;
  END IF;
  UPDATE control.etl_snapshot_continuation SET claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND claim_token=p_claim_token;
  RETURN true;
END;
$body$;
REVOKE ALL ON FUNCTION control.etl_snapshot_delete_ratio_exceeds(bigint,bigint),
  control.etl_snapshot_source_delete_busy(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.etl_snapshot_delete_ratio_exceeds(bigint,bigint),
  control.etl_snapshot_source_delete_busy(text,text) TO hub_api,hub_worker;
REVOKE ALL ON control.etl_snapshot_delete_run,control.etl_snapshot_delete_consumption,control.etl_snapshot_delete_presence,
  control.etl_snapshot_delete_streak,control.etl_snapshot_delete_candidate,control.etl_snapshot_delete_candidate_member,
  control.etl_snapshot_delete_policy_audit FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT SELECT ON control.etl_snapshot_delete_run TO hub_worker;

CREATE FUNCTION control.etl_snapshot_delete_proof_current(p_tenant_key text,p_source_id text,p_run_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
  SELECT EXISTS(
    SELECT 1 FROM control.etl_run r
    JOIN control.source_registry sr ON (sr.tenant_key,sr.source_id)=(r.tenant_key,r.source_id)
    JOIN control.source_credential c ON (c.tenant_key,c.source_id)=(r.tenant_key,r.source_id)
    JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision,cr.config_digest)=(r.tenant_key,r.source_id,r.config_revision,r.config_digest)
    JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision,m.mapping_digest)=(r.tenant_key,r.source_id,r.mapping_revision,r.mapping_digest)
    JOIN control.source_identity_mapping_revision im ON (im.tenant_key,im.source_id,im.revision,im.mapping_digest)=(r.tenant_key,r.source_id,r.identity_mapping_revision,r.identity_mapping_digest)
    JOIN control.auth_subject owner ON (owner.tenant_key,owner.user_id)=(r.tenant_key,r.owner_user_id) AND owner.enabled
    JOIN control.source_owner_approval a ON (a.id,a.tenant_key,a.source_id,a.owner_user_id,a.owner_revision,a.config_revision,a.mapping_revision,
      a.identity_mapping_revision,a.test_report_id)=(r.approval_id,r.tenant_key,r.source_id,r.owner_user_id,r.owner_revision,r.config_revision,
      r.mapping_revision,r.identity_mapping_revision,r.test_report_id)
    JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id,t.config_revision,t.mapping_revision,t.identity_mapping_revision)=
      (r.test_report_id,r.tenant_key,r.source_id,r.config_revision,r.mapping_revision,r.identity_mapping_revision) AND t.status='PASS'
    WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id AND r.run_id=p_run_id AND r.status='COMPLETE'
      AND NOT EXISTS(SELECT 1 FROM control.source_test_report newer
        WHERE newer.tenant_key=t.tenant_key AND newer.source_id=t.source_id
          AND newer.config_revision=t.config_revision AND newer.mapping_revision=t.mapping_revision
          AND newer.identity_mapping_revision=t.identity_mapping_revision
          AND (newer.created_at,newer.id)>(t.created_at,t.id))
      AND sr.data_owner_user_id=r.owner_user_id AND sr.owner_revision=r.owner_revision
      AND sr.current_config_revision=r.config_revision AND sr.mapping_revision=r.mapping_revision
      AND sr.identity_mapping_revision=r.identity_mapping_revision
      AND c.id=r.credential_id AND c.revision=r.credential_revision AND c.credential_generation=r.credential_generation AND c.enabled
      AND cr.config->>'version_domain'='SNAPSHOT_OBSERVATION' AND cr.config->>'delete_contract'=r.delete_contract
      AND NOT EXISTS(SELECT 1 FROM jsonb_each(r.entity_channel_proof) ch
        WHERE NOT EXISTS(SELECT 1 FROM control.source_channel current_channel
          WHERE current_channel.id=(ch.value->>'channel_id')::uuid AND current_channel.tenant_key=r.tenant_key
            AND current_channel.source_id=r.source_id AND current_channel.entity=ch.key AND current_channel.channel_epoch=(ch.value->>'channel_epoch')::bigint
            AND current_channel.version_domain=ch.value->>'version_domain' AND current_channel.state='active'))
      AND EXISTS(SELECT 1 FROM control.etl_snapshot_manifest mf JOIN control.etl_snapshot_validation v
        ON (v.tenant_key,v.source_id,v.run_id,v.attempt_id)=(mf.tenant_key,mf.source_id,mf.run_id,mf.attempt_id)
        JOIN control.etl_run_attempt at ON (at.tenant_key,at.source_id,at.run_id,at.attempt_id)=
          (mf.tenant_key,mf.source_id,mf.run_id,mf.attempt_id)
        WHERE mf.tenant_key=r.tenant_key AND mf.source_id=r.source_id AND mf.run_id=r.run_id AND mf.attempt_id=
          (SELECT d.attempt_id FROM control.etl_snapshot_delete_run d WHERE d.tenant_key=r.tenant_key AND d.source_id=r.source_id AND d.run_id=r.run_id)
          AND mf.state='EXTRACTED' AND at.status='COMPLETE')
  )
$body$;

CREATE FUNCTION control.freeze_etl_snapshot_delete_candidates(p_tenant_key text,p_source_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub
AS $body$
DECLARE latest control.etl_snapshot_delete_run%ROWTYPE; run_row control.etl_run%ROWTYPE;
  entity_value text; base_count bigint; member_count bigint; total_count bigint:=0; has_above boolean:=false;
  obs_invalid boolean; candidate uuid; digest_value bytea; baseline_digest bytea;
  member record; owner_role text; proof_json jsonb;
BEGIN
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  IF EXISTS(SELECT 1 FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id
    AND status IN ('QUEUED','SCANNING','VALIDATING','READY','APPLYING')) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_delete_run d WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id
    AND d.status='PENDING' AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption c
      WHERE c.tenant_key=d.tenant_key AND c.source_id=d.source_id AND c.run_id=d.run_id)) THEN RETURN false; END IF;
  SELECT d.* INTO latest FROM control.etl_snapshot_delete_run d JOIN control.etl_snapshot_delete_consumption c
    USING(tenant_key,source_id,run_id) WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id
      AND d.status IN ('PENDING','AWAITING_OWNER')
    ORDER BY d.reservation_ordinal DESC LIMIT 1 FOR UPDATE OF d;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO run_row FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=latest.run_id;
  IF NOT control.etl_snapshot_delete_proof_current(p_tenant_key,p_source_id,latest.run_id)
    OR EXISTS(SELECT 1 FROM control.source_security_barrier b
      WHERE b.tenant_key=run_row.tenant_key AND b.effective_fence>run_row.security_barrier_fence
        AND (b.source_id IS NULL OR b.source_id=run_row.source_id)
        AND (b.credential_id IS NULL OR b.credential_id=run_row.credential_id)
        AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')
        AND ((b.entity IS NULL AND b.channel_id IS NULL) OR EXISTS(SELECT 1 FROM jsonb_each(run_row.entity_channel_proof) cp
          WHERE (b.entity IS NULL OR cp.key=b.entity) AND (b.channel_id IS NULL OR cp.value->>'channel_id'=b.channel_id::text)))) THEN
    UPDATE control.etl_snapshot_delete_run d SET status='STALE',
      d_error_code=CASE WHEN EXISTS(SELECT 1 FROM control.etl_snapshot_delete_candidate c
        WHERE c.tenant_key=d.tenant_key AND c.source_id=d.source_id AND c.run_id=d.run_id)
        THEN 'D_CANDIDATE_STALE' ELSE d.d_error_code END,
      updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=latest.run_id;
    UPDATE control.etl_snapshot_delete_run d SET status='COMPLETE',candidate_count=0,updated_at=clock_timestamp()
      WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id AND d.status='PENDING'
        AND d.reservation_ordinal<latest.reservation_ordinal
        AND EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption c
          WHERE c.tenant_key=d.tenant_key AND c.source_id=d.source_id AND c.run_id=d.run_id);
    RETURN true;
  END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_delete_candidate WHERE tenant_key=p_tenant_key
    AND source_id=p_source_id AND run_id=latest.run_id) THEN
    UPDATE control.etl_snapshot_delete_run SET last_worker_checked_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=latest.run_id;
    RETURN false;
  END IF;
  proof_json:=latest.stable_scope_json;
  -- Candidate keys are full source identities, while the denominator is live canonical objects.
  -- Ambiguous aliases could otherwise make the key count understate the canonical impact ratio.
  IF EXISTS(
    SELECT 1 FROM control.canonical_source_identity i JOIN hub.canonical_customer cc
      ON (cc.tenant_id,cc.id)=(i.tenant_key,i.customer_id)
      WHERE i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity='customer'
        AND i.customer_id IS NOT NULL AND cc.deleted_at IS NULL
    GROUP BY i.canonical_object_id HAVING count(DISTINCT i.source_pk)>1
    UNION ALL
    SELECT 1 FROM control.canonical_source_identity i JOIN hub.canonical_order co
      ON (co.tenant_id,co.id)=(i.tenant_key,i.order_id)
      WHERE i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity='order'
        AND i.order_id IS NOT NULL AND co.deleted_at IS NULL
    GROUP BY i.canonical_object_id HAVING count(DISTINCT i.source_pk)>1
  ) THEN
    UPDATE control.etl_snapshot_delete_run SET status='STALE',pause_reason='AMBIGUOUS_CANONICAL_IDENTITY_ALIAS',updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=latest.run_id;
    UPDATE control.etl_snapshot_delete_run d SET status='COMPLETE',candidate_count=0,updated_at=clock_timestamp()
      WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id AND d.status='PENDING'
        AND d.reservation_ordinal<latest.reservation_ordinal
        AND EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption c
          WHERE c.tenant_key=d.tenant_key AND c.source_id=d.source_id AND c.run_id=d.run_id);
    RETURN true;
  END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_delete_streak s
      JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk)=
        (s.tenant_key,s.source_id,s.entity,s.source_pk)
      LEFT JOIN control.source_version_receipt vr ON vr.tenant_key=i.tenant_key AND vr.source_id=i.source_id
        AND vr.channel_id=(run_row.entity_channel_proof->s.entity->>'channel_id')::uuid
        AND vr.entity=s.entity AND vr.source_pk=s.source_pk
      WHERE s.tenant_key=p_tenant_key AND s.source_id=p_source_id AND s.scope_digest=
        public.digest(convert_to(jsonb_build_object('proof',proof_json,'entity',s.entity)::text,'UTF8'),'sha256')
        AND s.absence_count=2 AND s.last_processed_run_id=latest.run_id
        AND coalesce(vr.source_version,-1)>=s.second_absence_sequence
        AND ((s.entity='customer' AND i.customer_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_customer cc
              WHERE cc.tenant_id=i.tenant_key AND cc.id=i.customer_id AND cc.deleted_at IS NULL))
          OR (s.entity='order' AND i.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_order co
              WHERE co.tenant_id=i.tenant_key AND co.id=i.order_id AND co.deleted_at IS NULL)))) THEN
    UPDATE control.etl_snapshot_delete_run SET status='STALE',updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=latest.run_id;
    RETURN true;
  END IF;
  FOREACH entity_value IN ARRAY run_row.expected_entities LOOP
    SELECT f.baseline_count,f.baseline_digest INTO base_count,baseline_digest
      FROM control.etl_snapshot_delete_baseline_fingerprint(p_tenant_key,p_source_id,entity_value,proof_json) f;
    SELECT count(DISTINCT i.canonical_object_id) INTO member_count FROM control.etl_snapshot_delete_streak s
      JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk)=
        (s.tenant_key,s.source_id,s.entity,s.source_pk)
      LEFT JOIN control.source_version_receipt vr ON vr.tenant_key=i.tenant_key AND vr.source_id=i.source_id
        AND vr.channel_id=(run_row.entity_channel_proof->entity_value->>'channel_id')::uuid
        AND vr.entity=s.entity AND vr.source_pk=s.source_pk
      WHERE s.tenant_key=p_tenant_key AND s.source_id=p_source_id AND s.entity=entity_value
        AND s.scope_digest=public.digest(convert_to(jsonb_build_object('proof',proof_json,'entity',entity_value)::text,'UTF8'),'sha256')
        AND s.absence_count=2 AND s.last_processed_run_id=latest.run_id
        AND s.second_absence_sequence>coalesce(vr.source_version,-1)
        AND ((entity_value='customer' AND i.customer_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_customer cc
              WHERE cc.tenant_id=i.tenant_key AND cc.id=i.customer_id AND cc.deleted_at IS NULL))
          OR (entity_value='order' AND i.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_order co
              WHERE co.tenant_id=i.tenant_key AND co.id=i.order_id AND co.deleted_at IS NULL)));
    candidate:=gen_random_uuid();
    digest_value:=control.etl_snapshot_delete_candidate_digest_seed(proof_json,entity_value,latest.run_id,1,
      base_count,member_count,baseline_digest);
    FOR member IN
      SELECT s.source_pk,i.canonical_object_id,s.first_absence_run_id,s.second_absence_run_id,
        s.second_absence_sequence,s.second_absence_completed_at
      FROM control.etl_snapshot_delete_streak s
      JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk)=
        (s.tenant_key,s.source_id,s.entity,s.source_pk)
      LEFT JOIN control.source_version_receipt vr ON vr.tenant_key=i.tenant_key AND vr.source_id=i.source_id
        AND vr.channel_id=(run_row.entity_channel_proof->entity_value->>'channel_id')::uuid
        AND vr.entity=s.entity AND vr.source_pk=s.source_pk
      WHERE s.tenant_key=p_tenant_key AND s.source_id=p_source_id AND s.entity=entity_value
        AND s.scope_digest=public.digest(convert_to(jsonb_build_object('proof',proof_json,'entity',entity_value)::text,'UTF8'),'sha256')
        AND s.absence_count=2 AND s.last_processed_run_id=latest.run_id
        AND s.second_absence_sequence>coalesce(vr.source_version,-1)
        AND ((entity_value='customer' AND i.customer_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_customer cc
              WHERE cc.tenant_id=i.tenant_key AND cc.id=i.customer_id AND cc.deleted_at IS NULL))
          OR (entity_value='order' AND i.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_order co
              WHERE co.tenant_id=i.tenant_key AND co.id=i.order_id AND co.deleted_at IS NULL)))
      ORDER BY s.source_pk COLLATE "C" LOOP
      digest_value:=control.etl_snapshot_delete_candidate_member_digest(digest_value,member.source_pk,
        member.canonical_object_id,member.first_absence_run_id,member.second_absence_run_id,
        member.second_absence_sequence,member.second_absence_completed_at);
    END LOOP;
    INSERT INTO control.etl_snapshot_delete_candidate(candidate_id,tenant_key,source_id,run_id,entity,candidate_revision,
      scope_digest,stable_scope_json,baseline_count,candidate_count,baseline_membership_digest,candidate_digest)
      VALUES(candidate,p_tenant_key,p_source_id,latest.run_id,entity_value,1,
        public.digest(convert_to(jsonb_build_object('proof',proof_json,'entity',entity_value)::text,'UTF8'),'sha256'),
        jsonb_build_object('proof',proof_json,'entity',entity_value),base_count,member_count,baseline_digest,digest_value);
    INSERT INTO control.etl_snapshot_delete_candidate_member(candidate_id,tenant_key,source_id,run_id,entity,source_pk,
      canonical_object_id,origin_run_id,second_run_id,sequence_value,inferred_completed_at)
    SELECT candidate,p_tenant_key,p_source_id,latest.run_id,s.entity,s.source_pk,i.canonical_object_id,
      s.first_absence_run_id,s.second_absence_run_id,s.second_absence_sequence,s.second_absence_completed_at
    FROM control.etl_snapshot_delete_streak s
    JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk)=(s.tenant_key,s.source_id,s.entity,s.source_pk)
    LEFT JOIN control.source_version_receipt vr ON vr.tenant_key=i.tenant_key AND vr.source_id=i.source_id
      AND vr.channel_id=(run_row.entity_channel_proof->entity_value->>'channel_id')::uuid AND vr.entity=s.entity AND vr.source_pk=s.source_pk
    WHERE s.tenant_key=p_tenant_key AND s.source_id=p_source_id AND s.entity=entity_value
      AND s.scope_digest=public.digest(convert_to(jsonb_build_object('proof',proof_json,'entity',entity_value)::text,'UTF8'),'sha256')
      AND s.absence_count=2 AND s.last_processed_run_id=latest.run_id
      AND s.second_absence_sequence>coalesce(vr.source_version,-1)
      AND ((entity_value='customer' AND i.customer_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_customer cc
            WHERE cc.tenant_id=i.tenant_key AND cc.id=i.customer_id AND cc.deleted_at IS NULL))
        OR (entity_value='order' AND i.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_order co
            WHERE co.tenant_id=i.tenant_key AND co.id=i.order_id AND co.deleted_at IS NULL)));
    total_count:=total_count+member_count;
    IF control.etl_snapshot_delete_ratio_exceeds(member_count,base_count) THEN has_above:=true; END IF;
  END LOOP;
  IF has_above THEN
    UPDATE control.source_registry SET lifecycle='PAUSED',updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND lifecycle<>'PAUSED';
    UPDATE control.etl_snapshot_schedule SET enabled=false,schedule_revision=schedule_revision+CASE WHEN enabled THEN 1 ELSE 0 END,
      updated_at=clock_timestamp() WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND enabled;
    UPDATE control.source_credential SET source_epoch=source_epoch+1 WHERE tenant_key=p_tenant_key AND source_id=p_source_id
      AND EXISTS(SELECT 1 FROM control.source_registry WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND lifecycle='PAUSED');
    FOR entity_value IN SELECT entity FROM control.etl_snapshot_delete_candidate
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=latest.run_id AND candidate_count>0 LOOP
      INSERT INTO control.etl_snapshot_delete_policy_audit(tenant_key,source_id,run_id,actor_kind,database_worker_role,
        reason_code,candidate_digest,owner_user_id,owner_revision,approval_id)
      VALUES(p_tenant_key,p_source_id,latest.run_id,'SYSTEM_POLICY',
        coalesce(nullif(current_setting('role',true),'none'),session_user),'DELETE_CANDIDATES_EXCEED_FIVE_PERCENT',
        (SELECT candidate_digest FROM control.etl_snapshot_delete_candidate WHERE tenant_key=p_tenant_key AND source_id=p_source_id
          AND run_id=latest.run_id AND entity=entity_value),run_row.owner_user_id,run_row.owner_revision,run_row.approval_id);
    END LOOP;
  END IF;
  UPDATE control.etl_snapshot_delete_run SET status=CASE WHEN has_above THEN 'AWAITING_OWNER'
      WHEN total_count=0 THEN 'COMPLETE' ELSE 'PENDING' END,
    candidate_count=total_count,above_threshold=has_above,
    pause_reason=CASE WHEN has_above THEN 'DELETE_CANDIDATES_EXCEED_FIVE_PERCENT' ELSE NULL END,
    last_worker_checked_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=latest.run_id;
  UPDATE control.etl_snapshot_delete_run d SET status='COMPLETE',candidate_count=0,updated_at=clock_timestamp()
    WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id AND d.status='PENDING'
      AND d.reservation_ordinal<latest.reservation_ordinal
      AND EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption c
        WHERE c.tenant_key=d.tenant_key AND c.source_id=d.source_id AND c.run_id=d.run_id);
  RETURN true;
END;
$body$;

CREATE FUNCTION control.consume_etl_snapshot_delete_run(p_tenant_key text,p_source_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub
AS $body$
DECLARE d control.etl_snapshot_delete_run%ROWTYPE; r control.etl_run%ROWTYPE; scope_json jsonb; scope_hash bytea;
BEGIN
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  SELECT x.* INTO d FROM control.etl_snapshot_delete_run x
    WHERE x.tenant_key=p_tenant_key AND x.source_id=p_source_id AND x.status='PENDING'
      AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption c
        WHERE c.tenant_key=x.tenant_key AND c.source_id=x.source_id AND c.run_id=x.run_id)
    ORDER BY x.reservation_ordinal LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN control.freeze_etl_snapshot_delete_candidates(p_tenant_key,p_source_id); END IF;
  IF EXISTS(SELECT 1 FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id
    AND status IN ('QUEUED','SCANNING','VALIDATING','READY','APPLYING')) THEN
    UPDATE control.etl_snapshot_delete_run SET last_worker_checked_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
    RETURN false;
  END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id FOR UPDATE;
  IF r.delete_contract IS DISTINCT FROM 'hard_delete' THEN
    UPDATE control.etl_snapshot_delete_run SET status='SKIPPED',last_worker_checked_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
    RETURN true;
  END IF;
  IF NOT control.etl_snapshot_delete_proof_current(p_tenant_key,p_source_id,d.run_id)
    OR EXISTS(SELECT 1 FROM control.source_security_barrier b
      WHERE b.tenant_key=r.tenant_key AND b.effective_fence>r.security_barrier_fence
        AND (b.source_id IS NULL OR b.source_id=r.source_id) AND (b.credential_id IS NULL OR b.credential_id=r.credential_id)
        AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')
        AND ((b.entity IS NULL AND b.channel_id IS NULL) OR EXISTS(SELECT 1 FROM jsonb_each(r.entity_channel_proof) cp
          WHERE (b.entity IS NULL OR cp.key=b.entity) AND (b.channel_id IS NULL OR cp.value->>'channel_id'=b.channel_id::text)))) THEN
    UPDATE control.etl_snapshot_delete_run SET status='STALE',updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
    RETURN true;
  END IF;
  IF r.status<>'COMPLETE' OR r.completed_at IS NULL OR d.c_completed_at IS DISTINCT FROM r.completed_at
    OR NOT EXISTS(SELECT 1 FROM control.etl_snapshot_manifest m JOIN control.etl_snapshot_validation v
      ON (v.tenant_key,v.source_id,v.run_id,v.attempt_id)=(m.tenant_key,m.source_id,m.run_id,m.attempt_id)
      JOIN control.etl_run_attempt a ON (a.tenant_key,a.source_id,a.run_id,a.attempt_id)=(m.tenant_key,m.source_id,m.run_id,m.attempt_id)
      JOIN control.etl_snapshot_observation o ON (o.tenant_key,o.source_id,o.run_id,o.attempt_id)=(m.tenant_key,m.source_id,m.run_id,m.attempt_id)
      WHERE m.tenant_key=p_tenant_key AND m.source_id=p_source_id AND m.run_id=d.run_id AND m.attempt_id=d.attempt_id
        AND m.state='EXTRACTED' AND a.status='COMPLETE' AND o.sequence_value=d.sequence_value) THEN
    UPDATE control.etl_snapshot_delete_run SET status='STALE',updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
    RETURN true;
  END IF;
  SELECT config INTO scope_json FROM control.source_config_revision
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND revision=r.config_revision;
  scope_json:=jsonb_build_object('tenant_key',r.tenant_key,'source_id',r.source_id,'config_revision',r.config_revision,
    'config_digest',encode(r.config_digest,'hex'),'mapping_revision',r.mapping_revision,'mapping_digest',encode(r.mapping_digest,'hex'),
    'identity_mapping_revision',r.identity_mapping_revision,'identity_mapping_digest',encode(r.identity_mapping_digest,'hex'),
    'endpoint_profile_digest',encode(r.endpoint_profile_digest,'hex'),'channel_scope',r.entity_channel_proof,
    'enabled_entities',r.expected_entities,'delete_contract',r.delete_contract,'owner_user_id',r.owner_user_id,
    'owner_revision',r.owner_revision,'approval_id',r.approval_id);
  scope_hash:=public.digest(convert_to(scope_json::text,'UTF8'),'sha256');
  INSERT INTO control.etl_snapshot_delete_consumption(tenant_key,source_id,run_id,attempt_id)
    VALUES(p_tenant_key,p_source_id,d.run_id,d.attempt_id) ON CONFLICT(tenant_key,source_id,run_id) DO NOTHING;
  IF NOT FOUND THEN RETURN true; END IF;
  UPDATE control.etl_snapshot_delete_run SET scope_digest=scope_hash,stable_scope_json=scope_json,
    updated_at=clock_timestamp() WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
  INSERT INTO control.etl_snapshot_delete_presence(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,source_deleted)
    SELECT s.tenant_key,s.source_id,s.run_id,s.attempt_id,s.entity,s.relation,s.parent_source_pk,s.source_pk,
      lower(coalesce(s.facts->>'deleted_at','false')) IN ('true','yes','1')
    FROM control.etl_snapshot_stage_record s
    WHERE s.tenant_key=p_tenant_key AND s.source_id=p_source_id AND s.run_id=d.run_id AND s.attempt_id=d.attempt_id
      AND s.entity=ANY(r.expected_entities) AND s.relation=s.entity AND s.parent_source_pk='';
  INSERT INTO control.etl_snapshot_delete_streak(tenant_key,source_id,entity,source_pk,scope_digest,stable_scope_json,
    last_processed_run_id,last_presence_run_id,absence_count,last_presence_sequence,updated_at)
    SELECT p_tenant_key,p_source_id,p.entity,p.source_pk,
      public.digest(convert_to(jsonb_build_object('proof',scope_json,'entity',p.entity)::text,'UTF8'),'sha256'),scope_json,
      d.run_id,d.run_id,0,d.sequence_value,clock_timestamp()
    FROM control.etl_snapshot_delete_presence p WHERE p.tenant_key=p_tenant_key AND p.source_id=p_source_id AND p.run_id=d.run_id
    ON CONFLICT(tenant_key,source_id,entity,source_pk,scope_digest) DO UPDATE SET stable_scope_json=EXCLUDED.stable_scope_json,
      last_processed_run_id=EXCLUDED.last_processed_run_id,last_presence_run_id=EXCLUDED.last_presence_run_id,
      first_absence_run_id=NULL,second_absence_run_id=NULL,absence_count=0,last_presence_sequence=EXCLUDED.last_presence_sequence,
      second_absence_sequence=NULL,second_absence_completed_at=NULL,updated_at=clock_timestamp();
  -- Seed first-scope absences from live canonical identities with a matching
  -- channel epoch and OBS receipt. A missing/stale receipt cannot start a streak.
  INSERT INTO control.etl_snapshot_delete_streak(tenant_key,source_id,entity,source_pk,scope_digest,stable_scope_json,
    last_processed_run_id,last_presence_run_id,first_absence_run_id,absence_count,last_presence_sequence,updated_at)
    SELECT p_tenant_key,p_source_id,i.entity,i.source_pk,
      public.digest(convert_to(jsonb_build_object('proof',scope_json,'entity',i.entity)::text,'UTF8'),'sha256'),
      scope_json,d.run_id,NULL,d.run_id,1,vr.source_version,clock_timestamp()
    FROM control.canonical_source_identity i
    JOIN control.source_version_receipt vr ON vr.tenant_key=i.tenant_key AND vr.source_id=i.source_id
      AND vr.channel_id=(r.entity_channel_proof->i.entity->>'channel_id')::uuid
      AND vr.channel_epoch=(r.entity_channel_proof->i.entity->>'channel_epoch')::bigint
      AND vr.version_domain='SNAPSHOT_OBSERVATION' AND vr.entity=i.entity AND vr.source_pk=i.source_pk
      AND vr.canonical_object_id=i.canonical_object_id
    WHERE i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=ANY(r.expected_entities)
      AND ((i.entity='customer' AND i.customer_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_customer cc
            WHERE cc.tenant_id=i.tenant_key AND cc.id=i.customer_id AND cc.deleted_at IS NULL))
        OR (i.entity='order' AND i.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_order co
            WHERE co.tenant_id=i.tenant_key AND co.id=i.order_id AND co.deleted_at IS NULL)))
      AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_presence p WHERE p.tenant_key=d.tenant_key
        AND p.source_id=d.source_id AND p.run_id=d.run_id AND p.entity=i.entity AND p.source_pk=i.source_pk)
    ON CONFLICT(tenant_key,source_id,entity,source_pk,scope_digest) DO NOTHING;
  -- Update only prior keys in this exact stable scope; this D pause/epoch is deliberately absent from scope_hash.
  UPDATE control.etl_snapshot_delete_streak s SET
    first_absence_run_id=CASE WHEN s.absence_count=0 THEN d.run_id ELSE s.first_absence_run_id END,
    second_absence_run_id=CASE WHEN s.absence_count=1 THEN d.run_id ELSE s.second_absence_run_id END,
    second_absence_sequence=CASE WHEN s.absence_count=1 THEN d.sequence_value ELSE s.second_absence_sequence END,
    second_absence_completed_at=CASE WHEN s.absence_count=1 THEN r.completed_at ELSE s.second_absence_completed_at END,
    absence_count=LEAST(2,s.absence_count+1)::smallint,last_processed_run_id=d.run_id,updated_at=clock_timestamp()
    WHERE s.tenant_key=p_tenant_key AND s.source_id=p_source_id
      AND s.scope_digest=public.digest(convert_to(jsonb_build_object('proof',scope_json,'entity',s.entity)::text,'UTF8'),'sha256')
      AND s.last_processed_run_id<>d.run_id
      AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_presence p WHERE p.tenant_key=s.tenant_key
        AND p.source_id=s.source_id AND p.run_id=d.run_id AND p.entity=s.entity AND p.source_pk=s.source_pk);
  RETURN control.freeze_etl_snapshot_delete_candidates(p_tenant_key,p_source_id);
END;
$body$;
REVOKE ALL ON FUNCTION control.etl_snapshot_delete_proof_current(text,text,uuid),
  control.freeze_etl_snapshot_delete_candidates(text,text),control.consume_etl_snapshot_delete_run(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.consume_etl_snapshot_delete_run(text,text) TO hub_worker;

-- M1-5D2 starts with a selective guard on reservation facts. Initial C facts
-- are fixed at reservation, the scope binds once at consume, and aggregate
-- freeze facts derive from immutable candidate headers.
CREATE FUNCTION control.guard_etl_snapshot_delete_run_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
DECLARE default_scope_digest bytea:=public.digest(convert_to('{}','UTF8'),'sha256');
  candidate_total bigint; candidate_above boolean; has_candidates boolean;
BEGIN
  IF (NEW.tenant_key,NEW.source_id,NEW.run_id,NEW.attempt_id,NEW.reservation_ordinal,
      NEW.sequence_value,NEW.c_completed_at) IS DISTINCT FROM
     (OLD.tenant_key,OLD.source_id,OLD.run_id,OLD.attempt_id,OLD.reservation_ordinal,
      OLD.sequence_value,OLD.c_completed_at) THEN
    RAISE EXCEPTION 'immutable D reservation identity or C proof' USING ERRCODE='55000';
  END IF;

  IF (NEW.scope_digest,NEW.stable_scope_json) IS DISTINCT FROM (OLD.scope_digest,OLD.stable_scope_json) THEN
    IF OLD.scope_digest IS DISTINCT FROM default_scope_digest OR OLD.stable_scope_json IS DISTINCT FROM '{}'::jsonb
       OR NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption c
         WHERE (c.tenant_key,c.source_id,c.run_id,c.attempt_id)=(NEW.tenant_key,NEW.source_id,NEW.run_id,NEW.attempt_id))
       OR NEW.scope_digest IS DISTINCT FROM public.digest(convert_to(NEW.stable_scope_json::text,'UTF8'),'sha256') THEN
      RAISE EXCEPTION 'D reservation scope may bind exactly once at consume' USING ERRCODE='55000';
    END IF;
  END IF;

  IF (NEW.candidate_count,NEW.above_threshold) IS DISTINCT FROM (OLD.candidate_count,OLD.above_threshold) THEN
    SELECT count(*)>0,coalesce(sum(candidate_count),0),coalesce(bool_or(control.etl_snapshot_delete_ratio_exceeds(candidate_count,baseline_count)),false)
      INTO has_candidates,candidate_total,candidate_above
      FROM control.etl_snapshot_delete_candidate WHERE tenant_key=NEW.tenant_key AND source_id=NEW.source_id AND run_id=NEW.run_id;
    IF NOT has_candidates OR NEW.candidate_count<>candidate_total OR NEW.above_threshold IS DISTINCT FROM candidate_above
       OR NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption c
         WHERE (c.tenant_key,c.source_id,c.run_id,c.attempt_id)=(NEW.tenant_key,NEW.source_id,NEW.run_id,NEW.attempt_id)) THEN
      -- An older consumed PENDING reservation is finalized after the newest
      -- reservation freezes; its own frozen candidate count is retired to 0.
      IF NOT (OLD.status='PENDING' AND NEW.status='COMPLETE' AND NEW.candidate_count=0
          AND NEW.above_threshold=OLD.above_threshold
          AND EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption c
            WHERE (c.tenant_key,c.source_id,c.run_id,c.attempt_id)=(NEW.tenant_key,NEW.source_id,NEW.run_id,NEW.attempt_id))) THEN
        RAISE EXCEPTION 'D reservation freeze facts must match immutable candidates' USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$body$;
CREATE TRIGGER etl_snapshot_delete_run_facts_guard BEFORE UPDATE ON control.etl_snapshot_delete_run
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_run_update();
REVOKE ALL ON FUNCTION control.guard_etl_snapshot_delete_run_update() FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE FUNCTION control.etl_snapshot_delete_baseline_digest_seed(p_proof jsonb,p_entity text,p_count bigint)
RETURNS bytea LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog
AS $body$
  SELECT public.digest(convert_to(jsonb_build_object('proof',p_proof,'entity',p_entity,'baseline',p_count,
    'kind','live-baseline-v1')::text,'UTF8'),'sha256')
$body$;

CREATE FUNCTION control.etl_snapshot_delete_baseline_member_digest(p_prior bytea,p_tenant_key text,p_source_id text,
  p_entity text,p_source_pk text,p_canonical_object_id uuid)
RETURNS bytea LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog
AS $body$
  SELECT public.digest(p_prior||convert_to(jsonb_build_object('tenant_key',p_tenant_key,'source_id',p_source_id,
    'entity',p_entity,'source_pk',p_source_pk,'canonical_object_id',p_canonical_object_id)::text,'UTF8'),'sha256')
$body$;

CREATE FUNCTION control.etl_snapshot_delete_candidate_digest_seed(p_proof jsonb,p_entity text,p_run_id uuid,p_revision integer,
  p_baseline_count bigint,p_candidate_count bigint,p_baseline_digest bytea)
RETURNS bytea LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog
AS $body$
  SELECT public.digest(convert_to(jsonb_build_object('proof',p_proof,'entity',p_entity,'run',p_run_id,
    'revision',p_revision,'baseline',p_baseline_count,'count',p_candidate_count,
    'baseline_membership_digest',encode(p_baseline_digest,'hex'))::text,'UTF8'),'sha256')
$body$;

CREATE FUNCTION control.etl_snapshot_delete_candidate_member_digest(p_prior bytea,p_source_pk text,p_canonical_object_id uuid,
  p_origin_run_id uuid,p_second_run_id uuid,p_sequence_value numeric,p_completed_at timestamptz)
RETURNS bytea LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog
AS $body$
  SELECT public.digest(p_prior||convert_to(jsonb_build_object('source_pk',p_source_pk,
    'canonical_object_id',p_canonical_object_id,'origin_run_id',p_origin_run_id,'second_run_id',p_second_run_id,
    'sequence_value',p_sequence_value,'completed_at',to_char(p_completed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,'UTF8'),'sha256')
$body$;

CREATE FUNCTION control.etl_snapshot_delete_baseline_fingerprint(p_tenant_key text,p_source_id text,p_entity text,p_proof jsonb)
RETURNS TABLE(baseline_count bigint,baseline_digest bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub
AS $body$
DECLARE member record; count_value bigint; digest_value bytea;
BEGIN
  IF p_entity='customer' THEN
    SELECT count(DISTINCT i.canonical_object_id) INTO count_value
      FROM control.canonical_source_identity i JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(i.tenant_key,i.customer_id)
      WHERE i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=p_entity AND i.customer_id IS NOT NULL AND c.deleted_at IS NULL;
  ELSIF p_entity='order' THEN
    SELECT count(DISTINCT i.canonical_object_id) INTO count_value
      FROM control.canonical_source_identity i JOIN hub.canonical_order o ON (o.tenant_id,o.id)=(i.tenant_key,i.order_id)
      WHERE i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=p_entity AND i.order_id IS NOT NULL AND o.deleted_at IS NULL;
  ELSE
    RAISE EXCEPTION 'invalid D entity' USING ERRCODE='22023';
  END IF;
  digest_value:=control.etl_snapshot_delete_baseline_digest_seed(p_proof,p_entity,count_value);
  IF p_entity='customer' THEN
    FOR member IN SELECT i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id
      FROM control.canonical_source_identity i JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(i.tenant_key,i.customer_id)
      WHERE i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=p_entity AND i.customer_id IS NOT NULL AND c.deleted_at IS NULL
      ORDER BY i.source_pk COLLATE "C" LOOP
      digest_value:=control.etl_snapshot_delete_baseline_member_digest(digest_value,member.tenant_key,member.source_id,
        member.entity,member.source_pk,member.canonical_object_id);
    END LOOP;
  ELSE
    FOR member IN SELECT i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id
      FROM control.canonical_source_identity i JOIN hub.canonical_order o ON (o.tenant_id,o.id)=(i.tenant_key,i.order_id)
      WHERE i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=p_entity AND i.order_id IS NOT NULL AND o.deleted_at IS NULL
      ORDER BY i.source_pk COLLATE "C" LOOP
      digest_value:=control.etl_snapshot_delete_baseline_member_digest(digest_value,member.tenant_key,member.source_id,
        member.entity,member.source_pk,member.canonical_object_id);
    END LOOP;
  END IF;
  RETURN QUERY SELECT count_value,digest_value;
END;
$body$;

CREATE FUNCTION control.etl_snapshot_delete_candidate_recomputed_digest(p_candidate_id uuid)
RETURNS bytea LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE c control.etl_snapshot_delete_candidate%ROWTYPE; member record; digest_value bytea;
BEGIN
  SELECT * INTO c FROM control.etl_snapshot_delete_candidate WHERE candidate_id=p_candidate_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  digest_value:=control.etl_snapshot_delete_candidate_digest_seed(c.stable_scope_json->'proof',c.entity,c.run_id,
    c.candidate_revision,c.baseline_count,c.candidate_count,c.baseline_membership_digest);
  FOR member IN SELECT source_pk,canonical_object_id,origin_run_id,second_run_id,sequence_value,inferred_completed_at
    FROM control.etl_snapshot_delete_candidate_member WHERE candidate_id=p_candidate_id ORDER BY source_pk COLLATE "C" LOOP
    digest_value:=control.etl_snapshot_delete_candidate_member_digest(digest_value,member.source_pk,
      member.canonical_object_id,member.origin_run_id,member.second_run_id,member.sequence_value,member.inferred_completed_at);
  END LOOP;
  RETURN digest_value;
END;
$body$;
REVOKE ALL ON FUNCTION control.etl_snapshot_delete_baseline_fingerprint(text,text,text,jsonb),
  control.etl_snapshot_delete_candidate_recomputed_digest(uuid),
  control.etl_snapshot_delete_baseline_digest_seed(jsonb,text,bigint),
  control.etl_snapshot_delete_baseline_member_digest(bytea,text,text,text,text,uuid),
  control.etl_snapshot_delete_candidate_digest_seed(jsonb,text,uuid,integer,bigint,bigint,bytea),
  control.etl_snapshot_delete_candidate_member_digest(bytea,text,uuid,uuid,uuid,numeric,timestamptz)
  FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE TABLE control.etl_snapshot_delete_approval (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, candidate_id uuid NOT NULL, entity text NOT NULL,
  candidate_revision integer NOT NULL, candidate_digest bytea NOT NULL CHECK(octet_length(candidate_digest)=32),
  baseline_count bigint NOT NULL CHECK(baseline_count>=0), candidate_count bigint NOT NULL CHECK(candidate_count>=0),
  baseline_membership_digest bytea NOT NULL CHECK(octet_length(baseline_membership_digest)=32),
  stable_scope_json jsonb NOT NULL CHECK(jsonb_typeof(stable_scope_json)='object'),
  owner_user_id text NOT NULL, owner_revision bigint NOT NULL,
  approver_tenant_key text NOT NULL, approver_user_id text NOT NULL, oidc_issuer text NOT NULL, oidc_subject text NOT NULL,
  approver_auth_epoch bigint NOT NULL, required_scope text NOT NULL CHECK(required_scope='source:approve'),
  idempotency_key text NOT NULL, request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(candidate_id,candidate_revision), UNIQUE(approval_id,tenant_key,source_id),
  FOREIGN KEY(candidate_id,tenant_key,source_id,run_id,entity)
    REFERENCES control.etl_snapshot_delete_candidate(candidate_id,tenant_key,source_id,run_id,entity) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.etl_snapshot_delete_idempotency (
  tenant_key text NOT NULL, source_id text NOT NULL, request_route text NOT NULL CHECK(request_route='API-060'),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 160),
  request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32), approval_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_key,source_id,request_route,idempotency_key),
  FOREIGN KEY(approval_id,tenant_key,source_id) REFERENCES control.etl_snapshot_delete_approval(approval_id,tenant_key,source_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.etl_snapshot_delete_api_audit (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL CHECK(action IN ('EXACT_MEMBER_READ','OWNER_APPROVAL')),
  tenant_key text NOT NULL, source_id text NOT NULL, run_id uuid NOT NULL, candidate_id uuid NOT NULL,
  actor_user_id text NOT NULL, request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  approval_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((action='EXACT_MEMBER_READ' AND approval_id IS NULL) OR (action='OWNER_APPROVAL' AND approval_id IS NOT NULL)),
  FOREIGN KEY(candidate_id,tenant_key,source_id,run_id)
    REFERENCES control.etl_snapshot_delete_candidate(candidate_id,tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(approval_id,tenant_key,source_id)
    REFERENCES control.etl_snapshot_delete_approval(approval_id,tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION control.guard_etl_snapshot_delete_d2_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
BEGIN
  RAISE EXCEPTION 'immutable D2 approval evidence' USING ERRCODE='55000';
END;
$body$;
CREATE TRIGGER etl_snapshot_delete_approval_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_approval
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_d2_immutable();
CREATE TRIGGER etl_snapshot_delete_idempotency_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_idempotency
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_d2_immutable();
CREATE TRIGGER etl_snapshot_delete_api_audit_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_api_audit
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_d2_immutable();

CREATE FUNCTION control.etl_snapshot_delete_candidate_current(p_tenant_key text,p_source_id text,p_candidate_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub
AS $body$
DECLARE c control.etl_snapshot_delete_candidate%ROWTYPE; r control.etl_run%ROWTYPE; d control.etl_snapshot_delete_run%ROWTYPE;
  current_baseline_count bigint; current_baseline_digest bytea; current_member_count bigint;
BEGIN
  SELECT * INTO c FROM control.etl_snapshot_delete_candidate WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND candidate_id=p_candidate_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=c.run_id;
  SELECT * INTO d FROM control.etl_snapshot_delete_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=c.run_id;
  IF NOT FOUND OR d.status NOT IN ('PENDING','AWAITING_OWNER') OR c.stable_scope_json->'proof' IS DISTINCT FROM d.stable_scope_json
    OR c.scope_digest IS DISTINCT FROM public.digest(convert_to(jsonb_build_object('proof',c.stable_scope_json->'proof','entity',c.entity)::text,'UTF8'),'sha256')
    OR NOT control.etl_snapshot_delete_proof_current(p_tenant_key,p_source_id,c.run_id)
    OR EXISTS(SELECT 1 FROM control.etl_snapshot_delete_run newer WHERE newer.tenant_key=p_tenant_key AND newer.source_id=p_source_id
      AND newer.reservation_ordinal>d.reservation_ordinal)
    OR EXISTS(SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=r.tenant_key AND b.effective_fence>r.security_barrier_fence
      AND (b.source_id IS NULL OR b.source_id=r.source_id) AND (b.credential_id IS NULL OR b.credential_id=r.credential_id)
      AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')
      AND ((b.entity IS NULL AND b.channel_id IS NULL) OR EXISTS(SELECT 1 FROM jsonb_each(r.entity_channel_proof) cp
        WHERE (b.entity IS NULL OR cp.key=b.entity) AND (b.channel_id IS NULL OR cp.value->>'channel_id'=b.channel_id::text)))) THEN
    RETURN false;
  END IF;
  SELECT baseline_count,baseline_digest INTO current_baseline_count,current_baseline_digest
    FROM control.etl_snapshot_delete_baseline_fingerprint(p_tenant_key,p_source_id,c.entity,c.stable_scope_json->'proof');
  IF current_baseline_count IS DISTINCT FROM c.baseline_count OR current_baseline_digest IS DISTINCT FROM c.baseline_membership_digest
     OR control.etl_snapshot_delete_candidate_recomputed_digest(c.candidate_id) IS DISTINCT FROM c.candidate_digest THEN RETURN false; END IF;
  SELECT count(*) INTO current_member_count FROM control.etl_snapshot_delete_candidate_member m
    JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id)=
      (m.tenant_key,m.source_id,m.entity,m.source_pk,m.canonical_object_id)
    WHERE m.candidate_id=c.candidate_id AND (
      (m.entity='customer' AND i.customer_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_customer x WHERE (x.tenant_id,x.id)=(i.tenant_key,i.customer_id) AND x.deleted_at IS NULL)) OR
      (m.entity='order' AND i.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM hub.canonical_order x WHERE (x.tenant_id,x.id)=(i.tenant_key,i.order_id) AND x.deleted_at IS NULL)))
      AND m.sequence_value>coalesce((SELECT vr.source_version FROM control.source_version_receipt vr
        WHERE vr.tenant_key=m.tenant_key AND vr.source_id=m.source_id AND vr.channel_id=(r.entity_channel_proof->m.entity->>'channel_id')::uuid
          AND vr.entity=m.entity AND vr.source_pk=m.source_pk),-1);
  IF current_member_count IS DISTINCT FROM c.candidate_count THEN RETURN false; END IF;
  RETURN true;
END;
$body$;
REVOKE ALL ON FUNCTION control.etl_snapshot_delete_candidate_current(text,text,uuid) FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE FUNCTION control.api021_snapshot_delete_summary(p_tenant_key text,p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE result jsonb;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('status',x.status,'candidate_count',x.candidate_count,'above_threshold',x.above_threshold,
    'pause_reason',x.pause_reason,'c_completed_at',x.c_completed_at,'c_observation_sequence',x.sequence_value,
    'candidates',coalesce(jsonb_agg(jsonb_build_object('candidate_id',c.candidate_id,'entity',c.entity,
      'candidate_revision',c.candidate_revision,'candidate_digest',encode(c.candidate_digest,'hex'),
      'baseline_count',c.baseline_count,'candidate_count',c.candidate_count,
      'approval_status',CASE WHEN NOT control.etl_snapshot_delete_ratio_exceeds(c.candidate_count,c.baseline_count)
        THEN 'NOT_REQUIRED' WHEN a.approval_id IS NULL THEN 'AWAITING_OWNER' ELSE 'APPROVED' END,
      'approval_id',a.approval_id) ORDER BY c.entity) FILTER (WHERE c.candidate_id IS NOT NULL),'[]'::jsonb)) INTO result
  FROM control.etl_snapshot_delete_run x LEFT JOIN control.etl_snapshot_delete_candidate c
    ON (c.tenant_key,c.source_id,c.run_id)=(x.tenant_key,x.source_id,x.run_id)
  LEFT JOIN control.etl_snapshot_delete_approval a ON (a.candidate_id,a.candidate_revision)=(c.candidate_id,c.candidate_revision)
  WHERE x.tenant_key=p_tenant_key AND x.run_id=p_run_id
  GROUP BY x.status,x.candidate_count,x.above_threshold,x.pause_reason,x.c_completed_at,x.sequence_value;
  RETURN result;
END;
$body$;

CREATE FUNCTION control.api021_delete_candidate_page(p_tenant_key text,p_source_id text,p_run_id uuid,p_candidate_id uuid,
  p_cursor jsonb,p_limit integer,p_actor_user_id text,p_issuer text,p_subject text,p_request_id text)
RETURNS TABLE(tenant_key text,source_id text,entity text,source_pk text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE owner_id text; principal record; c control.etl_snapshot_delete_candidate%ROWTYPE; after_source_pk text;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_limit<1 OR p_limit>101 THEN RAISE EXCEPTION 'AUTH_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM control.lock_security_barrier_fence();
  PERFORM * FROM control.lock_source_credential(p_tenant_key,p_source_id);
  IF NOT control.lock_etl_snapshot_source(p_tenant_key,p_source_id) THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT sr.data_owner_user_id INTO owner_id FROM control.source_registry sr
    WHERE sr.tenant_key=p_tenant_key AND sr.source_id=p_source_id FOR UPDATE;
  IF owner_id IS DISTINCT FROM p_actor_user_id THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM control.tenant t JOIN control.auth_subject s USING(tenant_key)
    WHERE t.tenant_key=p_tenant_key AND s.user_id=owner_id AND t.enabled AND s.enabled FOR UPDATE OF t,s;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO principal FROM control.lock_api_identity(p_issuer,p_subject);
  IF NOT FOUND OR NOT principal.binding_enabled OR NOT principal.enabled OR NOT principal.tenant_enabled
    OR principal.tenant_key IS DISTINCT FROM p_tenant_key OR principal.user_id IS DISTINCT FROM p_actor_user_id
    OR NOT (principal.management_scopes @> ARRAY['source:read','source:approve']::text[]) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT cd.* INTO c FROM control.etl_snapshot_delete_candidate cd WHERE cd.candidate_id=p_candidate_id AND cd.tenant_key=p_tenant_key
    AND cd.source_id=p_source_id AND cd.run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR NOT control.etl_snapshot_delete_candidate_current(p_tenant_key,p_source_id,p_candidate_id) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF p_cursor IS NOT NULL THEN
    IF jsonb_typeof(p_cursor)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_cursor))<>7
      OR NOT (p_cursor ?& ARRAY['tenant_key','source_id','run_id','candidate_id','candidate_revision','candidate_digest','last_key'])
      OR (p_cursor->>'tenant_key') IS DISTINCT FROM p_tenant_key OR (p_cursor->>'source_id') IS DISTINCT FROM p_source_id
      OR (p_cursor->>'run_id') IS DISTINCT FROM p_run_id::text OR (p_cursor->>'candidate_id') IS DISTINCT FROM p_candidate_id::text
      OR (p_cursor->>'candidate_revision') !~ '^[1-9][0-9]*$'
      OR (p_cursor->>'candidate_revision')::integer IS DISTINCT FROM c.candidate_revision::integer
      OR (p_cursor->>'candidate_digest') IS DISTINCT FROM encode(c.candidate_digest,'hex')
      OR jsonb_typeof(p_cursor->'last_key') IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_cursor->'last_key'))<>4
      OR NOT (p_cursor->'last_key' ?& ARRAY['tenant_key','source_id','entity','source_pk'])
      OR (p_cursor->'last_key'->>'tenant_key') IS DISTINCT FROM p_tenant_key
      OR (p_cursor->'last_key'->>'source_id') IS DISTINCT FROM p_source_id
      OR (p_cursor->'last_key'->>'entity') IS DISTINCT FROM c.entity
      OR length(p_cursor->'last_key'->>'source_pk') NOT BETWEEN 1 AND 128 THEN
      RAISE EXCEPTION 'AUTH_INPUT_INVALID' USING ERRCODE='22023';
    END IF;
    after_source_pk:=p_cursor->'last_key'->>'source_pk';
  END IF;
  INSERT INTO control.etl_snapshot_delete_api_audit(action,tenant_key,source_id,run_id,candidate_id,actor_user_id,request_id)
    VALUES('EXACT_MEMBER_READ',p_tenant_key,p_source_id,p_run_id,p_candidate_id,p_actor_user_id,p_request_id);
  RETURN QUERY SELECT p_tenant_key,p_source_id,c.entity,m.source_pk FROM control.etl_snapshot_delete_candidate_member m
    WHERE m.candidate_id=p_candidate_id AND (after_source_pk IS NULL OR m.source_pk COLLATE "C">after_source_pk COLLATE "C")
    ORDER BY m.source_pk COLLATE "C" LIMIT p_limit;
END;
$body$;

CREATE FUNCTION control.api060_approve_delete_candidate(p_tenant_key text,p_source_id text,p_candidate_id uuid,p_run_id uuid,
  p_candidate_revision integer,p_candidate_digest bytea,p_expected_owner_revision bigint,p_reason text,p_idempotency_key text,
  p_actor_tenant_key text,p_actor_user_id text,p_issuer text,p_subject text,p_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE source_row record; principal record; c control.etl_snapshot_delete_candidate%ROWTYPE;
  d control.etl_snapshot_delete_run%ROWTYPE; approval control.etl_snapshot_delete_approval%ROWTYPE;
  previous control.etl_snapshot_delete_idempotency%ROWTYPE; live_owner record; request_hash bytea;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_candidate_revision<1 OR p_expected_owner_revision<1 OR octet_length(p_candidate_digest)<>32
    OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,160}$' OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000
    OR p_reason ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'AUTH_INPUT_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM control.lock_security_barrier_fence();
  PERFORM * FROM control.lock_source_credential(p_tenant_key,p_source_id);
  IF NOT control.lock_etl_snapshot_source(p_tenant_key,p_source_id) THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT r.data_owner_user_id,r.owner_revision,r.lifecycle,t.enabled AS tenant_enabled,cred.enabled AS credential_enabled
    INTO source_row FROM control.source_registry r JOIN control.tenant t USING(tenant_key)
    JOIN control.source_credential cred USING(tenant_key,source_id)
    WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id FOR UPDATE OF r,t,cred;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF source_row.data_owner_user_id IS DISTINCT FROM p_actor_user_id OR source_row.owner_revision IS DISTINCT FROM p_expected_owner_revision
    OR NOT source_row.tenant_enabled OR NOT source_row.credential_enabled THEN RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT s.enabled,s.tenant_key INTO live_owner FROM control.auth_subject s
    WHERE s.tenant_key=p_tenant_key AND s.user_id=source_row.data_owner_user_id FOR UPDATE;
  IF NOT FOUND OR NOT live_owner.enabled THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO principal FROM control.lock_api_identity(p_issuer,p_subject);
  IF NOT FOUND OR NOT principal.binding_enabled OR NOT principal.enabled OR NOT principal.tenant_enabled
    OR principal.tenant_key IS DISTINCT FROM p_actor_tenant_key OR principal.tenant_key IS DISTINCT FROM p_tenant_key
    OR principal.user_id IS DISTINCT FROM p_actor_user_id OR principal.issuer IS DISTINCT FROM p_issuer
    OR principal.subject IS DISTINCT FROM p_subject OR NOT (principal.management_scopes @> ARRAY['source:approve']::text[]) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF source_row.lifecycle IS DISTINCT FROM 'PAUSED' OR EXISTS(SELECT 1 FROM control.etl_snapshot_schedule s
      WHERE s.tenant_key=p_tenant_key AND s.source_id=p_source_id AND s.enabled) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO c FROM control.etl_snapshot_delete_candidate WHERE candidate_id=p_candidate_id AND tenant_key=p_tenant_key
    AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  SELECT * INTO d FROM control.etl_snapshot_delete_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR c.candidate_revision IS DISTINCT FROM p_candidate_revision OR c.candidate_digest IS DISTINCT FROM p_candidate_digest
    OR NOT d.above_threshold OR NOT control.etl_snapshot_delete_ratio_exceeds(c.candidate_count,c.baseline_count) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  request_hash:=public.digest(convert_to(jsonb_build_object('route','API-060','source_id',p_source_id,'candidate_id',p_candidate_id,
    'run_id',p_run_id,'candidate_revision',p_candidate_revision,'candidate_digest',encode(p_candidate_digest,'hex'),
    'expected_owner_revision',p_expected_owner_revision,'reason',p_reason)::text,'UTF8'),'sha256');
  SELECT * INTO previous FROM control.etl_snapshot_delete_idempotency WHERE tenant_key=p_tenant_key AND source_id=p_source_id
    AND request_route='API-060' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF previous.request_digest IS DISTINCT FROM request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    SELECT * INTO approval FROM control.etl_snapshot_delete_approval WHERE approval_id=previous.approval_id
      AND tenant_key=p_tenant_key AND source_id=p_source_id;
    IF NOT FOUND OR approval.candidate_id IS DISTINCT FROM p_candidate_id OR approval.run_id IS DISTINCT FROM p_run_id
      OR approval.candidate_revision IS DISTINCT FROM p_candidate_revision OR approval.candidate_digest IS DISTINCT FROM p_candidate_digest
      OR approval.approver_tenant_key IS DISTINCT FROM principal.tenant_key OR approval.approver_user_id IS DISTINCT FROM principal.user_id
      OR approval.oidc_issuer IS DISTINCT FROM principal.issuer OR approval.oidc_subject IS DISTINCT FROM principal.subject
      OR approval.approver_auth_epoch IS DISTINCT FROM principal.auth_epoch OR approval.required_scope IS DISTINCT FROM 'source:approve'
      OR approval.owner_user_id IS DISTINCT FROM source_row.data_owner_user_id OR approval.owner_revision IS DISTINCT FROM source_row.owner_revision
      OR NOT ((d.status='AWAITING_OWNER' AND control.etl_snapshot_delete_candidate_current(p_tenant_key,p_source_id,p_candidate_id))
        OR (d.status IN ('APPLYING','COMPLETE') AND control.etl_snapshot_delete_candidate_current_d3(p_tenant_key,p_source_id,p_candidate_id,true))) THEN
      RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('approval_id',approval.approval_id,'status','APPROVED','candidate_id',approval.candidate_id,
      'candidate_revision',approval.candidate_revision,'candidate_digest',encode(approval.candidate_digest,'hex'),'replayed',true);
  END IF;
  IF d.status IS DISTINCT FROM 'AWAITING_OWNER' OR NOT control.etl_snapshot_delete_candidate_current(p_tenant_key,p_source_id,p_candidate_id) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_delete_approval WHERE candidate_id=p_candidate_id AND candidate_revision=p_candidate_revision) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  INSERT INTO control.etl_snapshot_delete_approval(tenant_key,source_id,run_id,candidate_id,entity,candidate_revision,candidate_digest,
    baseline_count,candidate_count,baseline_membership_digest,stable_scope_json,owner_user_id,owner_revision,
    approver_tenant_key,approver_user_id,oidc_issuer,oidc_subject,approver_auth_epoch,required_scope,idempotency_key,request_digest,reason)
  VALUES(p_tenant_key,p_source_id,p_run_id,p_candidate_id,c.entity,p_candidate_revision,c.candidate_digest,c.baseline_count,c.candidate_count,
    c.baseline_membership_digest,c.stable_scope_json,source_row.data_owner_user_id,source_row.owner_revision,
    principal.tenant_key,principal.user_id,principal.issuer,principal.subject,principal.auth_epoch,'source:approve',p_idempotency_key,request_hash,p_reason)
  RETURNING * INTO approval;
  INSERT INTO control.etl_snapshot_delete_idempotency(tenant_key,source_id,request_route,idempotency_key,request_digest,approval_id)
    VALUES(p_tenant_key,p_source_id,'API-060',p_idempotency_key,request_hash,approval.approval_id);
  INSERT INTO control.etl_snapshot_delete_api_audit(action,tenant_key,source_id,run_id,candidate_id,actor_user_id,request_id,approval_id)
    VALUES('OWNER_APPROVAL',p_tenant_key,p_source_id,p_run_id,p_candidate_id,principal.user_id,p_request_id,approval.approval_id);
  RETURN jsonb_build_object('approval_id',approval.approval_id,'status','APPROVED','candidate_id',approval.candidate_id,
    'candidate_revision',approval.candidate_revision,'candidate_digest',encode(approval.candidate_digest,'hex'),'replayed',false);
END;
$body$;

REVOKE ALL ON control.etl_snapshot_delete_approval,control.etl_snapshot_delete_idempotency,control.etl_snapshot_delete_api_audit
  FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.guard_etl_snapshot_delete_d2_immutable(),
  control.etl_snapshot_delete_baseline_fingerprint(text,text,text,jsonb),control.etl_snapshot_delete_candidate_recomputed_digest(uuid),
  control.etl_snapshot_delete_candidate_current(text,text,uuid),control.api021_snapshot_delete_summary(text,uuid),
  control.api021_delete_candidate_page(text,text,uuid,uuid,jsonb,integer,text,text,text,text),
  control.api060_approve_delete_candidate(text,text,uuid,uuid,integer,bytea,bigint,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.api021_snapshot_delete_summary(text,uuid),
  control.api021_delete_candidate_page(text,text,uuid,uuid,jsonb,integer,text,text,text,text),
  control.api060_approve_delete_candidate(text,text,uuid,uuid,integer,bytea,bigint,text,text,text,text,text,text,text) TO hub_api;

-- M1-5D3 fenced logical apply. 009 is still unreleased; these are additive
-- D-owned facts and routines, with no second canonical writer.
ALTER TABLE control.etl_snapshot_delete_run
  ADD COLUMN d_claim_token uuid,
  ADD COLUMN d_lease_expires_at timestamptz,
  ADD COLUMN d_start_count smallint NOT NULL DEFAULT 0 CHECK (d_start_count BETWEEN 0 AND 4),
  ADD COLUMN d_next_retry_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
  ADD COLUMN d_heartbeat_at timestamptz,
  ADD COLUMN d_error_code text CHECK (d_error_code IS NULL OR d_error_code ~ '^[A-Z0-9_]{1,80}$');

CREATE TABLE control.etl_snapshot_delete_operation (
  candidate_id uuid NOT NULL,
  entity text NOT NULL CHECK(entity IN ('customer','order')),
  source_pk text COLLATE "C" NOT NULL,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(candidate_id,entity,source_pk),
  UNIQUE(operation_id),
  FOREIGN KEY(candidate_id,entity,source_pk)
    REFERENCES control.etl_snapshot_delete_candidate_member(candidate_id,entity,source_pk) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE control.etl_snapshot_delete_effect (
  candidate_id uuid NOT NULL,
  entity text NOT NULL CHECK(entity IN ('customer','order')),
  source_pk text COLLATE "C" NOT NULL,
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  canonical_object_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  sequence_value numeric(20,0) NOT NULL CHECK(sequence_value BETWEEN 0 AND 99999999999999999999),
  inferred_deleted_at timestamptz NOT NULL,
  source_content_digest bytea NOT NULL CHECK(octet_length(source_content_digest)=32),
  projection_digest bytea NOT NULL CHECK(octet_length(projection_digest)=32),
  hub_revision bigint NOT NULL CHECK(hub_revision>0),
  outbox_id bigint NOT NULL,
  start_count smallint NOT NULL CHECK(start_count BETWEEN 1 AND 4),
  claim_token uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(candidate_id,entity,source_pk),
  UNIQUE(outbox_id),
  FOREIGN KEY(candidate_id,entity,source_pk)
    REFERENCES control.etl_snapshot_delete_candidate_member(candidate_id,entity,source_pk) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(candidate_id,entity,source_pk)
    REFERENCES control.etl_snapshot_delete_operation(candidate_id,entity,source_pk) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TRIGGER etl_snapshot_delete_operation_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_operation
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_immutable();
CREATE TRIGGER etl_snapshot_delete_effect_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_delete_effect
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_snapshot_delete_immutable();
REVOKE ALL ON control.etl_snapshot_delete_operation,control.etl_snapshot_delete_effect FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE OR REPLACE FUNCTION control.etl_snapshot_delete_candidate_current_d3(
  p_tenant_key text,p_source_id text,p_candidate_id uuid,p_allow_completed boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub
AS $body$
DECLARE c control.etl_snapshot_delete_candidate%ROWTYPE; r control.etl_run%ROWTYPE; d control.etl_snapshot_delete_run%ROWTYPE;
  n bigint; fp bytea; member record; seen_count bigint:=0; digest_value bytea; live_count bigint; own_count bigint;
BEGIN
  SELECT * INTO c FROM control.etl_snapshot_delete_candidate
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND candidate_id=p_candidate_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=c.run_id;
  SELECT * INTO d FROM control.etl_snapshot_delete_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=c.run_id;
  IF NOT FOUND OR NOT (d.status='APPLYING' OR (p_allow_completed AND d.status='COMPLETE')
       OR (NOT p_allow_completed AND d.status IN ('PENDING','AWAITING_OWNER')))
     OR c.stable_scope_json->'proof' IS DISTINCT FROM d.stable_scope_json
     OR c.scope_digest IS DISTINCT FROM public.digest(convert_to(jsonb_build_object('proof',c.stable_scope_json->'proof','entity',c.entity)::text,'UTF8'),'sha256')
     OR NOT control.etl_snapshot_delete_proof_current(p_tenant_key,p_source_id,c.run_id)
     OR EXISTS(SELECT 1 FROM control.etl_snapshot_delete_run x WHERE x.tenant_key=p_tenant_key AND x.source_id=p_source_id
       AND x.reservation_ordinal>d.reservation_ordinal)
     OR EXISTS(SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=r.tenant_key AND b.effective_fence>r.security_barrier_fence
       AND (b.source_id IS NULL OR b.source_id=r.source_id) AND (b.credential_id IS NULL OR b.credential_id=r.credential_id)
       AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')
       AND ((b.entity IS NULL AND b.channel_id IS NULL) OR EXISTS(SELECT 1 FROM jsonb_each(r.entity_channel_proof) cp
         WHERE (b.entity IS NULL OR cp.key=b.entity) AND (b.channel_id IS NULL OR cp.value->>'channel_id'=b.channel_id::text)))) THEN
    RETURN false;
  END IF;
  IF control.etl_snapshot_delete_candidate_recomputed_digest(c.candidate_id) IS DISTINCT FROM c.candidate_digest THEN RETURN false; END IF;

  -- Rebuild the original live-only denominator using exactly the D2 serializer.
  SELECT count(*) INTO n FROM (
    SELECT i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id
      FROM control.canonical_source_identity i JOIN hub.canonical_customer x ON (x.tenant_id,x.id)=(i.tenant_key,i.customer_id)
      WHERE c.entity='customer' AND i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=c.entity AND x.deleted_at IS NULL
    UNION
    SELECT i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id
      FROM control.canonical_source_identity i JOIN hub.canonical_order x ON (x.tenant_id,x.id)=(i.tenant_key,i.order_id)
      WHERE c.entity='order' AND i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=c.entity AND x.deleted_at IS NULL
    UNION
    SELECT m.tenant_key,m.source_id,m.entity,m.source_pk,m.canonical_object_id
      FROM control.etl_snapshot_delete_effect e JOIN control.etl_snapshot_delete_candidate_member m
        USING(candidate_id,entity,source_pk)
      JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id)=
        (m.tenant_key,m.source_id,m.entity,m.source_pk,m.canonical_object_id)
      JOIN control.source_version_receipt vr ON (vr.tenant_key,vr.source_id,vr.entity,vr.source_pk,vr.canonical_object_id,vr.channel_id,vr.source_version,vr.deleted,vr.source_content_digest)=
        (e.tenant_key,e.source_id,e.entity,e.source_pk,e.canonical_object_id,e.channel_id,e.sequence_value,true,e.source_content_digest)
      JOIN control.canonical_apply_outbox ob ON (ob.id,ob.tenant_key,ob.source_id,ob.entity,ob.canonical_object_id,ob.channel_id,ob.operation,ob.source_content_digest,ob.projection_digest,ob.hub_revision)=
        (e.outbox_id,e.tenant_key,e.source_id,e.entity,e.canonical_object_id,e.channel_id,'DELETE',e.source_content_digest,e.projection_digest,e.hub_revision)
      WHERE e.candidate_id=c.candidate_id AND m.candidate_id=c.candidate_id
        AND ((c.entity='customer' AND EXISTS(SELECT 1 FROM hub.canonical_customer x WHERE (x.tenant_id,x.id)=(i.tenant_key,i.customer_id) AND x.deleted_at IS NOT NULL))
          OR (c.entity='order' AND EXISTS(SELECT 1 FROM hub.canonical_order x WHERE (x.tenant_id,x.id)=(i.tenant_key,i.order_id) AND x.deleted_at IS NOT NULL)))
  ) baseline;
  IF n IS DISTINCT FROM c.baseline_count THEN RETURN false; END IF;
  digest_value:=control.etl_snapshot_delete_baseline_digest_seed(c.stable_scope_json->'proof',c.entity,n);
  FOR member IN SELECT * FROM (
    SELECT i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id
      FROM control.canonical_source_identity i JOIN hub.canonical_customer x ON (x.tenant_id,x.id)=(i.tenant_key,i.customer_id)
      WHERE c.entity='customer' AND i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=c.entity AND x.deleted_at IS NULL
    UNION
    SELECT i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id
      FROM control.canonical_source_identity i JOIN hub.canonical_order x ON (x.tenant_id,x.id)=(i.tenant_key,i.order_id)
      WHERE c.entity='order' AND i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=c.entity AND x.deleted_at IS NULL
    UNION
    SELECT m.tenant_key,m.source_id,m.entity,m.source_pk,m.canonical_object_id
      FROM control.etl_snapshot_delete_effect e JOIN control.etl_snapshot_delete_candidate_member m USING(candidate_id,entity,source_pk)
      JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id)=
        (m.tenant_key,m.source_id,m.entity,m.source_pk,m.canonical_object_id)
      JOIN control.source_version_receipt vr ON (vr.tenant_key,vr.source_id,vr.entity,vr.source_pk,vr.canonical_object_id,vr.channel_id,vr.source_version,vr.deleted,vr.source_content_digest)=
        (e.tenant_key,e.source_id,e.entity,e.source_pk,e.canonical_object_id,e.channel_id,e.sequence_value,true,e.source_content_digest)
      JOIN control.canonical_apply_outbox ob ON (ob.id,ob.tenant_key,ob.source_id,ob.entity,ob.canonical_object_id,ob.channel_id,ob.operation,ob.source_content_digest,ob.projection_digest,ob.hub_revision)=
        (e.outbox_id,e.tenant_key,e.source_id,e.entity,e.canonical_object_id,e.channel_id,'DELETE',e.source_content_digest,e.projection_digest,e.hub_revision)
      WHERE e.candidate_id=c.candidate_id AND m.candidate_id=c.candidate_id
        AND ((c.entity='customer' AND EXISTS(SELECT 1 FROM hub.canonical_customer x WHERE (x.tenant_id,x.id)=(i.tenant_key,i.customer_id) AND x.deleted_at IS NOT NULL))
          OR (c.entity='order' AND EXISTS(SELECT 1 FROM hub.canonical_order x WHERE (x.tenant_id,x.id)=(i.tenant_key,i.order_id) AND x.deleted_at IS NOT NULL)))
  ) all_members ORDER BY source_pk COLLATE "C" LOOP
    digest_value:=control.etl_snapshot_delete_baseline_member_digest(digest_value,member.tenant_key,member.source_id,member.entity,member.source_pk,member.canonical_object_id);
    seen_count:=seen_count+1;
  END LOOP;
  SELECT count(*) INTO own_count FROM control.etl_snapshot_delete_effect e WHERE e.candidate_id=c.candidate_id;
  SELECT count(*) INTO live_count FROM (
    SELECT i.canonical_object_id FROM control.canonical_source_identity i JOIN hub.canonical_customer x ON (x.tenant_id,x.id)=(i.tenant_key,i.customer_id)
      WHERE c.entity='customer' AND i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=c.entity AND x.deleted_at IS NULL
    UNION ALL
    SELECT i.canonical_object_id FROM control.canonical_source_identity i JOIN hub.canonical_order x ON (x.tenant_id,x.id)=(i.tenant_key,i.order_id)
      WHERE c.entity='order' AND i.tenant_key=p_tenant_key AND i.source_id=p_source_id AND i.entity=c.entity AND x.deleted_at IS NULL
  ) live_members;
  IF seen_count IS DISTINCT FROM c.baseline_count OR digest_value IS DISTINCT FROM c.baseline_membership_digest
     OR live_count IS DISTINCT FROM c.baseline_count-own_count THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_delete_candidate_member m
    LEFT JOIN control.etl_snapshot_delete_effect e ON (e.candidate_id,e.entity,e.source_pk)=(m.candidate_id,m.entity,m.source_pk)
    LEFT JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id)=
      (m.tenant_key,m.source_id,m.entity,m.source_pk,m.canonical_object_id)
    WHERE m.candidate_id=c.candidate_id AND (
      (e.candidate_id IS NULL AND (i.canonical_object_id IS NULL OR
        (m.entity='customer' AND NOT EXISTS(SELECT 1 FROM hub.canonical_customer x WHERE (x.tenant_id,x.id)=(i.tenant_key,i.customer_id) AND x.deleted_at IS NULL)) OR
        (m.entity='order' AND NOT EXISTS(SELECT 1 FROM hub.canonical_order x WHERE (x.tenant_id,x.id)=(i.tenant_key,i.order_id) AND x.deleted_at IS NULL)) OR
        m.sequence_value<=coalesce((SELECT vr.source_version FROM control.source_version_receipt vr WHERE vr.tenant_key=m.tenant_key AND vr.source_id=m.source_id
          AND vr.channel_id=(r.entity_channel_proof->m.entity->>'channel_id')::uuid AND vr.entity=m.entity AND vr.source_pk=m.source_pk),-1)))
      OR (e.candidate_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM control.source_version_receipt vr JOIN control.canonical_apply_outbox ob
        ON ob.id=e.outbox_id AND ob.operation='DELETE' AND ob.source_content_digest=e.source_content_digest
        WHERE vr.tenant_key=e.tenant_key AND vr.source_id=e.source_id AND vr.entity=e.entity AND vr.source_pk=e.source_pk
          AND vr.channel_id=e.channel_id AND vr.source_version=e.sequence_value AND vr.deleted AND vr.canonical_object_id=e.canonical_object_id
          AND vr.source_content_digest=e.source_content_digest)))
  ) THEN RETURN false; END IF;
  RETURN true;
END;
$body$;
ALTER FUNCTION control.etl_snapshot_delete_candidate_current_d3(text,text,uuid,boolean) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.etl_snapshot_delete_candidate_current_d3(text,text,uuid,boolean) FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

CREATE FUNCTION control.claim_etl_snapshot_delete_apply(p_tenant_key text,p_source_id text,p_claim_token uuid,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE d control.etl_snapshot_delete_run%ROWTYPE; c control.etl_snapshot_delete_candidate%ROWTYPE; result jsonb; delay_seconds integer;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  PERFORM control.lock_security_barrier_fence();
  IF NOT control.lock_etl_snapshot_source(p_tenant_key,p_source_id) THEN RETURN NULL; END IF;
  SELECT x.* INTO d FROM control.etl_snapshot_delete_run x
    WHERE x.tenant_key=p_tenant_key AND x.source_id=p_source_id AND x.status IN ('PENDING','AWAITING_OWNER','APPLYING')
      AND x.d_next_retry_at<=clock_timestamp()
      AND (x.status<>'APPLYING' OR x.d_lease_expires_at IS NULL OR x.d_lease_expires_at<=clock_timestamp())
      AND EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption cs WHERE cs.tenant_key=x.tenant_key AND cs.source_id=x.source_id AND cs.run_id=x.run_id)
    ORDER BY x.reservation_ordinal DESC LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF d.status='APPLYING' AND d.d_claim_token IS NOT NULL AND d.d_lease_expires_at<=clock_timestamp() AND d.d_start_count>0 THEN
    IF d.d_start_count>=4 THEN
      UPDATE control.etl_snapshot_delete_run SET status='FAILED',d_claim_token=NULL,d_lease_expires_at=NULL,
        d_next_retry_at='-infinity'::timestamptz,d_error_code='D_START_BUDGET_EXHAUSTED',updated_at=clock_timestamp()
        WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
      RETURN NULL;
    END IF;
    delay_seconds:=CASE d.d_start_count WHEN 1 THEN 5 WHEN 2 THEN 30 ELSE 120 END;
    UPDATE control.etl_snapshot_delete_run SET d_claim_token=NULL,d_lease_expires_at=NULL,
      d_next_retry_at=clock_timestamp()+make_interval(secs=>delay_seconds),d_error_code='D_WORKER_LEASE_EXPIRED',updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
    RETURN NULL;
  END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_delete_approval a
      JOIN control.etl_snapshot_delete_candidate cd ON cd.candidate_id=a.candidate_id
      JOIN control.source_registry sr ON (sr.tenant_key,sr.source_id)=(a.tenant_key,a.source_id)
      LEFT JOIN control.identity_binding b ON (b.issuer,b.subject,b.tenant_key,b.user_id)=
        (a.oidc_issuer,a.oidc_subject,a.approver_tenant_key,a.approver_user_id)
      LEFT JOIN control.auth_subject s ON (s.tenant_key,s.user_id)=(b.tenant_key,b.user_id)
      LEFT JOIN control.tenant t ON t.tenant_key=b.tenant_key
      WHERE cd.tenant_key=p_tenant_key AND cd.source_id=p_source_id AND cd.run_id=d.run_id
        AND control.etl_snapshot_delete_ratio_exceeds(cd.candidate_count,cd.baseline_count)
        AND (a.run_id<>d.run_id OR a.candidate_revision<>cd.candidate_revision OR a.candidate_digest<>cd.candidate_digest
          OR a.baseline_count<>cd.baseline_count OR a.baseline_membership_digest<>cd.baseline_membership_digest
          OR a.owner_user_id<>sr.data_owner_user_id OR a.owner_revision<>sr.owner_revision OR a.required_scope<>'source:approve'
          OR NOT coalesce(b.enabled,false) OR NOT coalesce(s.enabled,false) OR s.auth_epoch<>a.approver_auth_epoch
          OR NOT coalesce(s.management_scopes @> ARRAY['source:approve']::text[],false) OR NOT coalesce(t.enabled,false))) THEN
    UPDATE control.etl_snapshot_delete_run SET status='STALE',d_error_code='D_APPROVAL_AUTHORITY_STALE',updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
    RETURN NULL;
  END IF;
  IF d.above_threshold AND EXISTS(SELECT 1 FROM control.etl_snapshot_delete_candidate cd
      WHERE cd.tenant_key=p_tenant_key AND cd.source_id=p_source_id AND cd.run_id=d.run_id
        AND control.etl_snapshot_delete_ratio_exceeds(cd.candidate_count,cd.baseline_count)
        AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_approval a WHERE a.candidate_id=cd.candidate_id
          AND a.candidate_revision=cd.candidate_revision AND a.candidate_digest=cd.candidate_digest)) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM control.etl_run r WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id
      AND r.status IN ('QUEUED','SCANNING','VALIDATING','READY','APPLYING'))
    OR EXISTS(SELECT 1 FROM control.etl_snapshot_delete_run older WHERE older.tenant_key=p_tenant_key AND older.source_id=p_source_id
      AND older.reservation_ordinal<d.reservation_ordinal AND older.status='PENDING'
      AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_consumption cs WHERE cs.tenant_key=older.tenant_key AND cs.source_id=older.source_id AND cs.run_id=older.run_id))
    OR EXISTS(SELECT 1 FROM control.etl_snapshot_delete_run newer WHERE newer.tenant_key=p_tenant_key AND newer.source_id=p_source_id
      AND newer.reservation_ordinal>d.reservation_ordinal) THEN RETURN NULL; END IF;
  SELECT * INTO c FROM control.etl_snapshot_delete_candidate WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id
    ORDER BY entity COLLATE "C" LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT control.etl_snapshot_delete_candidate_current_d3(p_tenant_key,p_source_id,c.candidate_id,false) THEN
    UPDATE control.etl_snapshot_delete_run SET status='STALE',d_claim_token=NULL,d_lease_expires_at=NULL,d_error_code='D_CANDIDATE_STALE',updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
    RETURN NULL;
  END IF;
  INSERT INTO control.etl_snapshot_delete_operation(candidate_id,entity,source_pk)
    SELECT m.candidate_id,m.entity,m.source_pk FROM control.etl_snapshot_delete_candidate_member m
      JOIN control.etl_snapshot_delete_candidate cd ON cd.candidate_id=m.candidate_id
      WHERE cd.tenant_key=p_tenant_key AND cd.source_id=p_source_id AND cd.run_id=d.run_id
    ON CONFLICT(candidate_id,entity,source_pk) DO NOTHING;
  UPDATE control.etl_snapshot_delete_run SET status='APPLYING',d_claim_token=p_claim_token,
    d_lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),d_heartbeat_at=clock_timestamp(),d_error_code=NULL,updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=d.run_id;
  SELECT jsonb_build_object('tenant_key',p_tenant_key,'source_id',p_source_id,'run_id',d.run_id,'attempt_id',d.attempt_id,
      'claim_token',p_claim_token,'start_count',d.d_start_count,'lease_expires_at',to_char(clock_timestamp()+make_interval(secs=>p_lease_seconds),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) INTO result;
  RETURN result;
END;
$body$;
ALTER FUNCTION control.claim_etl_snapshot_delete_apply(text,text,uuid,integer) OWNER TO CURRENT_USER;

CREATE FUNCTION control.begin_etl_snapshot_delete_start(p_tenant_key text,p_source_id text,p_run_id uuid,p_claim_token uuid)
RETURNS smallint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE starts smallint;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  UPDATE control.etl_snapshot_delete_run SET d_start_count=d_start_count+1,d_next_retry_at='-infinity',updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND status='APPLYING'
      AND d_claim_token=p_claim_token AND d_lease_expires_at>clock_timestamp() AND d_start_count<4
    RETURNING d_start_count INTO starts;
  RETURN starts;
END;
$body$;

CREATE FUNCTION control.heartbeat_etl_snapshot_delete_apply(p_tenant_key text,p_source_id text,p_run_id uuid,p_claim_token uuid,p_lease_seconds integer DEFAULT 60)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN RETURN false; END IF;
  PERFORM control.lock_security_barrier_fence();
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  UPDATE control.etl_snapshot_delete_run SET d_lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    d_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND status='APPLYING'
      AND d_claim_token=p_claim_token AND d_lease_expires_at>clock_timestamp();
  RETURN FOUND;
END;
$body$;

CREATE FUNCTION control.load_etl_snapshot_delete_apply_proof(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE result jsonb;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker'
    OR NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_run d WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id
      AND d.run_id=p_run_id AND d.attempt_id=p_attempt_id AND d.status='APPLYING' AND d.d_claim_token=p_claim_token AND d.d_lease_expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM control.etl_run r JOIN control.etl_snapshot_manifest sm
      ON (sm.tenant_key,sm.source_id,sm.run_id,sm.attempt_id)=(r.tenant_key,r.source_id,r.run_id,p_attempt_id) AND sm.state='EXTRACTED'
      JOIN control.etl_snapshot_validation v ON (v.tenant_key,v.source_id,v.run_id,v.attempt_id,v.manifest_digest)=
        (sm.tenant_key,sm.source_id,sm.run_id,sm.attempt_id,sm.manifest_digest)
      WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id AND r.run_id=p_run_id AND r.status='COMPLETE') THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('tenant_key',r.tenant_key,'source_id',r.source_id,'run_id',r.run_id,'attempt_id',p_attempt_id,'status',r.status,
    'expected_entities',r.expected_entities,'credential_id',r.credential_id,'credential_revision',r.credential_revision,
    'credential_generation',r.credential_generation,'admission_source_epoch',r.admission_source_epoch,'entity_channel_proof',r.entity_channel_proof,
    'config_revision',r.config_revision,'config_digest',encode(r.config_digest,'hex'),'config',c.config,'mapping_revision',r.mapping_revision,
    'mapping_digest',encode(r.mapping_digest,'hex'),'mappings',m.mappings,'identity_mapping_revision',r.identity_mapping_revision,
    'identity_mapping_digest',encode(r.identity_mapping_digest,'hex'),'identity_mappings',i.mappings,
    'endpoint_profile_digest',encode(r.endpoint_profile_digest,'hex'),'test_report_id',r.test_report_id,'approval_id',r.approval_id,
    'data_contract_ref',r.data_contract_ref,'delete_contract',r.delete_contract,'security_barrier_fence',r.security_barrier_fence,
    'owner_user_id',r.owner_user_id,'owner_revision',r.owner_revision,
    'manifest',jsonb_build_object('manifest',sm.manifest,'digest',encode(sm.manifest_digest,'hex')),
    'completed_at',to_char(r.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'validation',jsonb_build_object('proof_scope_digest',encode(v.proof_scope_digest,'hex'),'semantic_digest',encode(v.semantic_digest,'hex'),'coverage',v.coverage))
    INTO result FROM control.etl_run r JOIN control.source_config_revision c
      ON (c.tenant_key,c.source_id,c.revision,c.config_digest)=(r.tenant_key,r.source_id,r.config_revision,r.config_digest)
    JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision,m.mapping_digest)=(r.tenant_key,r.source_id,r.mapping_revision,r.mapping_digest)
    JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision,i.mapping_digest)=(r.tenant_key,r.source_id,r.identity_mapping_revision,r.identity_mapping_digest)
    JOIN control.source_owner_approval a ON (a.id,a.tenant_key,a.source_id,a.owner_user_id,a.owner_revision,a.config_revision,a.mapping_revision,
      a.identity_mapping_revision,a.test_report_id)=(r.approval_id,r.tenant_key,r.source_id,r.owner_user_id,r.owner_revision,r.config_revision,
      r.mapping_revision,r.identity_mapping_revision,r.test_report_id)
    JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id,t.config_revision,t.mapping_revision,t.identity_mapping_revision)=
      (r.test_report_id,r.tenant_key,r.source_id,r.config_revision,r.mapping_revision,r.identity_mapping_revision) AND t.status='PASS'
    JOIN control.etl_snapshot_manifest sm ON (sm.tenant_key,sm.source_id,sm.run_id,sm.attempt_id)=(r.tenant_key,r.source_id,r.run_id,p_attempt_id) AND sm.state='EXTRACTED'
    JOIN control.etl_snapshot_validation v ON (v.tenant_key,v.source_id,v.run_id,v.attempt_id)=(r.tenant_key,r.source_id,r.run_id,p_attempt_id)
    WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id AND r.run_id=p_run_id AND r.status='COMPLETE';
  RETURN result;
END;
$body$;

CREATE FUNCTION control.list_etl_snapshot_delete_apply_members(p_tenant_key text,p_source_id text,p_run_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE result jsonb;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker'
    OR NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_run d WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id
      AND d.run_id=p_run_id AND d.status='APPLYING' AND d.d_claim_token=p_claim_token AND d.d_lease_expires_at>clock_timestamp()) THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('candidate_id',c.candidate_id,'entity',c.entity,'candidate_revision',c.candidate_revision,
      'candidate_digest',encode(c.candidate_digest,'hex'),'baseline_count',c.baseline_count,'candidate_count',c.candidate_count,
      'above_threshold',control.etl_snapshot_delete_ratio_exceeds(c.candidate_count,c.baseline_count),
      'members',coalesce((SELECT jsonb_agg(jsonb_build_object('source_pk',m.source_pk,'canonical_object_id',m.canonical_object_id,
        'sequence_value',m.sequence_value::text,'inferred_completed_at',to_char(m.inferred_completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'operation_id',o.operation_id,'applied',e.candidate_id IS NOT NULL) ORDER BY m.source_pk COLLATE "C")
        FROM control.etl_snapshot_delete_candidate_member m JOIN control.etl_snapshot_delete_operation o USING(candidate_id,entity,source_pk)
        LEFT JOIN control.etl_snapshot_delete_effect e USING(candidate_id,entity,source_pk)
        WHERE m.candidate_id=c.candidate_id),'[]'::jsonb)) ORDER BY c.entity),'[]'::jsonb) INTO result
    FROM control.etl_snapshot_delete_candidate c WHERE c.tenant_key=p_tenant_key AND c.source_id=p_source_id AND c.run_id=p_run_id;
  RETURN result;
END;
$body$;

CREATE FUNCTION control.check_etl_snapshot_delete_apply_current(p_tenant_key text,p_source_id text,p_run_id uuid,p_candidate_id uuid,
  p_claim_token uuid,p_require_approval boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE d control.etl_snapshot_delete_run%ROWTYPE; c control.etl_snapshot_delete_candidate%ROWTYPE; owner_row record; approval control.etl_snapshot_delete_approval%ROWTYPE;
  subject_row record; tenant_row record; binding_row record; owner_subject_enabled boolean;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' THEN RETURN false; END IF;
  PERFORM control.lock_security_barrier_fence();
  IF NOT control.lock_etl_snapshot_source(p_tenant_key,p_source_id) THEN RETURN false; END IF;
  SELECT * INTO d FROM control.etl_snapshot_delete_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR d.status<>'APPLYING' OR p_claim_token IS NULL OR d.d_claim_token IS NULL
    OR d.d_claim_token<>p_claim_token OR d.d_lease_expires_at IS NULL OR d.d_lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
  SELECT * INTO c FROM control.etl_snapshot_delete_candidate WHERE candidate_id=p_candidate_id AND tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR NOT control.etl_snapshot_delete_candidate_current_d3(p_tenant_key,p_source_id,p_candidate_id,false) THEN RETURN false; END IF;
  SELECT r.data_owner_user_id,r.owner_revision,r.lifecycle INTO owner_row FROM control.source_registry r
    WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id FOR UPDATE;
  IF NOT FOUND OR owner_row.data_owner_user_id IS DISTINCT FROM c.stable_scope_json->'proof'->>'owner_user_id'
    OR owner_row.owner_revision::text IS DISTINCT FROM c.stable_scope_json->'proof'->>'owner_revision' THEN RETURN false; END IF;
  SELECT s.enabled INTO owner_subject_enabled FROM control.auth_subject s
    WHERE s.tenant_key=p_tenant_key AND s.user_id=owner_row.data_owner_user_id FOR UPDATE;
  IF NOT FOUND OR NOT owner_subject_enabled THEN RETURN false; END IF;
  IF NOT control.etl_snapshot_delete_ratio_exceeds(c.candidate_count,c.baseline_count) THEN RETURN true; END IF;
  SELECT * INTO approval FROM control.etl_snapshot_delete_approval WHERE candidate_id=p_candidate_id AND candidate_revision=c.candidate_revision FOR UPDATE;
  IF NOT FOUND THEN RETURN NOT p_require_approval; END IF;
  IF approval.run_id<>p_run_id OR approval.candidate_digest<>c.candidate_digest OR approval.baseline_count<>c.baseline_count
    OR approval.baseline_membership_digest<>c.baseline_membership_digest OR approval.owner_user_id<>owner_row.data_owner_user_id
    OR approval.owner_revision<>owner_row.owner_revision OR approval.required_scope<>'source:approve' THEN RETURN false; END IF;
  SELECT b.enabled,s.enabled AS subject_enabled,s.auth_epoch,s.management_scopes,t.enabled AS tenant_enabled
    INTO binding_row FROM control.identity_binding b JOIN control.auth_subject s USING(tenant_key,user_id)
    JOIN control.tenant t USING(tenant_key) WHERE b.issuer=approval.oidc_issuer AND b.subject=approval.oidc_subject
      AND b.tenant_key=approval.approver_tenant_key AND b.user_id=approval.approver_user_id FOR UPDATE OF b,s,t;
  IF NOT FOUND OR NOT binding_row.enabled OR NOT binding_row.subject_enabled OR NOT binding_row.tenant_enabled
    OR binding_row.auth_epoch<>approval.approver_auth_epoch OR NOT (binding_row.management_scopes @> ARRAY['source:approve']::text[]) THEN RETURN false; END IF;
  RETURN true;
END;
$body$;

CREATE FUNCTION control.preflight_etl_snapshot_delete_apply_candidate(p_tenant_key text,p_source_id text,p_run_id uuid,p_candidate_id uuid,
  p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' THEN RETURN false; END IF;
  RETURN control.check_etl_snapshot_delete_apply_current(p_tenant_key,p_source_id,p_run_id,p_candidate_id,p_claim_token,true);
END;
$body$;

CREATE FUNCTION control.record_etl_snapshot_delete_effect(p_tenant_key text,p_source_id text,p_run_id uuid,p_candidate_id uuid,
  p_entity text,p_source_pk text,p_claim_token uuid,p_apply_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub
AS $body$
DECLARE d control.etl_snapshot_delete_run%ROWTYPE; m control.etl_snapshot_delete_candidate_member%ROWTYPE;
  c control.etl_snapshot_delete_candidate%ROWTYPE; operation uuid; channel uuid; receipt record; effect_deleted_at timestamptz; outbox_id bigint;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' OR p_apply_status<>'APPLIED' THEN
    RAISE EXCEPTION 'D_EFFECT_OUTCOME_REJECTED' USING ERRCODE='55000';
  END IF;
  PERFORM control.lock_security_barrier_fence();
  IF NOT control.lock_etl_snapshot_source(p_tenant_key,p_source_id) THEN RETURN false; END IF;
  SELECT * INTO d FROM control.etl_snapshot_delete_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR d.status<>'APPLYING' OR p_claim_token IS NULL OR d.d_claim_token IS NULL
    OR d.d_claim_token<>p_claim_token OR d.d_lease_expires_at IS NULL OR d.d_lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
  SELECT * INTO c FROM control.etl_snapshot_delete_candidate WHERE candidate_id=p_candidate_id AND tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  SELECT * INTO m FROM control.etl_snapshot_delete_candidate_member WHERE candidate_id=p_candidate_id AND entity=p_entity AND source_pk=p_source_pk FOR UPDATE;
  SELECT operation_id INTO operation FROM control.etl_snapshot_delete_operation WHERE candidate_id=p_candidate_id AND entity=p_entity AND source_pk=p_source_pk;
  IF NOT FOUND OR m.canonical_object_id IS NULL OR operation IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_delete_effect WHERE candidate_id=p_candidate_id AND entity=p_entity AND source_pk=p_source_pk) THEN
    RETURN EXISTS(SELECT 1 FROM control.etl_snapshot_delete_effect e WHERE e.candidate_id=p_candidate_id AND e.entity=p_entity AND e.source_pk=p_source_pk
      AND e.operation_id=operation AND e.canonical_object_id=m.canonical_object_id AND e.sequence_value=m.sequence_value);
  END IF;
  channel:=(SELECT (r.entity_channel_proof->p_entity->>'channel_id')::uuid FROM control.etl_run r
    WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id AND r.run_id=p_run_id);
  SELECT vr.canonical_object_id,vr.source_version,vr.source_content_digest,vr.projection_digest,vr.apply_xid,
      ob.id AS outbox_id,ob.hub_revision
    INTO receipt FROM control.source_version_receipt vr JOIN control.canonical_apply_outbox ob
      ON (ob.tenant_key,ob.source_id,ob.channel_id,ob.entity,ob.canonical_object_id,ob.operation,ob.apply_xid,ob.source_content_digest,ob.projection_digest)=
         (vr.tenant_key,vr.source_id,vr.channel_id,vr.entity,vr.canonical_object_id,'DELETE',vr.apply_xid,vr.source_content_digest,vr.projection_digest)
    WHERE vr.tenant_key=p_tenant_key AND vr.source_id=p_source_id AND vr.channel_id=channel AND vr.entity=p_entity
      AND vr.source_pk=p_source_pk AND vr.canonical_object_id=m.canonical_object_id AND vr.source_version=m.sequence_value AND vr.deleted
    ORDER BY ob.id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT r.completed_at INTO effect_deleted_at FROM control.etl_run r WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id AND r.run_id=p_run_id;
  IF (p_entity='customer' AND NOT EXISTS(SELECT 1 FROM hub.canonical_customer x WHERE (x.tenant_id,x.id)=(p_tenant_key,m.canonical_object_id) AND x.deleted_at=effect_deleted_at))
    OR (p_entity='order' AND NOT EXISTS(SELECT 1 FROM hub.canonical_order x WHERE (x.tenant_id,x.id)=(p_tenant_key,m.canonical_object_id) AND x.deleted_at=effect_deleted_at)) THEN
    RETURN false;
  END IF;
  INSERT INTO control.etl_snapshot_delete_effect(candidate_id,entity,source_pk,tenant_key,source_id,run_id,operation_id,canonical_object_id,
    channel_id,sequence_value,inferred_deleted_at,source_content_digest,projection_digest,hub_revision,outbox_id,start_count,claim_token)
  VALUES(p_candidate_id,p_entity,p_source_pk,p_tenant_key,p_source_id,p_run_id,operation,m.canonical_object_id,channel,m.sequence_value,effect_deleted_at,
    receipt.source_content_digest,receipt.projection_digest,receipt.hub_revision,receipt.outbox_id,d.d_start_count,p_claim_token);
  IF NOT control.check_etl_snapshot_delete_apply_current(p_tenant_key,p_source_id,p_run_id,p_candidate_id,p_claim_token,true) THEN RETURN false; END IF;
  RETURN true;
END;
$body$;

CREATE FUNCTION control.finish_etl_snapshot_delete_apply(p_tenant_key text,p_source_id text,p_run_id uuid,p_claim_token uuid,p_status text,p_error_code text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE d control.etl_snapshot_delete_run%ROWTYPE; missing boolean;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' OR p_status NOT IN ('COMPLETE','STALE','FAILED') THEN RETURN 'STALE'; END IF;
  PERFORM control.lock_security_barrier_fence();
  IF NOT control.lock_etl_snapshot_source(p_tenant_key,p_source_id) THEN RETURN 'STALE'; END IF;
  SELECT * INTO d FROM control.etl_snapshot_delete_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR d.status<>'APPLYING' OR p_claim_token IS NULL OR d.d_claim_token IS NULL
    OR d.d_claim_token<>p_claim_token OR d.d_lease_expires_at IS NULL OR d.d_lease_expires_at<=clock_timestamp() THEN RETURN 'STALE'; END IF;
  IF p_status='COMPLETE' THEN
    SELECT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_candidate_member m JOIN control.etl_snapshot_delete_candidate c USING(candidate_id)
      WHERE c.tenant_key=p_tenant_key AND c.source_id=p_source_id AND c.run_id=p_run_id
        AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_delete_effect e WHERE (e.candidate_id,e.entity,e.source_pk)=(m.candidate_id,m.entity,m.source_pk)))
      INTO missing;
    IF missing THEN RAISE EXCEPTION 'D_EFFECTS_INCOMPLETE' USING ERRCODE='55000'; END IF;
  END IF;
  IF p_status='COMPLETE' AND EXISTS(SELECT 1 FROM control.etl_snapshot_delete_candidate c WHERE c.tenant_key=p_tenant_key AND c.source_id=p_source_id
      AND c.run_id=p_run_id AND NOT control.etl_snapshot_delete_candidate_current_d3(p_tenant_key,p_source_id,c.candidate_id,true)) THEN
    p_status:='STALE'; p_error_code:='D_CANDIDATE_STALE';
  END IF;
  UPDATE control.etl_snapshot_delete_run SET status=p_status,d_claim_token=NULL,d_lease_expires_at=NULL,d_error_code=p_error_code,
    d_next_retry_at='-infinity'::timestamptz,updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  RETURN p_status;
END;
$body$;

CREATE FUNCTION control.retry_etl_snapshot_delete_apply(p_tenant_key text,p_source_id text,p_run_id uuid,p_claim_token uuid,p_error_code text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE d control.etl_snapshot_delete_run%ROWTYPE; delay_seconds integer;
BEGIN
  IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_worker' OR p_error_code !~ '^[A-Z0-9_]{1,80}$' THEN RETURN 'STALE'; END IF;
  PERFORM control.lock_security_barrier_fence();
  IF NOT control.lock_etl_snapshot_source(p_tenant_key,p_source_id) THEN RETURN 'STALE'; END IF;
  SELECT * INTO d FROM control.etl_snapshot_delete_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR d.status<>'APPLYING' OR p_claim_token IS NULL OR d.d_claim_token IS NULL
    OR d.d_claim_token<>p_claim_token OR d.d_lease_expires_at IS NULL OR d.d_lease_expires_at<=clock_timestamp() THEN RETURN 'STALE'; END IF;
  IF d.d_start_count>=4 THEN
    UPDATE control.etl_snapshot_delete_run SET status='FAILED',d_claim_token=NULL,d_lease_expires_at=NULL,d_error_code=p_error_code,updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
    RETURN 'FAILED';
  END IF;
  delay_seconds:=CASE d.d_start_count WHEN 1 THEN 5 WHEN 2 THEN 30 ELSE 120 END;
  UPDATE control.etl_snapshot_delete_run SET d_claim_token=NULL,d_lease_expires_at=clock_timestamp(),d_next_retry_at=clock_timestamp()+make_interval(secs=>delay_seconds),
    d_error_code=p_error_code,updated_at=clock_timestamp() WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  RETURN 'RETRY_PENDING';
END;
$body$;

REVOKE ALL ON FUNCTION control.claim_etl_snapshot_delete_apply(text,text,uuid,integer),
  control.begin_etl_snapshot_delete_start(text,text,uuid,uuid),control.heartbeat_etl_snapshot_delete_apply(text,text,uuid,uuid,integer),
  control.load_etl_snapshot_delete_apply_proof(text,text,uuid,uuid,uuid),control.list_etl_snapshot_delete_apply_members(text,text,uuid,uuid),
  control.check_etl_snapshot_delete_apply_current(text,text,uuid,uuid,uuid,boolean),
  control.preflight_etl_snapshot_delete_apply_candidate(text,text,uuid,uuid,uuid),
  control.record_etl_snapshot_delete_effect(text,text,uuid,uuid,text,text,uuid,text),
  control.finish_etl_snapshot_delete_apply(text,text,uuid,uuid,text,text),
  control.retry_etl_snapshot_delete_apply(text,text,uuid,uuid,text) FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.claim_etl_snapshot_delete_apply(text,text,uuid,integer),
  control.begin_etl_snapshot_delete_start(text,text,uuid,uuid),control.heartbeat_etl_snapshot_delete_apply(text,text,uuid,uuid,integer),
  control.load_etl_snapshot_delete_apply_proof(text,text,uuid,uuid,uuid),control.list_etl_snapshot_delete_apply_members(text,text,uuid,uuid),
  control.preflight_etl_snapshot_delete_apply_candidate(text,text,uuid,uuid,uuid),
  control.record_etl_snapshot_delete_effect(text,text,uuid,uuid,text,text,uuid,text),
  control.finish_etl_snapshot_delete_apply(text,text,uuid,uuid,text,text),
  control.retry_etl_snapshot_delete_apply(text,text,uuid,uuid,text) TO hub_worker;

-- M1-5E1a1 API-022 immutable recovery linkage.
ALTER TABLE control.etl_run DROP CONSTRAINT etl_run_request_route_check;
ALTER TABLE control.etl_run ADD CONSTRAINT etl_run_request_route_check CHECK (request_route IN ('API-019','API-022','DUE_GATE'));
ALTER TABLE control.etl_run ADD COLUMN failure_version bigint NOT NULL DEFAULT 0 CHECK (failure_version>=0);
UPDATE control.etl_run SET failure_version=1 WHERE status IN ('FAILED','INCOMPLETE');
ALTER TABLE control.etl_run ADD COLUMN recovery_operation_id uuid;
ALTER TABLE control.etl_run ADD COLUMN recovery_lineage_root_run_id uuid;
ALTER TABLE control.etl_run ADD COLUMN recovery_parent_run_id uuid;
ALTER TABLE control.etl_run ADD COLUMN recovery_original_run_id uuid;
ALTER TABLE control.etl_run ADD COLUMN recovery_original_attempt_id uuid;
ALTER TABLE control.etl_run ADD COLUMN recovery_mode text CHECK (recovery_mode IS NULL OR recovery_mode IN ('FRESH_SCAN','SEALED_STAGE'));
ALTER TABLE control.etl_run ADD COLUMN recovery_source_manifest_digest bytea CHECK (recovery_source_manifest_digest IS NULL OR octet_length(recovery_source_manifest_digest)=32);
ALTER TABLE control.etl_run ADD CONSTRAINT etl_run_recovery_tuple_check CHECK (
  (recovery_operation_id IS NULL AND recovery_lineage_root_run_id IS NULL AND recovery_parent_run_id IS NULL AND
   recovery_original_run_id IS NULL AND recovery_original_attempt_id IS NULL AND recovery_mode IS NULL AND recovery_source_manifest_digest IS NULL)
  OR (recovery_operation_id IS NOT NULL AND recovery_lineage_root_run_id IS NOT NULL AND recovery_parent_run_id IS NOT NULL AND
   recovery_original_run_id IS NOT NULL AND recovery_original_attempt_id IS NOT NULL AND recovery_mode IS NOT NULL));
CREATE TABLE control.etl_snapshot_recovery_operation (
  operation_id uuid PRIMARY KEY,
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  route text NOT NULL DEFAULT 'API-022' CHECK (route='API-022'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  lineage_root_run_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  original_run_id uuid NOT NULL,
  original_attempt_id uuid NOT NULL,
  original_failure_version bigint NOT NULL CHECK (original_failure_version>0),
  original_manifest_digest bytea CHECK (original_manifest_digest IS NULL OR octet_length(original_manifest_digest)=32),
  original_proof_scope_digest bytea CHECK (original_proof_scope_digest IS NULL OR octet_length(original_proof_scope_digest)=32),
  original_semantic_digest bytea CHECK (original_semantic_digest IS NULL OR octet_length(original_semantic_digest)=32),
  recovery_mode text NOT NULL CHECK (recovery_mode IN ('FRESH_SCAN','SEALED_STAGE')),
  child_run_id uuid NOT NULL,
  child_attempt_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason)>0 AND char_length(reason)<=1000),
  initiator_issuer text NOT NULL,
  initiator_subject text NOT NULL,
  initiator_tenant text NOT NULL,
  initiator_user_id text NOT NULL,
  initiator_auth_epoch bigint NOT NULL CHECK (initiator_auth_epoch>=0),
  initiator_scopes text[] NOT NULL CHECK ('source:write'=ANY(initiator_scopes)),
  request_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_key,source_id,route,idempotency_key),
  UNIQUE(tenant_key,source_id,child_run_id),
  UNIQUE(tenant_key,source_id,parent_run_id),
  FOREIGN KEY(tenant_key,source_id,lineage_root_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,parent_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,original_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(original_attempt_id) REFERENCES control.etl_run_attempt(attempt_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,child_run_id) REFERENCES control.etl_run(tenant_key,source_id,run_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(child_attempt_id) REFERENCES control.etl_run_attempt(attempt_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE control.etl_run ADD CONSTRAINT etl_run_recovery_operation_fk FOREIGN KEY(recovery_operation_id)
  REFERENCES control.etl_snapshot_recovery_operation(operation_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION control.guard_etl_run_failure_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.failure_version:=CASE WHEN NEW.status IN ('FAILED','INCOMPLETE') THEN GREATEST(NEW.failure_version,1) ELSE 0 END;
    RETURN NEW;
  END IF;
  IF NEW.recovery_operation_id IS DISTINCT FROM OLD.recovery_operation_id OR
     NEW.recovery_lineage_root_run_id IS DISTINCT FROM OLD.recovery_lineage_root_run_id OR
     NEW.recovery_parent_run_id IS DISTINCT FROM OLD.recovery_parent_run_id OR
     NEW.recovery_original_run_id IS DISTINCT FROM OLD.recovery_original_run_id OR
     NEW.recovery_original_attempt_id IS DISTINCT FROM OLD.recovery_original_attempt_id OR
     NEW.recovery_mode IS DISTINCT FROM OLD.recovery_mode OR
     NEW.recovery_source_manifest_digest IS DISTINCT FROM OLD.recovery_source_manifest_digest THEN
    RAISE EXCEPTION 'immutable snapshot recovery lineage' USING ERRCODE='55000';
  END IF;
  IF NEW.status IN ('FAILED','INCOMPLETE') AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.failure_version:=OLD.failure_version+1;
  ELSE
    NEW.failure_version:=OLD.failure_version;
  END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER etl_run_failure_version BEFORE INSERT OR UPDATE ON control.etl_run
FOR EACH ROW EXECUTE FUNCTION control.guard_etl_run_failure_version();

CREATE FUNCTION control.reject_etl_snapshot_recovery_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
BEGIN
  RAISE EXCEPTION 'immutable snapshot recovery operation' USING ERRCODE='55000';
END;
$body$;
CREATE TRIGGER etl_snapshot_recovery_immutable BEFORE UPDATE OR DELETE ON control.etl_snapshot_recovery_operation
FOR EACH ROW EXECUTE FUNCTION control.reject_etl_snapshot_recovery_mutation();

REVOKE ALL ON control.etl_snapshot_recovery_operation FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.guard_etl_run_failure_version(),control.reject_etl_snapshot_recovery_mutation()
  FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT SELECT(failure_version,recovery_operation_id,recovery_lineage_root_run_id,recovery_parent_run_id,recovery_original_run_id,
  recovery_original_attempt_id,recovery_mode,recovery_source_manifest_digest) ON control.etl_run TO hub_worker;
GRANT INSERT(recovery_operation_id,recovery_lineage_root_run_id,recovery_parent_run_id,recovery_original_run_id,
  recovery_original_attempt_id,recovery_mode,recovery_source_manifest_digest) ON control.etl_run TO hub_worker;
GRANT UPDATE(failure_version) ON control.etl_run TO hub_worker;
GRANT SELECT(failure_version,recovery_operation_id,recovery_lineage_root_run_id,recovery_parent_run_id,recovery_original_run_id,
  recovery_original_attempt_id,recovery_mode,recovery_source_manifest_digest) ON control.etl_run TO hub_api;

CREATE FUNCTION control.create_etl_snapshot_manual_recovery(p_tenant_key text,p_original_run_id uuid,p_failed_version bigint,
  p_idempotency_key text,p_request_digest bytea,p_reason text,p_issuer text,p_subject text,p_user_id text,p_auth_epoch bigint,
  p_scopes text[],p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE original control.etl_run%ROWTYPE; latest_attempt control.etl_run_attempt%ROWTYPE; manifest_row control.etl_snapshot_manifest%ROWTYPE;
  validation_row control.etl_snapshot_validation%ROWTYPE; lineage uuid; mode_value text; operation uuid:=gen_random_uuid(); child uuid:=gen_random_uuid();
  child_attempt uuid:=gen_random_uuid(); child_attempt_operation uuid:=gen_random_uuid(); old_operation control.etl_snapshot_recovery_operation%ROWTYPE;
  item record; source_enabled boolean; tenant_enabled boolean; channel_id uuid;
BEGIN
  IF p_request_digest IS NULL OR octet_length(p_request_digest)<>32
    OR p_failed_version IS NULL OR p_failed_version<1 OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,160}$'
    OR p_reason IS NULL OR btrim(p_reason)='' OR char_length(p_reason)>1000 OR p_auth_epoch IS NULL OR p_auth_epoch<0
    OR p_request_id IS NULL OR p_issuer IS NULL OR p_subject IS NULL OR p_user_id IS NULL OR NOT ('source:write'=ANY(p_scopes)) THEN
    RAISE EXCEPTION 'AUTH_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM control.lock_security_barrier_fence();
  SELECT * INTO original FROM control.etl_run WHERE tenant_key=p_tenant_key AND run_id=p_original_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  PERFORM 1 FROM control.lock_source_credential(p_tenant_key,original.source_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF NOT control.lock_etl_snapshot_source(p_tenant_key,original.source_id) THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT c.enabled,t.enabled INTO source_enabled,tenant_enabled FROM control.source_credential c JOIN control.tenant t USING(tenant_key)
    WHERE c.tenant_key=p_tenant_key AND c.source_id=original.source_id FOR UPDATE OF c,t;
  IF NOT FOUND OR NOT source_enabled OR NOT tenant_enabled THEN RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  FOR item IN SELECT key,value FROM jsonb_each(original.entity_channel_proof) ORDER BY key LOOP
    channel_id:=(item.value->>'channel_id')::uuid;
    PERFORM 1 FROM control.source_channel WHERE id=channel_id AND tenant_key=p_tenant_key AND source_id=original.source_id
      AND entity=item.key AND state='active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=p_tenant_key
    AND b.effective_fence>original.security_barrier_fence AND (b.source_id IS NULL OR b.source_id=original.source_id)
    AND (b.credential_id IS NULL OR b.credential_id=original.credential_id)
    AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')
    AND ((b.entity IS NULL AND b.channel_id IS NULL) OR EXISTS(SELECT 1 FROM jsonb_each(original.entity_channel_proof) e
      WHERE (b.entity IS NULL OR e.key=b.entity) AND (b.channel_id IS NULL OR e.value->>'channel_id'=b.channel_id::text)))) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO old_operation FROM control.etl_snapshot_recovery_operation WHERE tenant_key=p_tenant_key AND source_id=original.source_id
    AND route='API-022' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF old_operation.request_digest<>p_request_digest THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('operation_id',old_operation.operation_id,'original_run_id',old_operation.original_run_id,
      'run_id',old_operation.child_run_id,'attempt_id',old_operation.child_attempt_id,'recovery_mode',old_operation.recovery_mode,
      'status','QUEUED','replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM control.etl_snapshot_recovery_operation prior
      WHERE prior.tenant_key=p_tenant_key AND prior.source_id=original.source_id AND prior.route='API-022'
        AND prior.parent_run_id=original.run_id) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF original.status NOT IN ('FAILED','INCOMPLETE') OR p_failed_version<>original.failure_version THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF EXISTS(SELECT 1 FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=original.source_id
      AND status IN ('QUEUED','SCANNING','VALIDATING','READY','APPLYING')) OR control.etl_snapshot_source_delete_busy(p_tenant_key,original.source_id) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF EXISTS(SELECT 1 FROM control.etl_run_attempt a WHERE a.run_id=original.run_id AND
       (a.status='RUNNING' AND a.lease_expires_at>clock_timestamp())) OR EXISTS(
    SELECT 1 FROM control.etl_snapshot_continuation c WHERE c.run_id=original.run_id AND c.claim_token IS NOT NULL AND c.lease_until>clock_timestamp()) THEN
    RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO latest_attempt FROM control.etl_run_attempt WHERE run_id=original.run_id ORDER BY ordinal DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT * INTO manifest_row FROM control.etl_snapshot_manifest WHERE tenant_key=p_tenant_key AND source_id=original.source_id
    AND run_id=original.run_id AND attempt_id=latest_attempt.attempt_id AND state='EXTRACTED';
  IF FOUND THEN
    SELECT * INTO validation_row FROM control.etl_snapshot_validation WHERE tenant_key=p_tenant_key AND source_id=original.source_id
      AND run_id=original.run_id AND attempt_id=latest_attempt.attempt_id AND manifest_digest=manifest_row.manifest_digest;
  END IF;
  IF FOUND AND (SELECT config->>'version_domain' FROM control.source_config_revision WHERE tenant_key=p_tenant_key
      AND source_id=original.source_id AND revision=original.config_revision AND config_digest=original.config_digest)='SNAPSHOT_OBSERVATION'
      AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_observation WHERE tenant_key=p_tenant_key AND source_id=original.source_id AND run_id=original.run_id) THEN
    validation_row:=NULL; manifest_row:=NULL;
  END IF;
  mode_value:=CASE WHEN manifest_row.manifest_digest IS NOT NULL AND validation_row.manifest_digest IS NOT NULL THEN 'SEALED_STAGE' ELSE 'FRESH_SCAN' END;
  SELECT COALESCE(parent.recovery_lineage_root_run_id,original.run_id) INTO lineage FROM control.etl_run parent
    WHERE parent.tenant_key=p_tenant_key AND parent.run_id=original.run_id;
  INSERT INTO control.etl_run(tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,request_digest,status,
    credential_id,credential_revision,credential_generation,source_epoch,admission_source_epoch,expected_entities,entity_channel_proof,
    config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,
    test_report_id,approval_id,data_contract_ref,delete_contract,security_barrier_fence,owner_user_id,owner_revision,
    recovery_operation_id,recovery_lineage_root_run_id,recovery_parent_run_id,recovery_original_run_id,recovery_original_attempt_id,
    recovery_mode,recovery_source_manifest_digest)
  VALUES(p_tenant_key,original.source_id,'FULL_SNAPSHOT','MANUAL','API-022',p_idempotency_key,p_request_digest,'QUEUED',
    original.credential_id,original.credential_revision,original.credential_generation,original.source_epoch,original.admission_source_epoch,
    original.expected_entities,original.entity_channel_proof,original.config_revision,original.config_digest,original.mapping_revision,
    original.mapping_digest,original.identity_mapping_revision,original.identity_mapping_digest,original.endpoint_profile_digest,
    original.test_report_id,original.approval_id,original.data_contract_ref,original.delete_contract,original.security_barrier_fence,
    original.owner_user_id,original.owner_revision,operation,lineage,original.run_id,original.run_id,latest_attempt.attempt_id,
    mode_value,CASE WHEN mode_value='SEALED_STAGE' THEN manifest_row.manifest_digest ELSE NULL END)
    RETURNING run_id INTO child;
  INSERT INTO control.etl_run_attempt(attempt_id,tenant_key,source_id,run_id,ordinal,operation_id,status)
    VALUES(child_attempt,p_tenant_key,original.source_id,child,1,child_attempt_operation,'QUEUED');
  INSERT INTO control.etl_snapshot_recovery_operation(operation_id,tenant_key,source_id,idempotency_key,request_digest,
    lineage_root_run_id,parent_run_id,original_run_id,original_attempt_id,original_failure_version,original_manifest_digest,
    original_proof_scope_digest,original_semantic_digest,recovery_mode,child_run_id,child_attempt_id,reason,
    initiator_issuer,initiator_subject,initiator_tenant,initiator_user_id,initiator_auth_epoch,initiator_scopes,request_id)
  VALUES(operation,p_tenant_key,original.source_id,p_idempotency_key,p_request_digest,lineage,original.run_id,original.run_id,
    latest_attempt.attempt_id,original.failure_version,CASE WHEN mode_value='SEALED_STAGE' THEN manifest_row.manifest_digest END,
    CASE WHEN mode_value='SEALED_STAGE' THEN validation_row.proof_scope_digest END,
    CASE WHEN mode_value='SEALED_STAGE' THEN validation_row.semantic_digest END,mode_value,child,child_attempt,btrim(p_reason),
    p_issuer,p_subject,p_tenant_key,p_user_id,p_auth_epoch,p_scopes,p_request_id);
  UPDATE control.etl_snapshot_schedule SET active_run_id=child,last_run_id=child,updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=original.source_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('operation_id',operation,'original_run_id',original.run_id,'run_id',child,'attempt_id',child_attempt,
    'recovery_mode',mode_value,'status','QUEUED','replayed',false);
END;
$body$;
ALTER FUNCTION control.create_etl_snapshot_manual_recovery(text,uuid,bigint,text,bytea,text,text,text,text,bigint,text[],uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.create_etl_snapshot_manual_recovery(text,uuid,bigint,text,bytea,text,text,text,text,bigint,text[],uuid)
  FROM PUBLIC,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.create_etl_snapshot_manual_recovery(text,uuid,bigint,text,bytea,text,text,text,text,bigint,text[],uuid) TO hub_api;

-- SEALED_STAGE is a worker-only page-for-page copy into fresh child coordinates.
-- The original attempt is selected exclusively through the immutable operation.
CREATE FUNCTION control.read_etl_snapshot_recovery_manifest(p_tenant_key text,p_source_id text,p_child_run_id uuid,
  p_child_attempt_id uuid,p_claim_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE child_row control.etl_run%ROWTYPE; operation_row control.etl_snapshot_recovery_operation%ROWTYPE;
  original_manifest control.etl_snapshot_manifest%ROWTYPE; original_attempt control.etl_run_attempt%ROWTYPE;
  original_validation control.etl_snapshot_validation%ROWTYPE; version_domain text;
BEGIN
  child_row:=control.assert_etl_snapshot_claim(p_tenant_key,p_source_id,p_child_run_id,p_claim_token);
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  IF child_row.recovery_mode<>'SEALED_STAGE' OR child_row.recovery_operation_id IS NULL OR
     child_row.recovery_source_manifest_digest IS NULL OR p_child_attempt_id IS NULL OR
     NOT EXISTS(SELECT 1 FROM control.etl_run_attempt a WHERE a.tenant_key=p_tenant_key AND a.source_id=p_source_id
       AND a.run_id=p_child_run_id AND a.attempt_id=p_child_attempt_id AND a.status='RUNNING' AND a.claim_token=p_claim_token
       AND a.lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'snapshot recovery claim invalid' USING ERRCODE='40001'; END IF;
  SELECT * INTO operation_row FROM control.etl_snapshot_recovery_operation o WHERE o.operation_id=child_row.recovery_operation_id
    AND o.tenant_key=p_tenant_key AND o.source_id=p_source_id AND o.child_run_id=p_child_run_id AND o.recovery_mode='SEALED_STAGE';
  IF NOT FOUND OR operation_row.original_run_id<>child_row.recovery_original_run_id OR
     operation_row.original_attempt_id<>child_row.recovery_original_attempt_id OR
     operation_row.original_manifest_digest<>child_row.recovery_source_manifest_digest THEN
    RAISE EXCEPTION 'snapshot recovery link invalid' USING ERRCODE='55000';
  END IF;
  SELECT * INTO original_attempt FROM control.etl_run_attempt a WHERE a.attempt_id=operation_row.original_attempt_id
    AND a.run_id=operation_row.original_run_id AND a.tenant_key=p_tenant_key AND a.source_id=p_source_id AND a.status='COMPLETE';
  SELECT * INTO original_manifest FROM control.etl_snapshot_manifest m WHERE m.tenant_key=p_tenant_key AND m.source_id=p_source_id
    AND m.run_id=operation_row.original_run_id AND m.attempt_id=operation_row.original_attempt_id AND m.state='EXTRACTED'
    AND m.manifest_digest=operation_row.original_manifest_digest;
  SELECT * INTO original_validation FROM control.etl_snapshot_validation v WHERE v.tenant_key=p_tenant_key AND v.source_id=p_source_id
    AND v.run_id=operation_row.original_run_id AND v.attempt_id=operation_row.original_attempt_id
    AND v.manifest_digest=operation_row.original_manifest_digest AND v.proof_scope_digest=operation_row.original_proof_scope_digest
    AND v.semantic_digest=operation_row.original_semantic_digest;
  IF original_attempt.attempt_id IS NULL OR original_manifest.attempt_id IS NULL OR original_validation.attempt_id IS NULL THEN
    RAISE EXCEPTION 'snapshot recovery proof unavailable' USING ERRCODE='55000';
  END IF;
  SELECT config->>'version_domain' INTO version_domain FROM control.source_config_revision WHERE tenant_key=p_tenant_key
    AND source_id=p_source_id AND revision=child_row.config_revision AND config_digest=child_row.config_digest;
  IF version_domain='SNAPSHOT_OBSERVATION' AND NOT EXISTS(SELECT 1 FROM control.etl_snapshot_observation o
      WHERE o.tenant_key=p_tenant_key AND o.source_id=p_source_id AND o.run_id=operation_row.original_run_id
        AND o.attempt_id=operation_row.original_attempt_id) THEN
    RAISE EXCEPTION 'snapshot recovery observation unavailable' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('manifest',original_manifest.manifest,'manifest_digest',encode(original_manifest.manifest_digest,'hex'),
    'original_run_id',operation_row.original_run_id,'original_attempt_id',operation_row.original_attempt_id,
    'original_manifest_digest',encode(operation_row.original_manifest_digest,'hex'));
END;
$body$;

CREATE FUNCTION control.read_etl_snapshot_recovery_stage_page(p_tenant_key text,p_source_id text,p_child_run_id uuid,
  p_child_attempt_id uuid,p_claim_token uuid,p_relation text,p_page_no integer)
RETURNS TABLE(entity text,relation text,page_no integer,row_count integer,first_key text,last_key text,page_digest bytea,rows jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE child_row control.etl_run%ROWTYPE; operation_row control.etl_snapshot_recovery_operation%ROWTYPE;
  source_page control.etl_snapshot_stage_page%ROWTYPE;
BEGIN
  child_row:=control.assert_etl_snapshot_claim(p_tenant_key,p_source_id,p_child_run_id,p_claim_token);
  PERFORM control.lock_etl_snapshot_source(p_tenant_key,p_source_id);
  IF child_row.recovery_mode<>'SEALED_STAGE' OR child_row.recovery_operation_id IS NULL OR
     p_relation NOT IN ('customer','order','order_line') OR p_page_no<1 OR
     NOT EXISTS(SELECT 1 FROM control.etl_run_attempt a WHERE a.tenant_key=p_tenant_key AND a.source_id=p_source_id
       AND a.run_id=p_child_run_id AND a.attempt_id=p_child_attempt_id AND a.status='RUNNING' AND a.claim_token=p_claim_token
       AND a.lease_expires_at>clock_timestamp()) THEN RETURN; END IF;
  SELECT * INTO operation_row FROM control.etl_snapshot_recovery_operation o WHERE o.operation_id=child_row.recovery_operation_id
    AND o.tenant_key=p_tenant_key AND o.source_id=p_source_id AND o.child_run_id=p_child_run_id
    AND o.original_run_id=child_row.recovery_original_run_id
    AND o.original_attempt_id=child_row.recovery_original_attempt_id AND o.original_manifest_digest=child_row.recovery_source_manifest_digest
    AND o.recovery_mode='SEALED_STAGE';
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation v WHERE v.tenant_key=p_tenant_key
      AND v.source_id=p_source_id AND v.run_id=operation_row.original_run_id AND v.attempt_id=operation_row.original_attempt_id
      AND v.manifest_digest=operation_row.original_manifest_digest AND v.proof_scope_digest=operation_row.original_proof_scope_digest
      AND v.semantic_digest=operation_row.original_semantic_digest) THEN RETURN; END IF;
  SELECT * INTO source_page FROM control.etl_snapshot_stage_page p WHERE p.tenant_key=p_tenant_key AND p.source_id=p_source_id
    AND p.run_id=operation_row.original_run_id AND p.attempt_id=operation_row.original_attempt_id
    AND p.relation=p_relation AND p.page_no=p_page_no;
  IF NOT FOUND THEN RETURN; END IF;
  entity:=source_page.entity; relation:=source_page.relation; page_no:=source_page.page_no; row_count:=source_page.row_count;
  first_key:=source_page.first_key; last_key:=source_page.last_key; page_digest:=source_page.page_digest;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('entity',r.entity,'relation',r.relation,'source_pk',r.source_pk,
    'parent_source_pk',r.parent_source_pk,'source_version',r.source_version,'facts',r.facts) ORDER BY r.row_ordinal),'[]'::jsonb)
    INTO rows FROM control.etl_snapshot_stage_record r WHERE r.tenant_key=p_tenant_key AND r.source_id=p_source_id
      AND r.run_id=operation_row.original_run_id AND r.attempt_id=operation_row.original_attempt_id
      AND r.entity=source_page.entity AND r.relation=p_relation AND r.page_no=p_page_no;
  IF jsonb_array_length(rows)<>row_count THEN RAISE EXCEPTION 'snapshot recovery stage coverage invalid' USING ERRCODE='55000'; END IF;
  RETURN NEXT;
END;
$body$;
ALTER FUNCTION control.read_etl_snapshot_recovery_manifest(text,text,uuid,uuid,uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION control.read_etl_snapshot_recovery_stage_page(text,text,uuid,uuid,uuid,text,integer) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.read_etl_snapshot_recovery_manifest(text,text,uuid,uuid,uuid),
  control.read_etl_snapshot_recovery_stage_page(text,text,uuid,uuid,uuid,text,integer) FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.read_etl_snapshot_recovery_manifest(text,text,uuid,uuid,uuid),
  control.read_etl_snapshot_recovery_stage_page(text,text,uuid,uuid,uuid,text,integer) TO hub_worker;

ALTER TABLE control.etl_snapshot_apply_outcome ADD COLUMN reused_original_outcome_id uuid
  REFERENCES control.etl_snapshot_apply_outcome(outcome_id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE FUNCTION control.read_etl_snapshot_recovery_c_metadata(p_tenant_key text,p_source_id text,p_run_id uuid,
  p_attempt_id uuid,p_claim_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE r control.etl_run%ROWTYPE;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN NULL; END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  IF r.recovery_operation_id IS NULL THEN RETURN jsonb_build_object('recovery_mode',NULL); END IF;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_recovery_operation o WHERE o.operation_id=r.recovery_operation_id
      AND o.tenant_key=p_tenant_key AND o.source_id=p_source_id AND o.child_run_id=p_run_id
      AND o.recovery_mode=r.recovery_mode AND o.original_run_id=r.recovery_original_run_id
      AND o.original_attempt_id=r.recovery_original_attempt_id) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('recovery_mode',r.recovery_mode,'original_run_id',r.recovery_original_run_id,
    'original_attempt_id',r.recovery_original_attempt_id,'lineage_root_run_id',r.recovery_lineage_root_run_id);
END;
$body$;

CREATE OR REPLACE FUNCTION control.persist_etl_snapshot_observation(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid,
  p_semantic_digest bytea,p_reuse_scope_digest bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE existing numeric(20,0); chosen numeric(20,0); next numeric(20,0); r control.etl_run%ROWTYPE;
  operation_row control.etl_snapshot_recovery_operation%ROWTYPE;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN NULL; END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation v WHERE v.tenant_key=p_tenant_key AND v.source_id=p_source_id AND v.run_id=p_run_id
      AND v.attempt_id=p_attempt_id AND v.semantic_digest=p_semantic_digest AND v.proof_scope_digest=p_reuse_scope_digest) THEN RETURN NULL; END IF;
  IF r.recovery_mode='SEALED_STAGE' THEN
    SELECT * INTO operation_row FROM control.etl_snapshot_recovery_operation o WHERE o.operation_id=r.recovery_operation_id
      AND o.tenant_key=p_tenant_key AND o.source_id=p_source_id AND o.child_run_id=p_run_id
      AND o.recovery_mode='SEALED_STAGE';
    IF NOT FOUND OR operation_row.original_semantic_digest<>p_semantic_digest OR
       operation_row.original_proof_scope_digest<>p_reuse_scope_digest OR NOT EXISTS(
         SELECT 1 FROM control.etl_snapshot_manifest m
         WHERE m.tenant_key=p_tenant_key AND m.source_id=p_source_id AND m.run_id=p_run_id AND m.attempt_id=p_attempt_id
           AND m.state='EXTRACTED' AND EXISTS(SELECT 1 FROM control.etl_run_attempt a
             WHERE a.tenant_key=p_tenant_key AND a.source_id=p_source_id AND a.run_id=p_run_id AND a.attempt_id=p_attempt_id
               AND a.status='COMPLETE' AND a.operation_id::text=m.manifest->>'operation_id')
           AND m.manifest->>'attempt_id'=p_attempt_id::text
           AND m.manifest#>>'{recovery_source,run_id}'=operation_row.original_run_id::text
           AND m.manifest#>>'{recovery_source,attempt_id}'=operation_row.original_attempt_id::text
           AND m.manifest#>>'{recovery_source,manifest_digest}'=encode(operation_row.original_manifest_digest,'hex')
           AND m.manifest#>>'{recovery_source,copy_kind}'='EXACT_STAGE_FACTS'
       ) THEN RETURN NULL; END IF;
    SELECT sequence_value INTO chosen FROM control.etl_snapshot_observation WHERE tenant_key=p_tenant_key AND source_id=p_source_id
      AND run_id=operation_row.original_run_id AND attempt_id=operation_row.original_attempt_id;
    RETURN chosen::text;
  END IF;
  SELECT sequence_value INTO chosen FROM control.etl_snapshot_observation WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id;
  IF chosen IS NOT NULL THEN RETURN chosen::text; END IF;
  SELECT a.sequence_value INTO existing FROM control.etl_snapshot_observation_sequence s
    JOIN control.etl_snapshot_observation_allocation a ON (a.tenant_key,a.source_id,a.sequence_value)=(s.tenant_key,s.source_id,s.next_value-1)
    WHERE s.tenant_key=p_tenant_key AND a.semantic_digest=p_semantic_digest AND a.reuse_scope_digest=p_reuse_scope_digest
      AND EXISTS(SELECT 1 FROM control.etl_snapshot_observation b JOIN control.etl_run prior
        ON (prior.tenant_key,prior.source_id,prior.run_id)=(b.tenant_key,b.source_id,b.run_id)
        WHERE (b.tenant_key,b.source_id,b.sequence_value)=(a.tenant_key,a.source_id,a.sequence_value) AND prior.status='COMPLETE')
    ORDER BY a.sequence_value DESC LIMIT 1;
  IF existing IS NOT NULL THEN chosen:=existing;
  ELSE
    INSERT INTO control.etl_snapshot_observation_sequence(tenant_key,source_id) VALUES(p_tenant_key,p_source_id) ON CONFLICT DO NOTHING;
    SELECT next_value INTO next FROM control.etl_snapshot_observation_sequence WHERE tenant_key=p_tenant_key AND source_id=p_source_id FOR UPDATE;
    IF next>99999999999999999999 THEN RAISE EXCEPTION 'observation sequence exhausted' USING ERRCODE='22003'; END IF;
    chosen:=next;
    INSERT INTO control.etl_snapshot_observation_allocation(tenant_key,source_id,sequence_value,semantic_digest,reuse_scope_digest)
      VALUES(p_tenant_key,p_source_id,chosen,p_semantic_digest,p_reuse_scope_digest);
    UPDATE control.etl_snapshot_observation_sequence SET next_value=chosen+1 WHERE tenant_key=p_tenant_key AND source_id=p_source_id;
  END IF;
  INSERT INTO control.etl_snapshot_observation(tenant_key,source_id,run_id,attempt_id,sequence_value)
    VALUES(p_tenant_key,p_source_id,p_run_id,p_attempt_id,chosen) ON CONFLICT(tenant_key,source_id,run_id) DO NOTHING;
  RETURN chosen::text;
END;
$body$;

CREATE FUNCTION control.get_etl_snapshot_recovery_prior_range(p_tenant_key text,p_source_id text,p_child_run_id uuid,
  p_attempt_id uuid,p_claim_token uuid,p_entity text,p_source_pk text)
RETURNS TABLE(aggregate_digest bytea,proof_scope_digest bytea,status text,error_code text,outcome_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE r control.etl_run%ROWTYPE; o control.etl_snapshot_recovery_operation%ROWTYPE;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_child_run_id,p_attempt_id,p_claim_token) THEN RETURN; END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_child_run_id;
  IF r.recovery_mode<>'SEALED_STAGE' THEN RETURN; END IF;
  SELECT * INTO o FROM control.etl_snapshot_recovery_operation WHERE operation_id=r.recovery_operation_id
    AND child_run_id=p_child_run_id AND recovery_mode='SEALED_STAGE';
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT ar.aggregate_digest,ar.proof_scope_digest,ao.status,ao.error_code,ao.outcome_id
    FROM control.etl_snapshot_apply_range ar JOIN control.etl_snapshot_apply_outcome ao
      ON (ao.outcome_id,ao.tenant_key,ao.source_id,ao.run_id,ao.attempt_id)=
         (ar.outcome_id,ar.tenant_key,ar.source_id,ar.run_id,ar.attempt_id)
    WHERE ar.tenant_key=p_tenant_key AND ar.source_id=p_source_id AND ar.run_id=o.original_run_id
      AND ar.attempt_id=o.original_attempt_id AND ar.entity=p_entity AND ar.source_pk=p_source_pk
      AND ao.status IN ('APPLIED','DUPLICATE','IGNORED_STALE');
END;
$body$;

CREATE FUNCTION control.record_etl_snapshot_recovery_reuse(p_tenant_key text,p_source_id text,p_child_run_id uuid,p_attempt_id uuid,
  p_claim_token uuid,p_entity text,p_source_pk text,p_aggregate_digest bytea,p_proof_scope_digest bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE r control.etl_run%ROWTYPE; o control.etl_snapshot_recovery_operation%ROWTYPE; prior record; new_outcome uuid;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_child_run_id,p_attempt_id,p_claim_token) THEN RETURN false; END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_child_run_id;
  IF r.recovery_mode<>'SEALED_STAGE' THEN RETURN false; END IF;
  SELECT * INTO o FROM control.etl_snapshot_recovery_operation WHERE operation_id=r.recovery_operation_id
    AND child_run_id=p_child_run_id AND recovery_mode='SEALED_STAGE';
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation v WHERE v.tenant_key=p_tenant_key
      AND v.source_id=p_source_id AND v.run_id=p_child_run_id AND v.attempt_id=p_attempt_id
      AND v.proof_scope_digest=p_proof_scope_digest) THEN RETURN false; END IF;
  SELECT ar.aggregate_digest,ar.proof_scope_digest,ao.status,ao.outcome_id INTO prior
    FROM control.etl_snapshot_apply_range ar JOIN control.etl_snapshot_apply_outcome ao
      ON (ao.outcome_id,ao.tenant_key,ao.source_id,ao.run_id,ao.attempt_id)=
         (ar.outcome_id,ar.tenant_key,ar.source_id,ar.run_id,ar.attempt_id)
    WHERE ar.tenant_key=p_tenant_key AND ar.source_id=p_source_id AND ar.run_id=o.original_run_id
      AND ar.attempt_id=o.original_attempt_id AND ar.entity=p_entity AND ar.source_pk=p_source_pk
      AND ao.status IN ('APPLIED','DUPLICATE','IGNORED_STALE') FOR SHARE OF ar,ao;
  IF NOT FOUND OR prior.aggregate_digest<>p_aggregate_digest OR prior.proof_scope_digest<>p_proof_scope_digest THEN RETURN false; END IF;
  INSERT INTO control.etl_snapshot_apply_outcome(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,
    aggregate_digest,status,reused_original_outcome_id)
  VALUES(p_tenant_key,p_source_id,p_child_run_id,p_attempt_id,p_entity,p_entity,'',p_source_pk,p_aggregate_digest,'DUPLICATE',prior.outcome_id)
    RETURNING outcome_id INTO new_outcome;
  INSERT INTO control.etl_snapshot_apply_range(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,
    aggregate_digest,proof_scope_digest,outcome_id)
  VALUES(p_tenant_key,p_source_id,p_child_run_id,p_attempt_id,p_entity,p_entity,'',p_source_pk,p_aggregate_digest,p_proof_scope_digest,new_outcome);
  INSERT INTO control.etl_snapshot_checkpoint(tenant_key,source_id,run_id,entity,last_relation,last_parent_source_pk,last_source_pk,completed_count)
    VALUES(p_tenant_key,p_source_id,p_child_run_id,p_entity,p_entity,'',p_source_pk,1)
    ON CONFLICT(tenant_key,source_id,run_id,entity) DO UPDATE SET last_relation=EXCLUDED.last_relation,
      last_parent_source_pk=EXCLUDED.last_parent_source_pk,last_source_pk=EXCLUDED.last_source_pk,
      completed_count=control.etl_snapshot_checkpoint.completed_count+1,updated_at=clock_timestamp();
  RETURN true;
END;
$body$;

ALTER FUNCTION control.read_etl_snapshot_recovery_c_metadata(text,text,uuid,uuid,uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION control.get_etl_snapshot_recovery_prior_range(text,text,uuid,uuid,uuid,text,text) OWNER TO CURRENT_USER;
ALTER FUNCTION control.record_etl_snapshot_recovery_reuse(text,text,uuid,uuid,uuid,text,text,bytea,bytea) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.read_etl_snapshot_recovery_c_metadata(text,text,uuid,uuid,uuid),
  control.get_etl_snapshot_recovery_prior_range(text,text,uuid,uuid,uuid,text,text),
  control.record_etl_snapshot_recovery_reuse(text,text,uuid,uuid,uuid,text,text,bytea,bytea) FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.read_etl_snapshot_recovery_c_metadata(text,text,uuid,uuid,uuid),
  control.get_etl_snapshot_recovery_prior_range(text,text,uuid,uuid,uuid,text,text),
  control.record_etl_snapshot_recovery_reuse(text,text,uuid,uuid,uuid,text,text,bytea,bytea) TO hub_worker;

CREATE OR REPLACE FUNCTION control.finish_etl_snapshot_run(p_tenant_key text,p_source_id text,p_run_id uuid,p_attempt_id uuid,p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
DECLARE expected bigint; done bigint; bad bigint; applied bigint; completed timestamptz; r control.etl_run%ROWTYPE;
BEGIN
  IF NOT control.assert_etl_snapshot_continuation(p_tenant_key,p_source_id,p_run_id,p_attempt_id,p_claim_token) THEN RETURN false; END IF;
  SELECT * INTO r FROM control.etl_run WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM control.etl_snapshot_validation WHERE tenant_key=p_tenant_key AND source_id=p_source_id
      AND run_id=p_run_id AND attempt_id=p_attempt_id) THEN RETURN false; END IF;
  SELECT count(*) INTO expected FROM control.etl_snapshot_stage_record WHERE tenant_key=p_tenant_key AND source_id=p_source_id
    AND run_id=p_run_id AND attempt_id=p_attempt_id AND relation IN ('customer','order');
  SELECT count(*),count(*) FILTER(WHERE status IN ('QUARANTINED','CHANNEL_EPOCH_RETIRED','FAILED')),
    count(*) FILTER(WHERE status='APPLIED') INTO done,bad,applied FROM control.etl_snapshot_apply_outcome
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND attempt_id=p_attempt_id;
  IF done<>expected THEN RETURN false; END IF;
  IF bad=0 THEN
    UPDATE control.etl_run SET status='COMPLETE',completed_at=clock_timestamp(),applied_count=applied,
      completeness_summary=jsonb_build_object('status','COMPLETE','outcome_count',done)
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND status='APPLYING'
      RETURNING completed_at INTO completed;
    IF NOT FOUND THEN RETURN false; END IF;
    IF r.recovery_mode IS DISTINCT FROM 'SEALED_STAGE' AND (r.recovery_lineage_root_run_id IS NULL OR NOT EXISTS(
        SELECT 1 FROM control.etl_snapshot_delete_run d JOIN control.etl_run prior
          ON (prior.tenant_key,prior.source_id,prior.run_id)=(d.tenant_key,d.source_id,d.run_id)
        WHERE d.tenant_key=p_tenant_key AND d.source_id=p_source_id
          AND coalesce(prior.recovery_lineage_root_run_id,prior.run_id)=r.recovery_lineage_root_run_id)) THEN
      PERFORM control.reserve_etl_snapshot_delete_run(p_tenant_key,p_source_id,p_run_id,p_attempt_id);
    END IF;
    UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,last_run_id=p_run_id,last_successful_run_id=p_run_id,
      next_due_at=clock_timestamp()+make_interval(secs=>interval_seconds),updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND active_run_id=p_run_id;
  ELSE
    UPDATE control.etl_run SET status='FAILED',completed_at=clock_timestamp(),quarantined_count=GREATEST(quarantined_count,bad),
      completeness_summary=jsonb_build_object('status','FAILED','outcome_count',done,'failed_count',bad)
      WHERE run_id=p_run_id AND status='APPLYING';
    UPDATE control.etl_snapshot_schedule SET active_run_id=NULL,last_run_id=p_run_id,updated_at=clock_timestamp()
      WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND active_run_id=p_run_id;
  END IF;
  UPDATE control.etl_snapshot_continuation SET claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND run_id=p_run_id AND claim_token=p_claim_token;
  RETURN true;
END;
$body$;
ALTER FUNCTION control.finish_etl_snapshot_run(text,text,uuid,uuid,uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.finish_etl_snapshot_run(text,text,uuid,uuid,uuid) FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.finish_etl_snapshot_run(text,text,uuid,uuid,uuid) TO hub_worker;

-- M1-5E1a2-1: narrow immutable identity and same-transaction quarantine capture.
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_job_item_quarantine_origin_key
  ON control.ingestion_job_item(job_id,ordinal,event_id,source_pk);
CREATE UNIQUE INDEX IF NOT EXISTS etl_snapshot_apply_outcome_quarantine_origin_key
  ON control.etl_snapshot_apply_outcome(outcome_id,tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk);
CREATE UNIQUE INDEX IF NOT EXISTS etl_snapshot_apply_range_quarantine_proof_key
  ON control.etl_snapshot_apply_range(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,
    outcome_id,aggregate_digest,proof_scope_digest);

CREATE TABLE IF NOT EXISTS control.ingestion_quarantine_index (
  quarantine_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_kind text NOT NULL CHECK(origin_kind IN ('REST','SNAPSHOT')),
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  entity text NOT NULL CHECK(entity IN ('customer','order')),
  job_id uuid,
  ordinal integer,
  event_id uuid,
  source_pk text NOT NULL,
  run_id uuid,
  attempt_id uuid,
  outcome_id uuid,
  relation text,
  parent_source_pk text,
  status text NOT NULL CHECK(status='QUARANTINED'),
  error_code text CHECK(error_code IS NULL OR (char_length(error_code)<=96 AND error_code ~ '^[A-Z0-9_:-]+$')),
  created_at timestamptz NOT NULL,
  owner_approval_id uuid,
  owner_revision bigint,
  channel_id uuid,
  channel_epoch bigint,
  config_revision bigint,
  config_digest bytea,
  mapping_revision bigint,
  mapping_digest bytea,
  identity_mapping_revision bigint,
  identity_mapping_digest bytea,
  endpoint_profile_digest bytea,
  test_report_id uuid,
  approval_security_fence bigint,
  security_barrier_fence_at_admission bigint,
  aggregate_digest bytea,
  proof_scope_digest bytea,
  dependency_status text NOT NULL DEFAULT 'UNKNOWN' CHECK(dependency_status IN ('UNKNOWN','AVAILABLE')),
  dependency_code text,
  CHECK((dependency_status='UNKNOWN' AND dependency_code IS NULL) OR
    (dependency_status='AVAILABLE' AND dependency_code IS NOT NULL AND char_length(dependency_code)<=96 AND dependency_code ~ '^[A-Z0-9_:-]+$')),
  CHECK(
    (origin_kind='REST' AND job_id IS NOT NULL AND ordinal IS NOT NULL AND event_id IS NOT NULL AND
      run_id IS NULL AND attempt_id IS NULL AND outcome_id IS NULL AND relation IS NULL AND parent_source_pk IS NULL AND
      owner_approval_id IS NOT NULL AND owner_revision IS NOT NULL AND channel_id IS NOT NULL AND channel_epoch IS NOT NULL AND
      config_revision IS NOT NULL AND config_digest IS NOT NULL AND mapping_revision IS NOT NULL AND mapping_digest IS NOT NULL AND
      identity_mapping_revision IS NOT NULL AND identity_mapping_digest IS NOT NULL AND endpoint_profile_digest IS NOT NULL AND
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
  ),
  FOREIGN KEY(job_id,tenant_key,source_id,entity)
    REFERENCES control.ingestion_job(id,tenant_key,source_id,entity) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(job_id,ordinal,event_id,source_pk)
    REFERENCES control.ingestion_job_item(job_id,ordinal,event_id,source_pk) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(outcome_id,tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk)
    REFERENCES control.etl_snapshot_apply_outcome(outcome_id,tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,
      outcome_id,aggregate_digest,proof_scope_digest)
    REFERENCES control.etl_snapshot_apply_range(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk,
      outcome_id,aggregate_digest,proof_scope_digest) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_quarantine_rest_origin_key
  ON control.ingestion_quarantine_index(tenant_key,source_id,job_id,ordinal) WHERE origin_kind='REST';
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_quarantine_snapshot_origin_key
  ON control.ingestion_quarantine_index(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk)
  WHERE origin_kind='SNAPSHOT';
CREATE INDEX IF NOT EXISTS ingestion_quarantine_page_seek_idx
  ON control.ingestion_quarantine_index(tenant_key,source_id,created_at DESC,quarantine_id DESC);

CREATE OR REPLACE FUNCTION control.reject_ingestion_quarantine_index_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,control
AS $body$
BEGIN RAISE EXCEPTION 'ingestion quarantine identity is immutable' USING ERRCODE='55000'; END;
$body$;
DROP TRIGGER IF EXISTS ingestion_quarantine_index_immutable ON control.ingestion_quarantine_index;
CREATE TRIGGER ingestion_quarantine_index_immutable BEFORE UPDATE OR DELETE ON control.ingestion_quarantine_index
  FOR EACH ROW EXECUTE FUNCTION control.reject_ingestion_quarantine_index_mutation();

CREATE OR REPLACE FUNCTION control.capture_rest_ingestion_quarantine_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  IF NEW.status IS DISTINCT FROM 'QUARANTINED' OR OLD.status IS NOT DISTINCT FROM 'QUARANTINED' THEN RETURN NEW; END IF;
  INSERT INTO control.ingestion_quarantine_index(origin_kind,tenant_key,source_id,entity,job_id,ordinal,event_id,source_pk,
    status,error_code,created_at,owner_approval_id,owner_revision,channel_id,channel_epoch,config_revision,config_digest,
    mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,
    approval_security_fence,security_barrier_fence_at_admission)
  SELECT 'REST',j.tenant_key,j.source_id,j.entity,NEW.job_id,NEW.ordinal,NEW.event_id,NEW.source_pk,
    'QUARANTINED',CASE WHEN NEW.error_code IS NOT NULL AND char_length(NEW.error_code)<=96 AND NEW.error_code ~ '^[A-Z0-9_:-]+$' THEN NEW.error_code ELSE NULL END,
    NEW.updated_at,j.owner_approval_id,j.owner_revision,j.channel_id,j.channel_epoch,j.config_revision,j.config_digest,
    j.mapping_revision,j.mapping_digest,j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,
    j.approval_security_fence,j.security_barrier_fence_at_admission
    FROM control.ingestion_job j WHERE j.id=NEW.job_id AND j.tenant_key IS NOT NULL;
  RETURN NEW;
END;
$body$;
ALTER FUNCTION control.capture_rest_ingestion_quarantine_index() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.capture_rest_ingestion_quarantine_index() FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
DROP TRIGGER IF EXISTS ingestion_job_item_quarantine_capture ON control.ingestion_job_item;
CREATE TRIGGER ingestion_job_item_quarantine_capture AFTER UPDATE OF status ON control.ingestion_job_item
  FOR EACH ROW EXECUTE FUNCTION control.capture_rest_ingestion_quarantine_index();

CREATE OR REPLACE FUNCTION control.capture_snapshot_ingestion_quarantine_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control
AS $body$
BEGIN
  INSERT INTO control.ingestion_quarantine_index(origin_kind,tenant_key,source_id,entity,run_id,attempt_id,outcome_id,relation,
    parent_source_pk,source_pk,status,error_code,created_at,aggregate_digest,proof_scope_digest)
  SELECT 'SNAPSHOT',o.tenant_key,o.source_id,o.entity,o.run_id,o.attempt_id,o.outcome_id,o.relation,o.parent_source_pk,o.source_pk,
    'QUARANTINED',CASE WHEN o.error_code IS NOT NULL AND char_length(o.error_code)<=96 AND o.error_code ~ '^[A-Z0-9_:-]+$' THEN o.error_code ELSE NULL END,
    o.created_at,r.aggregate_digest,r.proof_scope_digest
  FROM control.etl_snapshot_apply_outcome o
  JOIN control.etl_snapshot_apply_range r ON (r.tenant_key,r.source_id,r.run_id,r.attempt_id,r.entity,r.relation,r.parent_source_pk,
    r.source_pk,r.outcome_id)=(NEW.tenant_key,NEW.source_id,NEW.run_id,NEW.attempt_id,NEW.entity,NEW.relation,NEW.parent_source_pk,
    NEW.source_pk,NEW.outcome_id)
  WHERE o.status='QUARANTINED' AND (o.tenant_key,o.source_id,o.run_id,o.attempt_id,o.entity,o.relation,o.parent_source_pk,o.source_pk)
    =(NEW.tenant_key,NEW.source_id,NEW.run_id,NEW.attempt_id,NEW.entity,NEW.relation,NEW.parent_source_pk,NEW.source_pk);
  RETURN NEW;
END;
$body$;
ALTER FUNCTION control.capture_snapshot_ingestion_quarantine_index() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.capture_snapshot_ingestion_quarantine_index() FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
DROP TRIGGER IF EXISTS etl_snapshot_range_quarantine_capture ON control.etl_snapshot_apply_range;
CREATE TRIGGER etl_snapshot_range_quarantine_capture AFTER INSERT ON control.etl_snapshot_apply_range
  FOR EACH ROW EXECUTE FUNCTION control.capture_snapshot_ingestion_quarantine_index();

INSERT INTO control.ingestion_quarantine_index(origin_kind,tenant_key,source_id,entity,job_id,ordinal,event_id,source_pk,status,
  error_code,created_at,owner_approval_id,owner_revision,channel_id,channel_epoch,config_revision,config_digest,mapping_revision,
  mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,approval_security_fence,
  security_barrier_fence_at_admission)
SELECT 'REST',j.tenant_key,j.source_id,j.entity,i.job_id,i.ordinal,i.event_id,i.source_pk,'QUARANTINED',
  CASE WHEN i.error_code IS NOT NULL AND char_length(i.error_code)<=96 AND i.error_code ~ '^[A-Z0-9_:-]+$' THEN i.error_code ELSE NULL END,
  i.updated_at,j.owner_approval_id,j.owner_revision,j.channel_id,j.channel_epoch,j.config_revision,j.config_digest,j.mapping_revision,
  j.mapping_digest,j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,
  j.approval_security_fence,j.security_barrier_fence_at_admission
FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id
WHERE i.status='QUARANTINED'
ON CONFLICT DO NOTHING;

INSERT INTO control.ingestion_quarantine_index(origin_kind,tenant_key,source_id,entity,run_id,attempt_id,outcome_id,relation,
  parent_source_pk,source_pk,status,error_code,created_at,aggregate_digest,proof_scope_digest)
SELECT 'SNAPSHOT',o.tenant_key,o.source_id,o.entity,o.run_id,o.attempt_id,o.outcome_id,o.relation,o.parent_source_pk,o.source_pk,
  'QUARANTINED',CASE WHEN o.error_code IS NOT NULL AND char_length(o.error_code)<=96 AND o.error_code ~ '^[A-Z0-9_:-]+$' THEN o.error_code ELSE NULL END,
  o.created_at,r.aggregate_digest,r.proof_scope_digest
FROM control.etl_snapshot_apply_outcome o
JOIN control.etl_snapshot_apply_range r ON (r.tenant_key,r.source_id,r.run_id,r.attempt_id,r.entity,r.relation,r.parent_source_pk,
  r.source_pk,r.outcome_id)=(o.tenant_key,o.source_id,o.run_id,o.attempt_id,o.entity,o.relation,o.parent_source_pk,o.source_pk,o.outcome_id)
WHERE o.status='QUARANTINED'
ON CONFLICT DO NOTHING;

REVOKE ALL ON control.ingestion_quarantine_index FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.reject_ingestion_quarantine_index_mutation(),control.capture_rest_ingestion_quarantine_index(),
  control.capture_snapshot_ingestion_quarantine_index() FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;

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
     (p_origin_kind IS NOT NULL AND p_origin_kind NOT IN ('REST','SNAPSHOT')) OR
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
    CASE WHEN i.origin_kind='REST' THEN jsonb_build_object(
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
ALTER FUNCTION control.list_ingestion_quarantine_current_owner(text,text,text,text,text,bigint,bigint,text,text,timestamptz,uuid,integer)
  OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION control.list_ingestion_quarantine_current_owner(text,text,text,text,text,bigint,bigint,text,text,timestamptz,uuid,integer)
  FROM PUBLIC,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.list_ingestion_quarantine_current_owner(text,text,text,text,text,bigint,bigint,text,text,timestamptz,uuid,integer)
  TO hub_api;
