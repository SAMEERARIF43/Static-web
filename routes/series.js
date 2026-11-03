// Anime TV-series route used to verify that manga data stays isolated.

const axios = require('axios');
const express = require('express');
const { mapAniListMediaToCatalogItem } = require('../catalog-utils');

const { getAniListUrl } = require('../anilist-endpoint');

const router = express.Router();
const REQUEST_TIMEOUT_MS = 10000;

router.get('/', async (_req, res) => {
  const query = `query ($page: Int, $perPage: Int, $sort: [MediaSort]) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, isAdult: false, sort: $sort) {
        id type title { romaji english native }
        format countryOfOrigin coverImage { large extraLarge } bannerImage
        description episodes status averageScore genres seasonYear
        studios(isMain: true) { nodes { name } }
      }
    }
  }`;

  try {
    const response = await axios.post(getAniListUrl(), {
      query,
      variables: { page: 1, perPage: 30, sort: ['POPULARITY_DESC'] }
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS
    });
    if (response.data?.errors) {
      throw new Error(response.data.errors.map(error => error.message).join('; '));
    }

    const media = response.data?.data?.Page?.media;
    if (!Array.isArray(media)) throw new Error('AniList returned an invalid series response.');

    const series = media
      .filter(item => !item?.type || String(item.type).toUpperCase() === 'ANIME')
      .filter(item => ['TV', 'TV_SHORT'].includes(String(item?.format || '').toUpperCase()))
      .map(mapAniListMediaToCatalogItem);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(series);
  } catch (error) {
    console.warn(`AniList series unavailable: ${error.message}`);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json([]);
  }
});

module.exports = router;
