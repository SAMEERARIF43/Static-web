# Anime Hub — Supabase Migration Runbook

**Project:** Anime Hub  
**Database:** Supabase (PostgreSQL)  
**Last updated:** Thu Nov 05 2026  
**Status:** Documentation only — do not execute against production without operator approval

---

## 1. Migration Files and Execution Order

Migrations must be applied in the following order. Migration 001 assumes the `public.watchlist` table already exists (created by the base schema).

| Order | File | Purpose | Dependencies | Idempotent | Data Impact |
|-------|------|---------|--------------|------------|-------------|
| 1 | `supabase/migrations/001_add_watch_status_and_progress.sql` | Adds `watch_status`, `current_episode`, `total_episodes`, `updated_at` columns to `public.watchlist`; adds check constraints; enables RLS; adds UPDATE policy; creates `set_watchlist_updated_at()` trigger function | Assumes `public.watchlist` exists | Yes (`ADD COLUMN IF NOT EXISTS`, constraint guards) | Additive only |
| 2 | `supabase/schema_hardening.sql` | Creates `public.progress` table; creates `public.admin_users` table; creates `public.is_admin()` function; hardens RLS on `watchlist`, `profiles`, `dmca_reports`, `content_reports`, `site_stats`; grants permissions | Assumes `public.watchlist`, `public.profiles` exist | Yes (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS`) | Additive only |
| 3 | `supabase/migrations/002_enable_realtime_and_policies.sql` | Adds `watchlist`, `progress`, `profiles` to `supabase_realtime` publication; adds SELECT/INSERT/UPDATE/DELETE RLS policies on `watchlist` | `public.progress` must exist (created by step 2) | Yes (`IF NOT EXISTS` guards on publication rels, `DROP POLICY IF EXISTS`) | Additive only |
| 4 | `supabase/migrations/003_admin_persistence.sql` | Creates `dmca_reports`, `content_reports`, `site_stats` tables with RLS policies; inserts default `site_stats` rows; creates indexes; grants permissions to `service_role` | Assumes `auth.users` exists | Yes (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `ON CONFLICT DO NOTHING`) | Additive only |
| 5 | `supabase/migrations/004_convert_target_id_to_text.sql` | Converts `target_id` columns from UUID to TEXT on `dmca_reports` and `content_reports`; refreshes indexes | Tables must exist (created by step 4) | Yes (guards check `data_type = 'uuid'` before altering) | Additive only (data preserved via `USING target_id::TEXT`) |

### Critical Ordering Constraint

**`schema_hardening.sql` MUST be applied before migration 002.** Migration 002 adds `public.progress` and `public.profiles` to the `supabase_realtime` publication, but those tables are created by `schema_hardening.sql`. Applying 002 before `schema_hardening.sql` will cause `ALTER PUBLICATION ... ADD TABLE public.progress` to fail because the table does not yet exist.

**Corrected execution order:**
```
001_add_watch_status_and_progress.sql
→ schema_hardening.sql
→ 002_enable_realtime_and_policies.sql
→ 003_admin_persistence.sql
→ 004_convert_target_id_to_text.sql
```

---

## 2. `schema_hardening.sql` Position

`supabase/schema_hardening.sql` is **not** in the `supabase/migrations/` directory and is **not tracked by Git** (untracked). It must be applied separately after migration 001 and before migration 002.

**Operator action required:** Ensure `schema_hardening.sql` is included in your deployment pipeline and applied in the correct position. Do not rely on it being discovered automatically.

---

## 3. Tables and Critical Data

| Table | Contains | Criticality | Recovery Priority |
|-------|----------|-------------|-------------------|
| `public.watchlist` | User watchlist items (anime/manga entries with status and progress) | High — user-generated data | Critical |
| `public.progress` | Watch progress (anime_id, episode, seconds_watched, completed) | High — user-generated data | Critical |
| `public.profiles` | User profiles | High — user data | Critical |
| `public.admin_users` | Administrator authorization mapping (auth.users → admin status) | Critical — security boundary | Critical |
| `public.dmca_reports` | DMCA takedown notices | Medium — administrative data | High |
| `public.content_reports` | Content moderation reports | Medium — administrative data | High |
| `public.site_stats` | Site-wide statistics counters | Low — regeneratable | Low |

---

## 4. Foreign Key Relationships

| Table | Column | References | On Delete |
|-------|--------|-----------|-----------|
| `public.watchlist` | `user_id` | `auth.users(id)` | (defined in base schema) |
| `public.progress` | `user_id` | `auth.users(id)` | CASCADE |
| `public.progress` | — | — | — |
| `public.dmca_reports` | `reporter_id` | `auth.users(id)` | SET NULL |
| `public.dmca_reports` | `resolved_by` | `auth.users(id)` | SET NULL |
| `public.content_reports` | `reporter_id` | `auth.users(id)` | SET NULL |
| `public.content_reports` | `resolved_by` | `auth.users(id)` | SET NULL |
| `public.site_stats` | `updated_by` | `auth.users(id)` | SET NULL |
| `public.admin_users` | `user_id` | `auth.users(id)` | CASCADE |
| `public.admin_users` | `created_by` | `auth.users(id)` | (no ON DELETE specified) |

---

## 5. Row Level Security (RLS) Policies

| Table | SELECT | INSERT | UPDATE | DELETE | Ownership Check |
|-------|--------|--------|--------|--------|-----------------|
| `public.watchlist` | authenticated (own) | authenticated (own) | authenticated (own) | authenticated (own) | `auth.uid() = user_id` |
| `public.progress` | authenticated (own) | authenticated (own) | authenticated (own) | authenticated (own) | `auth.uid() = user_id` |
| `public.profiles` | authenticated (own) | — | — | — | `auth.uid() = id` |
| `public.admin_users` | service_role only | service_role only | service_role only | service_role only | service_role bypasses RLS |
| `public.dmca_reports` | service_role only | authenticated (self) | — | — | `auth.uid() = reporter_id` for INSERT |
| `public.content_reports` | service_role only | authenticated (self) | — | — | `auth.uid() = reporter_id` for INSERT |
| `public.site_stats` | service_role only | service_role only | — | — | service_role |

---

## 6. `is_admin()` Authorization Function

- **File:** `supabase/schema_hardening.sql:178-195`
- **Signature:** `public.is_admin(user_id UUID) RETURNS BOOLEAN`
- **Security:** `SECURITY INVOKER`, `SET search_path = public`
- **Permissions:** `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO service_role` only
- **Logic:** `RETURN EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = is_admin.user_id)`
- **Backend usage:** `middleware/security.js:161-164` calls via service-role Supabase client; checks `data === true`

**Security note:** Administrator status is NOT derived from `auth.jwt()` → `user_metadata` → `role`, because user metadata can be modified by the client. Instead, it uses the dedicated `public.admin_users` table which can only be modified by the service role.

---

## 7. Destructive Operations Analysis

**No destructive operations found.** All migrations are idempotent and data-preserving:

| Operation | Destructive? | Mitigation |
|-----------|--------------|------------|
| `ADD COLUMN IF NOT EXISTS` | No | Additive only |
| `DROP POLICY IF EXISTS` + `CREATE POLICY` | No | Policy replacement, brief window possible during concurrent execution |
| `ALTER COLUMN ... TYPE TEXT USING target_id::TEXT` | No | Data preserved via explicit cast |
| `CREATE TABLE IF NOT EXISTS` | No | Additive only |
| `CREATE OR REPLACE FUNCTION` | No | Function replacement |
| `INSERT ... ON CONFLICT DO NOTHING` | No | Idempotent seed data |

---

## 8. Migration Rollback Limitations

**No rollback SQL files exist.** There are no `down` migrations. Rolling back would require manually writing DROP statements, which would result in data loss for tables created by the migration.

| Limitation | Severity | Mitigation |
|------------|----------|------------|
| No `down` migration scripts | High | Take a full database backup before applying migrations |
| No migration tracking table | High | Record migration application externally (e.g., deployment logs) |
| `schema_hardening.sql` not versioned | Medium | Track application status in deployment documentation |
| `admin_users` table data loss on rollback | Critical | Back up `admin_users` before any rollback; administrator authorizations would be lost |

---

## 9. Backup and Recovery Requirements

### What to Back Up

| Item | Method | Frequency |
|------|--------|-----------|
| Full database (all tables including user data) | Supabase platform backup / `pg_dump` | Before each migration, daily |
| `admin_users` table | Included in full backup | Before each migration |
| Migration SQL files | Git repository | On every change |
| `schema_hardening.sql` | Git repository (track it!) | On every change |

### Restoration Procedure

1. **Obtain Supabase project credentials** (not in repository — from hosting provider)
2. **Restore database from backup** (Supabase platform PITR or `pg_restore`)
3. **Verify all tables exist:** `watchlist`, `progress`, `profiles`, `dmca_reports`, `content_reports`, `site_stats`, `admin_users`
4. **Apply `schema_hardening.sql`** if not already applied (it's not tracked by migrations)
5. **Apply migrations in order:** 001 → schema_hardening → 002 → 003 → 004
6. **Verify `is_admin()` function exists and is executable by `service_role`**
7. **Verify RLS policies are enabled on all user-owned tables**
8. **Test admin authentication** with a known administrator account

### Backup-Migration Conflict Risk

Restoring a backup taken before `schema_hardening.sql` was applied means `public.progress` and `public.admin_users` tables won't exist. This causes:
- Frontend errors (`useWatchProgress.ts` references `progress`)
- Admin authorization failures (`is_admin()` function missing)

**The restoration procedure must include re-applying `schema_hardening.sql` after restore.**

---

## 10. Migration Tracking

**No migration tracking table exists** in the repository or in any SQL file. There is no `supabase_migrations.schema_migrations` or equivalent.

**Operator action required:** Maintain external records of which migrations have been applied to each environment. Do not rely on the database to track migration state.

---

## 11. Manual Operator Approval Required

The following actions require explicit operator approval before execution:

1. **Applying any migration to production** — schema changes affect production data
2. **Restoring from backup** — may overwrite current data
3. **Modifying `schema_hardening.sql`** — affects authorization boundaries
4. **Modifying RLS policies** — affects data access rules
5. **Creating rollback SQL** — must be separately reviewed before use

---

## 12. Do Not

- Do not run SQL against production without a full backup
- Do not apply migrations out of order (002 before schema_hardening will fail)
- Do not rely on `schema_hardening.sql` being auto-discovered — it's not in `migrations/`
- Do not assume migration state is tracked in the database — it isn't
- Do not delete `admin_users` rows — this revokes administrator access
- Do not claim Supabase PITR is configured without dashboard evidence
