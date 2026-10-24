#!/bin/sh
set -eu

read_secret() {
  value=$(cat "/run/secrets/$1")
  case "$value" in ''|*[!A-Fa-f0-9]*) echo 'ALPHA1_SECRET_INVALID' >&2; exit 1;; esac
  printf '%s' "$value"
}

api_password=$(read_secret api_db_password)
mcp_password=$(read_secret mcp_db_password)
publisher_password=$(read_secret publisher_db_password)
hasura_read_password=$(read_secret hasura_read_db_password)
migrator_password=$(read_secret migrator_db_password)
metadata_password=$(read_secret hasura_metadata_db_password)
worker_password=$(read_secret worker_db_password)

psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 <<SQL
CREATE ROLE hub_api LOGIN PASSWORD '$api_password';
CREATE ROLE hub_mcp LOGIN PASSWORD '$mcp_password';
CREATE ROLE hub_publisher LOGIN PASSWORD '$publisher_password';
CREATE ROLE hub_hasura_read LOGIN PASSWORD '$hasura_read_password';
CREATE ROLE hub_migrator LOGIN PASSWORD '$migrator_password';
CREATE ROLE hub_hasura_meta LOGIN PASSWORD '$metadata_password';
CREATE ROLE hub_worker LOGIN PASSWORD '$worker_password';
CREATE DATABASE alpha1 OWNER hub_migrator;
CREATE DATABASE hasura_metadata OWNER hub_hasura_meta;
REVOKE CONNECT ON DATABASE alpha1 FROM PUBLIC;
GRANT CONNECT ON DATABASE alpha1 TO hub_api, hub_mcp, hub_publisher, hub_hasura_read, hub_migrator;
REVOKE CONNECT ON DATABASE hasura_metadata FROM PUBLIC;
GRANT CONNECT ON DATABASE hasura_metadata TO hub_hasura_meta;
SQL
