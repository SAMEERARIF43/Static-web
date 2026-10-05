# ADMIN_SPEC — administration system

> Snapshot: 2026-10-05.
> Legend: **CURRENT** · **PLANNED** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Current state

```text
ADMIN SYSTEM = NOT IMPLEMENTED
```

Verified absent:

- **No admin routes** in `server.js` (the only routes are the public catalog/SEO/config endpoints and self-service `DELETE /api/account`).
- **No admin UI** — `public/index.html` has no admin page; no admin CSS classes exist in `style.css`.
- **No roles or permissions** — no role column, no role claim handling, no allowlist of administrator accounts.
- **No admin tables** — `supabase-schema.sql` defines only `profiles` and `watchlist`.
- **No content-management endpoints** — the 12 curated entries in `ANIME_DB` are edited directly in source code (`server.js`), which is the only "content management" that exists today.
- The word "admin" in `server.js` refers exclusively to the **Supabase Admin API** used to delete the authenticated user's own account; it is not an admin feature.

## 2. Why nothing exists

- The catalog is entirely third-party (AniList) plus a small curated array; there is no user-generated content to moderate.
- No product requirement for administration has been recorded — **NEEDS CONFIRMATION** whether one is wanted at all.
- Account data is user-owned and protected by RLS; no operator workflow needs to read it.

## 3. Decisions required before building anything (PLANNED — decision list only)

1. **Purpose.** What must an admin actually do? Candidate scopes: curate the local catalog overlay, manage legal-page contact addresses, view operational status, handle DMCA/abuse reports, manage users. Without a concrete purpose there is nothing to design.
2. **Roles & permissions.** Decide role model (e.g. `admin` vs `moderator`), where roles live (Supabase `profiles.role`, a separate `roles` table, or a JWT claim), and how elevation is granted/revoked.
3. **Admin authentication.** Reuse Supabase Auth (recommended for consistency) with a role check enforced by RLS/claims; decide whether admin access requires MFA.
4. **Admin UI.** Decide location (hidden SPA page inside `public/`, or a separate app). A hidden page in the current SPA would be discoverable in source — acceptable only if the server/data layer enforces authorisation.
5. **Anime management.** Decide whether admins edit the 12-item curated overlay (currently hardcoded) — that would require a `curated_titles` table and a merge-path change, or whether curation stays in code.
6. **Episode management.** Depends entirely on the episode model decision in `docs/WATCH_SYSTEM.md`; nothing can be managed before an episode identity exists.
7. **Moderation.** Decide whether any user-generated content (comments, reviews, tags) will exist — none does today, so there is nothing to moderate.
8. **Auditing.** Decide whether admin actions are logged (who changed what, when) and where those logs live.
9. **RLS for admin reads.** If admins ever read user rows, that requires explicit policies (e.g. a service-role-only server route or a role-checked policy). The current RLS has no admin path by design.

## 4. Constraints on any future admin design

- The service-role key must remain server-side; an admin UI must never receive it.
- Any admin capability that reads other users' data must be server-mediated with explicit authorisation checks; RLS as configured protects users from each other, not from an administrator.
- The admin surface must not break the existing public flows or the non-hosting legal positioning.

## 5. NOT FOUND / NEEDS CONFIRMATION

- Whether an admin system is in scope at all.
- Who the operator(s) would be and how many.
- Any hosting/database access policy for operators.
