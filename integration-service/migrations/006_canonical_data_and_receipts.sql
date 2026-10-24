ALTER TABLE control.source_security_barrier
  ADD COLUMN effective_fence bigint NOT NULL DEFAULT 0 CHECK (effective_fence >= 0);
CREATE SEQUENCE control.security_barrier_fence_seq AS bigint START WITH 1;

CREATE FUNCTION control.acquire_security_barrier_guard_internal() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
DECLARE fence bigint; allocated boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(1296905544,1);
  SELECT last_value,is_called INTO fence,allocated FROM control.security_barrier_fence_seq;
  IF NOT allocated THEN RETURN 0; END IF;
  RETURN fence;
END;
$body$;

CREATE FUNCTION control.lock_security_barrier_fence() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  RETURN control.acquire_security_barrier_guard_internal();
END;
$body$;

CREATE FUNCTION control.allocate_security_barrier_fence() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN nextval('control.security_barrier_fence_seq');
END;
$body$;

CREATE FUNCTION control.guard_security_fact_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN NULL;
END;
$body$;

CREATE TRIGGER source_credential_security_fence
BEFORE INSERT OR UPDATE OR DELETE ON control.source_credential
FOR EACH STATEMENT EXECUTE FUNCTION control.guard_security_fact_write();
CREATE TRIGGER tenant_security_fence
BEFORE INSERT OR UPDATE OR DELETE ON control.tenant
FOR EACH STATEMENT EXECUTE FUNCTION control.guard_security_fact_write();
CREATE TRIGGER source_channel_security_fence
BEFORE INSERT OR UPDATE OR DELETE ON control.source_channel
FOR EACH STATEMENT EXECUTE FUNCTION control.guard_security_fact_write();
CREATE TRIGGER source_barrier_security_fence
BEFORE INSERT OR UPDATE OR DELETE ON control.source_security_barrier
FOR EACH STATEMENT EXECUTE FUNCTION control.guard_security_fact_write();

CREATE FUNCTION control.assign_source_barrier_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  NEW.effective_fence := nextval('control.security_barrier_fence_seq');
  RETURN NEW;
END;
$body$;
CREATE TRIGGER source_barrier_effective_fence
BEFORE INSERT ON control.source_security_barrier
FOR EACH ROW EXECUTE FUNCTION control.assign_source_barrier_fence();

-- Keep the reviewed 005 implementation private behind a guarded wrapper. The
-- shared transaction guard is acquired before its first credential row lock.
ALTER FUNCTION control.record_source_security_barrier(text,text,text,text,text)
  RENAME TO record_source_security_barrier_unfenced;
