# Alpha.1 W0 Task 3 execution report

## Result

- Status: `DONE_WITH_CONCERNS` (the code and local checks are complete; product readiness remains `BLOCKED`).
- Base: `e53a252b59e73d6d61a64868195d456c8a65d0e4`.
- Task commits: `383ddbe9127845fd7173a71d0ce5736e7a308170`, `3e00a5eb97f262e2ebb57c2a74569b4c60470843`, `7190d757272360c0506862e698377430238b46a3`, `f9abd03f968590ee8fac50ad7916b49453fbb735`, `11eb22b25736c3948edc76f933a53292ba0397ac`.
- Changed files: `integration-service/contracts/evidence.ts`, `integration-service/acceptance-tests/evidence/run-gate.ts`, `integration-service/acceptance-tests/evidence/gate.test.ts`, `integration-service/scripts/record-local-checks.ts`, `integration-service/evidence/README.md`, `integration-service/package.json`, and this report.
- No upstream workspace, `.env`, run output, `node_modules`, `dist`, or deliverables were committed.

## RED / GREEN

1. RED: `npm test -- acceptance-tests/evidence/gate.test.ts` exited 1 because `contracts/evidence.ts` did not exist.
2. GREEN: after implementing the contracts, safe reader, structure validator and release gate, `npm test -- acceptance-tests/evidence/gate.test.ts` passed 5/5. It covered absent manifests, the canonical 48 IDs, synthetic structure vs readiness, digest/path tampering, and a false Golden Consumer claim.
3. RED: `npm test -- acceptance-tests/evidence/gate.test.ts -t 'stable JSON-compatible CLI'` exited 1 because `run-gate.ts` did not exist.
4. GREEN: after adding `runGateCli`, the focused test passed; the suite later passed 12/12. It includes complete synthetic PASS-shaped records for all 48 IDs, Oracle value comparison (including referenced JSON with reordered keys), symlink rejection, source/image/input identity mismatch, and recorder argument/overwrite behavior.
5. A recorder attempt with run ID `task3-20261023-134950` exited 1 at startup with `spawn EINVAL` while launching Windows `npm.cmd`. Its partial run directory was preserved at `C:\Users\Administrator\AppData\Local\Temp\alpha1-task3-runs\task3-20261023-134950`.
6. Run `task3-20261023-135100` recorded `typecheck=0`, `test=1`, `build=0`. The failing assertion incorrectly required a dirty worktree after the implementation had been committed; the worktree was clean. The run and raw logs were preserved at `C:\Users\Administrator\AppData\Local\Temp\alpha1-task3-runs\task3-20261023-135100`.
7. Added a focused Windows command-selection regression, tested the actual worktree manifest digest behavior, and changed the launcher to use `cmd.exe` for the fixed allowlist. Focused command `npm test -- acceptance-tests/evidence/gate.test.ts -t 'Windows npm scripts|runs only the fixed allowlist'` passed 2/2.
8. Final recorder command: `node dist/scripts/record-local-checks.js --output-parent <TEMP>\alpha1-task3-runs --run-id task3-final-20261023`; exit 0, JSON status `PASS`, `product_ready=false`. Its recorded commands were exactly `npm run typecheck` (0), `npm test` (0), and `npm run build` (0). The test log reports 5 files and 63 tests passed.
9. Full run directory: `C:\Users\Administrator\AppData\Local\Temp\alpha1-task3-runs\task3-final-20261023`. It records Git SHA `f9abd03f968590ee8fac50ad7916b49453fbb735`, `dirty=false`, and an empty worktree file list; the digest manifest covers the run metadata, check results, worktree manifest, and raw stdout/stderr logs.
10. After the recorded full run, `npm test -- acceptance-tests/evidence/gate.test.ts -t 'stable JSON-compatible CLI'` passed 1/1 and `npm run build` exited 0 for a response-shape fix that prevents internal manifests/digests from leaking in CLI output. This final small fix is commit `11eb22b`; the full recorder run was not repeated.

## Gate result and limits

- `node dist/acceptance-tests/evidence/run-gate.js --run-dir C:\Users\Administrator\AppData\Local\Temp\alpha1-task3-runs\task3-final-20261023` emitted stable JSON with `status=BLOCKED`, `product_ready=false`, and a nonzero exit. The seven missing fixed inputs are `environment-inputs.json`, `signoffs.json`, `upstream-pins.json`, `deployment.lock.json`, `source-contracts.json`, `fixture-manifest.json`, and `golden-consumer/manifest.json`. All 48 canonical product rows remain `NOT_RUN`.
- A complete synthetic fixture can pass `validateEvidenceStructure`; it is never product-ready. Formal release still requires observed site inputs, approved real CRM and order material, site signoffs, deployment lock identity, actual Hermes version, three distinct environment actors and independent Golden Consumer Oracle/trace/answer evidence.
- The checker validates declared provenance, approval references, identity consistency, file paths and digests. It cannot independently prove real-world approver identity or remote runtime execution. Run directories must not be modified concurrently while validation is in progress.
