# Contact Export — frontend

Next.js (App Router) + React + TypeScript + Tailwind CSS 4. Client components only: no server actions, API routes, or middleware. The rules are in `docs/specs/07-frontend.md`, and the look follows the "Contact Export" design system (spec 07, 4.3).

## Run

Requires Node.js 22.12+ and the backend running on port 3000 (`cd ../backend && npm run dev`).

```sh
npm ci
npm run dev        # http://localhost:3001
```

`/api/*` is rewritten to the backend with the prefix stripped, so the browser sees one origin and the `SameSite=Strict` session cookie works without CORS. Set `BACKEND_URL` to point somewhere other than `http://localhost:3000`. In production, Caddy routes `/api/*` itself (T38).

```sh
npm run build      # production build (also typechecks)
npm start          # serve the build on port 3001
npm run typecheck
```

To try the whole flow without a phone, start the backend with fake platforms:

```powershell
cd ..\backend
$env:TELEGRAM_API_ID=' '; $env:TELEGRAM_API_HASH=' '; $env:WHATSAPP_PLATFORM='fake'; npm run dev
```

Use a **space**, not `''`: in PowerShell, assigning `''` deletes the variable, so the backend would read the real keys from `.env` again. The startup log should show both `telegram: using the fake platform` and `whatsapp: using the fake platform`. Open a new window to get the real platforms back.

The fake QR is a placeholder that turns `connected` after about 3 seconds.

## Layout

| Path | What |
| --- | --- |
| `app/page.tsx` | `/`: `GET /auth/me`, then Login, Change password, or Connect |
| `app/login`, `app/change-password` | M1, M2 |
| `app/connect` | M8–M11: platform → QR (→ Telegram password) → groups → download |
| `app/admin/users` | M3–M7: create (temporary password shown once), reset, disable, enable |
| `components/` | The design-system components: AppShell/TopBar, Button, Field, Callout, StepIndicator, PlatformCard, QrPanel, GroupPicker, TempPasswordBox, ConfirmDialog, Logos |
| `lib/api.ts` | The one fetch wrapper (`ApiError`, the navigation rules 401 → `/login` and 403 password change → `/change-password`), the file download, and the leave-page `DELETE` |
| `lib/strings.ts` | Every UI string (English). An Arabic UI later means translating this file and setting `dir="rtl"`. |
| `lib/types.ts` | Response shapes from `docs/04-api.md` |

## Rules worth knowing

- **Arabic and English content:** user and platform text uses `dir="auto"` or `<bdi>`, group rows use `[unicode-bidi:plaintext]`, and the layout uses only logical utilities (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`/`text-start`).
- **Privacy:** no `localStorage` or `sessionStorage`, no console logging, and no external fonts, scripts, or analytics. The downloaded file goes straight to the browser's download (its object URL is revoked right after).
- **Leaving the connect page** (closing the tab, navigating away) sends `DELETE /api/connections/:id` with `keepalive`. The backend's idle reaper is the fallback.
- **Long exports:** the dev rewrite's proxy timeout is raised to 11 minutes (`next.config.ts`), because an export sends nothing until every member is fetched.
- **No automated frontend tests,** by decision (`docs/05-architecture.md`). Use the manual checklist in spec 07, section 5.
