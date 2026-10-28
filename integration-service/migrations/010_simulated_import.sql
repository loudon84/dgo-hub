ALTER TABLE control.source_credential ALTER COLUMN secret_ref DROP NOT NULL;
ALTER TABLE control.source_credential ADD COLUMN authority_kind text NOT NULL DEFAULT 'EXTERNAL' CHECK (authority_kind IN ('EXTERNAL','SIMULATED_IMPORT'));
ALTER TABLE control.source_credential ADD CONSTRAINT source_credential_kind_secret_check CHECK ((authority_kind='EXTERNAL' AND secret_ref IS NOT NULL) OR (authority_kind='SIMULATED_IMPORT' AND secret_ref IS NULL));
CREATE FUNCTION control.guard_source_authority_kind() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,control AS $body$
BEGIN
  IF NEW.authority_kind IS DISTINCT FROM OLD.authority_kind THEN RAISE EXCEPTION 'source authority kind immutable'; END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER source_authority_kind_immutable BEFORE UPDATE ON control.source_credential FOR EACH ROW EXECUTE FUNCTION control.guard_source_authority_kind();
CREATE FUNCTION control.provision_import_authority(p_source text,p_tenant text,p_digest bytea,p_entities text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
BEGIN
  PERFORM control.acquire_security_barrier_guard_internal();
  IF octet_length(p_digest) <> 32 OR cardinality(p_entities)<1 OR NOT p_entities <@ ARRAY['customer','order']::text[] THEN RAISE EXCEPTION 'invalid import authority'; END IF;
  INSERT INTO control.credential_digest_registry(digest,kind) VALUES(p_digest,'source');
  INSERT INTO control.source_credential(source_id,tenant_key,digest,digest_kind,secret_ref,allowed_entities,enabled,revision,authority_kind)
    VALUES(p_source,p_tenant,p_digest,'source',NULL,p_entities,true,1,'SIMULATED_IMPORT');
END $body$;
REVOKE ALL ON FUNCTION control.provision_import_authority(text,text,bytea,text[]) FROM PUBLIC,hub_mcp,hub_worker,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.provision_import_authority(text,text,bytea,text[]) TO hub_api;
CREATE OR REPLACE FUNCTION control.authenticate_source(p_digest bytea)
RETURNS TABLE (credential_id uuid,source_id text,tenant_key text,allowed_entities text[],credential_revision bigint,source_epoch bigint,enabled boolean,tenant_enabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
 SELECT c.id,c.source_id,c.tenant_key,c.allowed_entities,c.revision,c.source_epoch,c.enabled,t.enabled
 FROM control.source_credential c JOIN control.credential_digest_registry d ON d.digest=c.digest AND d.kind='source' AND c.digest_kind=d.kind
 JOIN control.tenant t ON t.tenant_key=c.tenant_key WHERE c.digest=p_digest AND c.authority_kind='EXTERNAL'
$body$;
ALTER TABLE control.source_channel DROP CONSTRAINT source_channel_connector_check;
ALTER TABLE control.source_channel ADD CONSTRAINT source_channel_connector_check CHECK (connector IN ('rest','postgresql','sqlserver','SIMULATED_IMPORT'));
ALTER TABLE control.source_test_report ALTER COLUMN endpoint_profile_digest DROP NOT NULL;
ALTER TABLE control.source_owner_approval ALTER COLUMN endpoint_profile_digest DROP NOT NULL;
ALTER TABLE control.source_test_report ADD COLUMN sample_digest bytea CHECK (sample_digest IS NULL OR octet_length(sample_digest)=32);
ALTER TABLE control.source_owner_approval ADD COLUMN sample_digest bytea CHECK (sample_digest IS NULL OR octet_length(sample_digest)=32);
ALTER TABLE control.source_test_report ADD CONSTRAINT source_test_proof_kind CHECK ((endpoint_profile_digest IS NOT NULL AND sample_digest IS NULL) OR (endpoint_profile_digest IS NULL AND sample_digest IS NOT NULL));
ALTER TABLE control.source_owner_approval ADD CONSTRAINT source_approval_proof_kind CHECK ((endpoint_profile_digest IS NOT NULL AND sample_digest IS NULL) OR (endpoint_profile_digest IS NULL AND sample_digest IS NOT NULL));
CREATE FUNCTION control.check_source_proof_type() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $body$
DECLARE connector text; authority text;
BEGIN
 SELECT cr.config->>'connector',c.authority_kind INTO connector,authority FROM control.source_config_revision cr
 JOIN control.source_credential c USING(tenant_key,source_id)
 WHERE (cr.tenant_key,cr.source_id,cr.revision)=(NEW.tenant_key,NEW.source_id,NEW.config_revision);
 IF connector IS NULL OR NOT ((connector='SIMULATED_IMPORT' AND authority='SIMULATED_IMPORT' AND NEW.endpoint_profile_digest IS NULL AND NEW.sample_digest IS NOT NULL)
 OR (connector IN ('rest','postgresql','sqlserver') AND authority='EXTERNAL' AND NEW.endpoint_profile_digest IS NOT NULL AND NEW.sample_digest IS NULL)) THEN
  RAISE EXCEPTION 'source proof type mismatch';
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER source_test_proof_type BEFORE INSERT OR UPDATE ON control.source_test_report FOR EACH ROW EXECUTE FUNCTION control.check_source_proof_type();
CREATE TRIGGER source_approval_proof_type BEFORE INSERT OR UPDATE ON control.source_owner_approval FOR EACH ROW EXECUTE FUNCTION control.check_source_proof_type();

REVOKE ALL ON FUNCTION control.check_source_proof_type() FROM PUBLIC,hub_api,hub_mcp,hub_worker,hub_publisher,hub_hasura_read;
ALTER TABLE control.source_test_report ADD COLUMN sample_customer_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sample_customer_refs)='array');
CREATE FUNCTION control.lock_import_customer(p_tenant text,p_source text,p_pk text,p_customer text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,hub AS $body$
BEGIN
 PERFORM 1 FROM control.canonical_source_identity i JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(i.tenant_key,i.customer_id)
 WHERE i.tenant_key=p_tenant AND i.source_id=p_source AND i.entity='customer' AND i.source_pk=p_pk
 AND i.customer_id::text=p_customer AND c.deleted_at IS NULL FOR UPDATE OF i,c;
 RETURN FOUND;
END $body$;
REVOKE ALL ON FUNCTION control.lock_import_customer(text,text,text,text) FROM PUBLIC,hub_mcp,hub_worker,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.lock_import_customer(text,text,text,text) TO hub_api;
