# Round 1 RED summary (observed before implementation changes)

Command: `npm test -- acceptance-tests/migration-boundary.test.ts acceptance-tests/migrations.test.ts acceptance-tests/identity-store.test.ts`

Result: exit 1; 3 files; 54 tests total; 3 failed and 51 passed.

- Continued-E COMMIT on owned PostgreSQL: `MIGRATION_APPLY_FAILED`; `control.review_e_commit` remained present; migrations 001 and 002 were in the ledger, with no 003 row.
- Continued-E ROLLBACK on owned PostgreSQL: `MIGRATION_APPLY_FAILED`; no escaped table remained, but 001 and 002 were committed to the ledger before the failing 003.
- Submillisecond page traversal: first page had a cursor, but traversal returned 1 of the 3 owned credentials; the other two were omitted.

The migration boundary unit tests observed that the original scanner reached `connect()` for these E-string cases. The independent review probe's raw result is retained in `task-1-review.md` and `task-1-review-probe.mjs`; this summary records the implementation round's focused test output and does not reconstruct a raw log.
