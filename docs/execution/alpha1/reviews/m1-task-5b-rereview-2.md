**N1 — Isolate rejected due admissions — ADDRESSED.** `integration-service/etl-worker/snapshot-worker.ts:75` now handles admission errors inside each schedule iteration. The filter at `:78` accepts only the shared `AuthError` class with `SOURCE_CONFLICT`, `SOURCE_NOT_FOUND` or `SOURCE_CONTRACT_INVALID`; these are source-local eligibility denials. The admission helper uses that same class (`integration-service/etl-worker/snapshot-runs.ts:11`), so the original PAUSED/config-edit failure is caught. Other AuthError codes, SQL/transport failures and unexpected exceptions are explicitly rethrown. The guarded admission call is unchanged; a denied source receives no run or authority bypass. The diagnostic at `snapshot-worker.ts:79` contains only the fixed event, tenant/source identifiers and allowlisted code, without raw error, endpoint, query, row or credential data. Execution then continues to remaining selected schedules and the admitted-run candidate scan at `:83`.

**N1 regression coverage — adequate.** `integration-service/acceptance-tests/snapshot-runs.test.ts:481` creates/activates a source, makes its schedule due, edits its config to PAUSED, and verifies the schedule remains enabled/due with no active run. It also creates an unrelated admitted run, invokes the real strict loop, checks the safe denial warning, and verifies that the unrelated attempt reaches the injected connector and records `INCOMPLETE/SNAPSHOT_SOURCE_UNAVAILABLE`. This reproduces the original failure and demonstrates continuation. The warning spy and profile override are restored in `finally`.

### New material breakage in the fix diff

None found. The two-file change adds the narrow admission catch and its regression. R1–R5 remain closed; extraction, page metadata retention, manifest validation, cancellation and aggregate-version fixtures are untouched.

### Out-of-scope observations and assurance

None added. Original S1 remains the non-blocking C-owned page-membership seam. Production DNS/TLS/egress and deployed dependency composition remain unverified. B still stops at EXTRACTED/VALIDATING; C/D/E, whole-phase review and the formal 48-case gate remain outstanding/NOT_RUN.

### Checks

- Read the complete supplied Fix2 diff once, from `6d65fdfbdac7ecad7bedd1f90e85dbf6e6b18b5a` to `f855a587fd5adf93bd4117123b1982e8c44fc161`; product commit `8e6f1cfc0d1e1f0aa577806d8ba47c66a1a0b93b`. The focused outside-hunk check confirmed error-class identity and the admission helper's throw path.
- Inspected retained commands/stdout/exits under `docs/execution/alpha1/m1-task-5b-evidence/fix2-7bd8650d-1d6b-4aeb-b0a0-287d16410a63`: RED records **1 failed, 22 skipped**, exit 1; GREEN records **1 passed, 22 skipped**, exit 0. Typecheck/build each record exit 0. GREEN/typecheck/build stderr files are empty. The controller's separate 51-artifact SHA/size verification is not represented as rerun here.
- No tests, source/database connections, Git mutations or product edits were performed. Only this review report was written.

### Verdict

**Fix round: N1 addressed; no new Critical/Important breakage.**

**Spec compliance: Pass for the scoped B repair.**

**Task quality: Approve for the scoped B repair.**
