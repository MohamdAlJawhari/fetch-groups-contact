# Contact Export backend

Requires Node.js 22.12+ and PostgreSQL. Authentication, admin user management, and the fake connection lifecycle are implemented. Telegram uses the real `TelegramPlatform` (GramJS) when `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` are set: QR login, two-step verification, and logout work (T16), while groups and contacts come in T17–T18. Without the keys, and for WhatsApp, `FakePlatform` is used. Export (`POST /connections/:id/export`) works against the fake platform.

From this folder, install dependencies with `npm ci`. Copy `.env.example` to `.env` if `.env` does not exist, then edit it:

```dotenv
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/contact_export?schema=public
```

Use your PostgreSQL username and password, and URL-encode special characters in credentials. Create the `contact_export` database in pgAdmin (Databases → Create → Database) if it does not exist. Keep `.env` private. When copying the example, replace its cookie secret with at least 32 random characters.

Apply the committed migration, then start:

```sh
npm run db:deploy
npm start
```

`npm start` generates the Prisma client, compiles TypeScript, and starts the server. Startup checks PostgreSQL connectivity and exits on failure. `GET http://localhost:3000/health` returns HTTP 200 with `{"status":"ok"}`. This is a liveness endpoint; it does not query the database on every request.

For development, use `npm run dev`. After changing the schema, use `npm run db:migrate -- --name descriptive_name`, followed by `npm run db:generate`. Prisma CLI connection settings live in `prisma.config.ts`.

Configuration is validated once in `src/config/env.ts`: `DATABASE_URL` and a 32-character `COOKIE_SECRET` are required; `PORT` defaults to 3000, `NODE_ENV` to development, and `CONNECTION_IDLE_TIMEOUT_MS` to 600000. `ADMIN_EMAIL` is optional and reserved for future configuration; authorization uses the user's database role. `TELEGRAM_API_ID` (a positive integer) and `TELEGRAM_API_HASH` (32 hex characters) come from my.telegram.org. Set both or neither (empty counts as unset). Without them, `telegram` uses the fake platform and startup logs `telegram: using the fake platform`; with `NODE_ENV=production`, startup fails without them. The schema lives in `src/config/env.schema.ts` (`parseEnvironment`), and error messages name variables, never values.

`User` maps to `users`, and `AuditLog` to `audit_log`, with snake_case columns as specified in the plan. User IDs are database-generated UUIDs; audit IDs are bigserial. The migration also enforces the plan's allowed role and platform values with PostgreSQL check constraints. No contact data or platform sessions are stored.

## First admin

From `backend`, run:

```sh
npm run admin:create -- --email admin@example.com
```

