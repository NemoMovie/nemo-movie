# Backup safety and recovery

## Retention preview only

`node backend/retention.js --dry-run` previews `C:\NemoMovieBackups`.
An explicit `RETENTION_ROOT` override is supported; unsafe source/repository/E:
roots are refused. This command never writes, deletes, renames or marks snapshots.
There is no `--apply` mode. It is not integrated into backup creation.

Candidates require final timestamp/UUID names matching a valid UTC manifest
timestamp, version 1, successful verification, and regular COMPLETE/manifest files.
The newest per latest 7 populated UTC dates, 4 ISO Monday-based weeks and 3 calendar
months are retained as a union. Ties use ascending directory-name order. A regular
PROTECTED marker preserves a snapshot without reading its contents. Suspicious
entries are KEEP/REVIEW; partials are IGNORE. Neither is a deletion candidate.

Preview trusts the recorded verification result; it does not recheck database
integrity or hashes. Names/timestamps/counts/reasons are printed, not database or
manifest contents. Review races with ongoing backups can yield conservative or
stale previews; rerun after backup completion. These plans must never be used as
authorization for deletion without future locking and revalidation safeguards.

Supported production execution: one Windows account and one project checkout.
Use the same account/checkout for every backup; different accounts or checkouts
do not share the temporary-directory lock. Restrict backup-directory permissions.

Do not run until an authorized maintenance window has stopped metadata, poster,
credential and automatic-mapping mutations. `BACKUP_MAINTENANCE_CONFIRMED=1` is
an operator assertion, not an automatic service stop. SQLite backups and uploads
are not an atomic combined snapshot. No production backup has been run by tests.

`BACKUP_ROOT` defaults to `C:\NemoMovieBackups`. Sessions are excluded unless
`BACKUP_INCLUDE_SESSIONS=1`. Environment files require separate encrypted backup.

## Publication

- Every `.partial-*` directory is incomplete and must never be restored.
- Verification and the manifest are finished before the directory rename.
- A final timestamped directory is usable only when it contains `COMPLETE`.
- COMPLETE is published only after the final directory exists. A failed marker
  write may leave `.complete-pending`, which is not evidence of completion.
- A manifest with `verificationSuccess: true` alone does not prove publication.
- A later lock-cleanup warning does not invalidate a successfully completed snapshot.
- No old snapshots are pruned. Preserve them when a new run fails.

## Stale locks

The diagnostic prints the exact lock path, PID and generated run ID. The lock
also records start time and canonical checkout path. Never delete based on age.
Prevent new runs, verify that the owning backup process is gone (account for PID
reuse), and only then manually remove that exact lock file. Do not use wildcard
deletion. An unreadable lock requires the same process investigation. Never
replace/delete a lock while a backup may be active. Cleanup verifies run ownership
but is not a defense against a hostile local process racing filesystem changes.

## Recovery limitations

Plain poster filenames require the matching Git checkout/frontend assets.
External poster URLs and Telegram storage media are not preserved by this backup.
Test restore copies in isolation before replacing production data; no restore
script is provided yet. Verify database integrity, manifest hashes and posters.

Reads have no intentional source writes, but SQLite WAL readers may interact with
shared-memory sidecars and OneDrive/Windows reads may hydrate placeholders.
Filesystem links changed during copying are outside the supported maintenance
assumptions. Directory renames/markers are not a guarantee of power-loss durability;
verify snapshots again before recovery and keep an encrypted off-device copy.
