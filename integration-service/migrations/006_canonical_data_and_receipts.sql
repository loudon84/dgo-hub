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
  customer_name text NOT NULL,
  owner_user_id text COLLATE "C" NOT NULL,
  dept_id text COLLATE "C" NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  phone text,
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
  order_no text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','COMPLETED','CANCELLED')),
  order_at timestamptz NOT NULL,
  amount numeric(20,2) NOT NULL,
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
  product_name text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,6) NOT NULL,
  line_amount numeric(20,2) NOT NULL,
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
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (channel_id,tenant_key,source_id,entity,channel_epoch,version_domain)
    REFERENCES control.source_channel(id,tenant_key,source_id,entity,channel_epoch,version_domain) ON UPDATE RESTRICT ON DELETE RESTRICT
);

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
        PERFORM 1 FROM hub.canonical_customer c WHERE c.tenant_id=p_tenant AND c.id=v_object_id AND c.deleted_at IS NULL FOR UPDATE;
      END IF;
      IF FOUND THEN
        IF NOT EXISTS(SELECT 1 FROM control.auth_subject s JOIN hub.canonical_customer c
          ON c.tenant_id=p_tenant AND c.id=v_object_id
          WHERE s.tenant_key=p_tenant AND s.user_id=p_target_id AND s.enabled AND s.business_role='sales' AND s.department_id=c.dept_id) THEN
          RAISE EXCEPTION 'eligible owner not found for canonical department' USING ERRCODE='22023';
        END IF;
        UPDATE hub.canonical_customer c SET owner_user_id=p_target_id,hub_revision=nextval('control.canonical_hub_revision_seq')
          WHERE c.tenant_id=p_tenant AND c.id=v_object_id
          RETURNING c.hub_revision,public.digest(convert_to(to_jsonb(c)::text,'UTF8'),'sha256') INTO v_new_revision,v_projection;
        v_count:=v_count+1;
      END IF;
    ELSIF p_kind='department' AND v_row.entity='customer' THEN
      SELECT i.customer_id INTO v_object_id FROM control.canonical_source_identity i
        WHERE i.tenant_key=p_tenant AND i.source_id=p_source AND i.entity=v_row.entity AND i.source_pk=v_row.source_pk;
      IF v_object_id IS NOT NULL THEN
        PERFORM 1 FROM hub.canonical_customer c WHERE c.tenant_id=p_tenant AND c.id=v_object_id AND c.deleted_at IS NULL FOR UPDATE;
      END IF;
      IF FOUND THEN
        UPDATE hub.canonical_customer c SET dept_id=p_target_id,hub_revision=nextval('control.canonical_hub_revision_seq')
          WHERE c.tenant_id=p_tenant AND c.id=v_object_id
          RETURNING c.hub_revision,public.digest(convert_to(to_jsonb(c)::text,'UTF8'),'sha256') INTO v_new_revision,v_projection;
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
          RETURNING o.hub_revision,public.digest(convert_to(to_jsonb(o)::text,'UTF8'),'sha256') INTO v_new_revision,v_projection;
        v_count:=v_count+1;
      END IF;
    END IF;
    UPDATE control.canonical_identity_reference SET target_id=p_target_id
      WHERE tenant_key=p_tenant AND source_id=p_source AND entity=v_row.entity AND source_pk=v_row.source_pk AND kind=p_kind;
    IF v_new_revision IS NOT NULL THEN
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
GRANT EXECUTE ON FUNCTION control.lock_source_credential(text,text) TO hub_worker;
GRANT EXECUTE ON FUNCTION control.lock_security_barrier_fence() TO hub_api,hub_worker;
GRANT EXECUTE ON FUNCTION control.record_source_security_barrier(text,text,text,text,text) TO hub_api;
GRANT EXECUTE ON FUNCTION control.record_tenant_security_disable(text) TO hub_api;
GRANT EXECUTE ON FUNCTION control.upsert_source_credential(text,text,bytea,text,text[],boolean,bigint),
  control.update_source_credential(text,text,boolean,bigint,text[],text,boolean) TO hub_api;

GRANT SELECT ON api.canonical_customer_identity TO hub_api;
GRANT USAGE ON SCHEMA api TO hub_api;
GRANT EXECUTE ON FUNCTION control.remap_canonical_identity(text,text,text,text,text,bigint,text,text) TO hub_api;
