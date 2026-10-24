ALTER TABLE control.source_credential
  ADD COLUMN source_epoch bigint NOT NULL DEFAULT 0 CHECK (source_epoch >= 0);

-- revision on source_credential is the currently selected approved source-config revision.
CREATE TABLE control.source_registry (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  lifecycle text NOT NULL DEFAULT 'DRAFT' CHECK (lifecycle IN ('DRAFT','TESTED','APPROVED','ACTIVE','PAUSED')),
  current_config_revision bigint NOT NULL DEFAULT 1 CHECK (current_config_revision > 0),
  mapping_revision bigint NOT NULL DEFAULT 1 CHECK (mapping_revision > 0),
  identity_mapping_revision bigint NOT NULL DEFAULT 1 CHECK (identity_mapping_revision > 0),
  data_owner_user_id text NOT NULL,
  owner_revision bigint NOT NULL DEFAULT 1 CHECK (owner_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, source_id),
  FOREIGN KEY (tenant_key, source_id) REFERENCES control.source_credential(tenant_key, source_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key, data_owner_user_id) REFERENCES control.auth_subject(tenant_key, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.source_config_revision (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  config_digest bytea NOT NULL CHECK (octet_length(config_digest) = 32),
  config jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, source_id, revision),
  FOREIGN KEY (tenant_key, source_id) REFERENCES control.source_registry(tenant_key, source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.source_mapping_revision (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  mapping_digest bytea NOT NULL CHECK (octet_length(mapping_digest) = 32),
  mappings jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, source_id, revision),
  FOREIGN KEY (tenant_key, source_id) REFERENCES control.source_registry(tenant_key, source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.source_identity_mapping_revision (
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  mapping_digest bytea NOT NULL CHECK (octet_length(mapping_digest) = 32),
  mappings jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, source_id, revision),
  FOREIGN KEY (tenant_key, source_id) REFERENCES control.source_registry(tenant_key, source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.source_test_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  config_revision bigint NOT NULL,
  mapping_revision bigint NOT NULL,
  identity_mapping_revision bigint NOT NULL,
  config_digest bytea NOT NULL CHECK (octet_length(config_digest) = 32),
  mapping_digest bytea NOT NULL CHECK (octet_length(mapping_digest) = 32),
  identity_mapping_digest bytea NOT NULL CHECK (octet_length(identity_mapping_digest) = 32),
  source_credential_revision bigint NOT NULL,
  data_contract_ref text NOT NULL CHECK (length(data_contract_ref) BETWEEN 1 AND 256),
  report jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS','FAIL')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_key, source_id, config_revision) REFERENCES control.source_config_revision(tenant_key, source_id, revision),
  FOREIGN KEY (tenant_key, source_id, mapping_revision) REFERENCES control.source_mapping_revision(tenant_key, source_id, revision),
  FOREIGN KEY (tenant_key, source_id, identity_mapping_revision) REFERENCES control.source_identity_mapping_revision(tenant_key, source_id, revision)
);

CREATE TABLE control.source_owner_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  owner_user_id text NOT NULL,
  owner_revision bigint NOT NULL,
  config_revision bigint NOT NULL,
  mapping_revision bigint NOT NULL,
  identity_mapping_revision bigint NOT NULL,
  config_digest bytea NOT NULL CHECK (octet_length(config_digest) = 32),
  mapping_digest bytea NOT NULL CHECK (octet_length(mapping_digest) = 32),
  identity_mapping_digest bytea NOT NULL CHECK (octet_length(identity_mapping_digest) = 32),
  source_credential_revision bigint NOT NULL,
  data_contract_ref text NOT NULL CHECK (length(data_contract_ref) BETWEEN 1 AND 256),
  test_report_id uuid NOT NULL REFERENCES control.source_test_report(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_key, source_id) REFERENCES control.source_registry(tenant_key, source_id),
  FOREIGN KEY (tenant_key, owner_user_id) REFERENCES control.auth_subject(tenant_key, user_id)
);

CREATE TABLE control.source_channel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  connector text NOT NULL CHECK (connector IN ('rest','postgresql','sqlserver')),
  mode text NOT NULL CHECK (mode IN ('FULL_SNAPSHOT','INCREMENTAL')),
  version_domain text NOT NULL CHECK (version_domain IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')),
  channel_epoch bigint NOT NULL CHECK (channel_epoch > 0),
  state text NOT NULL CHECK (state IN ('pending','active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (tenant_key, source_id, entity, channel_epoch),
  FOREIGN KEY (tenant_key, source_id) REFERENCES control.source_registry(tenant_key, source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX source_channel_one_active_primary_idx ON control.source_channel(tenant_key,source_id,entity) WHERE state='active';

CREATE FUNCTION control.guard_source_channel_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, control
AS $body$
BEGIN
  IF (NEW.tenant_key,NEW.source_id,NEW.entity,NEW.connector,NEW.mode,NEW.version_domain,NEW.channel_epoch)
      IS DISTINCT FROM (OLD.tenant_key,OLD.source_id,OLD.entity,OLD.connector,OLD.mode,OLD.version_domain,OLD.channel_epoch)
     OR (OLD.state='retired' AND NEW.state<>'retired') THEN
    RAISE EXCEPTION 'source channel identity is immutable';
  END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER source_channel_identity_immutable BEFORE UPDATE ON control.source_channel
FOR EACH ROW EXECUTE FUNCTION control.guard_source_channel_identity();

CREATE TABLE control.source_lifecycle_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text NOT NULL,
  source_id text NOT NULL,
  actor_user_id text NOT NULL,
  action text NOT NULL,
  prior_state text,
  new_state text,
  owner_revision bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_key, source_id) REFERENCES control.source_registry(tenant_key, source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- These monotonic records are consumed by future workers before apply. Ordinary
-- pause, edit, or source_epoch changes are deliberately not security barriers.
CREATE TABLE control.source_security_barrier (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text NOT NULL,
  source_id text,
  credential_id uuid,
  entity text CHECK (entity IS NULL OR entity IN ('customer','order')),
  channel_id uuid REFERENCES control.source_channel(id),
  barrier_type text NOT NULL CHECK (barrier_type IN ('CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','TENANT_DISABLED','CHANNEL_RETIRED')),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 96),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (barrier_type <> 'CREDENTIAL_COMPROMISE' OR credential_id IS NOT NULL),
  CHECK (barrier_type <> 'CHANNEL_RETIRED' OR channel_id IS NOT NULL)
);

CREATE FUNCTION control.lock_current_source(p_credential_id uuid, p_tenant_key text, p_source_id text, p_entity text)
RETURNS TABLE (credential_id uuid, tenant_key text, source_id text, digest_kind text, enabled boolean,
  allowed_entities text[], credential_revision bigint, source_epoch bigint, tenant_enabled boolean,
  lifecycle text, config_revision bigint)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, control
AS $function$
  SELECT c.id,c.tenant_key,c.source_id,c.digest_kind,c.enabled,c.allowed_entities,c.revision,c.source_epoch,
         t.enabled,r.lifecycle,r.current_config_revision
    FROM control.source_credential c
    JOIN control.tenant t ON t.tenant_key=c.tenant_key
    JOIN control.source_registry r ON (r.tenant_key,r.source_id)=(c.tenant_key,c.source_id)
   WHERE c.id=p_credential_id AND c.tenant_key=p_tenant_key AND c.source_id=p_source_id
     AND p_entity = ANY(c.allowed_entities)
   FOR UPDATE OF c,t,r
$function$;

CREATE FUNCTION control.authenticate_source(p_digest bytea)
RETURNS TABLE (credential_id uuid, source_id text, tenant_key text, allowed_entities text[], credential_revision bigint,
  source_epoch bigint, enabled boolean, tenant_enabled boolean)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, control
AS $function$
  SELECT c.id,c.source_id,c.tenant_key,c.allowed_entities,c.revision,c.source_epoch,c.enabled,t.enabled
    FROM control.source_credential c
    JOIN control.credential_digest_registry d ON d.digest=c.digest AND d.kind='source' AND c.digest_kind=d.kind
    JOIN control.tenant t ON t.tenant_key=c.tenant_key
   WHERE c.digest=p_digest
$function$;

CREATE FUNCTION control.upsert_source_credential(p_source_id text,p_tenant_key text,p_digest bytea,p_secret_ref text,
  p_allowed_entities text[],p_enabled boolean,p_revision bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $function$
DECLARE registered integer;
BEGIN
  INSERT INTO control.credential_digest_registry(digest,kind) VALUES(p_digest,'source') ON CONFLICT(digest) DO NOTHING;
  GET DIAGNOSTICS registered = ROW_COUNT;
  IF registered <> 1 THEN RAISE EXCEPTION 'source credential digest is already registered'; END IF;
  INSERT INTO control.source_credential(source_id,tenant_key,digest,digest_kind,secret_ref,allowed_entities,enabled,revision)
    VALUES(p_source_id,p_tenant_key,p_digest,'source',p_secret_ref,p_allowed_entities,p_enabled,p_revision)
  ON CONFLICT(tenant_key,source_id) DO UPDATE SET digest=EXCLUDED.digest,digest_kind='source',secret_ref=EXCLUDED.secret_ref,
    allowed_entities=EXCLUDED.allowed_entities,enabled=EXCLUDED.enabled,revision=EXCLUDED.revision,
    source_epoch=control.source_credential.source_epoch+1;
END;
$function$;

CREATE FUNCTION control.update_source_credential(p_source_id text,p_tenant_key text,p_enabled boolean,p_revision bigint,
  p_allowed_entities text[],p_secret_ref text,p_change_secret boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $function$
DECLARE changed integer;
BEGIN
  UPDATE control.source_credential c SET enabled=p_enabled,revision=p_revision,allowed_entities=p_allowed_entities,
    secret_ref=CASE WHEN p_change_secret THEN p_secret_ref ELSE c.secret_ref END,source_epoch=c.source_epoch+1
   WHERE c.source_id=p_source_id AND c.tenant_key=p_tenant_key AND
    (c.enabled,c.revision,c.allowed_entities) IS DISTINCT FROM (p_enabled,p_revision,p_allowed_entities) OR
    c.source_id=p_source_id AND c.tenant_key=p_tenant_key AND p_change_secret AND c.secret_ref IS DISTINCT FROM p_secret_ref;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$function$;

CREATE FUNCTION control.bump_source_epoch(p_source_id text,p_tenant_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $function$
DECLARE changed integer;
BEGIN
  UPDATE control.source_credential SET source_epoch=source_epoch+1 WHERE source_id=p_source_id AND tenant_key=p_tenant_key;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$function$;

CREATE FUNCTION control.record_tenant_security_disable(p_tenant_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $function$
DECLARE changed integer;
BEGIN
  INSERT INTO control.source_security_barrier(tenant_key,source_id,credential_id,barrier_type,reason_code,created_by)
    SELECT tenant_key,source_id,id,'TENANT_DISABLED','TENANT_DISABLED','system'
      FROM control.source_credential WHERE tenant_key=p_tenant_key;
  UPDATE control.source_credential SET source_epoch=source_epoch+1 WHERE tenant_key=p_tenant_key;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$function$;

CREATE FUNCTION control.record_source_security_barrier(p_source_id text,p_tenant_key text,p_barrier_type text,p_reason_code text,p_entity text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $function$
DECLARE target_id uuid; changed integer;
BEGIN
  SELECT id INTO target_id FROM control.source_credential WHERE tenant_key=p_tenant_key AND source_id=p_source_id FOR UPDATE;
  IF target_id IS NULL THEN RETURN 0; END IF;
  IF p_barrier_type NOT IN ('CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL') THEN RAISE EXCEPTION 'invalid source security barrier type'; END IF;
  INSERT INTO control.source_security_barrier(tenant_key,source_id,credential_id,entity,barrier_type,reason_code,created_by)
    VALUES(p_tenant_key,p_source_id,target_id,p_entity,p_barrier_type,p_reason_code,'system');
  UPDATE control.source_credential SET enabled=false,source_epoch=source_epoch+1 WHERE id=target_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  UPDATE control.source_registry SET lifecycle='PAUSED',updated_at=now() WHERE tenant_key=p_tenant_key AND source_id=p_source_id AND lifecycle='ACTIVE';
  RETURN changed;
END;
$function$;

REVOKE ALL ON FUNCTION control.lock_current_source(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.authenticate_source(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.upsert_source_credential(text,text,bytea,text,text[],boolean,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.update_source_credential(text,text,boolean,bigint,text[],text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.bump_source_epoch(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.record_tenant_security_disable(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.record_source_security_barrier(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.guard_source_channel_identity() FROM PUBLIC;

REVOKE ALL ON control.source_registry,control.source_config_revision,control.source_mapping_revision,
  control.source_identity_mapping_revision,control.source_test_report,control.source_owner_approval,
  control.source_channel,control.source_lifecycle_event,control.source_security_barrier FROM PUBLIC;
REVOKE ALL ON FUNCTION control.lock_current_source(uuid,text,text,text) FROM hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE ALL ON FUNCTION control.guard_source_channel_identity() FROM hub_api,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;

GRANT SELECT (id,source_id,tenant_key,digest_kind,enabled,allowed_entities,revision,source_epoch) ON control.source_credential TO hub_api;
GRANT SELECT (tenant_key,enabled) ON control.tenant TO hub_api;
GRANT UPDATE (enabled) ON control.tenant TO hub_api;
GRANT SELECT (tenant_key,user_id,enabled,management_scopes) ON control.auth_subject TO hub_api;
GRANT UPDATE (enabled) ON control.auth_subject TO hub_api;

GRANT SELECT, INSERT, UPDATE ON control.source_registry TO hub_api;
GRANT SELECT, INSERT ON control.source_config_revision,control.source_mapping_revision,
  control.source_identity_mapping_revision,control.source_test_report,control.source_owner_approval,
  control.source_channel,control.source_lifecycle_event,control.source_security_barrier TO hub_api;
GRANT USAGE, SELECT ON SEQUENCE control.source_lifecycle_event_id_seq,control.source_security_barrier_id_seq TO hub_api;
GRANT EXECUTE ON FUNCTION control.lock_current_source(uuid,text,text,text) TO hub_api;
GRANT EXECUTE ON FUNCTION control.authenticate_source(bytea),control.upsert_source_credential(text,text,bytea,text,text[],boolean,bigint),
  control.update_source_credential(text,text,boolean,bigint,text[],text,boolean),control.bump_source_epoch(text,text),
  control.record_tenant_security_disable(text),control.record_source_security_barrier(text,text,text,text,text) TO hub_api;

-- Runtime principals retain their M0 boundaries; workers receive only the
-- security-fact read needed by the later apply transaction.
GRANT SELECT ON control.source_security_barrier,control.source_channel TO hub_worker;
