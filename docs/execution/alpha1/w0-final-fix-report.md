# W0 final fix wave report

Date: 2026-10-23 (Asia/Shanghai)
Repository: `E:\git\dgo-hub`, branch `feat/alpha1-implementation`
Base: `b11e52d413fa5d0b68ee9849d8ad0b7617055066`
Implementation commit: `90f3776605b91ebd9729902c6fac0dd366b08ab2`
Independent dependency commit: `4d4a77e04e8d736b94ced11da6d2aa82c39fb8ce`

This wave implements W0-I1 through W0-I4 and W0-M1/M2. It does not start M0. W0 is awaiting the single scoped Sol review; the product gate remains BLOCKED and all 48 product acceptance rows remain NOT_RUN.

## Findings closed

### I1 — deployment descriptor provenance

- Added required `image.digest_source` with `repo_digest | descriptor`, and optional standard OCI/Docker descriptor media type, to the Zod contract and JSON Schema. Updated the example lock and constructors.
- Removed the invalid rule that rejected a valid descriptor merely because Docker's runtime `image_id` was equal to that descriptor. Manifest digest, runtime/probe consistency, optional declared image ID consistency, and application config digest checks remain. No image ID fallback was added.
- RED on the pre-fix Vitest 3.2.7 focused run: the Docker 29 equality input was BLOCKED solely with `manifest_digest must not be populated with the config image_id`. GREEN after the change: Docker ID equality is accepted when descriptor provenance is declared; missing/unknown provenance and mismatched runtime/probe identities remain rejected.
- Updated the deployment lock example, integration README and upstream assumptions.

### I2 — repository-controlled release pins

- Final Gate reads `deploy/upstream-pins.json` anchored from the source module location or compiled `dist/contracts` location, outside the untrusted run directory. Missing or invalid anchor fails closed.
- Gate compares the run's embedded pin file with the controlled pin set, then validates the lock against the controlled values. `validateDeploymentLock` remains caller-parameterized and `evaluateReleaseGate(runDir)` remains unchanged.
- RED: a self-consistent run bundle with changed Hasura pins, component source SHA and recomputed digests returned PASS. GREEN: the equivalent post-fix bundle returns BLOCKED with a controlled/approved pins issue.
- Unit coverage includes both the source module path and the compiled-layout resolution branch through build and full suite. The single full Windows suite uses the current build output.

### I3 — explicit nonreal authorities

- Formal Gate rejects case-insensitive exact URI schemes `synthetic:`, `example:` and `fixture:` in the consumer deployment reference and existing approval, owner, actor, mapping, replica authorization, backup and deletion authority references.
- The scheme match is anchored at the start; strings containing those words elsewhere remain valid. Structural synthetic fixtures still pass structural validation. Release-shaped unit fixtures are marked artificial and are not saved as site evidence.
- RED: synthetic/example/fixture consumer references and authority references could reach the final Gate branch in the artificial fixture. GREEN: each tested explicit scheme is BLOCKED while the valid declared-control artificial case reaches PASS.

### I4 — Vitest 4 dependency upgrade

