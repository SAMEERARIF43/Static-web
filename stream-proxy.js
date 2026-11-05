'use strict';

// Local, allowlisted HLS gateway for operator-controlled/licensed sources.
// This module deliberately does not discover or scrape public streaming sites.

const crypto = require('crypto');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

const DEFAULT_USER_AGENT = 'AnimeHub/1.0 (+local authorized media gateway)';
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const BLOCKED_FORWARD_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-admin-token',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip'
]);
const ALLOWED_FORWARD_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'range',
  'user-agent',
  'referer',
  'origin'
]);

const TOKEN_SECRET = process.env.STREAM_PROXY_SECRET || crypto.randomBytes(32).toString('hex');

function parseHostList(value) {
  return String(value || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function configuredAllowedHosts(providerUrl) {
  const hosts = parseHostList(process.env.STREAM_PROXY_ALLOWED_HOSTS);
  if (providerUrl) {
    try {
      hosts.push(new URL(providerUrl).hostname.toLowerCase());
    } catch {
      // Provider URL validation reports the useful configuration error later.
    }
  }
  return [...new Set(hosts)];
}

function isPrivateAddress(address) {
  const normalized = normalizeHostname(address);
  if (normalized === '::1' || normalized === '0.0.0.0' || normalized === '::') return true;
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  if (net.isIP(normalized) === 6) {
    return normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') || normalized.startsWith('ff');
  }
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254);
}

// Additional SSRF protection: explicitly block metadata endpoints and
// any address that could be used for server-side request forgery.
// This guard runs in addition to isPrivateAddress for defense-in-depth.
function isSSRFTarget(address) {
  const normalized = normalizeHostname(address);
  // Block the specific metadata endpoint 169.254.169.254
  if (normalized === '169.254.169.254') return true;
  // Block loopback and private addresses (redundant with isPrivateAddress
  // but explicit for defense-in-depth and code clarity)
  if (normalized === 'localhost' || normalized === '127.0.0.1') return true;
  if (normalized.startsWith('10.')) return true;
  if (normalized.startsWith('172.16.')) return true;
  if (normalized.startsWith('172.31.')) return true;
  if (normalized.startsWith('192.168.')) return true;
  if (normalized.endsWith('.localhost')) return true;
  if (normalized === '::1' || normalized === '::ffff:127.0.0.1') return true;
  return false;
}

function isPrivateHostname(hostname) {
  const value = normalizeHostname(hostname);
  return value === 'localhost' || value.endsWith('.localhost') ||
    value === 'metadata.google.internal' || isPrivateAddress(value);
}

function hostIsAllowed(hostname, allowedHosts) {
  const value = normalizeHostname(hostname);
  return allowedHosts.some(allowed => {
    const normalizedAllowed = normalizeHostname(allowed).replace(/^\./, '');
    return normalizedAllowed && (value === normalizedAllowed || value.endsWith(`.${normalizedAllowed}`));
  });
}

async function assertSafeTarget(rawUrl, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    const error = new Error('Stream URL must be a valid URL.');
    error.code = 'INVALID_STREAM_URL';
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    const error = new Error('Only credential-free HTTP(S) stream URLs are supported.');
    error.code = 'INVALID_STREAM_URL';
    throw error;
  }
  if (isSSRFTarget(parsed.hostname) || isPrivateHostname(parsed.hostname) || !hostIsAllowed(parsed.hostname, allowedHosts)) {
    const error = new Error('The stream host is not allowlisted.');
    error.code = 'STREAM_HOST_NOT_ALLOWED';
    throw error;
  }

  // Resolve the host before connecting so an allowlisted hostname cannot be
  // used as a simple DNS-rebinding path into a local/private address.
  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
    const error = new Error('The stream host resolves to a private address.');
    error.code = 'STREAM_HOST_NOT_ALLOWED';
    throw error;
  }
  return parsed;
}

function requestModule(parsed) {
  return parsed.protocol === 'https:' ? https : http;
}

