# Current workflow reconciliation (Stage 1)

This section supersedes earlier workflow descriptions below, which document the
legacy foundation retained for compatibility.

- OPEN is exactly WAITING_PAYMENT, WAITING_VERIFICATION, CONFIRMED.
- Closed is COMPLETED, REJECTED, CANCELLED, EXPIRED (case expiry, not membership).
- WAITING_PAYMENT may cancel to CANCELLED or expire to EXPIRED at created_at + 24h.
  Closed status/time is preserved using immutable status and updated_at; no deletion.
- createPaymentCaseLifecycle(db,{clock}) exposes deterministic expire(),
  cancel(caseId,telegramUserId), and persisted progress(caseId,telegramUserId).
  No scheduler or customer cancellation button/API was added. Future integrations
  must derive the user ID from trusted Telegram identity. The Payment Bot case
  creation transaction runs expiry cleanup before choosing/resuming a case.
  Until a periodic caller is approved, expiry is not a continuously running job.
- Screenshot metadata determines WAITING_SCREENSHOT / WAITING_LAST_FOUR;
  WAITING_VERIFICATION indicates ADMIN_REVIEW; CONFIRMED indicates ACTIVATION_PENDING.
  Progress survives restart and does not require in-memory bot state.
- New clarification messages do not change case status. NEEDS_CUSTOMER_ACTION
  creation is retired (old authenticated action route returns 410). Existing legacy
  rows/actions remain readable. The old explicit return-to-verification route remains
  solely for reconciling legacy cases with complete evidence; it is not a new UI action.
- Admin Reject applies only to WAITING_VERIFICATION. CUSTOMER_CANCELLED is rejected
  for new actions; legacy audit rows retain it. All reasons require a short note,
  including OTHER. Cancellation is a separate customer-owner service operation.
- New Admin Confirm requires manual evidence/account verification and the actual
  payment time, plus the displayed plan/method/amount consistency checks. Full reference
  is optional for compatibility, absent references are NULL, never fabricated.
  The case becomes durably CONFIRMED without granting Premium. Separate activation/retry
  completes it. Failed activation stays CONFIRMED, rolls back financial/ledger writes,
  and does not request payment again. Confirm replay is idempotent; completed cases have
  no mutation controls and the Admin retry endpoint rejects them.
- The legacy adapter combined-confirm function remains only for legacy callers/tests;
  new Admin confirmation uses verifyPaymentCase. Null-reference activation enters the
  existing Premium confirmation/replay engine through confirmVerifiedCase, which checks
  the exact durable case, internal reservation, user, plan, amount, method, timestamp and
  Admin identity. Legacy public confirmation still requires a real reference.
- Matching Telegram proof metadata produces possible_duplicate_cases (case ID/status
  only) in Admin details. It is a warning, not a decision or proof of duplicated payment.
  No OCR, hashing, binary storage or Telegram retrieval was added.

## Explicit migration and rollout prerequisite

New module: payment-case-workflow-migration.js, migratePaymentCaseWorkflow(db).
It is NOT called by production startup. Apply only through a separately reviewed
maintenance procedure after backup. This task used disposable databases only.
Run after the existing case, adapter, Admin and conversation foundations. On an
upgraded database rerun this workflow migration for idempotent verification; the
older standalone migration validators intentionally reject the changed definitions.

It validates known legacy schema, refuses conflicting existing open/legacy-needs cases,
rebuilds only payment_cases and payment_case_verifications transactionally, preserving
all columns/rows/IDs and legacy reference values. It permits nullable verification
references, adds CANCELLED/EXPIRED, updates targeted guards, and adds a partial unique
index enforcing one open case per Telegram user. No movies, episodes, payments,
membership or ledger table is rebuilt. Foreign keys are disabled only on the isolated
migration connection for the standard SQLite table rebuild, checked before commit,
and restored even on failure. Trigger/view definitions are restored within that same
transaction. Unknown affected dependencies fail closed. Never resolve duplicate open
history automatically; review it before migration. No schema auto-upgrade at runtime.

Legacy NEEDS_CUSTOMER_ACTION is retained in the CHECK for old records, excluded from
Open and treated as a blocker for new bot attempts until explicitly reconciled.
Closed historical cases are never resumed; subsequent purchases get new cases.

