# SHOPME — Deploy Guide

A multi-tenant Shopify order-monitoring app. Frontend: Vite/React (Base44
export, preserved as-is). Backend: Netlify Functions. Database/Auth:
Supabase Postgres with Row Level Security.

## 0. Rotate your Supabase service-role key first

If you ever pasted your Supabase service-role key anywhere outside Netlify's
environment variable settings (chat, a doc, a public repo), rotate it now:
**Supabase Dashboard → Project Settings → API → "Roll" the `service_role` key.**
Only the new key should ever go into Netlify's env vars below.

## 1. Set up Supabase

1. In your Supabase project, open the **SQL Editor** and run the entire
   contents of `supabase/schema.sql`. This creates every table, the
   Row Level Security policies, and an auth trigger that auto-creates a
   `profiles` row whenever someone signs up.
2. **Enable email OTP for signup confirmation** (used by the registration
   flow): Authentication → Email Templates → "Confirm signup" → change the
   template to include `{{ .Token }}` (a 6-digit code) instead of the
   default magic link, and make sure "Enable email confirmations" is on
   under Authentication → Providers → Email.
3. After your first real signup, promote yourself to admin:
   ```sql
   update profiles set role = 'admin' where email = 'you@example.com';
   ```

## 2. Create a Shopify Partner app

