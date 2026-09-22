# Synthetic Premium browser fixture

Development only. This does not run or import `server.js` as a server, load `.env`,
copy a database, or contact production. It follows `premium-http.test.js`: reads the
bounded auth/session initialization from `server.js` and executes it with explicit
synthetic dependencies/configuration, then registers the real Premium routes.
The VM is for dependency isolation, not a sandbox for untrusted source code.

## Start manually

From the project root in a **new** PowerShell terminal:

```powershell
node backend/premium-browser-fixture.js
```

Default: `127.0.0.1:3101`. Optional port override in that terminal only:

```powershell
$env:PREMIUM_FIXTURE_PORT = '3102'
node backend/premium-browser-fixture.js
```

Port 3000, invalid ports and ports below 1024 are refused before file creation.
An occupied port fails; there is no fallback to another port or interface.
No host or database-path override is supported. Production path/secret variables
are ignored. Do not change `.env` to configure this fixture.

## Browser

Use **127.0.0.1**, not localhost, a LAN address, or the public domain:

- Login: http://127.0.0.1:3101/login.html
- Dashboard: http://127.0.0.1:3101/premium-admin.html
- User Details: http://127.0.0.1:3101/premium-user-details.html?telegramUserId=101

Synthetic login: **FixtureAdmin** / **Fixture-Only-Password-2026!**
These are deliberately public test credentials, never production credentials.
Do not save them over production credentials in a password manager.
Login uses the normal password verification, session regeneration and Admin guards.
A per-run fixture cookie name/secret prevents collisions with production sessions.
Logout destroys the fixture session and clears only its cookie.

Every served HTML page has a SYNTHETIC DATA banner. The fixture serves only the
Premium/login assets. Login's existing `admin.html` redirect (and Back to Movie
Admin) goes to the synthetic Premium Dashboard. Movie Admin, uploads, account
settings, internal mapping routes, databases and environment files are not served.
Host/Origin checks reject other sites and require same-origin writes. The fixture
adds a same-origin CSP; it does not change production security middleware.

## Fake data

- User 101: `fixture_active`, active paid membership and auditable ledger.
- User 202: `fixture_expired`, expired paid membership and auditable ledger.
- Two confirmed synthetic payments, 22 VOID pagination records, one valid pending
  request for user 101. Find its generated code in Pending Payments.
- User 101 history has 24 rows (20 + 4). All names, references and amounts are
  synthetic. Confirm Payment / Correct Membership affect only this run's data.

There is no bot, Telegram connection, real payment provider, or production data.
Each run starts fresh. Request expiry and memberships use real elapsed time, so
restart the fixture for a fresh dataset after extended testing.

## Stop and cleanup

Press **Ctrl+C in the fixture terminal only**. The fixture closes its listener,
waits for requests, clears timers, closes SQLite stores, then removes only its
owned `nemo-premium-browser-*` directory under the OS temporary directory.
Ownership, directory identity and alias checks precede recursive cleanup. A failed
check leaves the directory for review rather than deleting it. SIGTERM is also
handled. Never stop the separate production backend/bot terminals.

A forced kill, terminal crash or power failure can leave synthetic temporary data.
The path is printed at startup. Before manual removal, confirm that fixture is no
longer running and that the exact directory is an OS-temp `nemo-premium-browser-*`
directory with `FIXTURE-OWNER.json`. Never delete based on a broad wildcard; do not
touch project databases or `C:\NemoMovieData`. Nothing in this folder is recovery
data. No automatic stale-folder cleanup is performed.

## Tests

Explicit isolated files only, from project root:

```powershell
node --test --test-concurrency=1 backend/premium-browser-fixture.test.js backend/premium-http.test.js
```

Tests use allocated loopback ports other than 3000, temporary synthetic databases
and fake credentials. They close their listeners after testing. Do not use broad
`node --test` discovery: this repository also contains legacy manual localhost
scripts. The fixture must be reviewed if the auth initialization boundary changes.

Keep fixture ports local: do not add them to Cloudflare, port forwarding or firewall
rules. Other processes/users on the same PC may access this deliberately fake
service; it is not intended for deployment or real credentials/data.

## Customer Service browser testing

Open http://127.0.0.1:3101/customer-service.html after the normal synthetic login.
Six synthetic Payment Cases cover every state: WAITING_PAYMENT,
WAITING_VERIFICATION, NEEDS_CUSTOMER_ACTION, CONFIRMED, COMPLETED and REJECTED.
They use separate fake users 301–306, fake proof identifiers, and manual action
history. The CONFIRMED case has durable verification from a deliberately failed
synthetic grant; its retry can succeed. No Telegram service is involved.

This adds one completed synthetic payment to the older fixture totals: 26 payment
rows overall, 25 permanent history rows. User 101's original 24-row history and
manual membership correction scenario remain unchanged.

The Customer Service page renders proof placeholders, never financial screenshots.
No raw Telegram storage IDs or internal Request Codes are shown. Messages are only
recorded in the synthetic database; they are not delivered to Telegram.

Optional real headless browser test (requires an existing Playwright installation
and Microsoft Edge; no dependency installation is performed): set
PLAYWRIGHT_MODULE_PATH to the absolute path to Playwright's index.mjs, then run
`node --test backend/customer-service-browser.test.js`. This test starts and stops
its own isolated fixture at an allocated loopback port other than 3000, blocks
browser requests to other origins, and cleans up its synthetic databases.
The test skips when Playwright is not explicitly configured.

Always-available mocked frontend tests:
`node --test backend/customer-service-frontend.test.js`.