function sanitizeForwardHeaders(extra = {}) {
  const safe = {};
  for (const [name, value] of Object.entries(extra || {})) {
    const lowerName = String(name).toLowerCase();
    if (BLOCKED_FORWARD_HEADERS.has(lowerName) || !ALLOWED_FORWARD_HEADERS.has(lowerName)) continue;
    if (value === undefined || value === null) continue;
    safe[name] = String(value);
  }
  return safe;
}

function requestHeaders(parsed, extra = {}) {
  const origin = process.env.STREAM_PROXY_ORIGIN || parsed.origin;
  const referer = process.env.STREAM_PROXY_REFERER || `${parsed.origin}/`;
  return {
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    'User-Agent': process.env.STREAM_PROXY_USER_AGENT || DEFAULT_USER_AGENT,
    Referer: referer,
    Origin: origin,
    ...sanitizeForwardHeaders(extra)
  };
}

function fetchBuffer(rawUrl, { allowedHosts, maxBytes, headers = {}, redirects = 0 } = {}) {
  return assertSafeTarget(rawUrl, allowedHosts).then(parsed => new Promise((resolve, reject) => {
    const request = requestModule(parsed).get(parsed, {
      headers: requestHeaders(parsed, headers),
      timeout: Number(process.env.STREAM_PROXY_TIMEOUT_MS) || 15000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          const error = new Error('Too many stream redirects.');
          error.code = 'UPSTREAM_REDIRECT_LIMIT';
          reject(error);
          return;
        }
        const nextUrl = new URL(response.headers.location, parsed).href;
        fetchBuffer(nextUrl, { allowedHosts, maxBytes, headers, redirects: redirects + 1 })
          .then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        const error = new Error(`Upstream stream request failed with status ${response.statusCode}.`);
        error.code = 'UPSTREAM_STATUS';
        error.status = response.statusCode;
        reject(error);
        return;
      }

      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy();
          const error = new Error('Upstream stream response is too large.');
          error.code = 'UPSTREAM_TOO_LARGE';
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        body: Buffer.concat(chunks),
        contentType: response.headers['content-type'] || '',
        statusCode: response.statusCode,
        headers: response.headers,
        url: parsed.href
      }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Upstream stream request timed out.')));
    request.on('error', reject);
  }));
}

function fetchStream(rawUrl, { allowedHosts, headers = {}, requestHeaders: passthrough = {} } = {}) {
  return assertSafeTarget(rawUrl, allowedHosts).then(parsed => new Promise((resolve, reject) => {
    const request = requestModule(parsed).get(parsed, {
      headers: requestHeaders(parsed, { ...headers, ...passthrough }),
      timeout: Number(process.env.STREAM_PROXY_TIMEOUT_MS) || 15000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        reject(Object.assign(new Error('Redirected stream responses are not supported for passthrough requests.'), { code: 'UPSTREAM_REDIRECT' }));
        return;
      }
      resolve({ response, parsed });
    });
    request.on('timeout', () => request.destroy(new Error('Upstream stream request timed out.')));
    request.on('error', reject);
  }));
}

function providerUrlFor(animeId, episodeNum, providerUrl) {
  let parsed;
  try {
    parsed = new URL(providerUrl);
  } catch {
    const error = new Error('STREAM_PROVIDER_URL must be a valid HTTP(S) URL.');
    error.code = 'STREAM_PROVIDER_NOT_CONFIGURED';
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    const error = new Error('STREAM_PROVIDER_URL must be a credential-free HTTP(S) URL.');
    error.code = 'STREAM_PROVIDER_NOT_CONFIGURED';
    throw error;
  }
  const encodedId = encodeURIComponent(String(animeId));
  const encodedEpisode = encodeURIComponent(String(episodeNum));
  if (providerUrl.includes('{animeId}') || providerUrl.includes('{episode}')) {
    return providerUrl
      .replaceAll('{animeId}', encodedId)
      .replaceAll('{episode}', encodedEpisode);
  }
  parsed.searchParams.set('animeId', String(animeId));
  parsed.searchParams.set('episode', String(episodeNum));
  return parsed.href;
}

