# AUTH_SPEC — authentication and account lifecycle (current)

> Implementation: `public/auth-ui.js` (471 lines) + `DELETE /api/account` in `server.js`.
> Snapshot: 2026-10-05. Describes what exists — no changes proposed here.
> Legend: **CURRENT** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Provider and initialisation (CURRENT)

1. On page load `auth-ui.js` calls `GET /api/config`.
2. If `SUPABASE_URL` **and** `SUPABASE_ANON_KEY` are present, it calls `window.supabase.createClient(url, anonKey)` (library loaded from the pinned, SRI-verified CDN script in `index.html`).
3. `auth.getSession()` loads any persisted session; `handleAuthState(session)` updates the UI; `auth.onAuthStateChange()` keeps it in sync afterwards.
4. If config is missing or the library failed, the app initialises signed-out and reports "Supabase is not configured." when auth is attempted.
5. `window.animeHubAuthReady` is a promise resolved once initialisation finishes; `getAnimeHubAuthState()` exposes `{ ready, session }`; a `animehub:auth-state` window event is dispatched on every change.

## 2. Sign up (CURRENT)

- Modal mode `signup`: `auth.signUp({ email, password })`.
- On success the modal shows "Check your email for a verification link." (Supabase email confirmation applies).
- The modal stays open (the user is not auto-navigated).
- Errors are surfaced verbatim in the modal's live error region.
- Profile creation is handled by the database trigger `handle_new_user()` (see `docs/DATABASE.md`).

## 3. Log in (CURRENT)

- Modal mode `login`: `auth.signInWithPassword({ email, password })`.
- Success closes the modal; the header switches to Profile/Log Out; `handleAuthState` runs (including the watchlist migration prompt below).
- Failure shows the provider's message.

## 4. Log out (CURRENT)

- `auth.signOut()` → `handleAuthState(null)` → local state resets; if the Profile page is open the app navigates home.
- Logout clears the session only; the per-user cloud cache in `localStorage` is left in place (it is keyed by user id and is not readable as another user's data by the app).

## 5. Password reset (CURRENT)

- Modal mode `reset`: email field only (password field hidden and not required); `auth.resetPasswordForEmail(email)`.
- Success shows "Password reset email sent. Check your inbox."; the actual reset completes on Supabase's hosted flow (not implemented in this repository).

## 6. Email verification (CURRENT)

- The Profile page shows "Email verified" (green) when `user.email_confirmed_at` is set, otherwise "Email not yet verified — check your inbox".
- No in-app resend-verification control exists.

## 7. Session persistence (CURRENT)

- Persistence is whatever supabase-js uses by default in the browser (local storage); this repo configures nothing custom.
- `onAuthStateChange` re-runs the auth state handler on refresh/sign-in/sign-out events.

## 8. Profile (CURRENT)

- Page `#page-profile`, reachable only while signed in: the nav link is hidden when signed out, and `navigateToPage('profile')` awaits auth readiness and opens the login modal instead when there is no session.
- Shows: email and verification status. No editing, no avatar, no display name.

## 9. Account deletion (CURRENT)

1. "Delete My Account" → `confirm()` warning (permanent, irreversible).
2. Requires a live session; otherwise "Please sign in again before deleting your account."
3. `DELETE /api/account` with `Authorization: Bearer <access_token>`.
4. Server verifies the token with Supabase Auth and deletes **only that verified user** with the Admin API (see `docs/API_SPEC.md` §`DELETE /api/account`).
5. On success the client removes `anime_hub_watchlist` and the per-user cache, signs out locally, navigates home, and alerts confirmation.
6. On failure the button re-enables and the error is shown; nothing is deleted client-side.
7. If the server is not configured with Supabase credentials, deletion returns 503 and the UI reports the failure message.

## 10. Watchlist synchronisation (CURRENT)

- Signing in triggers `syncLocalWatchlistToCloud(session)` when a guest watchlist exists.
- The user is asked by `confirm('We found an offline watchlist. Do you want to sync it to your account?')`.
- Accepting: items are normalised (valid IDs and watch-progress fields), missing rows are upserted with `onConflict: 'user_id,anime_id'`, results are **verified by read-back**, then the local key is removed.
- Declining: remembered in `sessionStorage` under `anime_hub_watchlist_migration_declined_<userId>` so the prompt does not reappear in that session; the local watchlist is kept.
- Failure (network/validation): local data is kept untouched, an error is logged, and a toast "Watchlist sync failed. Your local watchlist was kept." is dispatched.
- Signing out restores the guest watchlist view (`loadLocalWatchlist()`).
- Watch status and title-level episode progress use the same ownership boundary: browser writes are filtered by the current session user and protected by the Supabase watchlist UPDATE policy. The browser never supplies another user's identity.

## 11. UI/accessibility behaviour of the auth modal (CURRENT)

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby="auth-title"`.
- Opening moves focus to the email field and remembers the previously focused element; closing restores it.
- Escape closes; clicking the backdrop closes; Tab/Shift+Tab are trapped inside the modal.
- One form serves three modes (login/signup/reset) with the password field hidden in reset mode and the switch link updating its label ("Need an account? Sign Up" / "Already have an account? Log In"); the "Forgot password?" link is hidden in reset mode.

## 12. NOT IMPLEMENTED

- Social/OAuth sign-in (Google/GitHub/etc.).
- Magic-link sign-in.
- MFA / 2FA.
- Account settings (email change, password change while signed in, display name).
- Deleting individual cloud watchlist rows from a management screen beyond the star toggle.
- Any admin/role concept.

## 13. NOT FOUND / NEEDS CONFIRMATION

- Supabase project settings that affect auth (email templates, rate limits, allowed redirect URLs, confirmation requirements) — configured in the Supabase dashboard, not in this repository.
- Session lifetime/refresh configuration (Supabase defaults).
- Whether email confirmation is enabled for the live project.
