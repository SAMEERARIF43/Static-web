// ============================================================
// ANIME HUB SERVER
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = 3000;

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));


// ============================================================
// LOCAL ANIME DATABASE
// ============================================================

const ANIME_DB = [
  {
    id: 1,
    title: "Jujutsu Kaisen",
    genre: ["Action", "Supernatural", "Shounen"],
    year: 2020,
    rating: 8.6,
    episodes: 24,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQBSkxWAAk83.jpg",
    description:
      "Yuji Itadori joins a secret organization of Jujutsu Sorcerers after becoming the host of a powerful curse."
  },

  {
    id: 2,
    title: "Solo Leveling",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2024,
    rating: 8.8,
    episodes: 25,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/151807-37yfQA3ym8PA.jpg",
    description:
      "Sung Jin-Woo, the weakest hunter, gains a mysterious ability that allows him to level up."
  },

  {
    id: 3,
    title: "One Piece",
    genre: ["Action", "Adventure", "Fantasy", "Shounen"],
    year: 1999,
    rating: 9.0,
    episodes: 1100,
    status: "Airing",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJmZqs.jpg",
    description:
      "Monkey D. Luffy and his crew travel across the Grand Line in search of the legendary One Piece."
  },

  {
    id: 4,
    title: "Demon Slayer",
    genre: ["Action", "Supernatural", "Shounen"],
    year: 2019,
    rating: 8.6,
    episodes: 55,
    status: "Airing",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-33MtJGsUSxga.jpg",
    description:
      "Tanjiro Kamado becomes a demon slayer after his family is attacked and his sister is turned into a demon."
  },

  {
    id: 5,
    title: "Attack on Titan",
    genre: ["Action", "Drama", "Fantasy"],
    year: 2013,
    rating: 9.0,
    episodes: 89,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmneX.jpg",
    description:
      "Humanity fights for survival against terrifying Titans that threaten to destroy civilization."
  },

  {
    id: 6,
    title: "Naruto",
    genre: ["Action", "Adventure", "Shounen"],
    year: 2002,
    rating: 8.3,
    episodes: 220,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/20-HHxhPj5JD13a.jpg",
    description:
      "Naruto Uzumaki dreams of becoming the strongest ninja and earning the respect of his village."
  },

  {
    id: 7,
    title: "Death Note",
    genre: ["Mystery", "Psychological", "Supernatural"],
    year: 2006,
    rating: 8.6,
    episodes: 37,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/1535.jpg",
    description:
      "A brilliant student discovers a mysterious notebook that can kill anyone whose name is written inside."
  },

  {
    id: 8,
    title: "Fullmetal Alchemist: Brotherhood",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2009,
    rating: 9.1,
    episodes: 64,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/5114-q0V5URebphSG.jpg",
    description:
      "Two brothers use alchemy to search for the Philosopher's Stone after a failed human transmutation."
  },

  {
    id: 9,
    title: "Bleach",
    genre: ["Action", "Adventure", "Supernatural"],
    year: 2004,
    rating: 8.2,
    episodes: 366,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/269-08ar2HJOUAuL.jpg",
    description:
      "Ichigo Kurosaki becomes a Soul Reaper and battles supernatural enemies threatening the human world."
  },

  {
    id: 10,
    title: "Vinland Saga",
    genre: ["Action", "Adventure", "Drama"],
    year: 2019,
    rating: 8.8,
    episodes: 48,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101348-pivKKffCAwAY.jpg",
    description:
      "Thorfinn grows up among Vikings while seeking revenge and searching for a land free from war."
  },

  {
    id: 11,
    title: "Steins;Gate",
    genre: ["Sci-Fi", "Thriller", "Psychological"],
    year: 2011,
    rating: 9.0,
    episodes: 24,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/n9253-JIhmKgBKsWUN.jpg",
    description:
      "A group of friends accidentally discover a method of sending messages through time."
  },

  {
    id: 12,
    title: "Hunter x Hunter",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2011,
    rating: 9.0,
    episodes: 148,
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/11061-8WkkTZ6duKpq.jpg",
    description:
      "Gon Freecss becomes a Hunter and travels the world while searching for his missing father."
  }
];