function isCandidateUrl(value, metadata = {}) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && (
      /mpegurl|m3u8|mp4/i.test(String(metadata.type || '')) ||
      parsed.pathname.toLowerCase().includes('.m3u8') ||
      parsed.pathname.toLowerCase().includes('.mp4') ||
      parsed.searchParams.has('m3u8') ||
      parsed.searchParams.has('url')
    );
  } catch {
    return false;
  }
}

function isTrackUrl(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const path = parsed.pathname.toLowerCase();
    return path.endsWith('.vtt') || path.endsWith('.ass') || path.endsWith('.ssa') ||
      parsed.searchParams.has('vtt') || parsed.searchParams.has('subtitle') || parsed.searchParams.has('captions');
  } catch {
    return false;
  }
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function qualityOf(source, url) {
  const raw = source?.quality || source?.resolution || source?.label || source?.height;
  if (raw !== undefined && raw !== null && String(raw).trim()) {
    const value = String(raw).trim();
    return /^\d+$/.test(value) ? `${value}p` : value;
  }
  const match = String(url).match(/(?:^|[^0-9])(2160|1440|1080|720|480|360|240)p?(?:[^0-9]|$)/i);
  return match ? `${match[1]}p` : 'Auto';
}

function typeOf(source, url) {
  if (source.type || source.mimeType) return source.type || source.mimeType;
  return String(url).toLowerCase().includes('.mp4') ? 'video/mp4' : 'application/x-mpegURL';
}

function languageOf(source = {}, fallback = 'und') {
  return String(source.language || source.lang || source.srclang || source.locale || fallback)
    .trim()
    .toLowerCase()
    .replace('_', '-');
}

function labelOf(source = {}, language = 'und') {
  if (source.label || source.name || source.title) return String(source.label || source.name || source.title).trim();
  const labels = {
    en: 'English',
    es: 'Spanish',
    ja: 'Japanese',
    fr: 'French',
    de: 'German',
    pt: 'Portuguese',
    ko: 'Korean',
    zh: 'Chinese'
  };
  return labels[language.split('-')[0]] || (language === 'und' ? 'Unknown' : language.toUpperCase());
}

function audioTrackFromObject(track) {
  if (!track || typeof track !== 'object') return null;
  const url = track.url || track.file || track.src || track.source || track.link;
  const label = labelOf(track, languageOf(track));
  const language = languageOf(track);
  if (!url && !track.groupId && !track.group && !track.default) return null;
  return {
    id: String(track.id || track.groupId || track.group || language || label),
    label,
    language,
    default: Boolean(track.default || track.isDefault || track.autoselect),
    url: typeof url === 'string' && isHttpUrl(url) ? url : null
  };
}

