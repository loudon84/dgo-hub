ALTER TABLE control.agent_audit
  ADD COLUMN request_id uuid,
  ADD COLUMN credential_id uuid,
  ADD COLUMN auth_epoch bigint,
  ADD COLUMN gate_epoch bigint,
  ADD COLUMN result_count integer,
  ADD COLUMN args_digest bytea,
  ADD COLUMN protocol_version text,
  ADD COLUMN binding_version text,
  ADD COLUMN policy_version text,
  ADD COLUMN stage text;

ALTER TABLE control.agent_audit
  ADD CONSTRAINT agent_audit_result_count_nonnegative CHECK (result_count IS NULL OR result_count >= 0),
  ADD CONSTRAINT agent_audit_args_digest_sha256 CHECK (args_digest IS NULL OR octet_length(args_digest) = 32),
  ADD CONSTRAINT agent_audit_auth_epoch_nonnegative CHECK (auth_epoch IS NULL OR auth_epoch >= 0),
  ADD CONSTRAINT agent_audit_gate_epoch_nonnegative CHECK (gate_epoch IS NULL OR gate_epoch >= 0);
