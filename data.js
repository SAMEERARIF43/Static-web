// ============================================================
// ANIME HUB — DATA LAYER
// Replace this with a real API fetch when backend is ready
// ============================================================

const ANIME_DB = [
  {
    id: 1,
    title: "Jujutsu Kaisen",
    poster: "https://placehold.co/300x450/0d1117/ff7200?text=JJK",
    banner: "https://placehold.co/1280x480/0d1117/ff7200?text=Jujutsu+Kaisen",
    description: "A boy swallows a cursed talisman — the finger of a demon — and becomes host to a powerful creature. Now enrolled in a secret school, he must harness this power to defeat the demons that plague the world.",
    rating: 4.9,
    genres: ["Action", "Supernatural", "Dark Fantasy"],
    type: "TV",
    status: "Ongoing",
    episodes: 24,
    year: 2020,
    studio: "MAPPA",
    trending: true,
    popular: true,
  },
  {
    id: 2,
    title: "Solo Leveling",
    poster: "https://placehold.co/300x450/0d1117/4f46e5?text=Solo+Leveling",
    banner: "https://placehold.co/1280x480/0d1117/4f46e5?text=Solo+Leveling",
    description: "In a world where hunters — humans who possess magical abilities — must battle deadly monsters to protect humanity, the weakest hunter Sung Jinwoo embarks on an unexpected journey to becoming the strongest.",
    rating: 4.8,
    genres: ["Action", "Fantasy", "Adventure"],
    type: "TV",
    status: "Ongoing",
    episodes: 12,
    year: 2024,
    studio: "A-1 Pictures",
    trending: true,
    popular: true,
  },
  {
    id: 3,
    title: "One Piece",
    poster: "https://placehold.co/300x450/0d1117/e11d48?text=One+Piece",
    banner: "https://placehold.co/1280x480/0d1117/e11d48?text=One+Piece",
    description: "Monkey D. Luffy sets out on an adventure to find the fabled One Piece treasure and become the Pirate King. Along the way he assembles a diverse crew and battles powerful enemies across the Grand Line.",
    rating: 4.9,
    genres: ["Action", "Adventure", "Comedy"],
    type: "TV",
    status: "Ongoing",
    episodes: 1098,
    year: 1999,
    studio: "Toei Animation",
    trending: true,
    popular: true,
  },
  {
    id: 4,
    title: "Demon Slayer",
    poster: "https://placehold.co/300x450/0d1117/10b981?text=Demon+Slayer",
    banner: "https://placehold.co/1280x480/0d1117/10b981?text=Demon+Slayer",
    description: "Tanjiro Kamado's peaceful life is shattered when a demon slaughters his family. His sister Nezuko, the sole survivor, has been transformed into a demon. Tanjiro sets out to avenge his family and cure his sister.",
    rating: 4.8,
    genres: ["Action", "Dark Fantasy", "Supernatural"],
    type: "TV",
    status: "Ongoing",
    episodes: 44,
    year: 2019,
    studio: "ufotable",
    trending: true,
    popular: true,
  },
  {
    id: 5,
    title: "Attack on Titan",
    poster: "https://placehold.co/300x450/0d1117/94a3b8?text=Attack+on+Titan",
    banner: "https://placehold.co/1280x480/0d1117/94a3b8?text=Attack+on+Titan",
    description: "After his hometown is destroyed and his mother is killed, young Eren Yeager vows to cleanse the earth of the giant humanoid Titans that have brought humanity to the brink of extinction.",
    rating: 5.0,
    genres: ["Action", "Drama", "Post-Apocalyptic"],
    type: "TV",
    status: "Completed",
    episodes: 87,
    year: 2013,
    studio: "MAPPA",
    trending: true,
    popular: true,
  },
  {
    id: 6,
    title: "Naruto",
    poster: "https://placehold.co/300x450/0d1117/f59e0b?text=Naruto",
    banner: "https://placehold.co/1280x480/0d1117/f59e0b?text=Naruto",
    description: "A young ninja with a fox demon sealed inside him dreams of becoming the greatest ninja — the Hokage — and earning the respect of his village.",
    rating: 4.8,
    genres: ["Action", "Adventure", "Martial Arts"],
    type: "TV",
    status: "Completed",
    episodes: 220,
    year: 2002,
    studio: "Studio Pierrot",
    trending: false,
    popular: true,
  },
  {
    id: 7,
    title: "Death Note",
    poster: "https://placehold.co/300x450/0d1117/a855f7?text=Death+Note",
    banner: "https://placehold.co/1280x480/0d1117/a855f7?text=Death+Note",
    description: "Light Yagami discovers a supernatural notebook that allows him to kill anyone by writing their name. He uses it to rid the world of criminals, but a brilliant detective is hot on his trail.",
    rating: 4.9,
    genres: ["Psychological", "Thriller", "Supernatural"],
    type: "TV",
    status: "Completed",
    episodes: 37,
    year: 2006,
    studio: "Madhouse",
    trending: false,
    popular: true,
  },
  {
    id: 8,
    title: "Fullmetal Alchemist: Brotherhood",
    poster: "https://placehold.co/300x450/0d1117/f97316?text=FMA+Brotherhood",
    banner: "https://placehold.co/1280x480/0d1117/f97316?text=FMA+Brotherhood",
    description: "Two brothers use alchemy in search of the Philosopher's Stone to restore their bodies after a forbidden ritual goes wrong. An epic journey unfolds across a world of political intrigue and hidden forces.",
    rating: 5.0,
    genres: ["Action", "Adventure", "Fantasy"],
    type: "TV",
    status: "Completed",
    episodes: 64,
    year: 2009,
    studio: "Bones",
    trending: false,
    popular: true,
  },
  {
    id: 9,
    title: "Bleach",
    poster: "https://placehold.co/300x450/0d1117/06b6d4?text=Bleach",
    banner: "https://placehold.co/1280x480/0d1117/06b6d4?text=Bleach",
    description: "Ichigo Kurosaki becomes a Soul Reaper after absorbing the powers of Rukia Kuchiki. He defends the living world from Hollows and Arrancars while unraveling the mysteries of his own heritage.",
    rating: 4.7,
    genres: ["Action", "Supernatural", "Adventure"],
    type: "TV",
    status: "Ongoing",
    episodes: 374,
    year: 2004,
    studio: "Studio Pierrot",
    trending: false,
    popular: true,
  },
  {
    id: 10,
    title: "Vinland Saga",
    poster: "https://placehold.co/300x450/0d1117/6366f1?text=Vinland+Saga",
    banner: "https://placehold.co/1280x480/0d1117/6366f1?text=Vinland+Saga",
    description: "Young Thorfinn grows up in a world of Vikings, driven by a singular desire for revenge against the man who killed his father — Askeladd, the mercenary leader he now fights under.",
    rating: 4.9,
    genres: ["Action", "Historical", "Drama"],
    type: "TV",
    status: "Ongoing",
    episodes: 48,
    year: 2019,
    studio: "MAPPA",
    trending: false,
    popular: true,
  },
  {
    id: 11,
    title: "Steins;Gate",
    poster: "https://placehold.co/300x450/0d1117/0ea5e9?text=Steins%3BGate",
    banner: "https://placehold.co/1280x480/0d1117/0ea5e9?text=Steins%3BGate",
    description: "A self-described mad scientist accidentally discovers time travel via microwave. As he tinkers with the past, he sets off a chain of events with catastrophic consequences for the future.",
    rating: 4.9,
    genres: ["Sci-Fi", "Thriller", "Drama"],
    type: "TV",
    status: "Completed",
    episodes: 24,
    year: 2011,
    studio: "White Fox",
    trending: false,
    popular: true,
  },
  {
    id: 12,
    title: "Hunter x Hunter (2011)",
    poster: "https://placehold.co/300x450/0d1117/22c55e?text=HxH",
    banner: "https://placehold.co/1280x480/0d1117/22c55e?text=Hunter+x+Hunter",
    description: "Young Gon Freecss learns his presumed-dead father is alive and a world-renowned Hunter. He sets out to follow in his footsteps, making friends and confronting incredibly dangerous enemies along the way.",
    rating: 4.9,
    genres: ["Action", "Adventure", "Fantasy"],
    type: "TV",
    status: "Completed",
    episodes: 148,
    year: 2011,
    studio: "Madhouse",
    trending: false,
    popular: true,
  },
];

