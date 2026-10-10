-- Add user-owned watch status and episode progress to the existing watchlist.
-- Existing rows receive:
--   watch_status    = 'plan_to_watch'
--   current_episode = 0
--   total_episodes  = NULL
--   updated_at      = current time

ALTER TABLE public.watchlist
    ADD COLUMN IF NOT EXISTS watch_status TEXT
        NOT NULL DEFAULT 'plan_to_watch',
    ADD COLUMN IF NOT EXISTS current_episode INTEGER
        NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_episodes INTEGER,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW();

-- Validate the five supported user statuses.
DO $watchlist_status_constraint$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'watchlist_watch_status_check'
          AND conrelid = 'public.watchlist'::regclass
    ) THEN
        ALTER TABLE public.watchlist
            ADD CONSTRAINT watchlist_watch_status_check
            CHECK (
                watch_status IN (
                    'watching',
                    'completed',
                    'plan_to_watch',
                    'on_hold',
                    'dropped'
                )
            );
    END IF;
END
$watchlist_status_constraint$;

-- Episode progress must be non-negative.
-- When total_episodes is known, current_episode cannot exceed it.
DO $watchlist_progress_constraint$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'watchlist_episode_progress_check'
          AND conrelid = 'public.watchlist'::regclass
    ) THEN
        ALTER TABLE public.watchlist
            ADD CONSTRAINT watchlist_episode_progress_check
            CHECK (
                current_episode >= 0
                AND (
                    total_episodes IS NULL
                    OR (
                        total_episodes >= 0
                        AND current_episode <= total_episodes
                    )
                )
            );
    END IF;
END
$watchlist_progress_constraint$;

-- Set updated_at inside the database whenever a watchlist row changes.
CREATE OR REPLACE FUNCTION public.set_watchlist_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $watchlist_updated_at_function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$watchlist_updated_at_function$;

-- Replacing this trigger is safe and does not affect table data.
DROP TRIGGER IF EXISTS set_watchlist_updated_at
ON public.watchlist;

CREATE TRIGGER set_watchlist_updated_at
BEFORE UPDATE ON public.watchlist
FOR EACH ROW
EXECUTE FUNCTION public.set_watchlist_updated_at();

-- Ensure row-level access policies are enforced.
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;

-- Add the missing UPDATE policy while preserving the existing
-- SELECT, INSERT, and DELETE policies.
DROP POLICY IF EXISTS "Users can update their own watchlist"
ON public.watchlist;

CREATE POLICY "Users can update their own watchlist"
ON public.watchlist
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
