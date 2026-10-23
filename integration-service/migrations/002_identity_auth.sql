CREATE TABLE control.tenant (
  tenant_key text PRIMARY KEY CHECK (tenant_key ~ '^[a-z][a-z0-9_]{0,31}$'),
  enabled boolean NOT NULL DEFAULT true,
  business_timezone text NOT NULL CHECK (length(business_timezone) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION control.prevent_tenant_key_change() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.tenant_key IS DISTINCT FROM OLD.tenant_key THEN
    RAISE EXCEPTION 'tenant key is immutable';
  END IF;
  RETURN NEW;
END;
$body$;

CREATE TRIGGER tenant_key_immutable
BEFORE UPDATE OF tenant_key ON control.tenant
FOR EACH ROW EXECUTE FUNCTION control.prevent_tenant_key_change();

CREATE TABLE control.auth_subject (
  tenant_key text NOT NULL REFERENCES control.tenant(tenant_key) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  department_id text,
  business_role text CHECK (business_role IN ('sales', 'sales_manager')),
  management_scopes text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  auth_epoch bigint NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, user_id),
  CHECK (management_scopes <@ ARRAY[
    'source:read','source:write','source:approve','mapping:write','governance:read','governance:write',
    'ontology:write','ontology:publish','binding:read','binding:write','binding:approve','binding:publish',
    'policy:read','policy:write','policy:approve','policy:publish','policy:revoke','access:preview',
    'agent:read','agent:revoke','audit:read','operation:read','ops:read'
  ]::text[])
);

CREATE TABLE control.identity_binding (
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 2048),
  tenant_key text NOT NULL,
  user_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (tenant_key, user_id) REFERENCES control.auth_subject(tenant_key, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX identity_binding_subject_idx ON control.identity_binding(tenant_key, user_id);

CREATE TABLE control.credential_digest_registry (
  digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
  kind text NOT NULL CHECK (kind IN ('agent','source')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (digest, kind)
);

CREATE FUNCTION control.prevent_credential_digest_reuse() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'credential digest registry is immutable';
END;
$body$;

CREATE TRIGGER credential_digest_registry_immutable
BEFORE UPDATE OR DELETE ON control.credential_digest_registry
FOR EACH ROW EXECUTE FUNCTION control.prevent_credential_digest_reuse();

CREATE TABLE control.agent_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  user_id text NOT NULL,
  digest bytea NOT NULL,
  digest_kind text NOT NULL DEFAULT 'agent' CHECK (digest_kind = 'agent'),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 96),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  credential_epoch bigint NOT NULL DEFAULT 0 CHECK (credential_epoch >= 0),
  FOREIGN KEY (tenant_key, user_id) REFERENCES control.auth_subject(tenant_key, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (digest, digest_kind) REFERENCES control.credential_digest_registry(digest, kind) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (id, tenant_key, user_id)
);
CREATE INDEX agent_credential_owner_order_idx ON control.agent_credential(tenant_key, user_id, created_at DESC, id DESC);
CREATE INDEX agent_credential_active_owner_idx ON control.agent_credential(tenant_key, user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE control.source_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  tenant_key text NOT NULL REFERENCES control.tenant(tenant_key) ON UPDATE RESTRICT ON DELETE RESTRICT,
  digest bytea NOT NULL,
  digest_kind text NOT NULL DEFAULT 'source' CHECK (digest_kind = 'source'),
  secret_ref text NOT NULL CHECK (length(secret_ref) BETWEEN 1 AND 512),
  allowed_entities text[] NOT NULL CHECK (
    cardinality(allowed_entities) > 0 AND
    allowed_entities <@ ARRAY['customer','order']::text[]
  ),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (digest, digest_kind) REFERENCES control.credential_digest_registry(digest, kind) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (id, tenant_key, source_id),
  UNIQUE (tenant_key, source_id)
);
CREATE INDEX source_credential_lookup_idx ON control.source_credential(source_id, tenant_key) WHERE enabled;

CREATE TABLE control.agent_credential_idempotency (
  tenant_key text NOT NULL,
  user_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  credential_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, user_id, idempotency_key),
  FOREIGN KEY (tenant_key, user_id) REFERENCES control.auth_subject(tenant_key, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (credential_id, tenant_key, user_id) REFERENCES control.agent_credential(id, tenant_key, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
