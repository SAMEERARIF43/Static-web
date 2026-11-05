import { useEffect, useState, useRef, useCallback } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useWatchProgress } from "../hooks/useWatchProgress"
import { Button } from "../components/ui/button"

interface VideoSource {
  src: string
  type: string
}

export function Watch() {
  const { animeId, episodeId } = useParams<{ animeId: string; episodeId: string }>()
  const navigate = useNavigate()
  const { saveProgress, getProgress } = useWatchProgress()
  const [videoSources, setVideoSources] = useState<VideoSource[]>([])
  const [currentEpisode, setCurrentEpisode] = useState<{ episode: number; title: string } | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Fetch saved progress on mount
  useEffect(() => {
    const storedProgress = getProgress(Number(animeId))
    if (storedProgress) {
      console.log("Restoring progress:", storedProgress)
    }
  }, [animeId, getProgress])

  // Fetch video streaming links
  useEffect(() => {
    if (!animeId) return

    const fetchStream = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await fetch(`/api/stream?animeId=${animeId}&episode=${episodeId ?? "1"}`)
        if (!response.ok) {
          throw new Error(`Failed to load stream: ${response.status}`)
        }
        const data = await response.json()
        setVideoSources(data.sources || [])
        setCurrentEpisode({
          episode: Number(episodeId ?? 1),
          title: `Episode ${episodeId ?? 1}`,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load video")
        console.error("Failed to fetch stream:", err)
      } finally {
        setIsLoading(false)
      }
    }

    fetchStream()
  }, [animeId, episodeId])

  // Save progress on time update (throttled)
  const handleTimeUpdate = useCallback(() => {
    if (currentEpisode && videoSources.length > 0 && videoRef.current) {
      const currentTime = Math.floor(videoRef.current.currentTime)
      saveProgress(Number(animeId), Number(episodeId ?? 1), currentTime, false)
    }
  }, [animeId, episodeId, currentEpisode, videoSources.length, saveProgress])

  // Save progress on beforeunload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (currentEpisode && videoSources.length > 0 && videoRef.current) {
        saveProgress(Number(animeId), Number(episodeId ?? 1), Math.floor(videoRef.current.currentTime), false)
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [animeId, episodeId, currentEpisode, videoSources.length, saveProgress])

  const handlePlayPause = () => {
    setIsPlaying((prev) => {
      if (videoRef.current) {
        if (prev) {
          videoRef.current.pause()
        } else {
          videoRef.current.play().catch(console.error)
        }
      }
      return !prev
    })
  }

  const handleStartFromBeginning = () => {
    navigate(`/watch/${animeId}/1`)
  }

  const handleMarkComplete = () => {
    saveProgress(Number(animeId), Number(episodeId ?? 1), 0, true)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow border-b">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">
              Watch - {currentEpisode?.title || "Anime"}
            </h1>
            <button
              onClick={() => navigate("/")}
              className="text-sm text-gray-600 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
            >
              Back Home
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-4">
        {animeId ? (
          <div className="bg-white rounded-lg shadow sm:p-6 lg:p-8">
            {/* Video Player */}
            <div className="relative aspect-video w-full rounded-lg overflow-hidden mb-4 bg-gray-900">
              {isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                  Loading video player…
                </div>
              ) : error ? (
                <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-red-600 bg-red-50 rounded-lg">
                  <p>{error}</p>
                  <Button onClick={() => window.location.reload()} size="sm" variant="outline">
                    Retry
                  </Button>
                </div>
              ) : videoSources.length > 0 ? (
                <video
                  ref={videoRef}
                  src={videoSources[0].src}
                  className="w-full h-full object-contain"
                  autoPlay
                  muted
                  playsInline
                  onTimeUpdate={handleTimeUpdate}
                  onPause={() => setIsPlaying(false)}
                  onPlay={() => setIsPlaying(true)}
                  onEnded={() => setIsPlaying(false)}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                  No video sources available
                </div>
              )}
            </div>

            {/* Episode Info */}
            {currentEpisode && (
              <div className="mb-4">
                <p className="text-lg font-medium">
                  {currentEpisode.title}
                  <span className="text-sm text-gray-400 ml-2">(Episode {currentEpisode.episode})</span>
                </p>
              </div>
            )}

            {/* Progress Controls */}
            {currentEpisode && (
              <div className="mt-4 pt-4 border-t border-gray-200 sm:mt-6 sm:pt-6">
                <p className="text-sm text-gray-500 mb-2">
                  Progress:{getProgress(Number(animeId))?.secondsWatched != null
                    ? `${getProgress(Number(animeId))?.secondsWatched}s watched`
                    : "No progress saved"}
                </p>

                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  <button
                    onClick={handleStartFromBeginning}
                    className="mt-2 sm:mt-0 inline-block text-sm text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                  >
                    Start from beginning
                  </button>
                  <button
                    onClick={handleMarkComplete}
                    className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    Mark Complete
                  </button>
                </div>
              </div>
            )}

            {/* Controls */}
            <div className="mt-4 sm:mt-6 flex justify-between items-center sm:flex-row sm:justify-end gap-4">
              <button
                onClick={handlePlayPause}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:pointer-events-none"
                disabled={videoSources.length === 0 || isLoading}
              >
                {isPlaying ? "Pause" : "Play"}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center py-12 sm:py-20">
            <h2 className="text-xl text-gray-500">Select an episode to watch</h2>
          </div>
        )}
      </main>
    </div>
  )
}
