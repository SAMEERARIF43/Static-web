-- ============================================================
-- PHASE 4 — SUPABASE SCHEMA + RLS POLICIES
-- Anime Hub
-- ============================================================

-- ------------------------------------------------------------
-- 1. WATCHLIST TABLE
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.watchlist (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL
        REFERENCES auth.users(id)
        ON DELETE CASCADE,
    anime_id INT NOT NULL,
    added_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT watchlist_user_anime_unique
        UNIQUE (user_id, anime_id)
);

-- Enable Row Level Security
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 2. WATCHLIST RLS POLICIES
-- ------------------------------------------------------------

DROP POLICY IF EXISTS "Users can view their own watchlist"
ON public.watchlist;

CREATE POLICY "Users can view their own watchlist"
ON public.watchlist
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);


DROP POLICY IF EXISTS "Users can insert into their own watchlist"
ON public.watchlist;

CREATE POLICY "Users can insert into their own watchlist"
ON public.watchlist
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);


DROP POLICY IF EXISTS "Users can delete their own watchlist items"
ON public.watchlist;

CREATE POLICY "Users can delete their own watchlist items"
ON public.watchlist
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 3. USER PROFILES TABLE
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY
        REFERENCES auth.users(id)
        ON DELETE CASCADE,

    email TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 4. PROFILE RLS POLICIES
-- ------------------------------------------------------------

DROP POLICY IF EXISTS "Users can view their own profile"
ON public.profiles;

CREATE POLICY "Users can view their own profile"
ON public.profiles
FOR SELECT
TO authenticated
USING (auth.uid() = id);


-- ------------------------------------------------------------
-- 5. AUTOMATIC PROFILE CREATION ON SIGNUP
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, email)
    VALUES (NEW.id, NEW.email);

    RETURN NEW;
END;
$$;


-- ------------------------------------------------------------
-- 6. SIGNUP TRIGGER
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS on_auth_user_created
ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();


-- ------------------------------------------------------------
-- 7. ACCOUNT DELETION
-- ------------------------------------------------------------
--
-- Account deletion is NOT performed directly from the browser.
--
-- The frontend calls:
--     DELETE /api/account
--
-- The server:
--   1. Verifies the user's Supabase access token.
--   2. Gets the authenticated user's ID from Supabase.
--   3. Deletes that user from auth.users using the
--      server-only Supabase service-role credential.
--
-- Because profiles.id and watchlist.user_id both use
-- ON DELETE CASCADE, deleting auth.users automatically
-- removes the user's profile and watchlist records.
--
-- NEVER expose SUPABASE_SERVICE_ROLE_KEY to the frontend.
-- NEVER place it inside public/, HTML, browser JavaScript,
-- GitHub, or /api/config.
--
-- ============================================================
-- END OF PHASE 4
-- ============================================================profiles.id → auth.users(id)
