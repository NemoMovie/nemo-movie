# Premium backend Phase 3

No frontend/bot integration or schema migration runs from this module.

Admin routes use existing session authentication and same-origin mutation checks.
Admin identity is taken from the current server credential after session validation.

Internal status reads require a new backend environment variable,
`PREMIUM_STATUS_SECRET`, supplied as `Authorization: Bearer <secret>` by a future
trusted integration. It must be a separate strong secret, never a mapping write
secret. No environment files were edited. Missing configuration returns 503;
invalid authentication returns 401. Responses have Cache-Control: no-store.

Routes under `/api/admin/premium`:
- GET `/stats`, `/users`, `/users/:telegramUserId`
- GET `/users/:telegramUserId/payments`, `/pending`, `/payments/request/:code`
- POST `/users` (identity upsert), `/payments/request`
- POST `/payments/:id/confirm`, `/payments/:id/void`, `/payments/:id/correct`
- PUT `/users/:telegramUserId/membership`

Internal: GET `/api/internal/premium/users/:telegramUserId/status`.

Request creation takes telegram_user_id, plan, payment_method only. Confirmation
accepts transaction_reference and payment_at (canonical UTC ISO with milliseconds).
VOID takes reason. Payment correction takes reason, plan, payment_method.
Membership correction takes start_at, expires_at, reason only.

Users/pending lists default to 24; history defaults to 20; limit is capped at 100.
Pending sorting supports newest/oldest. Matching uses SQLite LIKE literal
substrings; NOCASE/LIKE are not full Unicode case folding.

Cleanup runs at registration/startup and every ten minutes (unref timer), as well
as request creation. It deletes only expired PENDING/EXPIRED rows with canonical
valid timestamps. The database trigger remains an independent final guard.
No cleanup runs merely by importing the modules. Tests use in-memory databases.

Corrections preserve the original payment with CORRECTED status and create a
PENDING replacement, linked through the existing audit record. Membership stays
unchanged until confirmation. Confirmation adds a revision at the original
ledger event_order/effective_at, then replays the highest revision of every
logical event in order. It replaces the original duration rather than adding
another independent extension. Later renewals and absolute manual corrections
are replayed afterward. Missing or ambiguous history fails closed.

The v3 ledger must already be installed; the service never migrates it. Normal
confirmation and manual membership correction append effects transactionally.
Payment status, ledger/audit writes, and membership projection commit or roll
back together. Existing membership dates must match replay before mutations;
legacy/imported membership without authoritative effects requires review.

Code generation retries collisions up to 100 times, then returns a generic 503
rather than hanging. Normal collisions are invisible to users. Expired deleted
codes are not retained in a separate registry: uniqueness is enforced against
existing payments. This follows the approved deletion rule, not lifetime code
reservation.

The system assumes membership rows represent successfully activated membership
(or legacy imported Premium data), a correctly synchronized host clock, one
backend process, and the approved Phase 2 schema/guard already installed.
No refund workflows, Telegram messages, reminders, or Premium delivery gate are
implemented. Deploy only after manual review; no production restart was performed.