## Earlier foundation notes (legacy behavior where superseded above)

# Payment Case foundation (Phase 5, data only)

`migratePaymentCases(db)` in payment-case-migration.js accepts an explicitly opened
connection. It does not load environment files, open a database, run on server
startup, or provide an operator CLI. Production application is a separate approved
step. It requires the existing Premium and membership ledger schemas.

## Additions

- payment_cases: internal autoincrement ID, Telegram-user foreign key, immutable
  plan/days/expected MMK/method/account-reference snapshot, state, submission/
  confirmation/completion/rejection times, confirming/rejecting Admin identities,
  rejection reason, timestamps, unique nullable payment_id.
- payment_case_submissions: append-only optional last-four and Telegram proof
  file ID/unique ID/chat ID/message ID, case foreign key and submission time.
  At least a last-four or proof is required. A correction appends a row; it never
  overwrites an earlier submission. Proof bytes are not stored. Chat/message
  pairs are optional when a Telegram file ID alone suffices.
- payment_cases_latest view: latest nonnull last-four and latest proof submission
  ID. Joining that ID retrieves full proof metadata without duplicating it.
- indexes: case user/ID, case state/ID, submission case/ID.

All case deletion is blocked, including abandoned attempts (retention is not part
of this stage). REJECTED and COMPLETED cannot be updated. Core purchase identity
is immutable from creation; changed plan/method means a new case. CONFIRMED keeps
its confirmation identity/time/evidence frozen and permits only completion.
Evidence cannot be changed/deleted, replaced by INSERT OR REPLACE, or appended to
confirmed/completed/rejected cases. Canonical UTC timestamps and approved plan
price/day tuples are checked in SQLite. Foreign keys must remain enabled on all
future connections, as in existing Premium code.

Allowed transitions:
WAITING_PAYMENT -> WAITING_VERIFICATION / REJECTED
WAITING_VERIFICATION -> NEEDS_CUSTOMER_ACTION / CONFIRMED / REJECTED
NEEDS_CUSTOMER_ACTION -> WAITING_VERIFICATION / REJECTED
CONFIRMED -> COMPLETED

Verification/confirmation requires proof and last-four history. submitted_at must
cover all submitted evidence. Completion requires a unique linked matching
CONFIRMED legacy payment and its existing PAYMENT_GRANT ledger entry. It does not
create that payment or grant. Later corrections to the legacy financial history
remain governed by the existing engine; completed case records remain historical.

## Internal confirmation adapter

Apply `migratePaymentCaseAdapter(db)` explicitly after the foundation migration,
under a separately approved migration procedure. Neither migration runs on import
or server startup. No existing table/guard is rebuilt. The additive migration adds
`payment_case_verifications` and guards for immutable verification, verified case
transitions and reserved financial references. Pre-existing CONFIRMED/COMPLETED
cases without verification require manual review; nothing is backfilled by guess.

The foundation cannot durably hold a full transaction reference, and payment_id
must remain NULL until COMPLETED. The new table solves this without weakening that
constraint: one permanent verification per case, full reference/method (unique
pair), payment time, confirmation time, original Admin identity and unique internal
legacy-compatible NM identifier. UPDATE, DELETE and replacement are prohibited.

Internal usage: `createPaymentCaseAdapter(db).confirmPaymentCase(caseId, data,
adminIdentity)`. Data must contain exactly `transaction_reference`, `payment_at`
(canonical UTC ISO), `plan`, `amount_mmk`, `payment_method`. Identity must come from
authenticated server context, never customer input. This module provides no HTTP
authorization boundary; future routes must reuse existing session/Origin guards.

The customer supplies proof/last-four, not a Request Code or full reference.
Admin must obtain the authoritative reference from actual received-payment records.
References are trimmed with the existing case-sensitive comparison semantics;
values shorter than five characters are refused to exclude last-four-only input.
This length check cannot prove a reference is genuine: actual Admin verification
is required. No reference is synthesized from case ID, screenshot or last-four.
Plan, amount and method must match the immutable purchase snapshot.

Transaction A (IMMEDIATE): validate WAITING_VERIFICATION/evidence and verification
data, reserve the reference and internal code, insert verification, mark CONFIRMED.
Existing confirmed references and other cases' reservations are rejected. Additional
payment triggers prevent legacy confirmation from consuming a reserved reference.
Unreserved legacy requests keep their existing behavior.

