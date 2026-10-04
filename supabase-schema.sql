-- Phase 4: Supabase Schema and RLS Policies

-- Create Watchlist Table
CREATE TABLE public.watchlist (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    anime_id INT NOT NULL,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, anime_id)
);

-- Enable RLS
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only select their own watchlist
CREATE POLICY "Users can view their own watchlist" 
ON public.watchlist FOR SELECT 
USING (auth.uid() = user_id);

-- Policy: Users can only insert into their own watchlist
CREATE POLICY "Users can insert into their own watchlist" 
ON public.watchlist FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Policy: Users can only delete their own watchlist items
CREATE POLICY "Users can delete from their own watchlist" 
ON public.watchlist FOR DELETE 
USING (auth.uid() = user_id);

-- Create User Profiles Table (Minimal)
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only select their own profile
CREATE POLICY "Users can view their own profile" 
ON public.profiles FOR SELECT 
USING (auth.uid() = id);

-- Trigger to automatically create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (new.id, new.email);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();


-- Account deletion is performed by the authenticated server-side DELETE /api/account
-- endpoint. It verifies the user's access token and deletes that auth.users row using
-- a server-only Admin credential. The foreign keys above cascade to profiles and watchlist.
