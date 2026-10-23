# Alpha.1 evidence runs

An evidence run is a directory containing the ten fixed JSON inputs listed in the Task 3 brief. `file-digests.json` maps each fixed input (except itself) and every referenced evidence file to a `sha256:<hex>` digest. References use relative paths beneath the run directory. The gate checks every path segment for symlinks or junctions before reading it and verifies that the resolved path remains inside the run directory.

## Gate behavior

`evaluateReleaseGate(runDir)` returns `{ status, product_ready, issues }`. It compares run pins against the repository-controlled `deploy/upstream-pins.json` before validating the lock against those approved pins; a missing or invalid controlled pins file fails closed. A bundle cannot supply its own approval baseline. Missing required files and incomplete acceptance results are `BLOCKED`; malformed JSON, invalid contracts, unsafe paths, or content and digest mismatches are `FAIL`. Both are nonzero from the CLI integration. A release PASS requires all 48 canonical A/N/FI results to satisfy their evidence contract, an observed site run, approved real CRM and order inputs, and a structurally complete Golden Consumer run. Formal release checks reject authority references whose exact URI scheme is `synthetic:`, `example:`, or `fixture:` (case insensitive); this does not reject other strings containing those words.

`validateEvidenceStructure(runDir)` checks internal structure and file consistency. It is useful for synthetic fixtures and can return `PASS` for a complete synthetic bundle. That result does not indicate product readiness. Gate regression fixtures may contain artificial data shaped to reach the final release branch; they remain unit-test material and are never site evidence. Machine checks can validate declared approval references, source and image identities, and file consistency; they cannot prove that a real person approved the inputs or that a remote service actually ran the claimed version. Do not evaluate a run directory while another process is changing it; ordinary filesystem reads do not provide an atomic hostile-writer snapshot.

Oracle expected and actual values are concrete JSON assertions and must match with object-key order ignored. When either value is a file reference, the file is read through the same safe path and digest checks. Golden Consumer Oracle, tool trace, and final answer artifacts must be three distinct files for each call. The owning acceptance tests remain responsible for the meaning of each assertion.

## Local checks

From `integration-service`, run:

```text
npm run record:local-checks -- --output-parent <directory> --run-id <safe-id>
```

The recorder runs only `npm run typecheck`, `npm test`, and `npm run build`. It creates a new run directory and refuses to reuse an existing one. `check-results.json` records each command, exit code, source SHA, image identity map, worktree dirty state, and stdout/stderr file digests. `worktree-manifest.json` records SHA256 digests for changed or untracked regular files, alongside the Git HEAD; `.env`, `node_modules`, `dist`, and `deliverables` are excluded. No process environment is recorded.

The recorder initializes all 48 product acceptance results to `NOT_RUN`. Its local check logs do not promote product acceptance IDs to PASS. It does not fill missing site manifests or run live integrations. Live checks remain optional and require a separately started local lab with an explicit configuration.
