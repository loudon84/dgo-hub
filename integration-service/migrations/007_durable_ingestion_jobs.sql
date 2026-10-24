ALTER TABLE control.source_owner_approval
  ADD COLUMN approval_security_fence bigint NOT NULL DEFAULT 0 CHECK (approval_security_fence >= 0);
ALTER TABLE control.source_owner_approval ADD CONSTRAINT source_owner_approval_scope_id_unique UNIQUE (tenant_key,source_id,id);
ALTER TABLE control.source_test_report ADD CONSTRAINT source_test_report_scope_id_unique UNIQUE (tenant_key,source_id,id);

CREATE FUNCTION control.capture_source_approval_security_fence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, control
AS $body$
BEGIN
  NEW.approval_security_fence := control.lock_security_barrier_fence();
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION control.capture_source_approval_security_fence() FROM PUBLIC;
CREATE TRIGGER source_owner_approval_security_fence
  BEFORE INSERT ON control.source_owner_approval
  FOR EACH ROW EXECUTE FUNCTION control.capture_source_approval_security_fence();

CREATE SCHEMA IF NOT EXISTS raw;

CREATE TABLE raw.ingestion_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  route text NOT NULL CHECK (route IN ('/hub/v1/ingest/crm/customers','/hub/v1/ingest/orders/orders')),
  body_bytes bytea NOT NULL CHECK (octet_length(body_bytes) BETWEEN 1 AND 4194304),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,tenant_key,source_id,route),
  FOREIGN KEY (tenant_key,source_id) REFERENCES control.source_registry(tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION control.reject_ingestion_raw_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, control
AS $body$
BEGIN
  RAISE EXCEPTION 'immutable ingestion raw batch' USING ERRCODE='55000';
END;
$body$;
REVOKE ALL ON FUNCTION control.reject_ingestion_raw_mutation() FROM PUBLIC;
CREATE TRIGGER ingestion_raw_batch_immutable
  BEFORE UPDATE OR DELETE ON raw.ingestion_batch
  FOR EACH ROW EXECUTE FUNCTION control.reject_ingestion_raw_mutation();

CREATE TABLE control.ingestion_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  route text NOT NULL CHECK (route IN ('/hub/v1/ingest/crm/customers','/hub/v1/ingest/orders/orders')),
  batch_id uuid NOT NULL,
  raw_batch_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  status text NOT NULL CHECK (status IN ('RECEIVED','PROCESSING','SUCCEEDED','PARTIAL','FAILED')),
  received_count integer NOT NULL CHECK (received_count BETWEEN 1 AND 100),
  applied_count integer NOT NULL DEFAULT 0 CHECK (applied_count BETWEEN 0 AND received_count),
  credential_id uuid NOT NULL,
  source_epoch_at_admission bigint NOT NULL CHECK (source_epoch_at_admission >= 0),
  credential_revision_at_admission bigint NOT NULL CHECK (credential_revision_at_admission > 0),
  credential_generation_at_admission bigint NOT NULL CHECK (credential_generation_at_admission > 0),
  channel_id uuid NOT NULL,
  channel_epoch bigint NOT NULL CHECK (channel_epoch > 0),
  version_domain text NOT NULL CHECK (version_domain IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')),
  owner_approval_id uuid NOT NULL,
  owner_user_id text NOT NULL,
  owner_revision bigint NOT NULL CHECK (owner_revision > 0),
  approval_security_fence bigint NOT NULL CHECK (approval_security_fence >= 0),
  config_revision bigint NOT NULL CHECK (config_revision > 0),
  config_digest bytea NOT NULL CHECK (octet_length(config_digest)=32),
  mapping_revision bigint NOT NULL CHECK (mapping_revision > 0),
  mapping_digest bytea NOT NULL CHECK (octet_length(mapping_digest)=32),
  identity_mapping_revision bigint NOT NULL CHECK (identity_mapping_revision > 0),
  identity_mapping_digest bytea NOT NULL CHECK (octet_length(identity_mapping_digest)=32),
  endpoint_profile_digest bytea NOT NULL CHECK (octet_length(endpoint_profile_digest)=32),
  test_report_id uuid NOT NULL,
  security_barrier_fence_at_admission bigint NOT NULL CHECK (security_barrier_fence_at_admission >= 0),
  first_source_updated_at timestamptz NOT NULL,
  last_source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_key,source_id,route,idempotency_key),
  UNIQUE (id,tenant_key,source_id,entity),
  FOREIGN KEY (tenant_key,source_id) REFERENCES control.source_registry(tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (raw_batch_id,tenant_key,source_id,route) REFERENCES raw.ingestion_batch(id,tenant_key,source_id,route) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,entity,channel_epoch) REFERENCES control.source_channel(tenant_key,source_id,entity,channel_epoch) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,owner_approval_id) REFERENCES control.source_owner_approval(tenant_key,source_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,config_revision) REFERENCES control.source_config_revision(tenant_key,source_id,revision) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,mapping_revision) REFERENCES control.source_mapping_revision(tenant_key,source_id,revision) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,identity_mapping_revision) REFERENCES control.source_identity_mapping_revision(tenant_key,source_id,revision) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,test_report_id) REFERENCES control.source_test_report(tenant_key,source_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((entity='customer' AND route='/hub/v1/ingest/crm/customers') OR (entity='order' AND route='/hub/v1/ingest/orders/orders')),
  CHECK (first_source_updated_at <= last_source_updated_at)
);
CREATE INDEX ingestion_job_tenant_source_created_idx ON control.ingestion_job(tenant_key,source_id,created_at DESC,id DESC);

