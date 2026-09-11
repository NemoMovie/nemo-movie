# Encrypted environment recovery

This is separate from database/upload backups. Do not change backup.js or retention.js.
NEVER use E:. Never commit plaintext or encrypted packages to GitHub. Keep output
outside the checkout, OneDrive, normal backups and production-data directories.
Default output: C:\NemoMovieSecretsRecovery; override with ENV_RECOVERY_ROOT.

## Dependency and approval gate

Use official age: `winget install --id FiloSottile.age` (operator installation only).
Verify `age --version`. The operator reports age v1.3.1 installed; the coding task's
inherited PATH does not resolve it. A successful Windows console roundtrip has NOT
been verified; real packaging is NOT yet approved. Mock tests do not verify
cryptography. No real environment files were read.

From a dedicated interactive VS Code PowerShell terminal at the project root:

```powershell
node backend/env-recovery.js synthetic
```

The expected flow is three entries: encryption passphrase, encryption confirmation,
then the SAME passphrase again for verification decryption. All input is through
age's native non-echoing prompt. The wrapper prints stage instructions only.
age v1.3.1 itself displays an option to leave encryption input empty; it has no
CLI flag to disable this. Nemo Movie does not support that option: enter a nonempty
passphrase. An empty encryption entry generates/displays a passphrase inside age;
an empty decryption entry fails. The wrapper cannot enforce nonempty input without
intercepting/replacing the native prompt, which it intentionally does not do.
Cancel with Ctrl+C if unsure; never continue by submitting blank input. Confirm input
does not appear on screen/history or in process arguments. Do not paste secrets
into commands, PowerShell variables, environment variables or config files.
If nonempty input fails with piped binary input on Windows, stop; do not add an insecure
passphrase workaround. Retest with synthetic data after correcting invocation.

After that manual gate, the proposed first real command is:

```powershell
node backend/env-recovery.js create-real --confirm-prompt-tested
```

This confirmation is an operator assertion. It never happens during tests.
Real inputs are the existing `backend/.env` and `telegram-bot/.env`, NOT new
`backend.env` files. Both must be ignored, untracked, regular files. Configuration
must not change while the two inputs are captured. Keep the passphrase in a vault
recoverable independently of the PC, never beside the encrypted package.

## Format, publication and verification

A bounded version-1 JSON envelope is held in memory. It contains exactly two
base64 byte entries, backend/.env and telegram-bot/.env, plus an internal
recovery-manifest.json with lengths and hashes. Base64 is not encryption: only
the age ciphertext is written to disk during creation. No plaintext archive exists.
The payload is decrypted fully into memory and checked byte-for-byte before
publication. External metadata has only version/time/filename/ciphertext hash/status.

Fresh restricted work folders and exclusive creation protect existing files.
Publication uses exclusive copies, with verified metadata last. Interruption can
leave an orphan/incomplete ciphertext file without metadata; do not treat it as
verified. Never overwrite it. No automatic deletion of old packages is performed.
The wrapper discards age error details; age itself owns the terminal prompt.

## Isolated restore test

```powershell
node backend/env-recovery.js restore-test C:\NemoMovieSecretsRecovery\nemo-env-TIMESTAMP-ID.age
```

Full age authentication and envelope validation precede any plaintext writes.
Only backend.env and telegram-bot.env are written in a fresh restricted disposable
folder, never in live locations. The command reports counts and required-name
PASS/FAIL only, then removes the folder. A cleanup failure reports its exact path
and fails; inspect/remove that folder manually. After abrupt termination, inspect
`.nemo-env-recovery-work-*` folders before claiming cleanup. Do not blindly delete
another active operation's folder. Deletion is not forensic erasure on SSDs.

## Disaster recovery

Restore the matching Git checkout, databases and uploads first. admin-auth.db
belongs to the normal backup system; this package does not replace it. Recover
the age passphrase separately. Validate a decrypted package in isolation, review
machine-specific paths privately, and obtain explicit approval before moving the
two recovered files to backend/.env and telegram-bot/.env. This tool intentionally
does not install files into production or leave test plaintext available afterward;
a separately reviewed recovery/export procedure is required for actual installation.
Restrict NTFS permissions to the operator and SYSTEM/necessary administrators.

In the backend VS Code PowerShell terminal, change to backend and run `npm start`.
In a separate bot terminal, change to telegram-bot and run `node bot.js`.
Validate website/Admin and controlled delivery without printing configuration.

## Rotation and limitations

Regenerate after any secret/configuration change. Keep old encrypted packages until
manual review; they contain historical credentials. Local-only recovery does not
survive total disk failure. Later copy verified ciphertext to the dedicated SSD,
never E:. Store the passphrase elsewhere. Memory zeroing is best effort: JavaScript
strings, OS paging, crash dumps and OneDrive hydration prevent forensic guarantees.
Use full-disk encryption. Concurrent malicious filesystem changes/reparse types
not reported as links are not fully preventable by these user-space checks.
