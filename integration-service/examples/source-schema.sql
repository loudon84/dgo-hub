-- Optional PostgreSQL source fixtures for local DB ETL verification.
CREATE TABLE IF NOT EXISTS crm_customers (
 source_id text PRIMARY KEY, tenant_id text NOT NULL, owner_user_id text NOT NULL, version integer NOT NULL,
 name text NOT NULL,email text,phone text,deleted boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS erp_orders (
 source_id text PRIMARY KEY,customer_source_id text NOT NULL,tenant_id text NOT NULL,owner_user_id text NOT NULL,
 version integer NOT NULL,total numeric(18,2) NOT NULL,status text NOT NULL,items jsonb NOT NULL,
 deleted boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now()
);