CREATE FUNCTION control.guard_ingestion_job_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, control
AS $body$
BEGIN
  IF (NEW.id,NEW.tenant_key,NEW.source_id,NEW.entity,NEW.route,NEW.batch_id,NEW.raw_batch_id,NEW.idempotency_key,NEW.request_digest,
      NEW.credential_id,NEW.source_epoch_at_admission,NEW.credential_revision_at_admission,NEW.credential_generation_at_admission,
      NEW.channel_id,NEW.channel_epoch,NEW.version_domain,NEW.owner_approval_id,NEW.owner_user_id,NEW.owner_revision,
      NEW.approval_security_fence,NEW.config_revision,NEW.config_digest,NEW.mapping_revision,NEW.mapping_digest,
      NEW.identity_mapping_revision,NEW.identity_mapping_digest,NEW.endpoint_profile_digest,NEW.test_report_id,
      NEW.security_barrier_fence_at_admission,NEW.received_count,NEW.first_source_updated_at,NEW.last_source_updated_at,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.tenant_key,OLD.source_id,OLD.entity,OLD.route,OLD.batch_id,OLD.raw_batch_id,OLD.idempotency_key,OLD.request_digest,
      OLD.credential_id,OLD.source_epoch_at_admission,OLD.credential_revision_at_admission,OLD.credential_generation_at_admission,
      OLD.channel_id,OLD.channel_epoch,OLD.version_domain,OLD.owner_approval_id,OLD.owner_user_id,OLD.owner_revision,
      OLD.approval_security_fence,OLD.config_revision,OLD.config_digest,OLD.mapping_revision,OLD.mapping_digest,
      OLD.identity_mapping_revision,OLD.identity_mapping_digest,OLD.endpoint_profile_digest,OLD.test_report_id,
      OLD.security_barrier_fence_at_admission,OLD.received_count,OLD.first_source_updated_at,OLD.last_source_updated_at,OLD.created_at) THEN
    RAISE EXCEPTION 'immutable ingestion job proof' USING ERRCODE='55000';
  END IF;
  IF (NEW.status,NEW.applied_count) IS NOT DISTINCT FROM (OLD.status,OLD.applied_count) THEN
    RAISE EXCEPTION 'ingestion job update has no worker state change' USING ERRCODE='55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION control.guard_ingestion_job_update() FROM PUBLIC;
CREATE TRIGGER ingestion_job_proof_immutable
  BEFORE UPDATE ON control.ingestion_job
  FOR EACH ROW EXECUTE FUNCTION control.guard_ingestion_job_update();

