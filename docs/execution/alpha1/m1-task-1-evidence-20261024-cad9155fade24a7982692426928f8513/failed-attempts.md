## Attempt 2 — initial SQL role test query

Command: `npm exec vitest -- run acceptance-tests/source-registry.test.ts`
Exit: 1. Results: 5 tests, 4 passed, 1 failed.

Raw tool output:

```text
RUN v4.1.12 E:/git/dgo-hub/integration-service
FAIL source-registry.test.ts > does not grant API access to source digest or secret reference and keeps the lock function private
error: role "PUBLIC" does not exist
at acceptance-tests/source-registry.test.ts:68:20
Tests 1 failed | 4 passed
```

Cause: PostgreSQL does not accept `PUBLIC` as a role name in `has_function_privilege`; the test is corrected to inspect function ACL grantee OID 0.
