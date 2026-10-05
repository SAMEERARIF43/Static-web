// ============================================================
// ANIME HUB SERVER
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { mapLocalAnimeToAniList, searchAnimeLocal, deduplicateMediaList } = require('./search-utils');
const { mergeAniListCatalog } = require('./catalog-utils');

const app = express();
const PORT = process.env.PORT || 3000;
const configuredSiteUrl = new URL(process.env.SITE_URL || `http://localhost:${PORT}`);
if (
  !['http:', 'https:'].includes(configuredSiteUrl.protocol) ||
  configuredSiteUrl.origin === 'null' ||
  configuredSiteUrl.username ||
  configuredSiteUrl.password
) {
  throw new Error('SITE_URL must be an HTTP or HTTPS site origin.');
}
const SITE_URL = configuredSiteUrl.origin;

// ============================================================
// MIDDLEWARE
// ============================================================

// Restricted CORS — only allow the app's own origin (or configured origins)
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : [`http://localhost:${PORT}`];

if (process.env.NODE_ENV === 'production') {
  const isLocalhost = hostname =>
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.startsWith('127.');
  if (
    !process.env.SITE_URL ||
    configuredSiteUrl.protocol !== 'https:' ||
    isLocalhost(configuredSiteUrl.hostname)
  ) {
    throw new Error('Production requires SITE_URL set to the public HTTPS origin.');
  }
  if (!process.env.CORS_ORIGINS) {
    throw new Error('Production requires CORS_ORIGINS to be explicitly configured.');
  }
  const invalidCorsOrigin = ALLOWED_ORIGINS.some(origin => {
    try {
      const url = new URL(origin);
      return url.protocol !== 'https:' ||
        url.origin !== origin ||
        isLocalhost(url.hostname);
    } catch {
      return true;
    }
  });
  if (invalidCorsOrigin) {
    throw new Error('Production CORS_ORIGINS must contain only valid public HTTPS origins.');
  }
  if (!ALLOWED_ORIGINS.includes(SITE_URL)) {
    throw new Error('Production CORS_ORIGINS must include SITE_URL.');
  }
  for (const variable of ['CONTACT_EMAIL', 'DMCA_EMAIL']) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env[variable] || '')) {
      throw new Error(`Production requires a valid monitored ${variable}.`);
    }
  }
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (same-origin, Postman, server-side)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Not allowed by CORS' });
  }
  next(err);
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '16kb' }));

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  res.type('html').send(indexHtml.replaceAll('__SITE_URL__', SITE_URL));
});

// Serve ONLY the public/ directory — not the project root
app.use(express.static(path.join(__dirname, 'public')));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const pages = [
    { path: '', changefreq: 'daily', priority: '1.0' },
    { path: 'privacy.html', changefreq: 'monthly', priority: '0.3' },
    { path: 'terms.html', changefreq: 'monthly', priority: '0.3' },
    { path: 'contact.html', changefreq: 'monthly', priority: '0.5' },
    { path: 'dmca.html', changefreq: 'monthly', priority: '0.3' }
  ];
  const urls = pages.map(p => {
    const loc = p.path ? `${SITE_URL}/${p.path}` : `${SITE_URL}/`;
    return `<url><loc>${loc}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`;
  }).join('');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  );
});

app.get('/api/site-config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    siteUrl: SITE_URL,
    contactEmail: process.env.CONTACT_EMAIL || '',
    dmcaEmail: process.env.DMCA_EMAIL || ''
  });
});

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || ''
  });
});

