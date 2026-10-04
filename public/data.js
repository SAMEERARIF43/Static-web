// ============================================================
// ANIME HUB — DATA LAYER
// Replace this with a real API fetch when backend is ready
// ============================================================

const ANIME_DB = [
  {
    id: 1,
    title: "Jujutsu Kaisen",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQBSkxWAAk83.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/151807-37yfQA3ym8PA.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJmZqs.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-33MtJGsUSxga.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmneX.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/20-HHxhPj5JD13a.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/1535.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/5114-q0V5URebphSG.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/269-08ar2HJOUAuL.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101348-pivKKffCAwAY.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/n9253-JIhmKgBKsWUN.jpg",
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
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/11061-8WkkTZ6duKpq.jpg",
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
