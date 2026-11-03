// Stream gateway routes — used by server.js under /api/stream.
// Extraction produces signed proxy tokens; the proxy and subtitle endpoints
// verify them and apply the SSRF allowlist before any upstream connection.

const express = require('express');
const {
  createStreamToken,
  extractStreamUrl,
  proxyStreamRequest,
  proxySubtitleRequest,
  proxyUrlForToken,
  subtitleProxyUrlForToken
} = require('../stream-proxy');

const router = express.Router();

router.get('/extract', async (req, res) => {
  const animeId = String(req.query.animeId || '').trim();
  const episode = String(req.query.episode || req.query.episodeNum || '').trim();
  if (!/^\d+$/.test(animeId) || Number(animeId) < 1 || !/^\d+$/.test(episode) || Number(episode) < 1) {
    return res.status(400).json({ message: 'animeId and episode must be positive integers.' });
  }

  try {
    const sources = await extractStreamUrl(animeId, episode);
    return res.json({
      animeId: Number(animeId),
      episode: Number(episode),
      expiresInSeconds: 600,
      sources: sources.map(source => ({
        quality: source.quality,
        type: source.type,
        host: source.host,
        url: proxyUrlForToken(createStreamToken(source.url)),
        subtitles: (source.subtitles || []).map(track => ({
          label: track.label,
          language: track.language,
          kind: track.kind,
          format: track.format,
          default: track.default,
          url: subtitleProxyUrlForToken(createStreamToken(track.url))
        })),
        audioTracks: source.audioTracks || []
      }))
    });
  } catch (error) {
    if (error.code === 'STREAM_PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({ message: 'Authorized stream playback is not configured on this server.' });
    }
    if (error.code === 'INVALID_STREAM_REQUEST') {
      return res.status(400).json({ message: error.message });
    }
    if (error.code === 'NO_STREAM_SOURCES') {
      return res.status(404).json({ message: 'No authorized stream source is available for this episode.' });
    }
    console.error(`Stream extraction failed [${req.id || 'no-request-id'}]: ${error.message}`);
    return res.status(502).json({ message: 'Could not retrieve an authorized stream source.' });
  }
});

router.get('/proxy', proxyStreamRequest);

router.options('/subtitles', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.status(204).end();
});

router.get('/subtitles', proxySubtitleRequest);

module.exports = router;
