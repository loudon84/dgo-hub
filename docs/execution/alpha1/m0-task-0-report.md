# M0 Task 0 — Versioned migration runner

**Status: IMPLEMENTED; I1/I2 review corrections pending combined Task1 review**
**Branch:** feat/alpha1-implementation
**Dispatch base:** 17d3d28ffe87ebb23e47f167cfe10fe298e6c45c
**Tested implementation commit:** 86b5458e697e296d848086714d581d19d13239b7

## Commits

1. 8b2ea433fd34349e04fb24890faaa238577b2f80 — trim authority references before checking the frozen synthetic/example/fixture schemes.
2. 86b5458e697e296d848086714d581d19d13239b7 — add import-safe versioned PostgreSQL migration runner, owned PostgreSQL test helper, integration coverage, and README instructions.

Task 0 stopped here; Tasks 1–5 were not started. The source commits do not change the product/site readiness status.

## Changes

- W0-R1: nonrealAuthorityIssues now matches the schema's .trim() behavior. Regression cases cover leading space/tab and mixed-case schemes in consumer deployment, source approval, and source owner references. Legitimate site/CMDB references containing these words remain accepted; the synthetic structure check remains covered.
- Migration runner: exports runMigrations(pool, { directory, environmentKind, adoptLegacy001 }); discovers continuous NNN_name.sql files, strictly decodes UTF-8, normalizes CRLF/CR to LF for SHA-256, validates ledger/history before pending SQL, and executes each SQL plus ledger insert in one transaction under one session advisory lock. It releases or destroys the checked-out client on failure and leaves pool lifetime with the library caller.
- Legacy baseline: detects known 001 hub objects by their qualified names. It rejects an unrecorded hub baseline by default; adoption replays and records 001 only for local_lab. Site adoption is rejected. Unrelated public objects are preserved.
- CLI: explicit direct-execution guard; environment kind comes from --environment-kind, then HUB_ENVIRONMENT_KIND, then safe site; legacy adoption requires explicit local_lab. CLI requires DATABASE_URL, does not load .env, prints only safe result/error codes and migration identifiers, and closes its own pool.
- PostgreSQL helper and tests: uses one task-owned PostgreSQL 16.10 container on loopback with tmpfs data, bounded readiness, safe failure codes, and exact-label/ID cleanup verification. Tests cover empty/repeat, concurrent execution, rollback/retry, checksum and history drift, malformed sets, adoption boundaries, import/CLI lifecycle, and lock release.
- Documentation: added the versioned migration contract and CLI usage to integration-service/README.md.

integration-service/migrations/001_init.sql was not edited. Its SHA-256 before and after is 600491b647d88dd2f282a425afe1005e7fe2c4c87a67b30570de52408a7f2251.

## RED / GREEN evidence

- R1 RED: npm test -- acceptance-tests/evidence/gate.test.ts produced 32 passed and 4 failed. The four failures were the expected false PASS results for " synthetic://hermes", tab-prefixed mixed-case ExAmPlE://hermes, " fixture://approval:crm", and " fixture://owner".
- R1 GREEN: the same focused Gate command passed 36/36; npm run typecheck and npm run build each exited 0. Retained logs: m0-task-0-evidence/r1-green-gate.log, r1-typecheck.log, and r1-build.log.
- Migration import RED: before replacing the prototype, a no-network Node probe stubbed pg.Pool.prototype.query/end, imported compiled dist/migrate.js, and observed queryCalls=1, endCalls=1; expected import behavior therefore exited 1. Output is retained in migration-import-red.log and .exit.
- Migration focused GREEN during iteration: the real PostgreSQL migration test file passed 14/14 in two focused runs. The final suite additionally covered the compiled CLI and LF checksum normalization.

## Final verification

Executed from E:/git/dgo-hub/integration-service after freezing the implementation source digests and before committing implementation 86b5458:

| Command | Exit | Result |
|---|---:|---|
| npm run typecheck | 0 | passed |
| npm run build | 0 | passed |
| npm test | 0 | 7 files, 106 tests passed |

Raw outputs and exit files are retained in m0-task-0-evidence/final-{typecheck,build,test}.{log,exit}. source-digests-pre-gate.txt and source-digests-post-commit.txt match for all touched implementation/test files, tying the test run to the committed source. Runtime: Node v24.14.1, npm 11.11.0, Vitest 4.1.12.

## PostgreSQL resource evidence

Docker Engine client/server were both 29.8.1. The owned helper used postgres:16.10-alpine. It recorded distribution RepoDigest as postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297 and runtime image ID separately as sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297; equality was observed, with no fallback between fields.

Three test-run containers were created. For each, the complete container ID and unique run label were recorded immediately; the helper confirmed both ownership labels before removing that exact ID and verified the container absent afterward:

- b06a214b-e042-4d26-b63d-0a2aeb7e9759 — d4f4ada45181558a75d406ec28a5e1be566666d3b67811d5b33768fdec3e375c
- 5abb48c5-6f3f-49cb-a230-67ba579503b7 — 7c04de109e321c2308ff9e581d229af3380c11f00dcdde5f171a9895ce95d018
- 6d009245-bdc3-4a05-a5a6-3013e27e894e — 705a84188e8fd45c2f28eb1ead0d8719d1281f723a1ec6b2cc48b9fd0cb6afe6

The final filtered Docker inventory for codex.m0.task=task0 was (none). The JSONL lifecycle log, final resource summary, runtime image evidence, and inventory are under m0-task-0-evidence/.

## Review follow-up

GPT-6.1 Sol confirmed W0-R1 as ADDRESSED. Its Task0 review also identified two implementation concerns: a migration file could issue transaction control outside the runner's transaction, and failed fixture startup/removal could leave an untracked owned container. Both were corrected in Task1 prerequisite commit `2549a13cb48c815cd5553c23a015e0946d561407`, with pre-connect SQL boundary tests and Docker command-seam cleanup fault tests. The runner requires `standard_conforming_strings=on`, rejects direct top-level SET/RESET/RESET ALL and `set_config` calls, and enforces the documented migration-file contract; this is not a general SQL sandbox. The helper verifies labels before removing an exact recorded ID and retains `cleanup_unconfirmed` evidence when absence cannot be confirmed. These corrections await the combined Task1 Sol review, so Task0's review gate is not marked closed here.

## Limits

Verification used only task-owned local PostgreSQL databases and synthetic fixtures. No existing hub database/container/volume was inspected for migration or modified. This proves runner behavior against the pinned local PostgreSQL image; it does not establish production database compatibility, site identity readiness, or PASS for any product acceptance ID. Independent GPT-6.1 Sol review remains the next gate.
