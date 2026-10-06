# DATABASE — Supabase PostgreSQL schema (current)

> Source of truth: `supabase-schema.sql` (149 lines), applied manually to the Supabase project (README instructs the operator to run it).
> Snapshot: 2026-10-05. **No schema changes are made by this document.**
> Legend: **CURRENT** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Tables (CURRENT)

### 1.1 `public.watchlist`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, `DEFAULT gen_random_uuid()` |
| `user_id` | `uuid` | `NOT NULL`, FK → `auth.users(id)` `ON DELETE CASCADE` |
| `anime_id` | `int` | `NOT NULL` (AniList anime ID — see `docs/ANIME_DATA.md` §3) |
| `added_at` | `timestamptz` | `DEFAULT NOW()` |

Table constraint: `watchlist_user_anime_unique UNIQUE (user_id, anime_id)` — a title can be saved once per user; the client upserts with `onConflict: 'user_id,anime_id'`.

**RLS:** enabled. Policies (all `TO authenticated`):

| Policy | Command | Rule |
| --- | --- | --- |
| "Users can view their own watchlist" | SELECT | `USING (auth.uid() = user_id)` |
| "Users can insert into their own watchlist" | INSERT | `WITH CHECK (auth.uid() = user_id)` |
| "Users can delete their own watchlist items" | DELETE | `USING (auth.uid() = user_id)` |

No UPDATE policy (nothing updates rows; add/remove is insert/delete). No `last_modified`/ordering column beyond `added_at`.

### 1.2 `public.profiles`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, FK → `auth.users(id)` `ON DELETE CASCADE` |
| `email` | `text` | nullable |
| `created_at` | `timestamptz` | `DEFAULT NOW()` |

**RLS:** enabled. Policy "Users can view their own profile" — SELECT `TO authenticated USING (auth.uid() = id)`. **No INSERT/UPDATE/DELETE policies**: rows are created only by the trigger below, and there is no client-side profile editing.

## 2. Signup trigger (CURRENT)

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$ BEGIN INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email); RETURN NEW; END; $$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

- `SECURITY DEFINER` with a fixed `search_path` so the trigger can insert despite RLS and cannot be hijacked by a different schema path.
- Email is copied at signup; it is **not** kept in sync if the auth email changes later (no update trigger).

## 3. Cascade and deletion behaviour (CURRENT)

- `profiles.id` and `watchlist.user_id` both cascade from `auth.users`.
- Account deletion is performed **only** by the server (`DELETE /api/account`) through the Supabase **Admin API** with the service-role key; deleting `auth.users` removes the profile and all watchlist rows automatically.
- The SQL file documents this and states explicitly that the service-role key must never reach the browser.

## 4. Data ownership in practice (CURRENT)

| Data | Owner | Notes |
| --- | --- | --- |
| Anime metadata | **AniList** (not stored in the database at all) | No anime table exists |
| Watchlist membership | Supabase `watchlist` (AniList IDs only) | Display data (title/poster/rating) is cached in the browser |
| Watchlist display cache | Browser `localStorage` | `anime_hub_watchlist_<userId>` |
| Guest watchlist | Browser `localStorage` | `anime_hub_watchlist` |
| Profile | Supabase `profiles` | id + email only |

## 5. Explicitly NOT IMPLEMENTED in the database

```text
Favorites:              NOT IMPLEMENTED  (no table, no endpoint, no UI)
Watch History:          NOT IMPLEMENTED  (no table, no endpoint, no UI)
Watch Progress:         NOT IMPLEMENTED  (no table, no endpoint, no UI)
Continue Watching:      NOT IMPLEMENTED  (no table, no endpoint, no UI)
Episode data:           NOT IMPLEMENTED  (episodes exist only as a count from AniList)
Admin tables / roles:   NOT IMPLEMENTED  (no roles, no admin users, no moderation tables)
```

Do **not** create these tables until the product decisions and the canonical ID model in `docs/WATCH_SYSTEM.md` / `docs/TASKS.md` are settled.

## 6. Operational notes (CURRENT)

- The schema file is idempotent-ish (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`) and re-runnable.
- There is **no migration tool, no version table, and no staging/production separation** in the repository.
- The last line of `supabase-schema.sql` contains a cosmetic stray fragment merged into a comment (`-- …===profiles.id → auth.users(id)`); SQL-wise it is still a comment. Recorded for cleanup, not fixed here.
- `added_at` exists but is not used for ordering in the UI (the client keeps insertion order of its cache).

## 7. NOT FOUND / NEEDS CONFIRMATION

- Whether the Supabase project in the local `.env` is production or a scratch project.
- Backup/PITR configuration, retention, and region.
- Whether any manual changes exist in the live database that are not reflected in `supabase-schema.sql`.