function subtitleTrackFromObject(track, fallbackLanguage = 'und') {
  if (!track || typeof track !== 'object') return null;
  const url = track.url || track.file || track.src || track.source || track.link;
  if (!isTrackUrl(url)) return null;
  const language = languageOf(track, fallbackLanguage);
  return {
    label: labelOf(track, language),
    language,
    kind: String(track.kind || 'subtitles').toLowerCase() === 'captions' ? 'captions' : 'subtitles',
    format: /\.(ass|ssa)(?:$|[?#])/i.test(url) ? 'ass' : 'vtt',
    default: Boolean(track.default || track.isDefault || track.autoselect),
    url
  };
}

function collectTrackMetadata(source, subtitles = [], audioTracks = [], seenSubtitles = new Set(), seenAudio = new Set()) {
  if (!source || typeof source !== 'object') return { subtitles, audioTracks };
  const sourceSubtitleValues = [source.subtitle, source.subtitles, source.caption, source.captions, source.tracks]
    .flatMap(value => Array.isArray(value) ? value : value ? [value] : []);
  sourceSubtitleValues.forEach(track => {
    const normalized = typeof track === 'string'
      ? subtitleTrackFromObject({ url: track })
      : subtitleTrackFromObject(track);
    if (normalized && !seenSubtitles.has(normalized.url)) {
      seenSubtitles.add(normalized.url);
      subtitles.push(normalized);
    }
  });
  const sourceAudioValues = [source.audio, source.audios, source.audioTracks, source.audio_tracks]
    .flatMap(value => Array.isArray(value) ? value : value ? [value] : []);
  sourceAudioValues.forEach(track => {
    const normalized = typeof track === 'string'
      ? audioTrackFromObject({ url: track, label: track })
      : audioTrackFromObject(track);
    if (normalized && !seenAudio.has(normalized.id)) {
      seenAudio.add(normalized.id);
      audioTracks.push(normalized);
    }
  });
  return { subtitles, audioTracks };
}

function collectSources(payload, output = [], seen = new Set(), metadata = {}, trackState = { subtitles: [], audioTracks: [], seenSubtitles: new Set(), seenAudio: new Set() }) {
  if (output.length >= 30 || payload === null || payload === undefined) return output;
  if (typeof payload === 'string') {
    if (isCandidateUrl(payload, metadata) && !seen.has(payload)) {
      seen.add(payload);
      output.push({
        url: payload,
        quality: qualityOf(metadata, payload),
        type: typeOf(metadata, payload),
        host: new URL(payload).hostname,
        subtitles: [],
        audioTracks: []
      });
    }
    return output;
  }
  if (Array.isArray(payload)) {
    payload.forEach(entry => collectSources(entry, output, seen, metadata, trackState));
    return output;
  }
  if (typeof payload !== 'object') return output;

  const nextMetadata = {
    ...metadata,
    quality: payload.quality || payload.resolution || payload.label || payload.height || metadata.quality,
    type: payload.type || payload.mimeType || metadata.type
  };
  const beforeSources = output.length;
  collectTrackMetadata(payload, trackState.subtitles, trackState.audioTracks, trackState.seenSubtitles, trackState.seenAudio);
  for (const key of ['url', 'file', 'src', 'source', 'link']) {
    if (typeof payload[key] === 'string') collectSources(payload[key], output, seen, nextMetadata, trackState);
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') collectSources(value, output, seen, nextMetadata, trackState);
  }
  if (output.length > beforeSources && (trackState.subtitles.length || trackState.audioTracks.length)) {
    output.slice(beforeSources).forEach(source => {
      source.subtitles = [...trackState.subtitles];
      source.audioTracks = [...trackState.audioTracks];
    });
  }
  return output;
}

function convertAssToVtt(input) {
  const text = String(input || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const events = [];
  let inEvents = false;
  let format = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[.*\]$/.test(line) && !/^\[events\]$/i.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      format = line.slice(line.indexOf(':') + 1).split(',').map(value => value.trim());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const values = line.slice(line.indexOf(':') + 1).split(',');
    const fields = Object.fromEntries(format.map((name, index) => [name.toLowerCase(), values[index] ?? '']));
    const start = assTimeToVtt(fields.start);
    const end = assTimeToVtt(fields.end);
    const dialogue = assTextToVtt(fields.text);
    if (start && end && dialogue) events.push({ start, end, dialogue });
  }
  return `WEBVTT\n\n${events.map((event, index) => `${index + 1}\n${event.start} --> ${event.end}\n${event.dialogue}\n`).join('\n')}`;
}

function assTimeToVtt(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{2})$/);
  if (!match) return '';
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}:${match[3]}.${match[4]}`;
}

function assTextToVtt(value) {
  return String(value || '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(/\{[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

async function extractStreamUrl(animeId, episodeNum, options = {}) {
  if (!/^\d+$/.test(String(animeId)) || Number(animeId) < 1) {
    const error = new Error('animeId must be a positive integer.');
    error.code = 'INVALID_STREAM_REQUEST';
    throw error;
  }
  if (!/^\d+$/.test(String(episodeNum)) || Number(episodeNum) < 1) {
    const error = new Error('episode must be a positive integer.');
    error.code = 'INVALID_STREAM_REQUEST';
    throw error;
  }

  const configuredProviderUrl = options.providerUrl || process.env.STREAM_PROVIDER_URL;
  if (!configuredProviderUrl) {
    const error = new Error('No authorized stream provider is configured.');
    error.code = 'STREAM_PROVIDER_NOT_CONFIGURED';
    throw error;
  }
  const providerUrl = providerUrlFor(animeId, episodeNum, configuredProviderUrl);
  const allowedHosts = configuredAllowedHosts(configuredProviderUrl);
  const providerResponse = await fetchBuffer(providerUrl, {
    allowedHosts,
    maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
    headers: { Accept: 'application/json' }
  });
  let payload;
  try {
    payload = JSON.parse(providerResponse.body.toString('utf8'));
  } catch {
    const error = new Error('The configured stream provider returned invalid JSON.');
    error.code = 'UPSTREAM_INVALID_JSON';
    throw error;
  }

  const sources = collectSources(payload);
  const providerSubtitles = [];
  const providerAudioTracks = [];
  const seenSubtitles = new Set();
  const seenAudio = new Set();
  const collectProviderTracks = value => {
    if (!value || typeof value !== 'object') return;
    collectTrackMetadata(value, providerSubtitles, providerAudioTracks, seenSubtitles, seenAudio);
    Object.values(value).forEach(child => {
      if (child && typeof child === 'object') collectProviderTracks(child);
    });
  };
  collectProviderTracks(payload);
  const verifiedSources = [];
  for (const source of sources) {
    try {
      await assertSafeTarget(source.url, allowedHosts);
      const subtitles = [...(source.subtitles || [])];
      const subtitleUrls = new Set(subtitles.map(track => track.url));
      providerSubtitles.forEach(track => {
        if (!subtitleUrls.has(track.url)) subtitles.push(track);
      });
      const safeSubtitles = [];
      for (const track of subtitles) {
        try {
          await assertSafeTarget(track.url, allowedHosts);
          safeSubtitles.push(track);
        } catch {
          // Subtitle files must obey the same provider/CDN allowlist as media.
        }
      }
      const audioTracks = [...(source.audioTracks || [])];
      const audioIds = new Set(audioTracks.map(track => track.id));
      providerAudioTracks.forEach(track => {
        if (!audioIds.has(track.id)) audioTracks.push(track);
      });
      verifiedSources.push({ ...source, subtitles: safeSubtitles, audioTracks });
    } catch {
      // Ignore provider payload entries outside the operator allowlist.
    }
  }
  if (!verifiedSources.length) {
    const error = new Error('The configured provider returned no allowlisted HLS or MP4 sources.');
    error.code = 'NO_STREAM_SOURCES';
    throw error;
  }
  return verifiedSources;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(value).digest('base64url');
}

function createStreamToken(url, ttlMs = DEFAULT_TOKEN_TTL_MS) {
  const payload = base64Url(JSON.stringify({
    url,
    exp: Date.now() + Math.max(1000, Math.min(Number(ttlMs) || DEFAULT_TOKEN_TTL_MS, 60 * 60 * 1000))
  }));
  return `${payload}.${sign(payload)}`;
}

function validateStreamToken(token) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const separator = token.lastIndexOf('.');
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.url !== 'string' || !Number.isFinite(parsed.exp) || parsed.exp < Date.now()) return null;
  return parsed;
}

function proxyUrlForToken(token) {
  return `/api/stream/proxy?token=${encodeURIComponent(token)}`;
}

function subtitleProxyUrlForToken(token) {
  return `/api/stream/subtitles?token=${encodeURIComponent(token)}`;
}

function setSubtitleCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function rewriteManifest(manifest, manifestUrl, allowedHosts) {
  const rewrite = value => {
    if (!value || value.startsWith('data:')) return value;
    const absolute = new URL(value, manifestUrl).href;
    // URL validation is performed asynchronously before the upstream request;
    // the allowlist here prevents emitting links outside the same policy.
    const parsed = new URL(absolute);
    if (!hostIsAllowed(parsed.hostname, allowedHosts)) return value;
    return proxyUrlForToken(createStreamToken(absolute));
  };
  return manifest.split(/\r?\n/).map(line => {
    if (!line) return line;
    const withUri = line.replace(/URI="([^"]+)"/gi, (_match, value) => `URI="${rewrite(value)}"`);
    if (withUri.startsWith('#')) return withUri;
    return rewrite(withUri);
  }).join('\n');
}

async function proxyStreamRequest(req, res) {
  const token = Array.isArray(req.query?.token) ? req.query.token[0] : req.query?.token;
  const tokenPayload = validateStreamToken(token);
  if (!tokenPayload) {
    res.status(401).json({ message: 'The stream token is missing, invalid, or expired.' });
    return;
  }

  const allowedHosts = configuredAllowedHosts(process.env.STREAM_PROVIDER_URL);
  try {
    const parsed = await assertSafeTarget(tokenPayload.url, allowedHosts);
    const isManifest = parsed.pathname.toLowerCase().includes('.m3u8');
    if (isManifest) {
      const manifest = await fetchBuffer(parsed.href, {
        allowedHosts,
        maxBytes: MAX_MANIFEST_BYTES,
        headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' }
      });
      const body = rewriteManifest(manifest.body.toString('utf8'), manifest.url, allowedHosts);
      res.status(200).type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(body);
      return;
    }

    const upstream = await fetchStream(parsed.href, {
      allowedHosts,
      requestHeaders: req.get('range') ? { Range: req.get('range') } : {}
    });
    res.status(upstream.response.statusCode || 200);
    res.setHeader('Content-Type', upstream.response.headers['content-type'] || 'video/mp2t');
    if (upstream.response.headers['content-length']) res.setHeader('Content-Length', upstream.response.headers['content-length']);
    if (upstream.response.headers['content-range']) res.setHeader('Content-Range', upstream.response.headers['content-range']);
    res.setHeader('Accept-Ranges', upstream.response.headers['accept-ranges'] || 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=30');
    upstream.response.pipe(res);
  } catch (error) {
    const status = ['STREAM_HOST_NOT_ALLOWED', 'INVALID_STREAM_URL'].includes(error.code)
      ? 403
      : error.code === 'UPSTREAM_STATUS' && [401, 403, 404].includes(error.status)
        ? error.status
        : 502;
    res.status(status).json({ message: status === 403 ? 'The stream host is not allowed.' : 'The upstream stream is unavailable.' });
  }
}

async function proxySubtitleRequest(req, res) {
  setSubtitleCorsHeaders(res);
  const token = Array.isArray(req.query?.token) ? req.query.token[0] : req.query?.token;
  const tokenPayload = validateStreamToken(token);
  if (!tokenPayload) {
    res.status(401).json({ message: 'The subtitle token is missing, invalid, or expired.' });
    return;
  }
  const allowedHosts = configuredAllowedHosts(process.env.STREAM_PROVIDER_URL);
  try {
    const parsed = await assertSafeTarget(tokenPayload.url, allowedHosts);
    const subtitle = await fetchBuffer(parsed.href, {
      allowedHosts,
      maxBytes: MAX_SUBTITLE_BYTES,
      headers: { Accept: 'text/vtt, text/plain, */*' }
    });
    const isAss = /\.(ass|ssa)(?:$|[?#])/i.test(parsed.pathname) || /text\/x-ass|application\/x-ass/i.test(subtitle.contentType);
    const body = isAss ? convertAssToVtt(subtitle.body.toString('utf8')) : subtitle.body.toString('utf8');
    res.status(200)
      .type('text/vtt')
      .set('Cache-Control', 'private, max-age=60')
      .set('Content-Disposition', 'inline')
      .send(body);
  } catch (error) {
    const status = ['STREAM_HOST_NOT_ALLOWED', 'INVALID_STREAM_URL'].includes(error.code)
      ? 403
      : error.code === 'UPSTREAM_STATUS' && [401, 403, 404].includes(error.status)
        ? error.status
        : 502;
    res.status(status).json({ message: status === 403 ? 'The subtitle host is not allowed.' : 'The subtitle file is unavailable.' });
  }
}

module.exports = {
  createStreamToken,
  extractStreamUrl,
  proxyStreamRequest,
  proxySubtitleRequest,
  proxyUrlForToken,
  subtitleProxyUrlForToken,
  convertAssToVtt,
  requestHeaders,
  sanitizeForwardHeaders,
  validateStreamToken
};
