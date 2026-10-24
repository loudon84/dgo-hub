# Policy-blocked host artifacts — M1

## Exact target: do not retry deletion or moving

`E:\git\dgo-hub\docs\execution\alpha1\m1-task-2-fix2-evidence-9d38414e-45c4-4aee-8c57-4b9ee6e59bf3`

This is an untracked duplicate scratch evidence directory, not the reviewed fix2 package. Exclude it from source/evidence archives and staging. Do not read it to recreate evidence, delete it, move it, or switch tools, paths or mechanisms to retry the rejected cleanup.

The original Luna implementer reported two attempts rejected before process creation: first a recursive Remove-Item operation, then an alternative file-by-file/empty-directory removal script after checking the resolved path. Both returned `exec_command failed: CreateProcess ... Rejected ... blocked by policy`. No more specific policy reason or exact wall-clock timestamp was provided. The second attempt was a retry of the already rejected action; the controller has stopped further attempts and informed the user. No successful cleanup is claimed.

The valid reviewed package is `docs/execution/alpha1/m1-task-2-fix2-evidence-b7f3213d-4e57-4c39-95ee-fd59e20ff853/`, with an explicit safe file whitelist. Normal source review/implementation continues without the scratch directory.

The older M0 guard remains independently binding at `../../2026-10-23-alpha1-m0-identity-isolation-implementation-plan/context/policy-blocked-host-artifacts.md`. Its seven generated host paths and W0 temp target must also not be retried or included in archives. This note does not authorize new resource or filesystem cleanup.