CREATE FUNCTION control.record_source_security_barrier(p_source_id text,p_tenant_key text,p_barrier_type text,p_reason_code text,p_entity text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN control.record_source_security_barrier_unfenced(p_source_id,p_tenant_key,p_barrier_type,p_reason_code,p_entity);
END;
$body$;

ALTER FUNCTION control.record_tenant_security_disable(text)
  RENAME TO record_tenant_security_disable_unfenced;
CREATE FUNCTION control.record_tenant_security_disable(p_tenant_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN control.record_tenant_security_disable_unfenced(p_tenant_key);
END;
$body$;

ALTER FUNCTION control.upsert_source_credential(text,text,bytea,text,text[],boolean,bigint)
  RENAME TO upsert_source_credential_unfenced;
CREATE FUNCTION control.upsert_source_credential(p_source_id text,p_tenant_key text,p_digest bytea,p_secret_ref text,
  p_allowed_entities text[],p_enabled boolean,p_revision bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  PERFORM control.upsert_source_credential_unfenced(p_source_id,p_tenant_key,p_digest,p_secret_ref,p_allowed_entities,p_enabled,p_revision);
END;
$body$;

ALTER FUNCTION control.update_source_credential(text,text,boolean,bigint,text[],text,boolean)
  RENAME TO update_source_credential_unfenced;
CREATE FUNCTION control.update_source_credential(p_source_id text,p_tenant_key text,p_enabled boolean,p_revision bigint,
  p_allowed_entities text[],p_secret_ref text,p_change_secret boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN control.update_source_credential_unfenced(p_source_id,p_tenant_key,p_enabled,p_revision,p_allowed_entities,p_secret_ref,p_change_secret);
END;
$body$;

CREATE OR REPLACE FUNCTION control.lock_source_credential(p_tenant_key text,p_source_id text)
RETURNS TABLE(id uuid,enabled boolean,allowed_entities text[],revision bigint,source_epoch bigint,credential_generation bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN QUERY SELECT c.id,c.enabled,c.allowed_entities,c.revision,c.source_epoch,c.credential_generation
    FROM control.source_credential c WHERE c.tenant_key=p_tenant_key AND c.source_id=p_source_id FOR UPDATE OF c;
END;
$body$;

CREATE OR REPLACE FUNCTION control.lock_source_channel(p_tenant_key text,p_source_id text,p_entity text)
RETURNS TABLE(id uuid,connector text,mode text,version_domain text,channel_epoch bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN QUERY SELECT c.id,c.connector,c.mode,c.version_domain,c.channel_epoch
    FROM control.source_channel c
   WHERE c.tenant_key=p_tenant_key AND c.source_id=p_source_id AND c.entity=p_entity AND c.state='active'
   FOR UPDATE OF c;
END;
$body$;

CREATE OR REPLACE FUNCTION control.lock_current_source(p_credential_id uuid,p_tenant_key text,p_source_id text,p_entity text)
RETURNS TABLE (credential_id uuid, tenant_key text, source_id text, digest_kind text, enabled boolean,
  allowed_entities text[], credential_revision bigint, source_epoch bigint, tenant_enabled boolean,
  lifecycle text, config_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN QUERY SELECT c.id,c.tenant_key,c.source_id,c.digest_kind,c.enabled,c.allowed_entities,c.revision,c.source_epoch,
         t.enabled,r.lifecycle,r.current_config_revision
    FROM control.source_credential c
    JOIN control.tenant t ON t.tenant_key=c.tenant_key
    JOIN control.source_registry r ON (r.tenant_key,r.source_id)=(c.tenant_key,c.source_id)
    JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
    JOIN control.source_channel ch ON (ch.tenant_key,ch.source_id,ch.entity)=(r.tenant_key,r.source_id,p_entity) AND ch.state='active'
   WHERE c.id=p_credential_id AND c.tenant_key=p_tenant_key AND c.source_id=p_source_id
     AND c.revision=r.current_config_revision
     AND p_entity = ANY(c.allowed_entities)
     AND cr.config->'allowed_entities' ? p_entity
     AND ch.connector=cr.config->>'connector' AND ch.mode=cr.config->>'mode'
     AND ch.version_domain=cr.config->>'version_domain'
   FOR UPDATE OF c,t,r,ch;
END;
$body$;

ALTER TABLE control.source_channel
  ADD CONSTRAINT source_channel_apply_identity_unique
    UNIQUE (id,tenant_key,source_id,entity,channel_epoch,version_domain);

CREATE SEQUENCE control.canonical_hub_revision_seq AS bigint;

CREATE TABLE hub.canonical_customer (
  tenant_id text COLLATE "C" NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128 AND tenant_id !~ '^[[:space:]]|[[:space:]]$'),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 2048),
  owner_user_id text COLLATE "C" NOT NULL,
  dept_id text COLLATE "C" NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  phone text CHECK (phone IS NULL OR char_length(phone) <= 2048),
  source_updated_at timestamptz NOT NULL,
  source_version numeric(20,0) NOT NULL CHECK (source_version >= 0),
  version_domain text NOT NULL CHECK (version_domain IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')),
  channel_epoch bigint NOT NULL CHECK (channel_epoch > 0),
  deleted_at timestamptz,
  hub_revision bigint NOT NULL CHECK (hub_revision > 0),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES control.auth_subject(tenant_key,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE hub.canonical_order (
  tenant_id text COLLATE "C" NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128 AND tenant_id !~ '^[[:space:]]|[[:space:]]$'),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  order_no text NOT NULL CHECK (length(order_no) BETWEEN 1 AND 128 AND order_no !~ '^[[:space:]]|[[:space:]]$'),
  status text NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','COMPLETED','CANCELLED')),
  order_at timestamptz NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL CHECK (currency IN ('CNY','USD','EUR')),
  source_updated_at timestamptz NOT NULL,
  source_version numeric(20,0) NOT NULL CHECK (source_version >= 0),
  version_domain text NOT NULL CHECK (version_domain IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')),
  channel_epoch bigint NOT NULL CHECK (channel_epoch > 0),
  deleted_at timestamptz,
  hub_revision bigint NOT NULL CHECK (hub_revision > 0),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES hub.canonical_customer(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE hub.canonical_order_line (
  tenant_id text COLLATE "C" NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128 AND tenant_id !~ '^[[:space:]]|[[:space:]]$'),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  source_line_id text COLLATE "C" NOT NULL CHECK (length(source_line_id) BETWEEN 1 AND 128 AND source_line_id !~ '^[[:space:]]|[[:space:]]$'),
  product_code text COLLATE "C" NOT NULL CHECK (length(product_code) BETWEEN 1 AND 128 AND product_code !~ '^[[:space:]]|[[:space:]]$'),
  product_name text NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 2048),
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,6) NOT NULL CHECK (unit_price >= 0),
  line_amount numeric(20,2) NOT NULL CHECK (line_amount >= 0),
  source_updated_at timestamptz NOT NULL,
  source_version numeric(20,0) NOT NULL CHECK (source_version >= 0),
  version_domain text NOT NULL CHECK (version_domain IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')),
  channel_epoch bigint NOT NULL CHECK (channel_epoch > 0),
  deleted_at timestamptz,
  hub_revision bigint NOT NULL CHECK (hub_revision > 0),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,order_id,source_line_id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES hub.canonical_order(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX canonical_order_line_order_idx ON hub.canonical_order_line(tenant_id,order_id);

-- One source/entity key keeps a stable canonical UUID across channel epochs.
CREATE TABLE control.canonical_source_identity (
  tenant_key text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  source_pk text COLLATE "C" NOT NULL CHECK (length(source_pk) BETWEEN 1 AND 128 AND source_pk !~ '^[[:space:]]|[[:space:]]$'),
  canonical_object_id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid,
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key,source_id,entity,source_pk),
  UNIQUE (tenant_key,source_id,entity,source_pk,customer_id,order_id),
  UNIQUE (tenant_key,source_id,entity,source_pk,canonical_object_id),
  CHECK ((entity='customer' AND order_id IS NULL AND (customer_id IS NULL OR customer_id=canonical_object_id)) OR
         (entity='order' AND customer_id IS NULL AND (order_id IS NULL OR order_id=canonical_object_id))),
  FOREIGN KEY (tenant_key,source_id) REFERENCES control.source_registry(tenant_key,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,customer_id) REFERENCES hub.canonical_customer(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,order_id) REFERENCES hub.canonical_order(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- External identity keys are retained beside resolved projections so API-014 can
-- update only rows derived from the explicitly confirmed source identity.
CREATE TABLE control.canonical_identity_reference (
  tenant_key text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  source_pk text COLLATE "C" NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user','department','customer')),
  external_id text COLLATE "C" NOT NULL CHECK (length(external_id) BETWEEN 1 AND 128 AND external_id !~ '^[[:space:]]|[[:space:]]$'),
  target_id text COLLATE "C" NOT NULL,
  PRIMARY KEY (tenant_key,source_id,entity,source_pk,kind),
  FOREIGN KEY (tenant_key,source_id,entity,source_pk) REFERENCES control.canonical_source_identity(tenant_key,source_id,entity,source_pk) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX canonical_identity_reference_key_idx ON control.canonical_identity_reference(tenant_key,source_id,kind,external_id);

CREATE TABLE control.source_version_receipt (
  tenant_key text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  channel_id uuid NOT NULL,
  channel_epoch bigint NOT NULL CHECK (channel_epoch > 0),
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  source_pk text COLLATE "C" NOT NULL CHECK (length(source_pk) BETWEEN 1 AND 128 AND source_pk !~ '^[[:space:]]|[[:space:]]$'),
  version_domain text NOT NULL CHECK (version_domain IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')),
  source_version numeric(20,0) NOT NULL CHECK (source_version >= 0),
  source_content_digest bytea NOT NULL CHECK (octet_length(source_content_digest)=32),
  projection_digest bytea NOT NULL CHECK (octet_length(projection_digest)=32),
  canonical_object_id uuid NOT NULL,
  canonical_customer_id uuid GENERATED ALWAYS AS (CASE WHEN entity='customer' THEN canonical_object_id ELSE NULL::uuid END) STORED,
  canonical_order_id uuid GENERATED ALWAYS AS (CASE WHEN entity='order' THEN canonical_object_id ELSE NULL::uuid END) STORED,
  deleted boolean NOT NULL,
  apply_xid xid8 NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,channel_id,entity,source_pk),
  FOREIGN KEY (channel_id,tenant_key,source_id,entity,channel_epoch,version_domain)
    REFERENCES control.source_channel(id,tenant_key,source_id,entity,channel_epoch,version_domain) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key,source_id,entity,source_pk,canonical_object_id)
    REFERENCES control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id)
    DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX source_version_receipt_object_idx ON control.source_version_receipt(tenant_key,entity,canonical_object_id,committed_at DESC);

CREATE TABLE control.source_identity_remap_fence (
  tenant_key text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user','department','customer')),
  external_id text COLLATE "C" NOT NULL CHECK (length(external_id) BETWEEN 1 AND 128 AND external_id !~ '^[[:space:]]|[[:space:]]$'),
  identity_mapping_revision bigint NOT NULL CHECK (identity_mapping_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_key,source_id,kind,external_id),
  FOREIGN KEY (tenant_key,source_id,identity_mapping_revision)
    REFERENCES control.source_identity_mapping_revision(tenant_key,source_id,revision) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.canonical_ownership_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  source_pk text COLLATE "C" NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user','department','customer')),
  external_id text COLLATE "C" NOT NULL,
  old_target_id text COLLATE "C",
  new_target_id text COLLATE "C" NOT NULL,
  identity_mapping_revision bigint NOT NULL,
  actor_user_id text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_key,source_id,identity_mapping_revision)
    REFERENCES control.source_identity_mapping_revision(tenant_key,source_id,revision) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE control.canonical_apply_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  channel_id uuid NOT NULL,
  channel_epoch bigint NOT NULL,
  version_domain text NOT NULL CHECK (version_domain IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')),
  entity text NOT NULL CHECK (entity IN ('customer','order')),
  canonical_object_id uuid NOT NULL,
  hub_revision bigint NOT NULL,
  operation text NOT NULL CHECK (operation IN ('UPSERT','DELETE','IDENTITY_REMAP')),
  projection_digest bytea NOT NULL CHECK (octet_length(projection_digest)=32),
  source_content_digest bytea CHECK (source_content_digest IS NULL OR octet_length(source_content_digest)=32),
  apply_xid xid8 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (channel_id,tenant_key,source_id,entity,channel_epoch,version_domain)
    REFERENCES control.source_channel(id,tenant_key,source_id,entity,channel_epoch,version_domain) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION control.stamp_canonical_apply_xid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $body$
BEGIN
  NEW.apply_xid:=pg_catalog.pg_current_xact_id();
  RETURN NEW;
END;
$body$;
CREATE TRIGGER source_version_receipt_apply_xid BEFORE INSERT OR UPDATE ON control.source_version_receipt
FOR EACH ROW EXECUTE FUNCTION control.stamp_canonical_apply_xid();
CREATE TRIGGER canonical_apply_outbox_apply_xid BEFORE INSERT ON control.canonical_apply_outbox
FOR EACH ROW EXECUTE FUNCTION control.stamp_canonical_apply_xid();

CREATE FUNCTION control.lock_canonical_owner(p_tenant text,p_user text)
RETURNS TABLE(enabled boolean,business_role text,department_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  RETURN QUERY SELECT s.enabled,s.business_role,s.department_id FROM control.auth_subject s
    WHERE s.tenant_key=p_tenant AND s.user_id=p_user FOR UPDATE;
END;
$body$;

-- One deterministic projection envelope is shared by apply and API-014 remap.
-- Source content carries the complete normalized business image; identity carries
-- only resolved tenant-owned references.
CREATE FUNCTION control.canonical_projection_digest(p_source_digest bytea,p_object_id uuid,p_identity jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public
AS $body$
  SELECT public.digest(convert_to(jsonb_build_object('source_content_digest',encode(p_source_digest,'hex'),
    'canonical_object_id',p_object_id::text,'identity',p_identity)::text,'UTF8'),'sha256')
$body$;

DROP FUNCTION IF EXISTS control.record_canonical_customer_owner_change(text,text,text,text,text,text,text,text,text,bigint,text);
CREATE FUNCTION control.record_canonical_customer_owner_change(p_tenant text,p_source text,p_source_pk text,p_credential_id uuid,
  p_channel_id uuid,p_channel_epoch bigint,p_version_domain text,p_admitted_fence bigint,p_owner_approval_id uuid,
  p_test_report_id uuid,p_mapping_revision bigint,p_changes jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control
AS $body$
DECLARE
  v_actor text;
  v_mappings jsonb;
  v_config jsonb;
  v_fence bigint;
  v_credential_id uuid;
  v_channel_state text;
  v_channel_connector text;
  v_channel_mode text;
  v_channel_domain text;
  v_channel_epoch bigint;
  v_customer_id uuid;
  v_owner text;
  v_department text;
  v_hub_revision bigint;
  v_source_version numeric;
  v_change record;
  v_new_target text;
  v_old_target text;
  v_old_external text;
  v_affected_users text[] := ARRAY[]::text[];
  v_lock_users text[] := ARRAY[]::text[];
  v_user text;
  v_count integer;
  v_needs_apply boolean := false;
  v_apply_xid xid8;
  v_subject_enabled boolean;
  v_subject_role text;
  v_subject_department text;
BEGIN
  v_fence:=control.acquire_security_barrier_guard_internal();
  IF p_credential_id IS NULL OR p_channel_id IS NULL OR p_channel_epoch IS NULL OR p_admitted_fence IS NULL
     OR p_owner_approval_id IS NULL OR p_test_report_id IS NULL OR p_admitted_fence<0 OR p_admitted_fence>v_fence OR p_mapping_revision<=0
     OR p_version_domain NOT IN ('SOURCE_VERSION','SNAPSHOT_OBSERVATION')
     OR coalesce(jsonb_typeof(p_changes)<>'array',true) OR jsonb_array_length(p_changes)=0
     OR jsonb_array_length(p_changes)>2
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) e
       WHERE jsonb_typeof(e)<>'object' OR NOT (e ? 'kind') OR NOT (e ? 'external_id')
         OR (e - 'kind' - 'external_id')<>'{}'::jsonb
         OR e->>'kind' NOT IN ('user','department') OR coalesce(e->>'external_id','')='')
     OR (SELECT count(DISTINCT e->>'kind') FROM jsonb_array_elements(p_changes) e)<>
        (SELECT count(*) FROM jsonb_array_elements(p_changes)) THEN
    RAISE EXCEPTION 'invalid source ownership change proof' USING ERRCODE='42501';
  END IF;

  -- The caller's ordinary source job remains authorized by its immutable
  -- approval/report/mapping tuple. Current Data Owner changes are admission
  -- changes and do not cancel this already accepted proof.
  SELECT a.owner_user_id,m.mappings,c.config INTO v_actor,v_mappings,v_config
    FROM control.source_owner_approval a
    JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id)=(a.test_report_id,a.tenant_key,a.source_id)
    JOIN control.source_identity_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=
      (a.tenant_key,a.source_id,a.identity_mapping_revision)
    JOIN control.source_config_revision c ON (c.tenant_key,c.source_id,c.revision)=(a.tenant_key,a.source_id,a.config_revision)
   WHERE a.id=p_owner_approval_id AND a.test_report_id=p_test_report_id
     AND a.tenant_key=p_tenant AND a.source_id=p_source AND a.identity_mapping_revision=p_mapping_revision
     AND t.status='PASS' AND t.config_revision=a.config_revision AND t.mapping_revision=a.mapping_revision
     AND t.identity_mapping_revision=a.identity_mapping_revision
     AND t.config_digest=a.config_digest AND t.mapping_digest=a.mapping_digest
     AND t.identity_mapping_digest=a.identity_mapping_digest
     AND t.source_credential_revision=a.source_credential_revision
     AND t.credential_generation=a.credential_generation
     AND t.endpoint_profile_digest=a.endpoint_profile_digest AND t.data_contract_ref=a.data_contract_ref
     AND m.mapping_digest=a.identity_mapping_digest AND c.config_digest=a.config_digest;
  IF NOT FOUND OR v_actor IS NULL OR jsonb_typeof(v_mappings)<>'array' OR jsonb_typeof(v_config)<>'object' THEN
    RAISE EXCEPTION 'approved source ownership mapping required' USING ERRCODE='42501';
  END IF;

  SELECT id INTO v_credential_id FROM control.lock_source_credential(p_tenant,p_source);
  IF v_credential_id IS DISTINCT FROM p_credential_id THEN
    RAISE EXCEPTION 'source credential proof does not match' USING ERRCODE='42501';
  END IF;
  SELECT state,connector,mode,version_domain,channel_epoch INTO
    v_channel_state,v_channel_connector,v_channel_mode,v_channel_domain,v_channel_epoch
    FROM control.source_channel WHERE id=p_channel_id AND tenant_key=p_tenant AND source_id=p_source AND entity='customer';
  IF NOT FOUND OR v_channel_state<>'active' OR v_channel_epoch<>p_channel_epoch OR v_channel_domain<>p_version_domain
     OR v_channel_connector IS DISTINCT FROM v_config->>'connector' OR v_channel_mode IS DISTINCT FROM v_config->>'mode'
     OR v_channel_domain IS DISTINCT FROM v_config->>'version_domain' THEN
    RAISE EXCEPTION 'source channel proof does not match' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM control.source_security_barrier b
     WHERE b.tenant_key=p_tenant AND b.effective_fence>p_admitted_fence
       AND (b.source_id IS NULL OR b.source_id=p_source)
       AND (b.credential_id IS NULL OR b.credential_id=p_credential_id)
       AND (b.entity IS NULL OR b.entity='customer')
       AND (b.channel_id IS NULL OR b.channel_id=p_channel_id)
       AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED')) THEN
    RAISE EXCEPTION 'security barrier blocks source ownership change' USING ERRCODE='42501';
  END IF;

  SELECT i.customer_id,c.owner_user_id,c.dept_id,c.hub_revision,c.source_version
    INTO v_customer_id,v_owner,v_department,v_hub_revision,v_source_version
    FROM control.canonical_source_identity i
    JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(i.tenant_key,i.customer_id)
   WHERE i.tenant_key=p_tenant AND i.source_id=p_source AND i.entity='customer' AND i.source_pk=p_source_pk
   FOR UPDATE OF i,c;
  IF NOT FOUND OR v_customer_id IS NULL THEN
    RAISE EXCEPTION 'source ownership change has no canonical customer' USING ERRCODE='42501';
  END IF;

  -- Resolve and lock every affected identity reference before deciding whether
  -- this is an already-consumed replay or a new apply effect.
  FOR v_change IN SELECT e->>'kind' AS kind,e->>'external_id' AS external_id FROM jsonb_array_elements(p_changes) e
  LOOP
    IF EXISTS(SELECT 1 FROM control.source_identity_remap_fence f
        WHERE f.tenant_key=p_tenant AND f.source_id=p_source AND f.kind=v_change.kind AND f.external_id=v_change.external_id
          AND f.identity_mapping_revision>p_mapping_revision) THEN
      RAISE EXCEPTION 'identity mapping was superseded' USING ERRCODE='42501';
    END IF;
    SELECT count(*),min(e->>'target_id') INTO v_count,v_new_target
      FROM jsonb_array_elements(v_mappings) e
     WHERE e->>'kind'=v_change.kind AND e->>'external_id'=v_change.external_id;
    IF v_count<>1 OR v_new_target IS NULL THEN
      RAISE EXCEPTION 'approved source ownership mapping required' USING ERRCODE='42501';
    END IF;
    SELECT r.external_id,r.target_id INTO v_old_external,v_old_target
      FROM control.canonical_identity_reference r
     WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.entity='customer' AND r.source_pk=p_source_pk
       AND r.kind=v_change.kind
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source ownership reference missing' USING ERRCODE='42501'; END IF;

    IF (v_change.kind='user' AND v_owner<>v_new_target) OR
       (v_change.kind='department' AND v_department<>v_new_target) THEN
      RAISE EXCEPTION 'source ownership change does not match current projection' USING ERRCODE='42501';
    END IF;

    IF v_change.kind='user' THEN
      v_lock_users:=array_append(v_lock_users,v_new_target);
      IF v_old_target IS DISTINCT FROM v_new_target THEN
        v_lock_users:=array_append(v_lock_users,v_old_target);
        v_affected_users:=array_append(v_affected_users,v_old_target);
        v_affected_users:=array_append(v_affected_users,v_new_target);
      END IF;
    ELSE
      v_lock_users:=array_append(v_lock_users,v_owner);
      IF v_old_target IS DISTINCT FROM v_new_target THEN
        v_affected_users:=array_append(v_affected_users,v_owner);
      END IF;
    END IF;
    IF v_old_external IS DISTINCT FROM v_change.external_id OR v_old_target IS DISTINCT FROM v_new_target THEN
      v_needs_apply:=true;
    END IF;
  END LOOP;

  -- An exact replay after the reference was already consumed has no permission
  -- effects and remains safe without asking for a fresh apply artifact.
  IF NOT v_needs_apply THEN RETURN; END IF;

  v_apply_xid:=pg_catalog.pg_current_xact_id();
  IF NOT EXISTS(
    SELECT 1 FROM control.source_version_receipt r
    JOIN control.canonical_apply_outbox o ON (o.tenant_key,o.source_id,o.channel_id,o.entity,o.canonical_object_id,
      o.hub_revision,o.projection_digest,o.source_content_digest)=(r.tenant_key,r.source_id,r.channel_id,r.entity,
      r.canonical_object_id,v_hub_revision,r.projection_digest,r.source_content_digest)
    WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.channel_id=p_channel_id AND r.entity='customer'
      AND r.source_pk=p_source_pk AND r.canonical_object_id=v_customer_id AND r.source_version=v_source_version
      AND NOT r.deleted AND r.apply_xid=v_apply_xid AND o.apply_xid=v_apply_xid AND o.operation='UPSERT'
      AND r.projection_digest=control.canonical_projection_digest(r.source_content_digest,v_customer_id,
        jsonb_build_object('owner_user_id',v_owner,'department_id',v_department))
  ) THEN
    RAISE EXCEPTION 'source ownership change has no current canonical apply' USING ERRCODE='42501';
  END IF;

  -- Lock all affected authorization subjects in one stable order before
  -- relying on their eligibility. M0 changes serialize on these same rows.
  FOR v_user IN SELECT DISTINCT u COLLATE "C" AS u FROM unnest(v_lock_users) AS affected(u) ORDER BY u
  LOOP
    PERFORM 1 FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'affected owner subject missing' USING ERRCODE='42501'; END IF;
  END LOOP;

  FOR v_change IN SELECT e->>'kind' AS kind,e->>'external_id' AS external_id FROM jsonb_array_elements(p_changes) e
  LOOP
    SELECT min(e->>'target_id') INTO v_new_target FROM jsonb_array_elements(v_mappings) e
     WHERE e->>'kind'=v_change.kind AND e->>'external_id'=v_change.external_id;
    IF v_change.kind='user' THEN
      SELECT enabled,business_role,department_id INTO v_subject_enabled,v_subject_role,v_subject_department
        FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_new_target;
      IF NOT FOUND OR NOT v_subject_enabled OR v_subject_role<>'sales' OR v_subject_department IS DISTINCT FROM v_department THEN
        RAISE EXCEPTION 'eligible owner not found' USING ERRCODE='42501';
      END IF;
    ELSE
      SELECT enabled,business_role,department_id INTO v_subject_enabled,v_subject_role,v_subject_department
        FROM control.auth_subject WHERE tenant_key=p_tenant AND user_id=v_owner;
      IF NOT FOUND OR NOT v_subject_enabled OR v_subject_role<>'sales' OR v_subject_department IS DISTINCT FROM v_new_target THEN
        RAISE EXCEPTION 'eligible owner not found' USING ERRCODE='42501';
      END IF;
    END IF;
    SELECT r.external_id,r.target_id INTO v_old_external,v_old_target
      FROM control.canonical_identity_reference r
     WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.entity='customer' AND r.source_pk=p_source_pk
       AND r.kind=v_change.kind;
    IF NOT FOUND THEN RAISE EXCEPTION 'source ownership reference missing' USING ERRCODE='42501'; END IF;

    IF v_old_target<>v_new_target THEN
      INSERT INTO control.canonical_ownership_audit(tenant_key,source_id,entity,source_pk,kind,external_id,old_target_id,new_target_id,
        identity_mapping_revision,actor_user_id,reason)
        VALUES(p_tenant,p_source,'customer',p_source_pk,v_change.kind,v_change.external_id,v_old_target,v_new_target,
          p_mapping_revision,v_actor,'source projection changed ownership');
    END IF;
    UPDATE control.canonical_identity_reference SET external_id=v_change.external_id,target_id=v_new_target
     WHERE tenant_key=p_tenant AND source_id=p_source AND entity='customer' AND source_pk=p_source_pk AND kind=v_change.kind;
  END LOOP;

  FOR v_user IN SELECT DISTINCT u FROM unnest(v_affected_users) AS affected(u) ORDER BY u
  LOOP
    UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=p_tenant AND user_id=v_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'affected owner subject missing' USING ERRCODE='42501'; END IF;
  END LOOP;
END;
$body$;

CREATE FUNCTION control.reject_canonical_outbox_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $body$
BEGIN
  RAISE EXCEPTION 'canonical apply outbox is immutable';
END;
$body$;
CREATE TRIGGER canonical_apply_outbox_immutable BEFORE UPDATE OR DELETE ON control.canonical_apply_outbox
FOR EACH ROW EXECUTE FUNCTION control.reject_canonical_outbox_mutation();

CREATE VIEW api.canonical_customer AS
  SELECT tenant_id,id,customer_name,owner_user_id,dept_id,status,phone,source_updated_at,source_version,version_domain,channel_epoch,deleted_at,hub_revision
  FROM hub.canonical_customer;
CREATE VIEW api.canonical_order AS
  SELECT tenant_id,id,customer_id,order_no,status,order_at,amount,currency,source_updated_at,source_version,version_domain,channel_epoch,deleted_at,hub_revision
  FROM hub.canonical_order;
CREATE VIEW api.canonical_order_line AS
  SELECT tenant_id,id,order_id,source_line_id,product_code,product_name,quantity,unit_price,line_amount,source_updated_at,source_version,version_domain,channel_epoch,deleted_at,hub_revision
  FROM hub.canonical_order_line;
CREATE VIEW api.canonical_customer_identity AS
  SELECT tenant_id,id,customer_name,status FROM hub.canonical_customer WHERE deleted_at IS NULL;

-- API-014 delegates the immediate source-owned correction to this narrow
-- SECURITY DEFINER function. The caller writes the immutable mapping revision
-- first, then this function fences old accepted applications and projects the
-- explicit correction in the same transaction.
CREATE FUNCTION control.remap_canonical_identity(p_tenant text,p_source text,p_kind text,p_external_id text,
  p_target_id text,p_revision bigint,p_actor text,p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, control, hub
AS $body$
DECLARE
  v_count integer := 0;
  v_row record;
  v_owner text;
  v_new_revision bigint;
  v_object_id uuid;
  v_channel record;
  v_projection bytea;
  v_current_owner text;
  v_current_dept text;
BEGIN
  IF p_kind NOT IN ('user','department','customer') OR p_revision <= 0 OR
     p_external_id IS NULL OR length(p_external_id) NOT BETWEEN 1 AND 128 OR
     p_external_id ~ '^[[:space:]]|[[:space:]]$' OR p_target_id IS NULL OR length(p_target_id) NOT BETWEEN 1 AND 128 OR
     p_target_id ~ '^[[:space:]]|[[:space:]]$' OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid identity remap request' USING ERRCODE='22023';
  END IF;
  PERFORM control.acquire_security_barrier_guard_internal();
  SELECT r.data_owner_user_id INTO v_owner FROM control.source_registry r
    JOIN control.auth_subject a ON (a.tenant_key,a.user_id)=(r.tenant_key,r.data_owner_user_id)
   WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.data_owner_user_id=p_actor
     AND a.enabled AND 'source:approve'=ANY(a.management_scopes) FOR UPDATE OF r,a;
  IF NOT FOUND THEN RAISE EXCEPTION 'source approval authority required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM control.source_identity_mapping_revision m
    WHERE m.tenant_key=p_tenant AND m.source_id=p_source AND m.revision=p_revision
      AND m.mappings @> jsonb_build_array(jsonb_build_object('kind',p_kind,'external_id',p_external_id,'target_id',p_target_id))) THEN
    RAISE EXCEPTION 'mapping revision does not contain confirmed target' USING ERRCODE='22023';
  END IF;
  IF p_kind='user' AND NOT EXISTS(SELECT 1 FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.user_id=p_target_id AND s.enabled) THEN
    RAISE EXCEPTION 'eligible user not found' USING ERRCODE='22023';
  ELSIF p_kind='department' AND NOT EXISTS(SELECT 1 FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.department_id=p_target_id AND s.enabled) THEN
    RAISE EXCEPTION 'eligible department not found' USING ERRCODE='22023';
  ELSIF p_kind='customer' AND NOT EXISTS(SELECT 1 FROM hub.canonical_customer c WHERE c.tenant_id=p_tenant AND c.id::text=p_target_id AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'eligible customer not found' USING ERRCODE='22023';
  END IF;
  INSERT INTO control.source_identity_remap_fence(tenant_key,source_id,kind,external_id,identity_mapping_revision)
    VALUES(p_tenant,p_source,p_kind,p_external_id,p_revision)
    ON CONFLICT(tenant_key,source_id,kind,external_id) DO UPDATE SET identity_mapping_revision=EXCLUDED.identity_mapping_revision,created_at=clock_timestamp();

  FOR v_row IN SELECT r.entity,r.source_pk,r.target_id FROM control.canonical_identity_reference r
    WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.kind=p_kind AND r.external_id=p_external_id
      AND r.target_id<>p_target_id
  LOOP
    INSERT INTO control.canonical_ownership_audit(tenant_key,source_id,entity,source_pk,kind,external_id,old_target_id,new_target_id,
      identity_mapping_revision,actor_user_id,reason)
      VALUES(p_tenant,p_source,v_row.entity,v_row.source_pk,p_kind,p_external_id,v_row.target_id,p_target_id,p_revision,p_actor,btrim(p_reason));
    IF p_kind='user' AND v_row.entity='customer' THEN
      SELECT i.customer_id INTO v_object_id FROM control.canonical_source_identity i
        WHERE i.tenant_key=p_tenant AND i.source_id=p_source AND i.entity=v_row.entity AND i.source_pk=v_row.source_pk;
      IF v_object_id IS NOT NULL THEN
        SELECT c.owner_user_id,c.dept_id INTO v_current_owner,v_current_dept FROM hub.canonical_customer c
          WHERE c.tenant_id=p_tenant AND c.id=v_object_id AND c.deleted_at IS NULL;
        IF FOUND THEN
          PERFORM s.user_id FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.user_id IN (v_current_owner,p_target_id)
            ORDER BY s.user_id FOR UPDATE;
          IF NOT EXISTS(SELECT 1 FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.user_id=p_target_id
            AND s.enabled AND s.business_role='sales' AND s.department_id=v_current_dept) THEN
            RAISE EXCEPTION 'eligible owner not found for canonical department' USING ERRCODE='22023';
          END IF;
        END IF;
        PERFORM 1 FROM hub.canonical_customer c WHERE c.tenant_id=p_tenant AND c.id=v_object_id AND c.deleted_at IS NULL FOR UPDATE;
      END IF;
      IF FOUND THEN
        UPDATE hub.canonical_customer c SET owner_user_id=p_target_id,hub_revision=nextval('control.canonical_hub_revision_seq')
          WHERE c.tenant_id=p_tenant AND c.id=v_object_id
          RETURNING c.hub_revision INTO v_new_revision;
        v_count:=v_count+1;
      END IF;
    ELSIF p_kind='department' AND v_row.entity='customer' THEN
      SELECT i.customer_id INTO v_object_id FROM control.canonical_source_identity i
        WHERE i.tenant_key=p_tenant AND i.source_id=p_source AND i.entity=v_row.entity AND i.source_pk=v_row.source_pk;
      IF v_object_id IS NOT NULL THEN
        SELECT c.owner_user_id INTO v_current_owner FROM hub.canonical_customer c
          WHERE c.tenant_id=p_tenant AND c.id=v_object_id AND c.deleted_at IS NULL;
        IF FOUND THEN
          PERFORM s.user_id FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.user_id=v_current_owner
            FOR UPDATE;
          IF NOT EXISTS(SELECT 1 FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.user_id=v_current_owner
            AND s.enabled AND s.business_role='sales' AND s.department_id=p_target_id) THEN
            RAISE EXCEPTION 'confirmed department does not match current customer owner authority' USING ERRCODE='22023';
          END IF;
        END IF;
        PERFORM 1 FROM hub.canonical_customer c WHERE c.tenant_id=p_tenant AND c.id=v_object_id AND c.deleted_at IS NULL FOR UPDATE;
      END IF;
      IF FOUND THEN
        UPDATE hub.canonical_customer c SET dept_id=p_target_id,hub_revision=nextval('control.canonical_hub_revision_seq')
          WHERE c.tenant_id=p_tenant AND c.id=v_object_id
          RETURNING c.hub_revision INTO v_new_revision;
        v_count:=v_count+1;
      END IF;
    ELSIF p_kind='customer' AND v_row.entity='order' THEN
      SELECT i.order_id INTO v_object_id FROM control.canonical_source_identity i
        WHERE i.tenant_key=p_tenant AND i.source_id=p_source AND i.entity=v_row.entity AND i.source_pk=v_row.source_pk;
      IF v_object_id IS NOT NULL THEN
        PERFORM 1 FROM hub.canonical_order o WHERE o.tenant_id=p_tenant AND o.id=v_object_id AND o.deleted_at IS NULL FOR UPDATE;
      END IF;
      IF FOUND THEN
        UPDATE hub.canonical_order o SET customer_id=p_target_id::uuid,hub_revision=nextval('control.canonical_hub_revision_seq')
          WHERE o.tenant_id=p_tenant AND o.id=v_object_id
          RETURNING o.hub_revision INTO v_new_revision;
        v_count:=v_count+1;
      END IF;
    END IF;
    UPDATE control.canonical_identity_reference SET target_id=p_target_id
      WHERE tenant_key=p_tenant AND source_id=p_source AND entity=v_row.entity AND source_pk=v_row.source_pk AND kind=p_kind;
    IF v_new_revision IS NOT NULL THEN
      SELECT control.canonical_projection_digest(r.source_content_digest,v_object_id,
        CASE WHEN v_row.entity='customer' THEN jsonb_build_object('owner_user_id',c.owner_user_id,'department_id',c.dept_id)
             ELSE jsonb_build_object('customer_id',o.customer_id::text) END)
        INTO v_projection
        FROM control.source_version_receipt r
        LEFT JOIN hub.canonical_customer c ON v_row.entity='customer' AND c.tenant_id=r.tenant_key AND c.id=v_object_id
        LEFT JOIN hub.canonical_order o ON v_row.entity='order' AND o.tenant_id=r.tenant_key AND o.id=v_object_id
        WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.entity=v_row.entity AND r.canonical_object_id=v_object_id
        ORDER BY r.committed_at DESC LIMIT 1;
      SELECT r.channel_id,r.channel_epoch,r.version_domain INTO v_channel FROM control.source_version_receipt r
        WHERE r.tenant_key=p_tenant AND r.source_id=p_source AND r.entity=v_row.entity AND r.canonical_object_id=v_object_id
        ORDER BY r.committed_at DESC LIMIT 1;
      IF FOUND THEN
        INSERT INTO control.canonical_apply_outbox(tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,
          canonical_object_id,hub_revision,operation,projection_digest,source_content_digest)
          VALUES(p_tenant,p_source,v_channel.channel_id,v_channel.channel_epoch,v_channel.version_domain,v_row.entity,
            v_object_id,v_new_revision,'IDENTITY_REMAP',v_projection,NULL);
      END IF;
    END IF;
    v_new_revision:=NULL;
  END LOOP;
  UPDATE control.auth_subject s SET auth_epoch=s.auth_epoch+1 WHERE s.tenant_key=p_tenant AND s.user_id IN (
    SELECT a.old_target_id FROM control.canonical_ownership_audit a
      WHERE a.tenant_key=p_tenant AND a.source_id=p_source AND a.kind='user' AND a.external_id=p_external_id AND a.identity_mapping_revision=p_revision
    UNION SELECT a.new_target_id FROM control.canonical_ownership_audit a
      WHERE a.tenant_key=p_tenant AND a.source_id=p_source AND a.kind='user' AND a.external_id=p_external_id AND a.identity_mapping_revision=p_revision
    UNION SELECT c.owner_user_id FROM control.canonical_ownership_audit a
      JOIN control.canonical_source_identity i ON (i.tenant_key,i.source_id,i.entity,i.source_pk)=(a.tenant_key,a.source_id,'customer',a.source_pk)
      JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(i.tenant_key,i.customer_id)
      WHERE a.tenant_key=p_tenant AND a.source_id=p_source AND a.kind='department' AND a.external_id=p_external_id AND a.identity_mapping_revision=p_revision
    UNION SELECT c.owner_user_id FROM control.canonical_ownership_audit a
      JOIN hub.canonical_customer c ON c.tenant_id=p_tenant AND c.id::text IN (a.old_target_id,a.new_target_id)
      WHERE a.tenant_key=p_tenant AND a.source_id=p_source AND a.kind='customer' AND a.external_id=p_external_id AND a.identity_mapping_revision=p_revision
  );
  RETURN v_count;
END;
$body$;

REVOKE ALL ON hub.canonical_customer,hub.canonical_order,hub.canonical_order_line,
  control.canonical_source_identity,control.canonical_identity_reference,control.source_version_receipt,
  control.source_identity_remap_fence,control.canonical_ownership_audit,control.canonical_apply_outbox FROM PUBLIC;
REVOKE ALL ON SEQUENCE control.canonical_hub_revision_seq,control.canonical_ownership_audit_id_seq,control.canonical_apply_outbox_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION control.reject_canonical_outbox_mutation() FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE ALL ON FUNCTION control.stamp_canonical_apply_xid() FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE ALL ON FUNCTION control.canonical_projection_digest(bytea,uuid,jsonb) FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.lock_canonical_owner(text,text) FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.record_canonical_customer_owner_change(text,text,text,uuid,uuid,bigint,text,bigint,uuid,uuid,bigint,jsonb)
  FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_hasura_read;
REVOKE ALL ON FUNCTION control.remap_canonical_identity(text,text,text,text,text,bigint,text,text) FROM PUBLIC,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE ALL ON FUNCTION control.acquire_security_barrier_guard_internal(),control.allocate_security_barrier_fence(),
  control.guard_security_fact_write(),control.assign_source_barrier_fence() FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE ALL ON FUNCTION control.record_source_security_barrier_unfenced(text,text,text,text,text) FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE ALL ON FUNCTION control.record_tenant_security_disable_unfenced(text) FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE ALL ON FUNCTION control.record_source_security_barrier(text,text,text,text,text),
  control.record_tenant_security_disable(text),
  control.upsert_source_credential_unfenced(text,text,bytea,text,text[],boolean,bigint),
  control.update_source_credential_unfenced(text,text,boolean,bigint,text[],text,boolean)
  FROM PUBLIC,hub_api,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE ALL ON FUNCTION control.record_source_security_barrier(text,text,text,text,text),
  control.upsert_source_credential(text,text,bytea,text,text[],boolean,bigint),
  control.update_source_credential(text,text,boolean,bigint,text[],text,boolean)
  FROM PUBLIC,hub_mcp,hub_publisher,hub_worker,hub_hasura_read;
REVOKE INSERT ON control.source_security_barrier FROM hub_api;

GRANT USAGE ON SCHEMA hub,control TO hub_worker;
GRANT SELECT,INSERT,UPDATE ON hub.canonical_customer,hub.canonical_order TO hub_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON hub.canonical_order_line TO hub_worker;
GRANT SELECT,INSERT,UPDATE ON control.canonical_source_identity,control.canonical_identity_reference,
  control.source_version_receipt TO hub_worker;
GRANT SELECT,INSERT ON control.canonical_apply_outbox TO hub_worker;
GRANT USAGE,SELECT ON SEQUENCE control.canonical_hub_revision_seq,control.canonical_apply_outbox_id_seq TO hub_worker;
GRANT SELECT ON control.source_config_revision,control.source_mapping_revision,control.source_identity_mapping_revision,
  control.source_test_report,control.source_owner_approval,control.source_channel,control.source_security_barrier TO hub_worker;
GRANT SELECT (tenant_key,source_id,kind,external_id,identity_mapping_revision) ON control.source_identity_remap_fence TO hub_worker;
GRANT EXECUTE ON FUNCTION control.lock_source_credential(text,text) TO hub_worker;
GRANT EXECUTE ON FUNCTION control.lock_security_barrier_fence() TO hub_api,hub_worker;
GRANT EXECUTE ON FUNCTION control.canonical_projection_digest(bytea,uuid,jsonb) TO hub_worker;
GRANT EXECUTE ON FUNCTION control.lock_canonical_owner(text,text) TO hub_worker;
GRANT EXECUTE ON FUNCTION control.record_canonical_customer_owner_change(text,text,text,uuid,uuid,bigint,text,bigint,uuid,uuid,bigint,jsonb) TO hub_worker;
GRANT EXECUTE ON FUNCTION control.record_source_security_barrier(text,text,text,text,text) TO hub_api;
GRANT EXECUTE ON FUNCTION control.record_tenant_security_disable(text) TO hub_api;
GRANT EXECUTE ON FUNCTION control.upsert_source_credential(text,text,bytea,text,text[],boolean,bigint),
  control.update_source_credential(text,text,boolean,bigint,text[],text,boolean) TO hub_api;

GRANT SELECT ON api.canonical_customer_identity TO hub_api;
GRANT USAGE ON SCHEMA api TO hub_api;
GRANT EXECUTE ON FUNCTION control.remap_canonical_identity(text,text,text,text,text,bigint,text,text) TO hub_api;
