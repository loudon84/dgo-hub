# M1-5E1a2-1 Fix 2 independent rereview

Source `28a64e50fa2b782e388410fd8bb3bf3129bc78e7`; Fix 2 base `ce565c01d481a0d6647d154ad87388bb75310d13`. Scope: the two open Fix 1 findings and new Fix 2 breakage.

**Spec: PASS. Quality: Approved.** No actionable findings in this scoped rereview.

The held-fence finding is addressed. The new test intercepts the following source credential lock call and uses a separate database connection to verify the real advisory fence is unavailable while the request holds it. The revoked subsequent function causes a real database error; the test asserts `AUTH_UNAVAILABLE`/503 and no items, then confirms another connection can acquire the same lock after the response. The pre-fence failure case remains separately qualified. Audit failure is N/A for this metadata read under the controller ruling.

The denial-envelope finding is addressed. The tests now require `AUTH_INVALID`/401 for a source bearer, `SOURCE_NOT_FOUND`/404 for wrong tenant and missing source, and `AUTH_REVOKED`/401 for disabled subject/binding and a binding disabled before continuation, with no returned items. These cases use the existing authenticator and API role. The binding-disabled continuation is reauthenticated at request entry; it does not claim a mid-transaction rebinding race.

## Evidence and limitations

Independently checked the manifest SHA-256 `91cf448b08fb3a298ca112ec3088d928cebec164931778e849dbde0faa9965e9` and its 44 entry count. The controller separately verified original/copy hashes and sizes. All three final gate records show actual HEAD before and after `28a64e50fa2b782e388410fd8bb3bf3129bc78e7`, exit zero, and the stated build, typecheck and focused acceptance commands. For all six before/after source captures, independently checked all seven files' raw and LF sizes and SHA-256 against workspace bytes and fixed-commit Git blob IDs and bytes; no mismatches. All final stderr files are empty, and focused stdout reports 26/26 passing.

Inspected the three final focused-run lifecycle records and corresponding later exact-ID absence entries: pinned image digest observed, ownership confirmed, removal and immediate absence recorded, and later Docker checks exited zero with empty output. Vitest executes in process; child-loaded `dist` proof is N/A. Formal 48-case/site/Hermes/production acceptance remains not run.

No tests, builds, mutation tests, new resources, product edits, staging, commits or cleanup were performed in this rereview. No broad audit of predecessor work was performed.
