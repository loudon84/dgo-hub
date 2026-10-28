CREATE FUNCTION control.import_recovery_authorize_internal(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint,p_scope text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE src text; reg control.source_registry%ROWTYPE; epoch bigint; scopes text[]; facts jsonb; mappings jsonb; data jsonb; user_target text; dept_target text; user_ok boolean; user_dept text; dept_ok boolean; customer_key text; current_fences jsonb;
BEGIN
 IF p_scope NOT IN ('source:read','source:approve') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF coalesce(nullif(current_setting('role',true),'none'),session_user)<>'hub_api' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM control.lock_security_barrier_fence();
 SELECT q.source_id INTO src FROM control.ingestion_quarantine_index q WHERE q.tenant_key=p_tenant AND q.quarantine_id=p_quarantine;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM * FROM control.lock_source_credential(p_tenant,src);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO reg FROM control.source_registry r WHERE r.tenant_key=p_tenant AND r.source_id=src FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF reg.data_owner_user_id IS DISTINCT FROM p_user THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM control.source_channel c JOIN control.ingestion_quarantine_index q ON q.channel_id=c.id
  WHERE q.quarantine_id=p_quarantine AND q.tenant_key=p_tenant AND q.source_id=src FOR UPDATE OF c;
 SELECT s.auth_epoch,s.management_scopes INTO epoch,scopes FROM control.auth_subject s JOIN control.tenant t ON t.tenant_key=s.tenant_key
 JOIN control.identity_binding b ON (b.tenant_key,b.user_id)=(s.tenant_key,s.user_id)
 WHERE s.tenant_key=p_tenant AND s.user_id=p_user AND b.issuer=p_issuer AND b.subject=p_subject AND t.enabled AND s.enabled AND b.enabled FOR UPDATE OF t,s,b;
 IF NOT FOUND OR epoch IS DISTINCT FROM p_epoch THEN RAISE EXCEPTION 'AUTH_CONTEXT_CHANGED' USING ERRCODE='P0001'; END IF;
 IF NOT (scopes @> ARRAY[p_scope]::text[]) THEN RAISE EXCEPTION 'AUTH_FORBIDDEN' USING ERRCODE='42501'; END IF;
 facts:=control.import_recovery_original_facts_internal(p_tenant,p_quarantine,src);
 IF p_scope='source:approve' AND facts IS NOT NULL AND facts->>'entity'='customer' THEN
  data:=facts->'publicRecord'->'data';
  SELECT m.mappings INTO mappings FROM control.source_identity_mapping_revision m
   WHERE (m.tenant_key,m.source_id,m.revision)=(p_tenant,src,reg.identity_mapping_revision);
  IF pg_catalog.jsonb_typeof(mappings)='array' THEN
   SELECT x->>'target_id' INTO user_target FROM pg_catalog.jsonb_array_elements(mappings) x WHERE x->>'kind'='user' AND x->>'external_id'=data->>'owner_external_id' LIMIT 1;
   SELECT x->>'target_id' INTO dept_target FROM pg_catalog.jsonb_array_elements(mappings) x WHERE x->>'kind'='department' AND x->>'external_id'=data->>'department_external_id' LIMIT 1;
  END IF;
  PERFORM 1 FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND (s.user_id=user_target OR s.department_id=dept_target) ORDER BY s.user_id COLLATE "C" FOR UPDATE;
  SELECT (s.enabled AND s.business_role='sales' AND s.department_id IS NOT NULL),s.department_id INTO user_ok,user_dept FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.user_id=user_target;
  SELECT EXISTS(SELECT 1 FROM control.auth_subject s WHERE s.tenant_key=p_tenant AND s.enabled AND s.department_id=dept_target) INTO dept_ok;
 END IF;
 IF p_scope='source:approve' AND facts IS NOT NULL THEN
  data:=facts->'publicRecord'->'data';
  IF facts->>'entity'='order' THEN
   customer_key:='c:'||pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(public.digest(pg_catalog.convert_to('['||pg_catalog.to_json(data->'customer_ref'->>'source_id')::text||','||pg_catalog.to_json(data->'customer_ref'->>'source_pk')::text||']','UTF8'),'sha256'),'base64'),'+/','-_'),'=');
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind',f.kind,'externalId',f.external_id,'revision',f.identity_mapping_revision::text)),'[]'::jsonb) INTO current_fences
   FROM control.source_identity_remap_fence f WHERE f.tenant_key=p_tenant AND f.source_id=src AND
    ((f.kind='user' AND f.external_id=data->>'owner_external_id') OR (f.kind='department' AND f.external_id=data->>'department_external_id') OR (f.kind='customer' AND f.external_id=customer_key));
 END IF;
 IF p_scope='source:read' THEN RETURN pg_catalog.jsonb_build_object('facts',facts); END IF;
 RETURN pg_catalog.jsonb_build_object('facts',facts,'currentFences',current_fences,'target',pg_catalog.jsonb_build_object('userOk',coalesce(user_ok,false),'userDepartment',user_dept,'departmentOk',coalesce(dept_ok,false)));
END $body$;

REVOKE ALL ON FUNCTION control.import_recovery_authorize_internal(text,uuid,text,text,text,bigint,text) FROM PUBLIC,hub_api,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
CREATE OR REPLACE FUNCTION control.read_import_recovery_original(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT control.import_recovery_authorize_internal(p_tenant,p_quarantine,p_user,p_issuer,p_subject,p_epoch,'source:read')
$body$;
CREATE FUNCTION control.read_import_recovery_for_approval(p_tenant text,p_quarantine uuid,p_user text,p_issuer text,p_subject text,p_epoch bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT control.import_recovery_authorize_internal(p_tenant,p_quarantine,p_user,p_issuer,p_subject,p_epoch,'source:approve')
$body$;
REVOKE ALL ON FUNCTION control.read_import_recovery_for_approval(text,uuid,text,text,text,bigint) FROM PUBLIC,hub_worker,hub_mcp,hub_publisher,hub_hasura_read;
GRANT EXECUTE ON FUNCTION control.read_import_recovery_for_approval(text,uuid,text,text,text,bigint) TO hub_api;
