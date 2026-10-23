INSERT INTO crm_customers(source_id,tenant_id,owner_user_id,version,name,email)
VALUES('etl-c1','etl-tenant','etl-user',1,'ETL Customer','etl@example.test') ON CONFLICT DO NOTHING;
INSERT INTO erp_orders(source_id,customer_source_id,tenant_id,owner_user_id,version,total,status,items)
VALUES('etl-o1','etl-c1','etl-tenant','etl-user',1,12.50,'paid','[{"sku":"ETL","quantity":1,"unitPrice":12.5}]'::jsonb)
ON CONFLICT DO NOTHING;
