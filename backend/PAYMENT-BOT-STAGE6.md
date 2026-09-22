# Stage 6 synthetic end-to-end validation and future deployment checklist

No deployment is authorized by this document. No real Telegram credentials,
payment accounts, customers, production databases or external drive are used.

## Harness

`payment-bot-e2e.test.js` creates a temporary directory containing synthetic movie,
Admin credential and session databases. It executes the existing server auth
initialization (the same isolated VM convention as the Premium HTTP tests), logs
in through the real login route, and registers the real Premium/Payment Bot APIs.
There are no authentication bypass endpoints. HTTP binds ephemeral loopback only;
the Payment Bot client calls only that fixture. No production server is started.
Telegram polling, acknowledgements and sends are injected fakes. Real SQLite,
services, routes, runtime, flow and delivery worker remain connected.

Date is deterministic; timers are not sped up. Tests advance Date explicitly,
reauthenticate when the eight-hour session expires, and close/reopen the isolated
database/server/services to prove persistence. Cleanup checks the temporary parent
and generated prefix before removing only its own fixture. No .env is loaded.

The operator explicitly approved ACTIVE early-renewal purchases during Stage 6.
Only the bot/backend purchase-entry blockers were removed. The existing ledger
still adds duration to the previous unexpired expiry and applies each payment
once. One open case, stale-button boundaries and confirmation protections remain.

## Exact migration order for a fresh eligible database

Base movie/episode tables must already exist. Apply these functions on one explicitly
chosen isolated/approved database connection, with each migration owning its
transaction; do not wrap the chain in another transaction:

1. `migratePremium` — premium-migration.js
2. `migratePremiumLedgerV3` — premium-ledger-migration.js
3. `migratePaymentCases` — payment-case-migration.js
4. `migratePaymentCaseAdapter` — payment-case-adapter-migration.js
5. `migratePaymentCaseAdmin` — payment-case-admin-migration.js
6. `migratePaymentCaseConversation` — payment-case-conversation-migration.js
7. `migratePaymentCaseWorkflow` — payment-case-workflow-migration.js
8. `migratePaymentBotIntake` — payment-bot-intake-migration.js
9. `migratePaymentCaseCompletion` — payment-case-completion-migration.js
10. `migratePaymentCaseDelivery` — payment-case-delivery-migration.js

For an existing deployment, inspect its exact schema and apply only missing
compatible stages. Do not blindly rerun this list: old exact-schema validators
intentionally reject later amended schemas. Intake, completion and delivery have
their own repeat-validation paths. Existing Premium history without a ledger
requires manual reconciliation; the ledger migration does not invent a baseline.
Legacy conflicting open cases and missing confirmation provenance also fail closed.
No schema or migration implementation was changed in Stage 6.

Verify integrity_check = ok, foreign_key_check empty, required tables/indexes/
triggers present, and preserved history. The tests cover a fresh chain and a
synthetic pre-Payment-Case database containing valid ledger-backed Premium history.

## Backup compatibility

backend/backup.js opens the configured movie database read-only and calls SQLite
`db.backup(destination)`. This copies the entire database, including users,
memberships, payments, cases, evidence metadata, conversation/link tables,
verifications, membership effects, activation attempts, notifications, operation
receipts and delivery state. No table-selection omission was found. The E2E suite
compares these tables after a synthetic whole-database backup/open/integrity check.
No production backup or restore is performed and backup code is unchanged.

The existing backup's core-table check does not certify all Premium schema/business
invariants. Validate those during an isolated restore test too. Screenshot binary
files are not downloaded by this system and are not in SQLite; only their Telegram
metadata is backed up. Telegram availability is still needed for future retrieval.
Poster uploads and the Admin auth database remain separate required backup inputs;
sessions remain optional. Environment files require separate encrypted recovery.
The backup/upload maintenance window remains necessary. Do not touch drive E:.

## Future deployment checklist — do not execute in Stage 6

1. Obtain a separate deployment approval and reconcile the existing production schema.
2. Enter the documented maintenance window; quiesce all mutation sources and workers.
   Take a verified COMPLETE database/uploads/Admin backup and secure environment
   recovery package. Record the matching Git checkpoint. Test restore in isolation.