- Independently committed `vitest` 4.1.12 and its lockfile graph. No unrelated production dependency was upgraded; no override or audit fix was used.
- Clean install used public npm registry, distinct empty user/global npm config files, and `--ignore-scripts --no-audit`; it installed 199 packages. `npm ls vitest @vitest/mocker tinypool --all` resolves Vitest 4.1.12 and mocker 4.1.12; tinypool is absent because Vitest 4 removed it. Package-lock SHA-256: `D57E05B22CAC17293328B3D3EBD97E55786A100CA06DCE93084766039D083065`.
- Installed Windows runtime: Node `v24.14.1`, npm `11.11.0`. Linux focused final source run: Node `v24.22.1`, npm `11.19.1`, Vitest `4.1.12`.
- Version compatibility and migration reference: [Vitest migration guide](https://vitest.dev/guide/migration.html). The final test config explicitly excludes generated `dist/**` tests, preventing Vitest from executing stale or duplicate compiled test files alongside the source suite.

### M1 — missing signoff path CLI

- Added a genuine missing-path CLI regression. It asserts stable JSON keys, `unreadable_input`, exit code 1, `product_ready: false`, and no leaked machine path in the safe message.
- GREEN in the Windows final full suite.

### M2 — Git path capture

- Both tracked and untracked path collection now requests NUL-delimited output (`git diff ... -z`, `git ls-files ... -z`) and splits on NUL. The existing deleted/nonregular handling remains.
- Added a real temporary Git repository regression with a dirty tracked Chinese path, an untracked Chinese path and a deleted tracked path. It checks content digests and unavailable-path reporting.
- Windows GREEN in the final full suite; Linux GREEN in the focused recorder test.

## File identity investigation

The first Windows Vitest 4 full-suite run surfaced distinct-file fixture failures. A direct reproduction on Node v24.14.1 showed `lstat().ino` values above `Number.MAX_SAFE_INTEGER`; different NTFS files could round to the same JavaScript `number` (the fixture showed `oracle-2.json` and `answer-2.json` sharing the rounded identity). A Windows path-only identity fallback was tried briefly. The coordinating controller pointed out before final review that this would miss hardlink aliases, so the implementation was corrected to preserve filesystem identity.

The final guard uses `lstat(path, { bigint: true })` and exact `dev`/`ino` BigInts on all platforms. It falls back to the existing canonical real path only when the filesystem returns zero device or inode identity. This preserves hardlink identity. Added a real NTFS test that confirms two ordinary files have distinct identities and a true hardlink alias shares identity and is rejected as a duplicate Golden Consumer artifact. Both cases pass. Node's [v24 fs documentation](https://nodejs.org/download/release/v24.19.0/docs/api/fs.html) documents the `bigint` option, BigInt stat fields, `ino`, and hardlink count.

## RED/GREEN and first full-run failures

Initial focused RED on the old installed Vitest 3.2.7 ran 74 relevant cases: 18 failed and 56 passed. Failures included the invalid Docker equality guard, run-controlled pins, nonreal authority references and the unexported Git snapshot helper. The missing-path CLI behavior already returned the desired safe result; M1 adds the direct regression that was missing.

The first clean-install full test run was not accepted as final evidence:

- Vitest 4 collected stale `dist/**` test files as well as source tests. Those old compiled files lacked `digest_source` and failed schema expectations. A build confirmed generated `dist` was out of date, and Vitest now excludes `dist/**`.
- The source run exposed the NTFS `ino` precision collision described above. The final BigInt fix preserves both distinct-file and hardlink alias semantics.
- The artificial fixture also exposed an invalid Oracle identity collision on Windows. Its source was the imprecise file identity value, not a product timeout; no timeout was widened.

Exact first full-run output is retained in [full-test.log](w0-final-fix-evidence/full-test.log); the focused BigInt diagnosis is in [identity-debug.log](w0-final-fix-evidence/identity-debug.log). [focused-vitest4-debug.log](w0-final-fix-evidence/focused-vitest4-debug.log) records the first focused reproduction. The temporary Windows realpath-only implementation is not included in either final evidence or the final commit.

## Final verification

The final Windows commands ran against the exact source tree committed as `90f3776605b91ebd9729902c6fac0dd366b08ab2`, following the successful clean install. The commit was created after verification; the recorded source tree and committed tree are identical. Each final verification command ran once against this implementation:

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` (Vitest 4.1.12, `dist/**` excluded) | 6 files passed; 85 tests passed; exit 0 |
| `npm audit --json` | 0 vulnerabilities; exit 0 |
| `npm audit --omit=dev --json` | 0 vulnerabilities; exit 0 |
| Linux focused Gate + Git path recorder | 2 files passed; 31 passed, 1 Windows-only skip; exit 0 |

Full check logs, dependency resolution, package-lock hash, audit JSON and exit codes are retained under [w0-final-fix-evidence](w0-final-fix-evidence/). The final Linux focused source SHA-256 values are recorded in [linux-source-sha256.txt](w0-final-fix-evidence/linux-source-sha256.txt); its complete output is [linux-bigint-focused.log](w0-final-fix-evidence/linux-bigint-focused.log).

## Linux fixture attempts and owned resources

All containers were named `alpha1-w0-linux-*` and used `docker run --rm`; no service containers, DBs, volumes or upstream state were touched. The isolated mounted fixture was `C:\Users\Administrator\AppData\Local\Temp\alpha1-w0-linux-ce937c31a8434017b7f7dc92e4eaf10c`.

- `alpha1-w0-linux-dee2e7e3aeec`: both npm configs pointed to `/dev/null`; npm failed before install with `double-loading config "/dev/null" as "global", previously loaded as "user"`.
- `alpha1-w0-linux-retry-1b5cbf6931cd`: separate empty configs fixed npm; 73 passed, 1 skipped, 1 failed because the isolated copy lacked Git HEAD (`could not capture hub git SHA`).
- `alpha1-w0-linux-git-14fee99e5988`: the first temporary `.gitignore` contained literal backtick text and included node_modules in the recorder scan; the 5-second recorder test timed out. Product timeout was not changed.
- `alpha1-w0-linux-final-0cb0a1724a99`: corrected ignore fixture and temporary Git commit; old snapshot before final BigInt source, Node 24.14.1/Vitest 4.1.12; 74 passed, 1 skipped.
- `alpha1-w0-linux-bigint-identity` first attempts: a slim image had no Git and the parent approvals example was not mounted; a subsequent `apt-get` attempt did not complete and its exact container was stopped. With `node:24` the copied Gate and path tests first showed one fixture-root mismatch (`/work` versus `/work/integration-service`), while the identity and Chinese path assertions passed. These fixture attempts are detailed in [linux-bigint-attempts.md](w0-final-fix-evidence/linux-bigint-attempts.md); original Linux attempts are in [linux-attempts.md](w0-final-fix-evidence/linux-attempts.md).
- `alpha1-w0-linux-bigint-identity` final retry: the temporary Git root was corrected to `/work`, only the required approval example was added, and the current BigInt source was recopied. Node v24.22.1/npm 11.19.1, Vitest 4.1.12: 31 passed, 1 Windows-only skip, exit 0.

Saved logs contain the container names but not full Docker container IDs; no full ID is reconstructed or assumed. Temporary npm config files were distinct empty files and contained no user configuration. No secrets were read or copied. The named containers use `--rm`; the stopped apt attempt was explicitly stopped and no matching container is still running. The owned temp mount path was verified, but recursive removal was rejected by the local command safety gate with `CreateProcess ... rejected: blocked by policy`; it was not retried. The mount remains at the exact path above. The detailed resource record is in [resource-disposition.md](w0-final-fix-evidence/resource-disposition.md).

## Limits and next action

This engineering wave creates no observed site evidence and proves no product acceptance. Current site endpoints, approved real CRM/order input and authority records, actual deployed lock, and real Golden Consumer evidence are still absent. Keep the M0 product gate BLOCKED, all 48 rows NOT_RUN, and W0 pending one scoped Sol review. No M0 work started in this wave.
