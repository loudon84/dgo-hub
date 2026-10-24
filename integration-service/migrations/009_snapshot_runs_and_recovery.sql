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