// All unique genres from the database
const ALL_GENRES = [...new Set(ANIME_DB.flatMap(a => a.genres))].sort();

// Helper: get anime by id
function getAnimeById(id) {
  return ANIME_DB.find(a => a.id === id) || null;
}

// Helper: search anime
function searchAnime(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return ANIME_DB.filter(a =>
    a.title.toLowerCase().includes(q) ||
    a.genres.some(g => g.toLowerCase().includes(q)) ||
    a.studio.toLowerCase().includes(q)
  );
}

// Helper: filter by genre
function filterByGenre(genre) {
  if (!genre || genre === 'All') return ANIME_DB;
  return ANIME_DB.filter(a => a.genres.includes(genre));
}

// Helper: get trending
function getTrending() {
  return ANIME_DB.filter(a => a.trending);
}

// Helper: get popular
function getPopular() {
  return ANIME_DB.filter(a => a.popular);
}

// Helper: get recommendations (excluding current)
function getRecommendations(excludeId, limit = 4) {
  return ANIME_DB.filter(a => a.id !== excludeId).slice(0, limit);
}

// Generate episode list for an anime
function getEpisodes(anime) {
  const count = Math.min(anime.episodes, 24); // Show max 24 for UI
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    title: `Episode ${i + 1}`,
    duration: "24 min",
  }));
}