CREATE TABLE control.ingestion_job_item (
  job_id uuid NOT NULL REFERENCES control.ingestion_job(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  event_id uuid NOT NULL,
  source_pk text NOT NULL CHECK (length(source_pk) BETWEEN 1 AND 128 AND source_pk= btrim(source_pk)),
  source_version numeric(20,0) NOT NULL CHECK (source_version >= 0),
  operation text NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
  source_updated_at timestamptz NOT NULL,
  public_record jsonb NOT NULL CHECK (jsonb_typeof(public_record)='object'),
  status text NOT NULL CHECK (status IN ('RECEIVED','VALIDATING','APPLYING','APPLIED','DUPLICATE','IGNORED_STALE','QUARANTINED','RETRY_PENDING')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id,ordinal),
  UNIQUE (job_id,event_id)
);

CREATE FUNCTION control.guard_ingestion_job_item_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, control
AS $body$
BEGIN
  IF (NEW.job_id,NEW.ordinal,NEW.event_id,NEW.source_pk,NEW.source_version,NEW.operation,NEW.source_updated_at,NEW.public_record)
     IS DISTINCT FROM
     (OLD.job_id,OLD.ordinal,OLD.event_id,OLD.source_pk,OLD.source_version,OLD.operation,OLD.source_updated_at,OLD.public_record) THEN
    RAISE EXCEPTION 'immutable ingestion item fact' USING ERRCODE='55000';
  END IF;
  IF (NEW.status,NEW.error_code) IS NOT DISTINCT FROM (OLD.status,OLD.error_code) THEN
    RAISE EXCEPTION 'ingestion item update has no worker state change' USING ERRCODE='55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION control.guard_ingestion_job_item_update() FROM PUBLIC;
CREATE TRIGGER ingestion_job_item_fact_immutable
  BEFORE UPDATE ON control.ingestion_job_item
  FOR EACH ROW EXECUTE FUNCTION control.guard_ingestion_job_item_update();

CREATE FUNCTION control.reject_ingestion_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, control
AS $body$
BEGIN
  RAISE EXCEPTION 'immutable ingestion receipt' USING ERRCODE='55000';
END;
$body$;
REVOKE ALL ON FUNCTION control.reject_ingestion_delete() FROM PUBLIC;
CREATE TRIGGER ingestion_job_no_delete BEFORE DELETE ON control.ingestion_job
  FOR EACH ROW EXECUTE FUNCTION control.reject_ingestion_delete();
CREATE TRIGGER ingestion_job_item_no_delete BEFORE DELETE ON control.ingestion_job_item
  FOR EACH ROW EXECUTE FUNCTION control.reject_ingestion_delete();

CREATE TABLE control.ingestion_processing_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES control.ingestion_job(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON raw.ingestion_batch,control.ingestion_job,control.ingestion_job_item,control.ingestion_processing_outbox FROM PUBLIC;
REVOKE ALL ON SEQUENCE control.ingestion_processing_outbox_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION control.reject_ingestion_raw_mutation(),control.guard_ingestion_job_update(),control.guard_ingestion_job_item_update(),
  control.reject_ingestion_delete() FROM PUBLIC;

GRANT USAGE ON SCHEMA raw TO hub_api,hub_worker;
GRANT INSERT (id,tenant_key,source_id,route,body_bytes) ON raw.ingestion_batch TO hub_api;
GRANT SELECT ON raw.ingestion_batch TO hub_worker;
GRANT USAGE ON SCHEMA control TO hub_api,hub_worker;
GRANT SELECT (id,tenant_key,source_id,entity,route,idempotency_key,request_digest,status,received_count,applied_count,
  first_source_updated_at,last_source_updated_at) ON control.ingestion_job TO hub_api;
GRANT INSERT (tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,request_digest,status,received_count,applied_count,
  credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,
  channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,approval_security_fence,
  config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
  endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at)
  ON control.ingestion_job TO hub_api;
GRANT SELECT (job_id,ordinal,event_id,source_pk,status,error_code) ON control.ingestion_job_item TO hub_api;
GRANT INSERT (job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status)
  ON control.ingestion_job_item TO hub_api;
GRANT INSERT (job_id) ON control.ingestion_processing_outbox TO hub_api;
GRANT USAGE,SELECT ON SEQUENCE control.ingestion_processing_outbox_id_seq TO hub_api;
GRANT SELECT ON control.ingestion_job,control.ingestion_job_item,control.ingestion_processing_outbox TO hub_worker;
GRANT UPDATE(status,applied_count) ON control.ingestion_job TO hub_worker;
GRANT UPDATE(status,error_code,updated_at) ON control.ingestion_job_item TO hub_worker;
GRANT EXECUTE ON FUNCTION control.lock_security_barrier_fence() TO hub_api,hub_worker;
