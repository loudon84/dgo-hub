# Temporary Linux verification attempts

All containers used `docker run --rm`; none remain running. The final focused test source was copied into an isolated temporary directory containing only the relevant contract, test, package, and approval example files. No project `.env`, user config, or existing application container/volume was mounted or modified.

- `alpha1-w0-linux-dee2e7e3aeec`: Node 24.14.1. Empty user/global npm config both pointed at `/dev/null`; npm exited before resolving config with `double-loading config "/dev/null" as "global", previously loaded as "user"`. No install or tests ran.
- `alpha1-w0-linux-retry-1b5cbf6931cd` (retry after separate empty config files): `npm ci` added 199 packages; Vitest 4.1.12 ran 75 cases. 73 passed, 1 skipped, 1 failed because the isolated source copy did not yet have a Git HEAD; recorder returned `could not capture hub git SHA`.
- `alpha1-w0-linux-git-14fee99e5988`: temporary Git repository was added, but its first `.gitignore` mistakenly contained literal backtick sequences, tracking temporary node_modules. Recorder smoke test timed out after 5 seconds during Git pathname collection. No production test timeout was changed.
- `alpha1-w0-linux-final-0cb0a1724a99`: corrected temporary `.gitignore`, temporary fixture commit, Node 24.14.1, clean npm ci, Vitest 4.1.12: 4 files passed; 74 passed, 1 platform-specific skip; exit 0. Full output is in `linux-focused.log`.

The repeated container name above denotes separate containers with `--rm`; names are retained to identify the owned attempts. Their mounted temporary directory was `C:\Users\Administrator\AppData\Local\Temp\alpha1-w0-linux-ce937c31a8434017b7f7dc92e4eaf10c`.