Transaction B (IMMEDIATE): reread case/verification; if already COMPLETED return
its existing IDs without writing. Otherwise insert one internal PENDING payment,
call the unchanged Premium service `confirm`, then link payment_id and mark
COMPLETED. The service's nested transaction/savepoint shares this transaction.
No pending-request reuse/cleanup is called: separate cases never share a request.
The reserved code is only used internally, never returned by the adapter. Responses
contain case ID/status/payment ID, or a generic completion-pending result.

Failure in A rolls everything back. Failure in B rolls back payment, grant,
membership and completion together; A remains committed. Retry with the same
verification data is safe, including after restart. Verification cannot be changed
on retry; another authenticated Admin can retry without replacing its original
Admin attribution. An outer transaction is refused to preserve the two commits.
SQLite write serialization plus the reread and unique links prevent duplicate
grants. No asynchronous external I/O occurs between these synchronous operations.

The existing engine receives the durable confirmation time on retry so a delayed
retry does not shift activation or manufacture extra days. If later ledger activity
already exists, completion fails closed for manual reconciliation rather than
backdating a grant past unrelated renewals/corrections. Original history is intact.

CONFIRMED means money verification is durably recorded in the case verification
table. The legacy payment becomes CONFIRMED only together with the membership grant
in B. Consequently existing payment lists/income statistics do not include a case
awaiting completion; future Customer Service must show these cases separately.
Reference reservations are permanent: later corrections/refunds of case-linked
payments need an explicit reviewed policy; they cannot silently reuse a reserved
reference. Direct legacy correction of such payments is not the new case workflow.

No customer-facing bot, API or UI is wired. Next implement protected Admin
verification/retry integration, clear pending-completion reporting and an explicit
manual-reconciliation path, then Payment Bot evidence submission. Never expose
verification records or internal Request Codes through customer DTOs.

Payment account references should be stable, versioned identifiers of the exact
instructions shown, not mutable display names or secrets. Telegram file IDs are
bot-scoped: retain the appropriate bot access for later evidence retrieval. This
schema does not download screenshots or enforce Telegram storage retention.

A future append-only conversation/state-event table can reference case_id without
changing existing tables. Customer-service message delivery, actor authorization,
state-event auditing, bot, APIs and UI are deliberately not implemented here.

No existing table, trigger, row, Request Code, membership or audit history is
rewritten by this migration. Schema mismatch aborts the transaction for review.

## Protected Admin API integration

The existing Premium route registrar now exposes the following under
`/api/admin/premium/cases`. It reuses requireAdmin, authenticated server Admin
identity, mandatory matching Origin for POST, and Cache-Control: no-store.
GET does not require Origin. No customer/bot route or frontend was added.

- GET `/`: page (default 1), limit (default 24, maximum 100), status (any of the
  six approved states), search (Telegram ID/username, literal substring, max 150),
  sort (newest/oldest by internal ID). Returns cases/total/page/limit/totalPages.
  Filter `status=CONFIRMED` identifies money verified but activation pending;
  each row includes activation_pending.
- GET `/:id`: identity, purchase/account reference, lifecycle/rejection information,
  latest last-four/proof submission ID, chronological evidence and Admin action
  history, authoritative verification, linked payment and current membership.
  Evidence exposes submission ID, last-four, timestamp and has_proof only. A future
  protected proof renderer must resolve that ID server-side; no Telegram storage
  identifiers or internal legacy Request Codes appear in these DTOs.
- POST `/:id/needs-customer-action`: `{message}` required; only
  WAITING_VERIFICATION -> NEEDS_CUSTOMER_ACTION.
- POST `/:id/return-to-verification`: `{message}` required; only
  NEEDS_CUSTOMER_ACTION -> WAITING_VERIFICATION, with complete existing evidence.
  This is an explicit Admin review action and does not claim a customer has replied
  or require a fresh screenshot when clarification alone was sufficient. The future
  bot must authenticate the customer, append evidence/reply separately, and apply
  an equally narrow transition; it must not invoke this Admin endpoint anonymously.