1. Create an app in your [Shopify Partner dashboard](https://partners.shopify.com).
2. App URL: `https://your-site.netlify.app`
3. Allowed redirection URL: `https://your-site.netlify.app/.netlify/functions/shopify-oauth-callback`
4. Copy the Client ID and Client Secret — you'll need them below.
5. Request scopes: `read_orders,read_products,read_customers,read_fulfillments`
   (already encoded in `shopify-oauth-begin.js` — nothing to configure here,
   just make sure your app's scope settings in Partners allow these).

## 3a. Deploy to Netlify

```bash
npm install
netlify init          # or: connect this repo in the Netlify dashboard
```

Set environment variables (Site settings → Environment variables, or via CLI):

```bash
netlify env:set VITE_SUPABASE_URL "https://YOUR_PROJECT.supabase.co"
netlify env:set VITE_SUPABASE_ANON_KEY "your-anon-key"
netlify env:set SUPABASE_URL "https://YOUR_PROJECT.supabase.co"
netlify env:set SUPABASE_SERVICE_ROLE_KEY "your-rotated-service-role-key"
netlify env:set TOKEN_ENCRYPTION_KEY "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
netlify env:set OAUTH_STATE_SECRET "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
netlify env:set SHOPIFY_CLIENT_ID "your-shopify-client-id"
netlify env:set SHOPIFY_CLIENT_SECRET "your-shopify-client-secret"
netlify env:set SHOPIFY_APP_URL "https://your-site.netlify.app"
netlify env:set SHOPIFY_API_VERSION "2025-01"
```

Then deploy:

```bash
netlify deploy --prod
```

This uses `netlify/functions/*` (Netlify's function format) and `netlify.toml`
for routing/scheduling. These are separate files from the Vercel version
below — both can exist in the repo at once without conflicting; each
platform only reads its own config.

## 3b. Deploy to Vercel

Import the GitHub repo at vercel.com/new — Vercel auto-detects Vite via
`vercel.json` (build command `npm run build`, output `dist`). This uses
`api/*` (Vercel's function format), which is a separate implementation
from `netlify/functions/*` — same behavior, different runtime conventions.

Set the same environment variables in Vercel's dashboard (Project Settings
→ Environment Variables) — same names/values as the Netlify list above,
except:
- `SHOPIFY_APP_URL` should be your Vercel URL (e.g. `https://your-app.vercel.app`)
- Optionally add `CRON_SECRET` (any random string) — Vercel automatically
  sends it as a bearer token when invoking scheduled functions, which
  `api/order-health-recompute.js` checks if it's set.

**Important Vercel-specific limits:**
- **Cron frequency**: the Hobby (free) plan only allows daily cron jobs.
  `vercel.json` is set to run the health recompute once a day
  (`0 3 * * *`, 3am UTC). On a Pro plan you can change this to
  `*/30 * * * *` to match Netlify's every-30-minutes behavior — webhooks
  still cover most real-time updates either way; this cron only catches
  the "nothing happened for N days" case.
- **Function duration**: `api/shopify-sync-orders.js` and
  `api/order-health-recompute.js` are set to `maxDuration: 60` seconds.
  Vercel Hobby allows up to 60s per function by default; Pro allows more.
  If your initial sync ever times out on a very large store, either raise
  this (Pro plan) or lower `MAX_PAGES` in that file.

Once deployed, update your Shopify Partner app's redirect URL to
`https://your-app.vercel.app/api/shopify-oauth-callback`.



## 4. Try the full flow

Register → confirm email code → activate a license → connect Shopify →
land on the dashboard with real synced orders.

To create a license to activate: sign in as admin at `/admin/login`,
go to Licenses → Create License.

## What's implemented

- Full Supabase schema + Row Level Security (every table, tenant-isolated)
- Real Supabase Auth wired into the existing UI (login/register/session)
- Server-side license activation, rate-limited, atomic claim
- Full Shopify OAuth flow with signed, stateless CSRF protection
- Access tokens encrypted at rest (AES-256-GCM), never sent to the browser
- Webhook receiver: HMAC-verified, idempotent, tenant-scoped, handles
  orders/fulfillments/app-uninstall
- Paginated initial order sync with retry/backoff on rate limits
- Deterministic, configurable order-health engine + scheduled recompute
  for time-based conditions webhooks can't push
- Admin actions (suspend/ban/reactivate users, generate/revoke licenses,
  disconnect stores) — all server-enforced, RLS-backed reads
- AI message generation behind a provider abstraction, currently a safe
  templated stub (no API key required) — swap in a real model later by
  editing the single `aiService` object in `messages-generate.js`

## Known gaps / things to sanity-check after deploy

- **Product images and product-catalog sync aren't implemented** — SHOPME
  tracks orders and line items, not the full Shopify product catalog.
  `getStoreStats().products` currently returns 0.
- **Admin activity log's "device" column** shows `—` — user-agent isn't
  captured server-side yet.
- **`src/pages/Register.jsx`, `ForgotPassword.jsx`, `ResetPassword.jsx`,
  `OAuthConsent.jsx`, `src/lib/AuthContext.jsx`** contain some leftover
  Base44-scaffold code. `Register.jsx` is real and routed; the others are
  unrouted/inert (their local mock fallback makes them harmless, they're
  never imported by `App.jsx`) — safe to delete later during cleanup, left
  in place per "don't remove existing pages" during this pass.
- **`vite.config.js` had a build-breaking bug** (called an undefined
  `base44()` plugin function) — this has been fixed by removing that
  plugin, since the app no longer depends on Base44's own hosting/dev
  tooling. This was necessary for the project to build at all.
- **`src/pages/customer/Dashboard.jsx` was truncated in the uploaded
  project** (ended mid-function, no `return`) — it's been completed to
  match the stats/health/issues/recent-orders/activity data now available.
  Worth a visual once-over since I couldn't run the actual Vite build in
  this environment to screenshot it.
- I was not able to run `npm install && npm run build` in this environment
  (no network access) to do a final compile check — please run it once
  locally or let the platform's build log surface anything before assuming
  it's 100% clean. I did carefully trace every import and call site I
  touched, but a real build is the definitive check. This applies doubly
  to the Vercel port (`api/*`, `vercel.json`) — it's a fresh conversion
  from the Netlify version and hasn't been deployed anywhere yet.
- Google sign-in button was removed from `Register.jsx` (was wired to a
  non-existent provider call) — add it back via Supabase's Google OAuth
  provider if you want it.
- The floating "Demo" view-switcher is now dev-only (`import.meta.env.DEV`)
  and won't appear in your production build.
