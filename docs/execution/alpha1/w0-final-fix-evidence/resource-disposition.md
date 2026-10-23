# W0 final-fix resource disposition

- Owned mounted fixture: `C:\Users\Administrator\AppData\Local\Temp\alpha1-w0-linux-ce937c31a8434017b7f7dc92e4eaf10c`.
- Container names seen in the saved attempt notes: `alpha1-w0-linux-dee2e7e3aeec`, `alpha1-w0-linux-retry-1b5cbf6931cd`, `alpha1-w0-linux-git-14fee99e5988`, `alpha1-w0-linux-final-0cb0a1724a99`, and repeated `alpha1-w0-linux-bigint-identity` runs. The saved logs contain names only; full Docker container IDs were not retained. No IDs are reconstructed or assumed.
- All runs used `docker run --rm`. The apt-install attempt was stopped by name. A final read-only `docker ps --filter name=alpha1-w0-linux-` snapshot showed no matching running containers.
- The exact mounted fixture path was resolved and inspected before cleanup. The recursive removal command was rejected by the command safety gate with: `CreateProcess ... rejected: blocked by policy`. It was not retried. The directory remains at the owned path above and contains only the isolated Linux test fixture/dependencies and its temporary Git metadata.
- No `.env`, secret, user npm config, service container, DB, or volume was copied or changed. The only report artifacts copied into this evidence directory are text logs, source hashes, and npm audit JSON.
