ALTER TABLE control.ingestion_processing_outbox
  ADD COLUMN claim_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN acknowledged_at timestamptz,
  ADD CONSTRAINT ingestion_processing_outbox_lease_pair CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL)),
  ADD CONSTRAINT ingestion_processing_outbox_ack_released CHECK (acknowledged_at IS NULL OR claim_token IS NULL);

CREATE INDEX ingestion_processing_outbox_available_idx
  ON control.ingestion_processing_outbox(available_at,id)
  WHERE acknowledged_at IS NULL;

ALTER TABLE control.ingestion_job_item
  ADD COLUMN operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN attempts_started smallint NOT NULL DEFAULT 0 CHECK (attempts_started BETWEEN 0 AND 4),
  ADD COLUMN retries_used smallint NOT NULL DEFAULT 0 CHECK (retries_used BETWEEN 0 AND 3),
  ADD COLUMN next_retry_at timestamptz,
  ADD CONSTRAINT ingestion_job_item_retry_count_matches CHECK (retries_used = greatest(attempts_started - 1, 0));

CREATE OR REPLACE FUNCTION control.guard_ingestion_job_item_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, control
AS $body$
BEGIN
  IF (NEW.job_id,NEW.ordinal,NEW.event_id,NEW.source_pk,NEW.source_version,NEW.operation,NEW.source_updated_at,NEW.public_record,NEW.operation_id)
     IS DISTINCT FROM
     (OLD.job_id,OLD.ordinal,OLD.event_id,OLD.source_pk,OLD.source_version,OLD.operation,OLD.source_updated_at,OLD.public_record,OLD.operation_id) THEN
    RAISE EXCEPTION 'immutable ingestion item fact' USING ERRCODE='55000';
  END IF;
  IF NEW.attempts_started < OLD.attempts_started OR NEW.attempts_started > OLD.attempts_started + 1 OR
      NEW.retries_used <> greatest(NEW.attempts_started - 1, 0) THEN
    RAISE EXCEPTION 'invalid durable ingestion attempt state' USING ERRCODE='55000';
  END IF;
  IF (NEW.status,NEW.error_code,NEW.attempts_started,NEW.retries_used,NEW.next_retry_at)
     IS NOT DISTINCT FROM
     (OLD.status,OLD.error_code,OLD.attempts_started,OLD.retries_used,OLD.next_retry_at) THEN
    RAISE EXCEPTION 'ingestion item update has no worker state change' USING ERRCODE='55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION control.guard_ingestion_job_item_update() FROM PUBLIC;

REVOKE ALL ON control.ingestion_processing_outbox,control.ingestion_job_item FROM PUBLIC;
GRANT SELECT ON control.ingestion_processing_outbox,control.ingestion_job_item TO hub_worker;
GRANT UPDATE (claim_token,lease_expires_at,available_at,acknowledged_at)
  ON control.ingestion_processing_outbox TO hub_worker;
GRANT UPDATE (status,error_code,updated_at,attempts_started,retries_used,next_retry_at)
  ON control.ingestion_job_item TO hub_worker;
