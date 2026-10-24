DO $roles$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['hub_api','hub_worker','hub_publisher','hub_mcp','hub_hasura_read'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END
$roles$;

CREATE FUNCTION control.lock_api_identity(p_issuer text, p_subject text)
RETURNS TABLE (
  tenant_key text,
  user_id text,
  department_id text,
  business_role text,
  management_scopes text[],
  auth_epoch bigint,
  enabled boolean,
  tenant_enabled boolean,
  business_timezone text,
  issuer text,
  subject text,
  binding_enabled boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $function$
  SELECT s.tenant_key, s.user_id, s.department_id, s.business_role, s.management_scopes,
         s.auth_epoch, s.enabled, t.enabled, t.business_timezone, b.issuer, b.subject, b.enabled
    FROM control.identity_binding AS b
    JOIN control.auth_subject AS s ON (s.tenant_key, s.user_id) = (b.tenant_key, b.user_id)
    JOIN control.tenant AS t ON t.tenant_key = s.tenant_key
   WHERE b.issuer = p_issuer AND b.subject = p_subject
   FOR UPDATE OF b, s, t
$function$;

CREATE FUNCTION control.lock_agent_credential_idempotency(p_tenant_key text, p_user_id text, p_idempotency_key text)
RETURNS TABLE (request_digest bytea, credential_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $function$
  SELECT i.request_digest, i.credential_id
    FROM control.agent_credential_idempotency AS i
   WHERE i.tenant_key = p_tenant_key AND i.user_id = p_user_id AND i.idempotency_key = p_idempotency_key
   FOR UPDATE
$function$;

CREATE FUNCTION control.close_query_gate()
RETURNS TABLE (state text, epoch bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $function$
  UPDATE control.query_gate
     SET state = 'closed', epoch = epoch + 1, changed_at = now()
   WHERE id = 1
   RETURNING state, epoch
$function$;

REVOKE ALL ON FUNCTION control.lock_api_identity(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.lock_agent_credential_idempotency(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.close_query_gate() FROM PUBLIC;

REVOKE ALL ON SCHEMA control, hub, api FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA control, hub, api REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA control, hub, api REVOKE ALL ON SEQUENCES FROM PUBLIC;
GRANT USAGE ON SCHEMA control TO hub_api, hub_mcp, hub_publisher;
GRANT USAGE ON SCHEMA api TO hub_hasura_read;

REVOKE ALL ON ALL TABLES IN SCHEMA control, hub, api FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control, hub, api FROM PUBLIC;

GRANT SELECT (tenant_key, enabled, business_timezone) ON control.tenant TO hub_api, hub_mcp;
GRANT SELECT (tenant_key, user_id, department_id, business_role, management_scopes, auth_epoch, enabled)
  ON control.auth_subject TO hub_api, hub_mcp;
GRANT SELECT (issuer, subject, tenant_key, user_id, enabled) ON control.identity_binding TO hub_api, hub_mcp;
GRANT SELECT (id, tenant_key, user_id, purpose, created_at, expires_at, revoked_at, credential_epoch)
  ON control.agent_credential TO hub_api;
GRANT SELECT (digest) ON control.credential_digest_registry TO hub_api;
GRANT INSERT (digest, kind) ON control.credential_digest_registry TO hub_api;
GRANT INSERT (tenant_key, user_id, digest, digest_kind, purpose, expires_at) ON control.agent_credential TO hub_api;
GRANT UPDATE (revoked_at, credential_epoch) ON control.agent_credential TO hub_api;
GRANT UPDATE (auth_epoch) ON control.auth_subject TO hub_api;
GRANT INSERT (tenant_key, user_id, idempotency_key, request_digest, credential_id)
  ON control.agent_credential_idempotency TO hub_api;
GRANT EXECUTE ON FUNCTION control.lock_api_identity(text, text) TO hub_api;
GRANT EXECUTE ON FUNCTION control.lock_agent_credential_idempotency(text, text, text) TO hub_api;

GRANT SELECT (digest, kind) ON control.credential_digest_registry TO hub_mcp;
GRANT SELECT (id, credential_epoch, expires_at, revoked_at, digest, digest_kind, tenant_key, user_id)
  ON control.agent_credential TO hub_mcp;
GRANT SELECT (id, state, epoch) ON control.query_gate TO hub_mcp;
GRANT INSERT (tenant_id, user_id, tool_name, outcome, error_code, duration_ms, request_id, credential_id,
  auth_epoch, gate_epoch, result_count, args_digest, protocol_version, binding_version, policy_version, stage)
  ON control.agent_audit TO hub_mcp;
GRANT USAGE ON SEQUENCE control.agent_audit_id_seq TO hub_mcp;

GRANT EXECUTE ON FUNCTION control.close_query_gate() TO hub_publisher;

GRANT SELECT (id, source_id, tenant_id, owner_user_id, name, email_masked, phone_masked, deleted) ON api.customer TO hub_hasura_read;
GRANT SELECT (id, source_id, customer_id, tenant_id, owner_user_id, total, status, deleted, updated_at) ON api.sales_order TO hub_hasura_read;
GRANT SELECT (id, order_id, tenant_id, owner_user_id, sku, quantity, unit_price) ON api.order_item TO hub_hasura_read;
GRANT SELECT (tenant_id, owner_user_id, order_count, total) ON api.sales_summary TO hub_hasura_read;
GRANT SELECT (tenant_id, owner_user_id, customer_id, total) ON api.customer_sales TO hub_hasura_read;
