# Linux BigInt guard focused attempts

All mounts were the owned temporary fixture `C:\Users\Administrator\AppData\Local\Temp\alpha1-w0-linux-ce937c31a8434017b7f7dc92e4eaf10c`; every run used `docker run --rm`. No service container, volume, upstream checkout, environment file, or user config was mounted. Final source SHA-256 values are in `linux-source-sha256.txt`.

1. `alpha1-w0-linux-bigint-identity` with `node:24.14.1-bookworm-slim` stopped at image pull; the slim image had no Git and the fixture did not include the parent approvals JSON. It produced no test output.
2. Retrying that slim image with `apt-get update && apt-get install git` did not complete in the 30-second tool window. That container was explicitly stopped; no tests from it are counted.
3. `alpha1-w0-linux-bigint-identity` with `node:24` (Node v24.22.1, npm 11.19.1) ran the copied final BigInt source. Gate assertions passed, including the hardlink test; the recorder regression also passed. One existing recorder test failed because the temporary Git root was nested at `/work/integration-service`, while the test resolves repository paths from `/work` (`ENOENT: /work/acceptance-tests/evidence/gate.test.ts`). At this stage 30 gate tests passed, one was skipped, one recorder test passed, and one recorder test failed.
4. The owned fixture was corrected to place its temporary Git root at `/work`, include only `docs/approvals/environment-inputs.example.json`, and exclude temporary node_modules. On the same Node v24.22.1/npm 11.19.1 and Vitest 4.1.12, the focused final source run passed: 2 files, 31 passed, 1 Windows-only skip, exit 0. Full output is `linux-bigint-focused.log`.

The separate original Linux attempts and their resource names remain in `linux-attempts.md`.
