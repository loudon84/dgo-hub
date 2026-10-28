# M1-5E1a2-2 Fix1 scoped rereview

- Original P1: **ADDRESSED**.
- Spec: **PASS** for this scoped rereview.
- Quality: **Approved** for this scoped rereview. No actionable new regression was found in the Fix1 diff.
- Fix base `ed8b90cfdc2de8c71a80ae171c59652cb8a867b5`; test source `229cbf136052212c26f378d6ab6868ceb4d9856c`; evidence/report `f204e29727832c7a3a1e1af64d5a7af6103c5f13`. Review covers the prior P1 and changes introduced by Fix1; it is not a new whole-phase review.

## Basis

The only source diff is `integration-service/acceptance-tests/quarantine-read.test.ts`. `admitRecoveryOrigin` sends the actual request through the strict ingestion route using the source bearer and `hub_api` pool. The customer and order cases check the exact sent JSON bytes against the associated raw batch and verify batch ID, event ID and stored record. They run `hub_worker` to produce the original quarantine, create a linked child, run the worker with the same target unavailable, then authorize a new retry after restoring that target and assert worker APPLIED with the original canonical UUID and, for order, the same customer UUID. The test snapshots the original job, item, quarantine index and complete raw row before recovery and compares them afterwards. `assertRecoveryCopy` compares child job and item fields, including frozen proof, raw batch, event and record, excluding fresh identifiers and worker state; it checks the link, fresh operation, one child item and a due unclaimed outbox. The prior synthetic original receipt defect is therefore addressed. Fixture provisioning and later unrelated remap cases remain synthetic; they are not presented as the new REST-origin chain.

The retained RED shows two failed matching linkage assertions and 32 skipped tests before the fix; final build and typecheck exited 0, focused recovery gate passed 2 with 32 skipped, and full quarantine suite passed 34. `verification.json` records before/after captures unchanged, source blob matches, and fixed HEAD for all four final gates. Captures include raw and normalized LF SHA-256, byte sizes and Git blobs. The manifest SHA-256 independently checked here is `c3be389dcd27b33a5a6fa707016fe4eea87d6bf42e26ce6b5a6300727616b755`; the controller separately verified all 60 original/copy pairs and safe unique paths, which this review did not repeat.

The build worker SHA-256 `04814affe67868128b1f03653a25ce74578ab78a6a750f1131d6eef361a6493d` matches the recorded loaded worker in both child records, PIDs 39152 and 46064. Both record observed SIGTERM exit and subsequent absence. Six retained PostgreSQL lifecycle logs identify owned containers and record absence after removal. No tests were rerun or resources created for this review.

## Limits

The separate credential-compromise subtype and exhaustive subject/binding race coverage remain as disclosed in the earlier report. The accepted-009 suffix replay uses a synthetic link, as previously qualified. Snapshot recovery, formal 48-case, site and whole-phase acceptance are outside this verdict.