app.delete('/api/account', async (req, res) => {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match || match[1].length > 8192) {
    return res.status(401).json({ message: 'A valid login session is required.' });
  }

  const supabaseUrlValue = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrlValue || !anonKey || !serviceRoleKey) {
    return res.status(503).json({ message: 'Account deletion is not configured on this server.' });
  }

  let supabaseUrl;
  try {
    supabaseUrl = new URL(supabaseUrlValue);
  } catch {
    console.error('Account deletion is unavailable because SUPABASE_URL is invalid.');
    return res.status(503).json({ message: 'Account deletion is not configured on this server.' });
  }
  if (
    !['https:', 'http:'].includes(supabaseUrl.protocol) ||
    (supabaseUrl.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(supabaseUrl.hostname)) ||
    supabaseUrl.username ||
    supabaseUrl.password
  ) {
    console.error('Account deletion is unavailable because SUPABASE_URL is not a secure origin.');
    return res.status(503).json({ message: 'Account deletion is not configured on this server.' });
  }

  const baseUrl = supabaseUrl.origin;
  const accessToken = match[1];
  let authenticatedUser;
  try {
    const verification = await axios.get(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      },
      timeout: 10000
    });
    authenticatedUser = verification.data;
  } catch (error) {
    if ([401, 403].includes(error.response?.status)) {
      return res.status(401).json({ message: 'Your login session is invalid or expired.' });
    }
    console.error(`Supabase session verification failed${error.response?.status ? ` (${error.response.status})` : ''}.`);
    return res.status(502).json({ message: 'Could not verify the account session.' });
  }

  const userId = authenticatedUser?.id;
  if (typeof userId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId)) {
    console.error('Supabase session verification returned an invalid user identity.');
    return res.status(502).json({ message: 'Could not verify the account session.' });
  }

  try {
    await axios.delete(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      },
      timeout: 15000
    });
    return res.status(200).json({ message: 'Your account has been deleted.' });
  } catch (error) {
    console.error(`Supabase account deletion failed${error.response?.status ? ` (${error.response.status})` : ''}.`);
    return res.status(502).json({ message: 'Account deletion could not be completed. Please try again later.' });
  }
});


// ============================================================
// HELPERS — Sanitize HTML from AniList descriptions
// ============================================================

/**
 * Strip all HTML tags except <br> and escape remaining content
 * to prevent XSS when forwarding AniList data to the client.
 */
function sanitizeDescription(html) {
  if (!html || typeof html !== 'string') return '';
  // Preserve <br> tags, strip all other HTML
  return html
    .replace(/<br\s*\/?>/gi, '\n')    // Convert <br> to newlines
    .replace(/<[^>]*>/g, '')           // Remove all other tags
    .replace(/\n/g, '<br>');           // Restore <br> tags
}

/**
 * Safely extract a nested property, returning fallback if missing.
 */
function safe(obj, path, fallback = null) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] != null ? acc[key] : fallback), obj);
}


// ============================================================
// LOCAL ANIME DATABASE
// ============================================================

