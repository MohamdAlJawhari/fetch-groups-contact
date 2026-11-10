# Contact Export backend

Requires Node.js 22.12+ and PostgreSQL. Authentication is implemented; future admin, platform, and export modules remain empty.

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

The command prompts for a hidden password and confirmation. Use at least 12 characters and at most 72 UTF-8 bytes (bcrypt's input limit). It hashes with bcrypt at cost 12, creates an active admin with `mustChangePassword: true`, and refuses to overwrite an existing account or create a second initial admin. For automation, supply the password via `ADMIN_PASSWORD` in the process environment or standard input; do not pass it as a command-line argument. The script never prints the password or hash.

## Authentication

| Endpoint | JSON body | Result |
| --- | --- | --- |
| `POST /auth/login` | `{"email":"admin@example.com","password":"your initial password"}` | Sets the session cookie and returns the public user with `id`, `email`, `role`, and `mustChangePassword`. |
| `POST /auth/logout` | `{}` | Requires the session cookie; revokes the session, clears the cookie, and records logout. |
| `POST /auth/change-password` | `{"currentPassword":"your initial password","newPassword":"your replacement password"}` | Requires the session cookie; verifies the current password, hashes the replacement, clears `mustChangePassword`, and revokes every session for that user. Log in again afterward. |

Emails are trimmed and lowercased. Every login failure returns `{"message":"wrong email or password"}`. Invalid credentials and disabled users return 401, rate-limited attempts return 429 with `Retry-After`, and invalid JSON returns 400. Internal errors use the same login message without disclosing database details. Successful login records `lastLoginAt` and a `login` audit event; logout records a `logout` event. No password hashes or session IDs are returned in response JSON.

Session IDs use 32 cryptographically random bytes and live only in a map for eight hours, with periodic cleanup. Restarting the backend logs everyone out. Cookies are signed using `COOKIE_SECRET`, HTTP-only, `SameSite=Strict`, and `Secure` when `NODE_ENV=production`. Plain HTTP localhost works in development. Keep and resend the cookie when testing with Postman or another HTTP client.

The in-memory login limiter allows 20 attempts per IP and 5 per normalized email in a 15-minute window, counting successful and unsuccessful attempts. Each backend process has its own sessions and rate limits. Proxy headers are not trusted: when deploying behind Caddy, configure Express `trust proxy` for the actual proxy topology so the limiter can identify client IPs reliably.

`requireAuth` loads the user on every protected request and rejects missing, expired, tampered, deleted-user, and inactive-user sessions. It attaches the public user and session ID to the request. Users flagged `mustChangePassword` can use change-password and logout; future application routes must enforce that flag before allowing other actions.

## Tests

`npm test` runs the authentication and HTTP tests without a database. To also exercise PostgreSQL repositories, audit persistence, and the admin CLI, run in PowerShell:

```powershell
$env:RUN_DATABASE_TESTS = '1'
npm test
Remove-Item Env:RUN_DATABASE_TESTS
```

The database test uses the configured PostgreSQL credentials to create a uniquely named temporary database, applies migrations, runs the tests, and removes that database afterward. The PostgreSQL user must have permission to create databases; the configured application's tables are left untouched.