The command prompts for a hidden password and confirmation. Use at least 10 characters and at most 72 UTF-8 bytes (bcrypt's input limit). The service also enforces this policy for password changes. It hashes with bcrypt at cost 12, creates an active admin with `mustChangePassword: true`, and refuses to overwrite an existing account or create a second initial admin. For automation, supply the password via `ADMIN_PASSWORD` in the process environment or standard input; do not pass it as a command-line argument. The script never prints the password or hash.

## Authentication

| Endpoint | JSON body | Result |
| --- | --- | --- |
| `POST /auth/login` | `{"email":"admin@example.com","password":"your initial password"}` | Sets the session cookie and returns the public user with `id`, `email`, `role`, and `mustChangePassword`. |
| `POST /auth/logout` | `{}` | Requires the session cookie; works even when `mustChangePassword` is true, revokes the session, clears the cookie, and records logout. |
| `POST /auth/change-password` | `{"currentPassword":"your initial password","newPassword":"your replacement password"}` | Requires the session cookie; verifies the current password, hashes the replacement, clears `mustChangePassword` and the session cookie, revokes every session for that user, and records `password_changed`. Log in again afterward. |

Emails are trimmed and lowercased. Invalid credentials and disabled users return 401 with `{"message":"wrong email or password"}`. Rate-limited attempts return 429 with `Retry-After` in seconds and a message such as `{"message":"too many attempts; try again in 15 minutes"}` (minutes round up). Invalid JSON returns 400. Internal errors use the vague login message without disclosing database details; the server logs an error ID, status, endpoint category, error kind, and an allowlisted error code. Raw errors, messages, stacks, request bodies, cookies, and URLs are excluded from these logs to avoid exposing passwords or credentials. Successful login records `lastLoginAt` and a `login` audit event; logout records a `logout` event. No password hashes or session IDs are returned in response JSON.

Session IDs use 32 cryptographically random bytes and live only in a map for eight hours, with periodic cleanup. Restarting the backend logs everyone out. Cookies are signed using `COOKIE_SECRET`, HTTP-only, `SameSite=Strict`, and `Secure` when `NODE_ENV=production`. Plain HTTP localhost works in development. Keep and resend the cookie when testing with Postman or another HTTP client.

The in-memory login limiter allows 5 failures per normalized email-and-IP pair, 20 per IP across emails, and 50 per email across IPs in a 15-minute window. Only completed authentication failures (401) count; successful logins, internal errors, and already-blocked requests do not. Success resets only the email-and-IP counter. Additional failures do not extend an existing window. JSON parsing runs before the limiter so it can read and normalize the email. Each backend process has its own sessions and rate limits. Proxy headers are not trusted: when deploying behind Caddy, configure Express `trust proxy` for the actual proxy topology so the limiter can identify client IPs reliably.

`requireAuth` loads the user on every protected request and rejects missing, expired, tampered, deleted-user, and inactive-user sessions. By default it also rejects users with `mustChangePassword: true` with HTTP 403 and `{"message":"password change required"}`. Only `POST /auth/change-password` and `POST /auth/logout` explicitly use `requireAuth(..., { allowTemporaryPassword: true })`; session validation and the active-user check still apply there. Login remains public so users can obtain the session needed to change their temporary password. Health is public. Future protected routes using the default middleware inherit this gate. Changing the password clears the flag in PostgreSQL, removes all sessions including the current one, records `password_changed` without passwords or hashes, and expires the browser's session cookie, so the user must log in again.

## Admin users

All routes under `/admin/users` require a valid session for an active user with `role: "admin"` and `mustChangePassword: false`. Ordinary users receive 403 on every admin route; missing or invalid sessions receive 401. The role and password-change flag are loaded from PostgreSQL on every request.

| Method | Path | Request body | Response |
| --- | --- | --- | --- |
| GET | `/admin/users` | None | `200 {"users":[...]}` |
| POST | `/admin/users` | `{"email":"person@example.com"}` | `201 {"user":{...},"temporaryPassword":"..."}` |
| POST | `/admin/users/:id/reset-password` | None | `200 {"user":{...},"temporaryPassword":"..."}` |
| POST | `/admin/users/:id/disable` | None | `200 {"user":{...}}` |
| POST | `/admin/users/:id/enable` | None | `200 {"user":{...}}` |

`:id` must be a UUID. Invalid IDs or bodies return 400, missing users return 404, and duplicate emails return 409. Email addresses are trimmed and stored lowercase; the unique database index also prevents duplicates from simultaneous requests. New accounts always have role `user`; clients cannot submit a role or password on create.

Create and reset generate a fresh temporary password from 24 cryptographically random bytes (32 base64url characters). Only its bcrypt hash is stored. The plaintext appears only in that successful response; copy it then, as listing users cannot retrieve it. All admin responses use `Cache-Control: no-store`. Password hashes are excluded from every response. Public user fields are `id`, `email`, `role`, `isActive`, `mustChangePassword`, `createdAt`, and `lastLoginAt`.

Create and reset set `mustChangePassword: true`. Reset removes all of the target user's sessions, including an admin's own sessions when they reset themselves. Disable also removes all target sessions; enable permits new logins but does not restore old sessions. Reset does not enable a disabled account. An admin cannot disable their own account (400).

Each successful admin mutation records an audit event with the acting admin in `user_id`: `admin_user_created`, `admin_password_reset`, `admin_user_disabled`, or `admin_user_enabled`. Create, reset, enable, and disable record the affected user in nullable `target_user_id`, a foreign key to `users.id`. Listing users writes no audit event. Existing historical list events are retained. Authentication events keep a null target. These events contain no passwords or hashes, and platform is null. Migration `20261111000000_add_audit_target_user` adds the target column without modifying historical records; apply it with `npm run db:deploy` when updating another environment.

Example using the PowerShell `$appSession` from login:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/admin/users' -WebSession $appSession

$body = @{ email = 'person@example.com' } | ConvertTo-Json
$created = Invoke-RestMethod -Uri 'http://localhost:3000/admin/users' `
    -Method Post -ContentType 'application/json' -Body $body -WebSession $appSession
# $created.user contains the account; $created.temporaryPassword is returned once.
```

## Fake connections

All five routes require an active logged-in user who has changed their temporary password:

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/connections` | `{"platform":"telegram"}` or `{"platform":"whatsapp"}` | 201 with `id`, `platform`, `status`, and placeholder `qr`. |
| GET | `/connections/:id` | None | 200 with status; `qr` appears only while waiting for scan. |
| GET | `/connections/:id/groups` | None | 200 with `{"groups":[{"id":"sample-group-1","title":"Sample team"},...]}` once connected; 409 while waiting. |
| POST | `/connections/:id/export` | `{"groupIds":["sample-group-1"]}` | 200 streaming `.xlsx`; then disconnects. See Export below. |
| DELETE | `/connections/:id` | None | 204; disconnects the platform and removes the registry entry. |

The fake QR is a placeholder string, not a scannable login code. The fake platform reports `waiting-for-scan` initially and `connected` after three seconds, using an injectable clock rather than a background scan timer. The platform interface exposes `connect`, `getStatus`, `listGroups`, `listContacts`, and `disconnect`. Fake Telegram contacts have `saved`, `unsaved_reachable`, and `unsaved_unreachable` categories. Fake WhatsApp contacts have `saved` and `unsaved` categories. Contacts leave the backend only inside the exported `.xlsx`.

The in-memory registry stores the owner, platform name, platform object, and last activity under an ID made from 32 cryptographically random bytes. Missing IDs and IDs owned by another user both return 404 with `{"message":"connection not found"}`. Only authorized accesses refresh activity. Starting a new connection disconnects and replaces the user's old connection, even across platform names. Operations are serialized per user to avoid concurrent replacements leaving multiple live platforms.

The reaper checks every minute for connections idle longer than `CONNECTION_IDLE_TIMEOUT_MS` (default 600000, ten minutes). Status polling and group requests refresh the timeout; polling therefore keeps a connection alive. Logout, admin disable, password reset, and password change destroy that user's live connection too. Shutdown stops the reaper, waits for any pending sweep, and disconnects remaining platforms before closing PostgreSQL.

Each start and end records `connection_started` or `connection_ended` under the connection owner's `user_id`, with `platform` set to `telegram` or `whatsapp` and no target. No QR values, contacts, groups, phone numbers, or connection IDs enter the audit events or error logs. All connection responses use `Cache-Control: no-store`. Connections are held in one process only and disappear on restart; no schema migration is needed for this feature.

After logging in using PowerShell and saving the cookie in `$appSession`:

```powershell
$connection = Invoke-RestMethod -Uri 'http://localhost:3000/connections' `
    -Method Post -ContentType 'application/json' `
    -Body '{"platform":"telegram"}' -WebSession $appSession

Start-Sleep -Seconds 3
Invoke-RestMethod -Uri "http://localhost:3000/connections/$($connection.id)" -WebSession $appSession
Invoke-RestMethod -Uri "http://localhost:3000/connections/$($connection.id)/groups" -WebSession $appSession
Invoke-RestMethod -Uri "http://localhost:3000/connections/$($connection.id)" -Method Delete -WebSession $appSession
```

## Export (step 5)

`POST /connections/:id/export` with `{"groupIds":[...]}` (1–50 unique IDs from `/groups`) streams `contacts-<platform>-<UTC date>.xlsx`, then disconnects the connection. The full rules are in `docs/specs/05-export.md`.

| Status | Message | When |
| --- | --- | --- |
| 400 | `select between 1 and 50 groups` | Bad or duplicate `groupIds`, or extra fields |
| 400 | `unknown group selected` | An ID isn't one of the connection's groups |
| 404 | `connection not found` | Missing or not yours, or ended (for example by `DELETE`) while contacts were being fetched |
| 409 | `connection is not connected yet` / `an export is already running` | |
| 502 | `could not read contacts from the platform; please try again` | Fetching failed before streaming. The connection is kept, so retry without a new scan. |
| — | download cut off | A failure, a `DELETE`/logout/disable, or the client leaving after streaming began. The connection is ended. |

- **How it runs:** `ConnectionsService.export` validates under the per-user lock, then fetches and streams **outside** it, so status polls and `DELETE` keep responding during a long export. While the connection's `exporting` flag is set, a second export gets 409 and the reaper skips the connection. Ending the connection by any route calls its `abortExport` callback, which destroys the response.
- **Audit:** `export_started`, then `export_finished` or `export_failed` (user and platform only), then `connection_ended` once.
- **Logs:** stream failures log only the error class name.
- **`ExcelWriter`** (`src/export/excel.writer.ts`) uses the ExcelJS streaming writer and never takes a filename, so nothing touches the disk. There's one sheet per category in order (`Saved`, `Unsaved reachable`, `Unsaved unreachable`, `Unsaved`), including empty ones. The columns are `Name | Phone`, plus `Username` (with `@`) for Telegram-style categories. Every cell is plain text (no formulas), contact IDs are never written, and XML-invalid characters are stripped.
- **`ExportService`** (`src/export/export.service.ts`): `prepare` makes one `listContacts` call, deduplicates by contact `id` (first wins), and sorts by name (ignoring case and accents, empty names last), then by phone and username. `write` delegates to the writer.

After logging in and connecting as above (wait until the status is `connected`):

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/connections/$($connection.id)/export" `
    -Method Post -ContentType 'application/json' `
    -Body '{"groupIds":["sample-group-1","sample-group-2"]}' `
    -WebSession $appSession -OutFile "$HOME\Downloads\contacts-telegram.xlsx"
```

## Telegram (step 6)

The rules are in `docs/specs/06-telegram.md`. `TelegramPlatform` (`src/platforms/telegram/telegram.platform.ts`) holds all GramJS code (`telegram@2.26.22`, pinned):

- **Session:** an in-memory `StringSession('')` per connection, never saved, logged, or returned. GramJS's logger is off. The device shows as `Contact Export Tool` in Telegram → Settings → Devices.
- **Connect:** `POST /connections` resolves as soon as the first login token exists. `qr` is `tg://login?token=<base64url>` and changes about every 30 s. If there's no token within 10 s, it returns `502 could not reach the platform; please try again` and nothing is kept or audited.
- **Two-step verification:** after the scan, an account with a cloud password reports `password-required` (plus `passwordHint` if one is set). Then send `POST /connections/:id/password {"password":"…"}`:

  | Status | Message | When |
  | --- | --- | --- |
  | 200 | *(connection, `connected`)* | Accepted |
  | 400 | `password is required` | Missing, empty, over 256 characters, or extra fields |
  | 409 | `connection is not waiting for a password` | The status isn't `password-required` |
  | 400 | `wrong two-step verification password` | Rejected. It stays `password-required`. |
  | 400 | `too many wrong passwords; start again` | The 5th wrong password. The connection is ended. |
  | 502 | `could not reach the platform; please try again` | Telegram failed or asked to wait. It stays `password-required`. |

  The password is passed to GramJS for the SRP check and never kept, logged, or audited. The check holds the per-user lock (up to 45 s), so status polls wait briefly.
- **Background failures:** if the login fails after the QR is shown (for example the QR loop errors), the status becomes `disconnected` and the client is destroyed. Start again with `POST /connections`.
- **Disconnect:** when logged in, `auth.logOut` (5 s timeout) and then the client is destroyed. Otherwise the login is cancelled and the client destroyed. It never throws, and only error class names and Telegram error codes are logged.
- `FakePlatform` accepts `password`/`passwordHint` options to simulate two-step verification in tests.

To scan without the frontend, poll the status and draw each new `qr` in the terminal (`npx` downloads `qrcode-terminal` once):

```powershell
$connection = Invoke-RestMethod -Uri 'http://localhost:3000/connections' -Method Post `
    -ContentType 'application/json' -Body '{"platform":"telegram"}' -WebSession $appSession
$last = ''
do {
    $s = Invoke-RestMethod -Uri "http://localhost:3000/connections/$($connection.id)" -WebSession $appSession
    if ($s.qr -and $s.qr -ne $last) { Clear-Host; npx --yes qrcode-terminal@0.12.0 $s.qr; $last = $s.qr }
    Start-Sleep -Seconds 2
} while ($s.status -eq 'waiting-for-scan')
$s.status
# Only if it says password-required:
Invoke-RestMethod -Uri "http://localhost:3000/connections/$($connection.id)/password" -Method Post `
    -ContentType 'application/json' -Body (@{ password = (Read-Host 'Telegram 2FA password') } | ConvertTo-Json) -WebSession $appSession
```

In the Telegram app: Settings → Devices → Link Desktop Device, then scan. `GET /connections/:id/groups` on real Telegram fails until T17.

## Tests

`npm test` runs authentication, admin authorization, user management, email capitalization, connection ownership, concurrent replacement, cleanup, fake-clock reaper, Excel writer, export service, export endpoint (errors, audit, concurrency, aborted downloads), environment validation (Telegram keys), the Telegram login state machine with a scripted fake GramJS client (QR, 2FA, logout), the password endpoint, and HTTP tests without a database. To also exercise PostgreSQL repositories, audit persistence, concurrent email uniqueness, and the admin CLI, run in PowerShell:

```powershell
$env:RUN_DATABASE_TESTS = '1'
npm test
Remove-Item Env:RUN_DATABASE_TESTS
```

The database test uses the configured PostgreSQL credentials to create a uniquely named temporary database, applies migrations, runs the tests, and removes that database afterward. The PostgreSQL user must have permission to create databases; the configured application's tables are left untouched.
