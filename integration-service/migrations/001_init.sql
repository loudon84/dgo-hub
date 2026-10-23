CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS hub;
CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS api;

CREATE TABLE IF NOT EXISTS hub.customer (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, source_system text NOT NULL, source_id text NOT NULL,
 owner_user_id text NOT NULL, version bigint NOT NULL, name text NOT NULL, email text, phone text, deleted boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,source_system,source_id)
);
CREATE TABLE IF NOT EXISTS hub.sales_order (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, source_system text NOT NULL, source_id text NOT NULL,
 customer_id uuid NOT NULL REFERENCES hub.customer(id), owner_user_id text NOT NULL, version bigint NOT NULL,
 total numeric(18,2) NOT NULL, status text NOT NULL, deleted boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,source_system,source_id)
);
CREATE TABLE IF NOT EXISTS hub.order_item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES hub.sales_order(id) ON DELETE CASCADE,
 tenant_id text NOT NULL, owner_user_id text NOT NULL, sku text NOT NULL, quantity integer NOT NULL, unit_price numeric(18,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_scope ON hub.customer(tenant_id,owner_user_id);
CREATE INDEX IF NOT EXISTS idx_order_scope ON hub.sales_order(tenant_id,owner_user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_order ON hub.order_item(order_id);

CREATE OR REPLACE VIEW api.customer AS SELECT id,source_id,tenant_id,owner_user_id,name,
 CASE WHEN email IS NULL THEN NULL ELSE left(email,1)||'***@'||split_part(email,'@',2) END AS email_masked,
 CASE WHEN phone IS NULL THEN NULL ELSE '***'||right(phone,4) END AS phone_masked,deleted FROM hub.customer;
CREATE OR REPLACE VIEW api.sales_order AS SELECT id,source_id,customer_id,tenant_id,owner_user_id,total,status,deleted,updated_at FROM hub.sales_order;
CREATE OR REPLACE VIEW api.order_item AS SELECT id,order_id,tenant_id,owner_user_id,sku,quantity,unit_price FROM hub.order_item;
CREATE OR REPLACE VIEW api.sales_summary AS SELECT tenant_id,owner_user_id,count(*)::integer AS order_count,
 coalesce(sum(total),0)::numeric(18,2) AS total FROM hub.sales_order WHERE NOT deleted AND status='paid' GROUP BY tenant_id,owner_user_id;
CREATE OR REPLACE VIEW api.customer_sales AS SELECT tenant_id,owner_user_id,customer_id,
 coalesce(sum(total),0)::numeric(18,2) AS total FROM hub.sales_order WHERE NOT deleted AND status='paid' GROUP BY tenant_id,owner_user_id,customer_id;

CREATE TABLE IF NOT EXISTS control.ingestion_event (
 source_system text NOT NULL,event_id text NOT NULL,kind text NOT NULL,payload_hash text NOT NULL,
 status text NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,
 PRIMARY KEY(source_system,event_id)
);
CREATE TABLE IF NOT EXISTS control.etl_watermark (
 source_system text PRIMARY KEY, last_updated_at timestamptz NOT NULL DEFAULT '-infinity', last_source_id text NOT NULL DEFAULT '',
 last_status text NOT NULL DEFAULT 'never', last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS control.ingestion_failure (
 id bigserial PRIMARY KEY,source_system text NOT NULL,event_id text NOT NULL,kind text NOT NULL,
 error text NOT NULL,failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS control.hook_outbox (
 id bigserial PRIMARY KEY,kind text NOT NULL,payload jsonb NOT NULL,attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),done_at timestamptz,last_error text
);
CREATE TABLE IF NOT EXISTS control.permission_policy (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_name text NOT NULL,role_name text NOT NULL,columns_json jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft',revision integer NOT NULL DEFAULT 1,created_by text NOT NULL,
 approved_by text,published_at timestamptz,last_error text, UNIQUE(table_name,role_name)
);
CREATE TABLE IF NOT EXISTS control.query_gate (
 id integer PRIMARY KEY CHECK (id=1), state text NOT NULL CHECK (state IN ('open','closed')),
 epoch bigint NOT NULL DEFAULT 0, changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO control.query_gate(id,state) VALUES(1,'closed') ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS control.ontology_binding (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),object_type text NOT NULL UNIQUE,table_name text NOT NULL,
 fields_json jsonb NOT NULL,relationships_json jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'draft',
 validation_json jsonb,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS control.agent_audit (
 id bigserial PRIMARY KEY,at timestamptz NOT NULL DEFAULT now(),tenant_id text NOT NULL,user_id text NOT NULL,
 tool_name text NOT NULL,outcome text NOT NULL,error_code text,duration_ms integer NOT NULL
);