// ============================================================
// HELPER FUNCTIONS
// ============================================================

function searchAnime(query) {

  const q = query.toLowerCase().trim();

  return ANIME_DB.filter(anime =>
    anime.title.toLowerCase().includes(q)
  );
}


function getAnimeById(id) {

  return ANIME_DB.find(anime =>
    anime.id === Number(id)
  );
}


// ============================================================
// TRENDING
// ============================================================

app.get('/api/trending', (req, res) => {

  const trending = ANIME_DB.slice(0, 5);

  res.json(trending);

});


// ============================================================
// POPULAR
// ============================================================

app.get('/api/popular', (req, res) => {

  const popular = [...ANIME_DB]
    .sort((a, b) => b.rating - a.rating);

  res.json(popular);

});


// ============================================================
// SEARCH (AniList first, local fallback)
// ============================================================

app.get('/api/search', async (req, res) => {

  const query = (req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({
      message: "Please enter an anime name."
    });
  }

  // Try AniList GraphQL first
  try {
    const graphqlQuery = `
      query ($search: String) {
        Page(perPage: 10) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            id
            title {
              romaji
              english
              native
            }
            coverImage {
              large
            }
            description
            episodes
            status
            averageScore
            genres
            season
            seasonYear
            format
          }
        }
      }
    `;

    const response = await axios.post(
      "https://graphql.anilist.co",
      {
        query: graphqlQuery,
        variables: {
          search: query
        }
      },
      {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    // Check for GraphQL errors
    if (response.data.errors) {
      console.error("❌ AniList GraphQL Error:", response.data.errors);
      // Fall through to local DB
    } else {
      const anime = response.data.data.Page.media;
      console.log(`✅ AniList returned ${anime.length} results for: ${query}`);
      res.json(anime);
      return;
    }
  } catch (error) {
    console.log("❌ AniList failed, using local database fallback");
    // AniList failed - will fall through to local DB
  }

  // Fall back to local database
  const results = searchAnimeLocal(query);
  res.json(results);

});


// ============================================================
// LOCAL SEARCH HELPER
// ============================================================

function searchAnimeLocal(query) {

  const q = query.toLowerCase().trim();

  return ANIME_DB.filter(anime =>
    anime.title.toLowerCase().includes(q) ||
    anime.genres.some(g => g.toLowerCase().includes(q))
  );

}


// ============================================================
// GENRE SEARCH
// ============================================================

app.get('/api/genre/:genre', (req, res) => {

  const genre = req.params.genre.toLowerCase();

  const results = ANIME_DB.filter(anime =>
    anime.genre.some(g =>
      g.toLowerCase() === genre
    )
  );

  res.json(results);

});


// ============================================================
// ANIME DETAILS
// ============================================================

app.get('/api/detail/:id', (req, res) => {

  const anime = getAnimeById(req.params.id);

  if (!anime) {

    return res.status(404).json({
      message: "Anime not found."
    });

  }

  res.json(anime);

});


// ============================================================
// EPISODES
// ============================================================

app.get('/api/episodes/:id', (req, res) => {

  const anime = getAnimeById(req.params.id);

  if (!anime) {

    return res.status(404).json({
      message: "Anime not found."
    });

  }

  const episodes = [];

  for (let i = 1; i <= anime.episodes; i++) {

    episodes.push({
      episode: i,
      title: `Episode ${i}`,
      duration: "24 min"
    });

  }

  res.json(episodes);

});


// ============================================================
// GENRES
// ============================================================

app.get('/api/genres', (req, res) => {

  const genres = new Set();

  ANIME_DB.forEach(anime => {

    anime.genre.forEach(genre => {
      genres.add(genre);
    });

  });

  res.json([...genres]);

});


// ============================================================
// ANILIST API SEARCH
// ============================================================

app.post('/api/anime/search', async (req, res) => {

  const query = (req.body.query || '').trim();

  if (!query) {

    return res.status(400).json({
      message: "Please enter an anime name."
    });

  }

  const graphqlQuery = `
    query ($search: String) {

      Page(perPage: 10) {

        media(
          search: $search,
          type: ANIME,
          sort: SEARCH_MATCH
        ) {

          id

          title {
            romaji
            english
            native
          }

          coverImage {
            large
          }

          description

          episodes

          status

          averageScore

          genres

          season

          seasonYear

          format

        }

      }

    }
  `;

  try {

    console.log(`🔎 Searching AniList for: ${query}`);

    const response = await axios.post(
      "https://graphql.anilist.co",

      {
        query: graphqlQuery,

        variables: {
          search: query
        }
      },

      {
        headers: {
          "Content-Type": "application/json"
        },

        timeout: 15000
      }
    );


    // Check for GraphQL errors

    if (response.data.errors) {

      console.error(
        "❌ AniList GraphQL Error:",
        response.data.errors
      );

      return res.status(500).json({

        message: "AniList returned an error.",

        errors: response.data.errors

      });

    }


    const anime =
      response.data.data.Page.media;


    console.log(
      `✅ AniList returned ${anime.length} results`
    );


    res.json(anime);


  } catch (error) {

    console.error("❌ AniList API Error");


    if (error.response) {

      console.error(
        "Status:",
        error.response.status
      );

      console.error(
        "Response:",
        error.response.data
      );

    } else {

      console.error(
        "Message:",
        error.message
      );

    }


    res.status(500).json({

      message:
        "Could not connect to AniList API.",

      error:
        error.message

    });

  }

});


// ============================================================
// ANILIST API DETAILS
// ============================================================

app.get('/api/anime/:id', async (req, res) => {
  const animeId = parseInt(req.params.id);

  if (isNaN(animeId)) {
    return res.status(400).json({ message: "Invalid Anime ID." });
  }

  const graphqlQuery = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          extraLarge
          large
        }
        bannerImage
        description
        episodes
        status
        averageScore
        genres
        season
        seasonYear
        format
        trailer {
          id
          site
        }
        recommendations(sort: RATING_DESC, perPage: 6) {
          edges {
            node {
              mediaRecommendation {
                id
                title {
                  romaji
                  english
                }
                coverImage {
                  large
                }
                averageScore
                format
                status
              }
            }
          }
        }
      }
    }
  `;

  try {
    console.log(`🔎 Fetching AniList details for ID: ${animeId}`);

    const response = await axios.post(
      "https://graphql.anilist.co",
      {
        query: graphqlQuery,
        variables: { id: animeId }
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
      }
    );

    if (response.data.errors) {
      console.error("❌ AniList GraphQL Error:", response.data.errors);
      return res.status(500).json({
        message: "AniList returned an error.",
        errors: response.data.errors
      });
    }

    const anime = response.data.data.Media;
    console.log(`✅ AniList returned details for: ${anime.title.romaji || anime.title.english}`);

    res.json(anime);

  } catch (error) {
    console.error("❌ AniList API Error");
    if (error.response) {
      console.error("Status:", error.response.status);
    } else {
      console.error("Message:", error.message);
    }
    res.status(500).json({
      message: "Could not connect to AniList API.",
      error: error.message
    });
  }
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log("");

  console.log("======================================");

  console.log("🎌 ANIME HUB SERVER");

  console.log("======================================");

  console.log(
    `🚀 Server: http://localhost:${PORT}`
  );

  console.log(
    `🔎 Anime search API: POST /api/anime/search`
  );

  console.log("======================================");

  console.log("");

});