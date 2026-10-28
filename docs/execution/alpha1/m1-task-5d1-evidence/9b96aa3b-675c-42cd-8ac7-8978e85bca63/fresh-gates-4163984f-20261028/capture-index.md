# Fresh D1 gate binding — 2026-10-28

These three rerun gates supersede the earlier three-gate result for the final D1 verification. Each fresh `E:\m1t5-runtime\<UUID>` root is the exact `M0_RUN_EVIDENCE_ROOT` for its command. For every gate, `source-before.json` and `source-after.json` contain the actual HEAD plus the seven explicit source-file raw SHA-256, LF-normalized SHA-256, byte size and Git blob. Their raw values and blobs are unchanged across each command. The 009 SQL checkout has CRLF bytes; its LF-normalized source hash and Git tree blob bind it to the committed source.

| Gate | External root | Result | Captured HEAD | Capture directory |
|---|---|---|---|---|
| Focused `snapshot-runs.test.ts` (26/26) | `E:\m1t5-runtime\df90d946-3af4-45cf-835f-6c65be2c8117` | exit 0 | `4163984f28cde7e70a9452416e43b71a0afad7ee` | `gates/df90d946-3af4-45cf-835f-6c65be2c8117/` |
| `npm run typecheck` | `E:\m1t5-runtime\e9e2ef4b-0e8f-40e1-9c06-200980cc593b` | exit 0 | `4163984f28cde7e70a9452416e43b71a0afad7ee` | `gates/e9e2ef4b-0e8f-40e1-9c06-200980cc593b/` |
| `npm run build` | `E:\m1t5-runtime\cbaef082-b59c-4b7c-a23c-34000369b8dc` | exit 0 | `4163984f28cde7e70a9452416e43b71a0afad7ee` | `gates/cbaef082-b59c-4b7c-a23c-34000369b8dc/` |

Gate folders contain the exact command, stdout, stderr, exit code, evidence root, capture metadata and source-before/after manifests. `source-binding-summary.json` compares each captured tree blob with product commit `68bfa36203be6446c47e0927ab9d982b5a380343`.

## Git history correction

`854df4cfb2492a5cd70da7343131e49d58f8e407` was a temporary product commit whose parent was `3040666fa9da2de19ba7b8bf632c4765f278b455`. The final product commit `68bfa36203be6446c47e0927ab9d982b5a380343` was created by amending that commit; its parent is also `3040666fa9da2de19ba7b8bf632c4765f278b455`. It is incorrect to describe 854df as 68bfa's parent. There was no reset or rebase. The diff from 854df to 68bfa is limited to the test's explicit child lifecycle instrumentation (9 insertions, 4 deletions). The original metadata remains preserved as historical evidence; the fresh gates above have true per-command before/after source captures.

The full focused suite created three owned PostgreSQL containers and two Node child processes. `owned-lifecycle/` contains only their explicit lifecycle records: each DB has ownership confirmation and absence after removal; both children record the owned PID, SIGKILL, observed exit signal and recovery.