const ANIME_DB = [
  {
    id: 1,
    anilistId: 113415,
    title: "Jujutsu Kaisen",
    genre: ["Action", "Supernatural", "Shounen"],
    year: 2020,
    rating: 8.6,
    episodes: 24,
    type: "TV",
    studio: "MAPPA",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQBSkxWAAk83.jpg",
    description:
      "Yuji Itadori joins a secret organization of Jujutsu Sorcerers after becoming the host of a powerful curse."
  },

  {
    id: 2,
    anilistId: 151807,
    title: "Solo Leveling",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2024,
    rating: 8.8,
    episodes: 25,
    type: "TV",
    studio: "A-1 Pictures",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/151807-37yfQA3ym8PA.jpg",
    description:
      "Sung Jin-Woo, the weakest hunter, gains a mysterious ability that allows him to level up."
  },

  {
    id: 3,
    anilistId: 21,
    title: "One Piece",
    genre: ["Action", "Adventure", "Fantasy", "Shounen"],
    year: 1999,
    rating: 9.0,
    episodes: 1100,
    type: "TV",
    studio: "Toei Animation",
    language: "Japanese",
    status: "Airing",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJmZqs.jpg",
    description:
      "Monkey D. Luffy and his crew travel across the Grand Line in search of the legendary One Piece."
  },

  {
    id: 4,
    anilistId: 101922,
    title: "Demon Slayer",
    genre: ["Action", "Supernatural", "Shounen"],
    year: 2019,
    rating: 8.6,
    episodes: 55,
    type: "TV",
    studio: "ufotable",
    language: "Japanese",
    status: "Airing",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-33MtJGsUSxga.jpg",
    description:
      "Tanjiro Kamado becomes a demon slayer after his family is attacked and his sister is turned into a demon."
  },

  {
    id: 5,
    anilistId: 16498,
    title: "Attack on Titan",
    genre: ["Action", "Drama", "Fantasy"],
    year: 2013,
    rating: 9.0,
    episodes: 89,
    type: "TV",
    studio: "WIT STUDIO",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmneX.jpg",
    description:
      "Humanity fights for survival against terrifying Titans that threaten to destroy civilization."
  },

  {
    id: 6,
    anilistId: 20,
    title: "Naruto",
    genre: ["Action", "Adventure", "Shounen"],
    year: 2002,
    rating: 8.3,
    episodes: 220,
    type: "TV",
    studio: "Studio Pierrot",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/20-HHxhPj5JD13a.jpg",
    description:
      "Naruto Uzumaki dreams of becoming the strongest ninja and earning the respect of his village."
  },

  {
    id: 7,
    anilistId: 1535,
    title: "Death Note",
    genre: ["Mystery", "Psychological", "Supernatural"],
    year: 2006,
    rating: 8.6,
    episodes: 37,
    type: "TV",
    studio: "Madhouse",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/1535.jpg",
    description:
      "A brilliant student discovers a mysterious notebook that can kill anyone whose name is written inside."
  },

  {
    id: 8,
    anilistId: 5114,
    title: "Fullmetal Alchemist: Brotherhood",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2009,
    rating: 9.1,
    episodes: 64,
    type: "TV",
    studio: "Bones",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/5114-q0V5URebphSG.jpg",
    description:
      "Two brothers use alchemy to search for the Philosopher's Stone after a failed human transmutation."
  },

  {
    id: 9,
    anilistId: 269,
    title: "Bleach",
    genre: ["Action", "Adventure", "Supernatural"],
    year: 2004,
    rating: 8.2,
    episodes: 366,
    type: "TV",
    studio: "Studio Pierrot",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/269-08ar2HJOUAuL.jpg",
    description:
      "Ichigo Kurosaki becomes a Soul Reaper and battles supernatural enemies threatening the human world."
  },

  {
    id: 10,
    anilistId: 101348,
    title: "Vinland Saga",
    genre: ["Action", "Adventure", "Drama"],
    year: 2019,
    rating: 8.8,
    episodes: 48,
    type: "TV",
    studio: "WIT STUDIO",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101348-pivKKffCAwAY.jpg",
    description:
      "Thorfinn grows up among Vikings while seeking revenge and searching for a land free from war."
  },

  {
    id: 11,
    anilistId: 9253,
    title: "Steins;Gate",
    genre: ["Sci-Fi", "Thriller", "Psychological"],
    year: 2011,
    rating: 9.0,
    episodes: 24,
    type: "TV",
    studio: "White Fox",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/n9253-JIhmKgBKsWUN.jpg",
    description:
      "A group of friends accidentally discover a method of sending messages through time."
  },

  {
    id: 12,
    anilistId: 11061,
    title: "Hunter x Hunter",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2011,
    rating: 9.0,
    episodes: 148,
    type: "TV",
    studio: "Madhouse",
    language: "Japanese",
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


function getAnimeById(id) {

  return ANIME_DB.find(anime =>
    anime.id === Number(id)
  );
}

const popularCatalogCache = {
  data: null,
  expiresAt: 0,
  pending: null
};
const POPULAR_CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;

async function getPopularCatalog() {
  if (popularCatalogCache.data && Date.now() < popularCatalogCache.expiresAt) {
    return popularCatalogCache.data;
  }
  if (popularCatalogCache.pending) return popularCatalogCache.pending;

  const staleCatalog = popularCatalogCache.data;
  popularCatalogCache.pending = (async () => {
    try {
      const graphqlQuery = `
        query {
          Page(page: 1, perPage: 50) {
            media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
              id
              title {
                romaji
                english
                native
              }
              coverImage {
                large
                extraLarge
              }
              bannerImage
              description
              episodes
              status
              averageScore
              genres
              seasonYear
              startDate {
                year
              }
              format
              countryOfOrigin
              studios(isMain: true) {
                nodes {
                  name
                }
              }
            }
          }
        }
      `;
      const response = await axios.post(
        'https://graphql.anilist.co',
        { query: graphqlQuery },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      if (response.data.errors) {
        throw new Error(response.data.errors.map(error => error.message).join('; '));
      }

      const media = safe(response, 'data.data.Page.media', null);
      if (!Array.isArray(media) || media.length === 0) {
        throw new Error('AniList returned no popular catalog entries.');
      }

      const sanitizedMedia = media.map(anime => ({
        ...anime,
        description: sanitizeDescription(anime.description)
      }));
      const catalog = mergeAniListCatalog(ANIME_DB, sanitizedMedia);
      popularCatalogCache.data = catalog;
      popularCatalogCache.expiresAt = Date.now() + POPULAR_CATALOG_CACHE_TTL_MS;
      return catalog;
    } catch (error) {
      console.warn(`AniList popular catalog unavailable; using ${staleCatalog ? 'cached' : 'local'} catalog: ${error.message}`);
      return staleCatalog || ANIME_DB;
    } finally {
      popularCatalogCache.pending = null;
    }
  })();

  return popularCatalogCache.pending;
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

app.get('/api/popular', async (req, res) => {
  const popular = await getPopularCatalog();
  res.json(popular);
});


// ============================================================
// SEARCH (AniList first, local fallback)
// ============================================================

app.get('/api/search', async (req, res) => {

  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (!query || query.length > 100) {
    return res.status(400).json({
      message: "Enter an anime name of 1 to 100 characters."
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
            countryOfOrigin
            studios(isMain: true) {
              nodes {
                name
              }
            }
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
      const mediaList = safe(response, 'data.data.Page.media', []);
      // Deduplicate and sanitize descriptions before sending to client
      const sanitized = deduplicateMediaList(mediaList).map(anime => ({
        ...anime,
        description: sanitizeDescription(anime.description)
      }));
      console.log(`AniList returned ${sanitized.length} search results.`);
      res.json(sanitized);
      return;
    }
  } catch (error) {
    console.log("❌ AniList failed, using local database fallback");
    // AniList failed - will fall through to local DB
  }

  // Fall back to local database
  const results = searchAnimeLocal(ANIME_DB, query).map(mapLocalAnimeToAniList);
  res.json(deduplicateMediaList(results));

});


// ============================================================
// LOCAL SEARCH HELPER
// ============================================================

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
        startDate {
          year
          month
          day
        }
        duration
        source
        countryOfOrigin
        studios(isMain: true) {
          nodes {
            name
          }
        }
        staff(page: 1, perPage: 6, sort: [RELEVANCE]) {
          edges {
            role
            node {
              name {
                full
              }
            }
          }
        }
        characters(page: 1, perPage: 6, sort: [ROLE]) {
          edges {
            role
            node {
              name {
                full
              }
            }
            voiceActors(language: JAPANESE, sort: [RELEVANCE]) {
              name {
                full
              }
              languageV2
            }
          }
        }
        trailer {
          id
          site
        }
        relations {
          edges {
            relationType
            node {
              id
              type
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
        message: "AniList returned an error."
      });
    }

    const anime = safe(response, 'data.data.Media', null);
    if (!anime) {
      return res.status(404).json({ message: "Anime not found on AniList." });
    }

    // Sanitize description before sending to client
    anime.description = sanitizeDescription(anime.description);

    const titleDisplay = safe(anime, 'title.romaji', '') || safe(anime, 'title.english', 'Unknown');
    console.log(`✅ AniList returned details for: ${titleDisplay}`);

    res.json(anime);

  } catch (error) {
    console.error("❌ AniList API Error");
    if (error.response) {
      console.error("Status:", error.response.status);
    } else {
      console.error("Message:", error.message);
    }
    res.status(500).json({
      message: "Could not connect to AniList API."
    });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.message === 'Not allowed by CORS'
    ? 403
    : [400, 413].includes(error.status)
      ? error.status
      : 500;

  console.error(`Request failed (${status}): ${error.message}`);
  res.status(status).json({
    message: status === 413
      ? 'Request body is too large.'
      : status === 400
        ? 'Invalid request.'
        : status === 403
          ? 'This origin is not allowed.'
          : 'An internal server error occurred.'
  });
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
    `📁 Serving frontend from: ./public/`
  );

  console.log("======================================");

  console.log("");

});