- POST `/:id/reject`: `{reason_category,message}` required. Only WAITING_PAYMENT,
  WAITING_VERIFICATION or NEEDS_CUSTOMER_ACTION -> REJECTED. Accepted categories:
  PAYMENT_NOT_FOUND, INCORRECT_PAYMENT_DETAILS, PAYMENT_PROOF_ALREADY_USED,
  INCORRECT_AMOUNT, INVALID_OR_UNCLEAR_PROOF, CUSTOMER_CANCELLED, OTHER.
- POST `/:id/confirm`: the adapter's exact authoritative verification fields;
  responds with actual case, linked payment and membership state.
- POST `/:id/retry-activation`: empty JSON object. Uses durable verification rather
  than resubmitting money confirmation. Only CONFIRMED is eligible for new work;
  COMPLETED is an idempotent read, with no second grant.

Apply the separate additive `migratePaymentCaseAdmin(db)` after the foundation and
adapter migrations during a future approved migration. It creates
payment_case_admin_actions (ID, case FK, action, message, rejection category,
server Admin identity, timestamp), a case index, and append-only/anti-replacement
triggers. Action insert and state update share one immediate transaction. Nothing
is sent to Telegram and no delivery status is implied. Future conversation records
can reference these action IDs to avoid sending messages twice.

These routes do not migrate on startup. Until the schemas are explicitly applied,
case operations return generic 503; existing Premium endpoints continue normally.
Invalid inputs return 400, missing cases 404, inappropriate states 409. Existing
session/Origin failures retain 401/403 behavior. Unexpected errors use the existing
generic server handler, not raw SQL or request logging.

Confirmation/retry responses use HTTP 200 for the durably recorded outcome. A
CONFIRMED result is NOT activation success: activation_pending/completion_pending
are true. completion_error is COMPLETION_FAILED or MANUAL_RECONCILIATION_REQUIRED,
with a safe explanation. Future UI must inspect state and must not display success
based on HTTP status alone. MANUAL_RECONCILIATION_REQUIRED means intervening ledger
activity was detected; repeated automated retry cannot resolve it. No reconciliation
algorithm is introduced in this step.

Accounting is unchanged: CONFIRMED cases awaiting completion still do not contribute
to existing legacy payment income totals. Show them separately in Customer Service;
changing accounting semantics requires a separate decision. Confirmed verification
and completed financial records remain immutable under their existing guards.

## Customer Service frontend

`frontend/customer-service.html` uses only the protected case APIs. Queue search
runs on Search/Enter, filters reset to page 1, and pagination uses server results.
Dialogs require explicit review. Confirmation requires the Admin's full transaction
reference plus actual payment date/time in MMT (converted to UTC), with immutable
case plan/amount/method. No financial totals are computed in the browser.

After any mutation, including an uncertain network result, the dialog closes and
the page refetches authoritative case data. It does not automatically repeat POSTs.
HTTP 200 is not activation success: CONFIRMED displays a prominent pending warning;
COMPLETED displays success. Manual reconciliation is a warning, not an automatic
repair. Rejection and customer-action messages are persisted only, never sent.

Proofs display "Payment proof received — secure preview integration pending."
A future endpoint could be GET /api/admin/premium/cases/:caseId/evidence/:evidenceId/proof.
It must authenticate Admin, check evidence belongs to the case, resolve bot-scoped
Telegram file data server-side, and stream validated image bytes with no-store and
safe content headers. Never return bot tokens, Telegram file URLs, chat/message IDs
or redirect the browser to a token-bearing URL. No such endpoint is implemented.

## Conversation foundation (service/data only)

Case Timeline remains the existing lifecycle/Admin audit. It is NOT chat. Existing
Admin action messages are not automatically copied into conversation or claimed to
have been sent. The new conversation service is separate and no route/UI/bot is
registered or changed by this step.

Explicit additive migration: `migratePaymentCaseConversation(db)`. Importing it
opens no database, loads no environment, and runs no migration. A future separately
approved migration is required before using the service in production.

### Tables and protections

payment_case_messages:
- autoincrement internal id
- payment_case_id and telegram_user_id foreign keys, checked to match each other
- sender_type: CUSTOMER, ADMIN, SYSTEM
- message_type: TEXT, PHOTO, SYSTEM
- optional text_content (up to 4096 characters; required for TEXT/SYSTEM)
- optional Telegram chat/message pair, file ID and file unique ID (references only)
- admin_identifier for ADMIN only
- initial_delivery_state: PENDING_SEND for ADMIN, NOT_APPLICABLE otherwise
- canonical UTC created_at
- unique Telegram chat/message pair for incoming-message duplicate protection
- case/created_at/id index for bounded chronological reads

