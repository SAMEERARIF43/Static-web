import { useEffect, useState } from "react"
import { useAuth } from "../context/AuthContext"
import { supabase } from "../lib/supabase"

export interface WatchProgress {
  animeId: number
  episode: number
  secondsWatched: number
  completed: boolean
  updatedAt: string
}

export interface ProgressState {
  progress: WatchProgress[]
  isLoading: boolean
  error: string | null
}

export function useWatchProgress() {
  const { user, session } = useAuth()

  // Initialize state from localStorage for guests
  const [state, setState] = useState<ProgressState>(() => {
    const stored = localStorage.getItem("anime_hub_progress")
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        // localStorage stores a single entry; normalize to an array
        const entries = Array.isArray(parsed) ? parsed : [parsed].filter(Boolean)
        return { progress: entries, isLoading: false, error: null }
      } catch {
        localStorage.removeItem("anime_hub_progress")
      }
    }
    // Authenticated user - will fetch from Supabase on mount
    return { progress: [], isLoading: true, error: null }
  })

  // Fetch progress from Supabase for authenticated users
  useEffect(() => {
    if (user && session) {
      fetchSupabaseProgress().then((supProgress) => {
        setState({ progress: supProgress, isLoading: false, error: null })
      })
    } else {
      // Guest mode - localStorage is already the source of truth
      setState((prev) => ({
        ...prev,
        isLoading: false,
      }))
    }
  }, [user, session])

  // --- Progress Functions ---

  const saveProgress = async (
    animeId: number,
    ep: number,
    seconds: number,
    completed: boolean
  ) => {
    setState((prev) => ({ ...prev, isLoading: true }))

    try {
      if (user && session) {
        // Authenticated: save to Supabase
        await saveToSupabaseProgress(animeId, ep, seconds, completed)
        // After successful save, refresh the full progress list so the UI stays consistent
        const updated = await fetchSupabaseProgress()
        setState((prev) => ({
          ...prev,
          progress: updated,
          isLoading: false,
          error: null,
        }))
      } else {
        // Guest: save to localStorage (single entry per guest session)
        const newProgress: WatchProgress = {
          animeId,
          episode: ep,
          secondsWatched: seconds,
          completed,
          updatedAt: new Date().toISOString(),
        }
        localStorage.setItem(
          "anime_hub_progress",
          JSON.stringify(newProgress)
        )
        setState((prev) => ({
          ...prev,
          progress: [newProgress],
          isLoading: false,
          error: null,
        }))
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: (err as Error).message,
        isLoading: false,
      }))
    }
  }

  const getProgress = (animeId: number): WatchProgress | null => {
    if (user && session) {
      // Authenticated: look up from the fetched progress list, filtered by animeId
      return state.progress.find((p) => p.animeId === animeId) || null
    } else {
      // Guest: get from localStorage
      const stored = localStorage.getItem("anime_hub_progress")
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          const entry = Array.isArray(parsed) ? parsed.find((p: any) => p.animeId === animeId) : parsed
          return entry?.animeId === animeId ? entry : null
        } catch {
          return null
        }
      }
      return null
    }
  }

  // --- Supabase helpers ---

  const fetchSupabaseProgress = async (): Promise<WatchProgress[]> => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return []

      const {
        data,
        error,
      } = await supabase
        .from("progress")
        .select("*")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })

      if (error) throw error
      return (data || []).map((row: any) => ({
        animeId: row.anime_id,
        episode: row.episode,
        secondsWatched: row.seconds_watched,
        completed: row.completed,
        updatedAt: row.updated_at,
      }))
    } catch (err) {
      console.error("Supabase progress error:", err)
      return []
    }
  }

  const saveToSupabaseProgress = async (
    animeId: number,
    ep: number,
    seconds: number,
    completed: boolean
  ) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return

      const { error } = await supabase.from("progress").upsert(
        {
          user_id: user.id,
          anime_id: animeId,
          episode: ep,
          seconds_watched: seconds,
          completed,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id, anime_id" }
      )

      if (error) throw error
    } catch (err) {
      console.error("Error saving to Supabase progress:", err)
      throw err
    }
  }

  return {
    state,
    saveProgress,
    getProgress,
  }
}