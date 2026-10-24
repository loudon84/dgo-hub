# Gate output retention record

Historical gate output status: `NOT_RETAINED`. The earlier passing and failing gate stdout/stderr and their original tool responses were not captured in retained files. The command/result/exit summaries in the Task 3 report remain summaries, not raw output. They have not been reconstructed.

A current-source supplemental sequence was captured to fill the review artifact gap. Run ID: `74ee7ba0-3902-4094-ab54-502999bc07ab`. Gate HEAD: `eb47494fcd98ca5a2bfb6acba7fe34d4d666b03b`, containing docs/evidence-only commits after source commit `ab7cfe565766c60e4de5ac8cfa2b5ab7f2334db5`. Start: `2026-10-24T10:47:39.6701736Z`. End: `2026-10-24T10:47:58.1291617Z`.

The `gate-captures/74ee7ba0-3902-4094-ab54-502999bc07ab/` directory contains actual stdout and stderr files, per-command exit/command JSON, `gate-results.json`, and pre/post raw/LF/Git blob source manifests. Current sequence: `npm run typecheck` exit 0; `npm test` exit 0, 18 test files and 288 tests passed; `npm run build` exit 0. The capture summary records all command file hashes, 15 unchanged source/test paths, migrations 001–006 unchanged, migration 007 SHA-256, and fixture lifecycle counts.

This supplemental capture documents the current run only. It does not recreate the historical gate output or historical failing RED transcripts.