3. Apply only the approved missing migrations in the dependency order above.
   Stop on any mismatch; do not drop protections or invent legacy data to proceed.
4. Verify schema, integrity, foreign keys and representative history before serving.
5. Preserve existing backend configuration names: DATABASE_PATH, UPLOADS_DIR,
   ADMIN_DATABASE_PATH, SESSION_DATABASE_PATH, SESSION_SECRET, NODE_ENV,
   PUBLIC_ORIGIN, PORT and other existing security configuration. Backend also
   needs PAYMENT_BOT_API_SECRET. Do not replace existing mapping/status secrets.
6. Future Payment Bot configuration names: PAYMENT_BOT_MODE, PAYMENT_BOT_TOKEN,
   PAYMENT_BOT_API_SECRET, PAYMENT_BOT_BACKEND_URL. The token is for the separate
   Payment Bot only. Real mode must be explicit. Real payment-account configuration
   is not implemented/approved by this stage; current instructions remain nonpayable.
7. In a separately approved rollout, restart the backend first, check Admin auth,
   Origin enforcement, no-store, internal secret guards and existing website/bot
   compatibility. Start one Payment Bot process only after backend health is proven.
   Do not start the existing movie bot as part of this Payment Bot procedure.
8. Smoke-test a separately approved account/payment scenario; check ordered durable
   notifications, SENT acknowledgements and no duplicate membership effects. Do not
   log raw proofs, credentials, lease tokens or customer payment evidence.
9. Stop the Payment Bot before rollback. Preserve failed/current databases for review.
   Code rollback alone may not match amended schemas. Restore a complete coherent
   snapshot into isolation first, then use a separately approved production restore.
   A rollback can discard later payments; reconcile external financial history before
   accepting writes. Restored pre-SENT state may resend notifications; do not blindly
   replay payments or claims. Never run two workers against divergent restores.

## Remaining boundaries

- Metadata/history is visible safely in Customer Service; secure screenshot image
  viewing remains unimplemented. Tests do not claim visual proof verification.
- Real Telegram and real payment-account tests remain unauthorized/unperformed.
- Telegram offsets are in memory. SQLite receipts protect mutations, not exactly-once
  reply delivery. Accepted send followed by lost acknowledgement/crash can duplicate
  network delivery after lease recovery.
- Per-customer exhaustion intentionally holds that customer's later messages; other
  customers continue. There is no automatic exhausted-message reset or production
  scheduler. Retry-after-aware scheduling remains future work.
- Reopen tests simulate process restart by closing the isolated listener/stores/DB
  and recreating them, not by killing any production process.

Focused E2E: `node --test --test-concurrency=1 backend/payment-bot-e2e.test.js`.
Full relevant isolated regression command (from repository root):

```
node --test --test-concurrency=1 backend/payment-bot-e2e.test.js backend/payment-case-delivery.test.js backend/payment-case-completion.test.js backend/payment-case-workflow.test.js backend/payment-bot-api.test.js backend/payment-bot-intake.test.js payment-bot/flow.test.js payment-bot/runtime.test.js backend/payment-bot-runtime.test.js backend/payment-case-conversation.test.js backend/payment-case-admin.test.js backend/payment-case-adapter.test.js backend/payment-case-migration.test.js backend/premium-migration.test.js backend/premium-ledger-migration.test.js backend/premium-service.test.js backend/premium-payments.test.js backend/premium-http.test.js backend/premium-browser-fixture.test.js backend/customer-service-frontend.test.js backend/customer-service-browser.test.js
```

Set PLAYWRIGHT_MODULE_PATH to the existing local Playwright module to include the
isolated headless Edge browser check; no package installation is needed in this
checkout. Browser requests are restricted to its synthetic loopback fixture.
Do not use broad test discovery that might invoke unrelated production-facing scripts.
The ACTIVE regression checks unchanged membership before confirmation, plan-only
no-creation, concurrent identical selections, conflicting selections, and the
database's one-open-case constraint. Legacy upgrade checks preserve exact movie/
episode IDs, payment rows/statuses, membership rows and a pre-workflow case ID/status.