Supported shapes are CUSTOMER TEXT/PHOTO, ADMIN TEXT, SYSTEM SYSTEM. Type/shape
allowlisting lives in an insertion trigger so an approved future message type can
be added by replacing that trigger and updating validation, without rebuilding
message history. No arbitrary type is accepted today. All messages and proof links
reject UPDATE, DELETE and INSERT OR REPLACE. Foreign keys must stay enabled on
future connections. Appends reject timestamps before case creation or prior
conversation messages, preventing backdated messages from escaping cursor reads.

payment_case_message_evidence:
- message_id primary key/FK
- evidence_id unique FK to payment_case_submissions
- canonical UTC created_at

Links require CUSTOMER PHOTO and evidence from the same case with the same file
reference. Optional unique/chat/message metadata on the evidence must agree.
The separate immutable link can be appended after a photo message is already
recorded. Supplying evidence_id with a new photo inserts both atomically: invalid
links roll back the whole message. No screenshot binary is stored or downloaded.
References may be repeated between tables; the actual file is not duplicated.
Linking existing historical evidence after closure does not reopen the case or
create a new customer/Admin message.

### Service operations and trust boundary

`createPaymentCaseConversationService(db, {clock})` exposes:
- appendCustomerMessage(caseId, input, {telegramUserId})
- prepareAdminMessage(caseId, {text}, {adminIdentifier})
- appendSystemMessage(caseId, {text}) — internal trusted callers only
- linkEvidence(caseId, messageId, evidenceId)
- listMessages(caseId, {limit, after_id}) — browser-safe projection
- getInternalMessage(caseId, messageId) — trusted server-side raw metadata only

Customer input: message_type, text where applicable, telegram_chat_id (canonical
signed numeric string), telegram_message_id, Telegram file references for PHOTO,
and optional evidence_id for PHOTO. Unknown keys, binary buffers and URL/token-like
file references are rejected. Sender and initial delivery state cannot be supplied
by input. Context must be derived from authenticated bot updates/server sessions,
never trusted merely because an arbitrary HTTP client claims a Telegram ID/Admin
identity. No public insertion endpoint exists. The service itself is not an HTTP
authentication boundary. SYSTEM notes are local records, not Telegram messages.

Reads default to 50, maximum 100, sorted by created_at then ID. next_after_id is
returned only when more rows exist; its cursor must belong to the same case.
Browser representation includes message/case/user IDs, sender/type/text, Admin
identity, initial delivery state, date, has_photo and linked evidence ID. Raw
Telegram chat/message/file identifiers are omitted. Never route the internal raw
method directly to a browser. Render text safely; it is untrusted user content.
No tokens/configuration are read or inserted, and nothing is logged. User-authored
text can itself contain sensitive information: future UI/logging must treat all
conversation content as private rather than assuming it has been secret-scanned.

### Closure and delivery

COMPLETED/REJECTED refuse new CUSTOMER or ADMIN messages at both service and DB
layers. Existing messages remain readable permanently. Explicit internal SYSTEM
notes are allowed after closure but never automatically generated or delivered.
No reopen mechanism exists. A future policy/migration would need to explicitly
change this guard; it must not weaken the historical case-state constraints.

PENDING_SEND means recorded/prepared, NOT delivered. NOT_APPLICABLE means no
outbound send was requested; incoming CUSTOMER messages are already received by
an authenticated future bot integration. Message rows are immutable, so future
SENT/FAILED updates must not mutate initial_delivery_state. Add a separate
append-only delivery-attempt/event table and a current-delivery projection when
implementing the authenticated worker. No SENT/FAILED recording API exists now.
That worker must check case closure, avoid stale queued sends, and define duplicate
update/idempotency and ambiguous Telegram timeout behavior before connecting.
Duplicate incoming Telegram chat/message pairs currently fail closed; the future
bot layer can handle a redelivered update without creating another message.

Next: review this schema, then implement dedicated least-privilege Payment Bot
integration and protected conversation APIs; build Dashboard chat and delivery
attempt tracking separately. Existing case statuses, the virtual OPEN list filter,
financial activation, audit history and Admin case actions are unchanged.

