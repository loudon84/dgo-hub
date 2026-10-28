# M1-5D1 Fix1 capture index

- Product source commit: 634e0c84cf2cf3d7953feb1e03d35f3387b27dfd
- Captured gates: acceptance, typecheck, build; each command has its own absolute M0_RUN_EVIDENCE_ROOT and independent source-before/source-after manifests.
- Acceptance command: npm test -- --run acceptance-tests/snapshot-runs.test.ts (exit 0; owned PostgreSQL fixture; 26 tests).
- Typecheck command: npm run typecheck (exit 0).
- Build command: npm run build (exit 0).
- The capture metadata records exact stdout/stderr/exit file hashes and actual HEAD. Source manifests record raw SHA-256, LF-normalized SHA-256, byte size, Git blob, and HEAD immediately before and after the command.
- Owned lifecycle files are copied from the successful acceptance capture only: three exact owned PostgreSQL containers and exact Node child PID events, including cleanup/absence results.
- External fresh gate roots:
  - acceptance: E:\m1t5-runtime\de0f17b2-f53c-42ae-b56b-eeefbdf0eda4
  - typecheck: E:\m1t5-runtime\9203944f-c555-40cd-a3a1-0f6833bd183d
  - build: E:\m1t5-runtime\910b55ad-6d92-4f2c-8b79-627b92ab10f9
- Attempt history (external roots, not relabeled as passing gates): parse/setup E:\m1t5-runtime\faf17ba9-72d8-440c-b6f9-8af1e3290593; RED expected I1 E:\m1t5-runtime\4b23fa5a-d050-40f6-984c-2ee90cbab5a1; intermediate failures retained at E:\m1t5-runtime\68b93eb2-6676-4a6d-b0b2-a04480499678, E:\m1t5-runtime\d0e5c17c-6ce9-4c5d-b223-e43a3ba12ce5, E:\m1t5-runtime\310281ec-e4dc-4122-baef-1ea2761bb63e, E:\m1t5-runtime\68371e0f-bd10-4c50-8cdf-c921772acbae, E:\m1t5-runtime\ad58f4ce-0eaa-4d19-bd01-4f03a9132803; pre-commit green E:\m1t5-runtime\aa932a9e-fbda-4ebf-bf20-afbc1d9bae86.
- Only an explicit whitelist was copied. The migration baseline snapshot, env/config, secrets, blocked host paths, and unrelated runtime files were excluded.
