import type { SourceEntity } from '../auth/types.js';

export type SnapshotRunMode = 'FULL_SNAPSHOT';
export type SnapshotRunStatus = 'QUEUED' | 'SCANNING' | 'VALIDATING' | 'READY' | 'APPLYING' | 'COMPLETE' | 'FAILED' | 'INCOMPLETE' | 'CANCELLED';
export type SnapshotRequestKind = 'MANUAL' | 'SCHEDULED';

export type EntityChannelProof = Readonly<Record<SourceEntity, Readonly<{
  channel_id: string;
  channel_epoch: string;
  connector: string;
  mode: SnapshotRunMode | 'INCREMENTAL';
  version_domain: 'SOURCE_VERSION' | 'SNAPSHOT_OBSERVATION';
}> | undefined>>;

export type SnapshotRunProof = Readonly<{
  tenant_key: string;
  source_id: string;
  run_id: string;
  run_mode: SnapshotRunMode;
  request_kind: SnapshotRequestKind;
  expected_entities: readonly SourceEntity[];
  credential_id: string;
  credential_revision: string;
  credential_generation: string;
  admission_source_epoch: string;
  entity_channel_proof: EntityChannelProof;
  config_revision: string;
  config_digest: string;
  mapping_revision: string;
  mapping_digest: string;
  identity_mapping_revision: string;
  failure_version?: string;
  identity_mapping_digest: string;
  endpoint_profile_digest: string;
  test_report_id: string;
  approval_id: string;
  data_contract_ref: string;
  delete_contract: 'tombstone' | 'hard_delete';
  security_barrier_fence: string;
  owner_user_id: string;
  owner_revision: string;
  schedule_revision: string | null;
}>;

export type SnapshotRunSummary = Readonly<{
  run_id: string;
  source_id: string;
  run_mode: SnapshotRunMode;
  request_kind: SnapshotRequestKind;
  status: SnapshotRunStatus;
  expected_entities: readonly SourceEntity[];
  extracted_count: number;
  applied_count: number;
  quarantined_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  config_revision: string;
  mapping_revision: string;
  identity_mapping_revision: string;
  completeness_report: Readonly<{ status: 'NOT_STARTED' }> | null;
  checkpoint_summary: Readonly<Record<string, unknown>> | null;
}>;