## Admin conversation display

`GET /api/admin/premium/cases/:id/messages` requires the existing current Admin
session and returns `Cache-Control: no-store` (including authentication/errors).
It uses the conversation service with `limit` (default 50, maximum 100) and
`after_id` cursor. A cursor must belong to this case; messages are ordered by
`created_at, id`. Response: `{ messages, next_after_id }`.

The explicit browser projection is: `id`, `payment_case_id`, `telegram_user_id`,
`sender_type`, `message_type`, `text_content`, `admin_identifier`,
`initial_delivery_state`, `created_at`, `has_photo`, `evidence_id`.
Telegram storage chat/message/file IDs and internal Request Codes are excluded.
No conversation tables are created by route registration. If the separately
approved conversation migration has not been applied, this read returns 503;
case detail and existing actions remain available. This task does not apply it
to production.

Customer Service shows **Telegram Conversation** separately from Evidence History
and Case Timeline. It renders text using `textContent`, with sender and MMT time.
PHOTO displays only `[Payment screenshot] / Secure preview not connected yet`.
Admin `PENDING_SEND` is explicitly **Pending delivery — not delivered**, not a
successful Telegram send. Load more retrieves subsequent chronological pages.
Loading/error/retry are independent of case detail; switching/reloading a case
invalidates previous conversation requests. There is no reply composer, write
route, real Telegram connection, or proof retrieval/rendering in this step.

The isolated browser fixture seeds synthetic photo/text/Admin/System conversations
before closing historical COMPLETED/REJECTED cases, leaves the CONFIRMED case
empty, and includes HTML-like text for safe-rendering checks. All databases and
credentials remain synthetic, with no production services contacted.

## Payment Bot Stage 2 intake amendment

`payment-bot-intake-migration.js` is an explicit, transactional amendment after the
Stage 1 workflow migration. It adds immutable `payment_case_method_changes` and
`payment_bot_operations` tables. The case-update guard allows only the method/account
change authorized by the latest matching audit row; audit insertion applies the
change atomically. It requires unexpired WAITING_PAYMENT and no PHOTO/proof history.
No unrestricted case updates or deletions are enabled. Production migration is NOT
automatic and was not run. Stage 1 exact-schema validation should not be run after
this amendment; repeat the Stage 2 migration to validate its schema instead.

`payment-bot-intake.js` implements DB-derived progress, append-only photo replacement,
exact four-digit submission, cancellation, lazy expiry and durable event receipts.
Photo evidence, conversation links, submission transitions and receipts share one
transaction. Existing Admin review/activation remains separate and unchanged.
All account instructions are development-only/nonpayable. See payment-bot/README.md.

## Stage 3 confirmation, activation and notification preparation

Explicit migration: `migratePaymentCaseCompletion(db)` in
`payment-case-completion-migration.js`, after the Stage 2 intake migration. It is
additive/idempotent and does not run at startup. Existing case/evidence/ledger
schema is not rebuilt. Production application remains a separate approved step.
Until this migration exists, Stage 1 Admin service behavior is retained for
compatibility; the synthetic browser fixture explicitly applies Stage 3.

Adds `payment_case_notifications`: one logical CONFIRMED, COMPLETED or REJECTED
notification per case, linked to an immutable SYSTEM conversation message. Text
and structured RESELECT action are immutable. Delivery state supports
PENDING_SEND / FAILED / SENT, with SENT terminal. No delivery worker or Telegram
sending/acknowledgement endpoint is implemented in this stage. SYSTEM message
initial_delivery_state remains historical NOT_APPLICABLE; the linked notification's
delivery_state is the authoritative outbound state and appears in conversation
projections. Existing prepared Admin messages remain unchanged.

Adds immutable `payment_case_activation_attempts`: actor, case, UTC timestamp and
safe outcome code only. It never stores raw errors. Durable verification is the
confirmation audit; the existing payment and membership ledger own the grant.

