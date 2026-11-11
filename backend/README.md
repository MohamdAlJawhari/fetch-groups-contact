# Contact Export backend

Requires Node.js 22.12+ and PostgreSQL. Authentication and admin user management are implemented; future platform and export modules remain empty.

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

Configuration is validated once in `src/config/env.ts`: `DATABASE_URL` and a 32-character `COOKIE_SECRET` are required; `PORT` defaults to 3000, `NODE_ENV` to development, and `CONNECTION_IDLE_TIMEOUT_MS` to 600000. `ADMIN_EMAIL` is optional and reserved for future configuration; authorization uses the user's database role.

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

Each successful admin action records an audit event with the acting admin in `user_id`: `admin_users_listed`, `admin_user_created`, `admin_password_reset`, `admin_user_disabled`, or `admin_user_enabled`. Create, reset, enable, and disable record the affected user in nullable `target_user_id`, a foreign key to `users.id`. Listing users has no individual target, so that column is null. Existing records and authentication events also keep a null target. These events contain no passwords or hashes, and platform is null. Migration `20261111000000_add_audit_target_user` adds the target column without modifying historical records; apply it with `npm run db:deploy` when updating another environment.

Example using the PowerShell `$appSession` from login:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/admin/users' -WebSession $appSession

$body = @{ email = 'person@example.com' } | ConvertTo-Json
$created = Invoke-RestMethod -Uri 'http://localhost:3000/admin/users' `
    -Method Post -ContentType 'application/json' -Body $body -WebSession $appSession
# $created.user contains the account; $created.temporaryPassword is returned once.
```

## Tests

`npm test` runs the authentication, admin authorization, user management, and HTTP tests without a database. To also exercise PostgreSQL repositories, audit persistence, concurrent email uniqueness, and the admin CLI, run in PowerShell:

```powershell
$env:RUN_DATABASE_TESTS = '1'
npm test
Remove-Item Env:RUN_DATABASE_TESTS
```

The database test uses the configured PostgreSQL credentials to create a uniquely named temporary database, applies migrations, runs the tests, and removes that database afterward. The PostgreSQL user must have permission to create databases; the configured application's tables are left untouched.