In Stage 3, Admin Confirm disallows full transaction-reference fields, records
verification plus CONFIRMED notification atomically, then attempts activation in
an independent transaction. Activation uses the original confirmation instant,
preserves active membership time, and commits completion plus success notification
and attempt audit together. Failure leaves CONFIRMED and records a safe failure.
Retry uses the same verified case. Matching already-applied payments/ledger effects
are reconciled without another grant; inconsistent or intervening ledger history
fails closed for manual review. Closed cases are not reopened; identical repeat
Confirm/Reject can return their existing result without mutation. Completed Retry
is refused.

Rejection and its notification commit together; OTHER requires a nonblank reason.
The six approved rejection categories remain unchanged. Rejection RESELECT is a
structured action using the existing plans:<closed-case-id> callback. Other
notifications have no return-to-bot button. MMT formatting uses explicit UTC+06:30,
not host timezone. All notification rendering is plain text.

GET /api/internal/payment-bot/notifications returns at most 100 unsent/failed
notifications in message order for a future trusted worker. Dedicated Payment Bot
Bearer authentication and no-store apply; Admin cookies never authorize it. The
projection contains intended recipient, text and logical action, not proof IDs,
internal request codes or secrets. This read does not mark messages sent. Future
worker design still needs claims/acknowledgements, retries and duplicate-send risk
handling before any real delivery. No notifications are delivered by Stage 3.

## Stage 4 durable delivery foundation (fake transport only)

Explicit `migratePaymentCaseDelivery(db)` follows Stage 3; no production startup
migration is added. `payment_case_deliveries` is companion metadata keyed by the
existing immutable conversation message ID, not a second payload queue. Migration
backfills prepared Admin messages and Stage 3 notifications, preserving SENT.
Triggers enqueue new Admin messages/notifications in their creation transaction.
SYSTEM notification delivery state is synchronized with the companion metadata.

Worker API, under the dedicated Payment Bot Bearer guard and no-store:
- POST /api/internal/payment-bot/deliveries/claim with {}
- POST /api/internal/payment-bot/deliveries/:messageId/sent with {claim_token}
- POST /api/internal/payment-bot/deliveries/:messageId/failed with {claim_token}

Claim uses an immediate SQLite transaction and a random 120-second lease. An
expired lease becomes FAILED/LEASE_EXPIRED and is recoverable. Acknowledgements
require the current token; an older replaced claim cannot acknowledge. An expired
but not yet recovered/replaced claim may still acknowledge, minimizing duplicate
risk. SENT is terminal; repeated acknowledgement is idempotent. No raw transport
error is accepted/stored: failures become TRANSPORT_FAILED only. Attempt count and
last attempt time are durable. FAILED retries wait 60 seconds, with at most five
claims, including crashed claims. Exhausted deliveries remain FAILED for operator
review; no reset/retry Admin control is implemented yet.

Creation timestamp + message ID determine order. The earliest unsent message for
a customer blocks later messages for that customer (including across cases), but
never blocks other customers. Exhausted messages therefore hold that customer's
later queue until a future reviewed recovery operation. Do not blindly change DB
rows in production. The old GET /notifications endpoint is inspection only, not a
claim or delivery acknowledgement mechanism.

Admin POST /api/admin/premium/cases/:id/messages persists {text} through existing
session + Origin checks. Customer Service offers Queue message, with no automatic
POST retry and no mark-sent control. Closed cases refuse ordinary Admin messages.
Delivery never changes case/payment/membership state. Conversation projections
show only safe delivery state/count/timestamps/category, not recipient/claim/proof
references. The existing case identity display is unchanged.

`payment-bot/delivery-worker.js` exposes injected processOne()/processBatch(max20).
`fake-transport.js` has no network or token support. Worker imports do not start
anything and bot.js is not wired to poll deliveries. A send followed by a lost ack
is ACK_UNCERTAIN, never immediately resent or falsely marked FAILED. Leases permit
recovery after restart. If the transport accepted a send but SENT was not committed,
a later recovery may send twice: this is recoverable at-least-once delivery, NOT
exactly-once Telegram delivery. A slow/stalled sender exceeding its lease has the
same limitation. Future real transport must bound send duration, implement claim
renewal if necessary, and address ambiguous outcomes before live rollout.

Rejection actions retain plans:<case-id>, an opaque case boundary already used in
Stage 2; it contains no trusted customer identity or secret. Telegram from.id
remains authoritative. Text is plain text, with no parse_mode or HTML interpretation.
No approved Stage 3 customer wording changes in Stage 4.
