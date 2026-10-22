document.addEventListener('DOMContentLoaded', () => {
  const {
    WATCH_STATUS_VALUES,
    normalizeWatchProgress,
    shouldActivateCardFromTarget,
    updateWatchlistState
  } = window.AnimeHubWatchlistUtils;

  // Use relative URL so it works regardless of host/port
  const baseURL = '/api';
  const readingUtils = window.AnimeHubReadingListUtils;
  let readingStore = null;
  let readingList = [];
  let readingListLoad = null;
  const readingView = { status: 'all', type: 'all', sort: 'updated' };
  let syncingReadingUI = false;
  let writingReadingList = false;
  let pendingReadingStorageRefresh = false;

  function acquireReadingStore() {
    readingStore = null;
    if (!readingUtils?.createReadingListStore) {
      return { ok: false, code: 'UNAVAILABLE', message: 'Reading-list utilities are unavailable. Reload this page to try again.', recoveryRequired: false };
    }
    try {
      // Accessing the property itself can throw when browser storage is blocked.
      readingStore = readingUtils.createReadingListStore(window.localStorage);
      return { ok: true };
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'Browser storage is unavailable. Allow local storage, then retry your reading list.', recoveryRequired: true };
    }
  }

  function readingEntryForComic(item, category = item?.category) {
    if (!readingUtils || !item || !['manga', 'manhwa', 'manhua'].includes(category)) return null;
    try {
      return readingUtils.normalizeReadingEntry({
        provider: 'anilist',
        providerId: item.providerId ?? item.id,
        contentType: category,
        title: comicTitle(item),
        poster: item.poster || item.image || item.coverImage?.extraLarge || item.coverImage?.large || '',
        readingStatus: 'plan_to_read',
        currentChapter: 0,
        totalChapters: comicChapterTotal(item)
      });
    } catch {
      return null;
    }
  }

  function readingKeyForComic(item, category = item?.category) {
    const entry = readingEntryForComic(item, category);
    return entry ? readingUtils.readingEntryKey(entry) : null;
  }

  function loadReadingList() {
    const acquired = acquireReadingStore();
    readingListLoad = acquired.ok ? readingStore.load() : acquired;
    // A failed read never replaces an existing in-memory snapshot or writes over
    // malformed/unsupported storage. Recovery is an explicit retry or clear.
    if (readingListLoad.ok) readingList = readingListLoad.value.entries;
    return readingListLoad;
  }

  function mutateReadingList(method, ...args) {
    if (writingReadingList) return { ok: false, message: 'A reading-list update is already in progress.' };
    writingReadingList = true;
    try {
      if (!readingStore) {
        const acquired = acquireReadingStore();
        if (!acquired.ok) {
          readingListLoad = acquired;
          return acquired;
        }
      }
      if (method !== 'clearReadingList') {
        // Re-read before writing so another tab's newer metadata/status is not
        // accidentally overwritten by this adapter's earlier snapshot.
        const loaded = readingStore.load();
        readingListLoad = loaded;
        if (!loaded.ok) return loaded;
        readingList = loaded.value.entries;
      }
      const result = readingStore[method](...args);
      if (result.ok) {
        readingList = result.value.entries;
        readingListLoad = { ok: true, value: result.value };
        pendingReadingStorageRefresh = false;
      }
      return result;
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'Could not update the reading list. Your saved data was kept; retry when browser storage is available.' };
    } finally {
      writingReadingList = false;
    }
  }

  loadReadingList();

  // Browser requests must have an upper bound so a stalled network cannot
  // leave skeletons or loading labels on screen forever. Values can be
  // shortened by deterministic browser tests through the init-script override;
  // production uses these conservative defaults.
  const REQUEST_TIMEOUTS = {
    siteConfig: 5000,
    suggestions: 6000,
    search: 12000,
    catalog: 12000,
    detail: 15000
  };

  function requestTimeout(name) {
    const override = window.__ANIME_HUB_REQUEST_TIMEOUTS?.[name];
    return Number.isFinite(override) && override > 0 ? override : REQUEST_TIMEOUTS[name];
  }

  function classifyRequestError(error, timedOut = false) {
    if (timedOut) return { kind: 'timeout', error };
    if (error?.name === 'AbortError') return { kind: 'cancelled', error };
    if (error?.name === 'TimeoutError') return { kind: 'timeout', error };
    if (error instanceof SyntaxError) return { kind: 'parse', error };
    if (error?.status >= 400) return { kind: 'http', error };
    return { kind: 'network', error };
  }

  async function fetchWithPolicy(url, options = {}, policy = {}) {
    const timeoutMs = policy.timeoutMs || requestTimeout(policy.timeout || 'catalog');
    const retries = Number.isInteger(policy.retries) ? Math.max(0, policy.retries) : 0;
    const method = String(options.method || 'GET').toUpperCase();
    const retryableMethod = method === 'GET' || method === 'HEAD';
    const callerSignal = options.signal;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (callerSignal?.aborted) {
        const error = new DOMException('The request was cancelled.', 'AbortError');
        error.kind = 'cancelled';
        throw error;
      }
      const controller = new AbortController();
      let timedOut = false;
      let handedOffResponse = false;
      const onCallerAbort = () => controller.abort();
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) {
          const error = new Error(`Request failed with status ${response.status}.`);
          error.status = response.status;
          throw error;
        }
        // fetch() resolves at headers, but every caller reads the payload after
        // that point. Keep this attempt's deadline alive until the body helper
        // settles; otherwise a server that sends headers and stalls forever in
        // response.json() bypasses the policy entirely.
        const bodyMethods = ['arrayBuffer', 'blob', 'formData', 'json', 'text'];
        let wrappedBodyMethod = false;
        bodyMethods.forEach(method => {
          if (typeof response[method] !== 'function') return;
          wrappedBodyMethod = true;
          const readBody = response[method].bind(response);
          response[method] = (...args) => Promise.resolve()
            .then(() => readBody(...args))
            .catch(bodyError => {
              const classified = classifyRequestError(bodyError, timedOut && !callerSignal?.aborted);
              bodyError.kind = classified.kind;
              throw bodyError;
            })
            .finally(() => {
              clearTimeout(timer);
              callerSignal?.removeEventListener('abort', onCallerAbort);
            });
        });
        // Keep lightweight response mocks (or unusual response-like objects)
        // from retaining a timer forever when they expose no body helper.
        if (!wrappedBodyMethod) {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
        }
        handedOffResponse = true;
        return response;
      } catch (error) {
        const classified = classifyRequestError(error, timedOut && !callerSignal?.aborted);
        const canRetry = retryableMethod && attempt < retries && ['timeout', 'network'].includes(classified.kind);
        if (!canRetry) {
          classified.error.kind = classified.kind;
          throw classified.error;
        }
      } finally {
        if (!handedOffResponse) {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
        }
      }

      if (callerSignal?.aborted) {
        const error = new DOMException('The request was cancelled.', 'AbortError');
        error.kind = 'cancelled';
        throw error;
      }
      const delay = Math.min(1000, 150 * (2 ** attempt) + Math.floor(Math.random() * 100));
      await new Promise((resolve, reject) => {
        let retryTimer;
        const cancelRetry = () => {
          clearTimeout(retryTimer);
          callerSignal?.removeEventListener('abort', cancelRetry);
          const error = new DOMException('The request was cancelled.', 'AbortError');
          error.kind = 'cancelled';
          reject(error);
        };
        retryTimer = setTimeout(() => {
          callerSignal?.removeEventListener('abort', cancelRetry);
          resolve();
        }, delay);
        callerSignal?.addEventListener('abort', cancelRetry, { once: true });
      });
    }
    throw new Error('Max retries exceeded');
  }

  // Default SEO Metadata
  const siteOrigin = new URL(
    document.querySelector('meta[property="og:url"]')?.content || window.location.origin
  ).origin;
  const DEFAULT_SEO = {
    title: 'AnimeHub — Discover Anime & Movies Catalog',
    description: 'AnimeHub is a modern anime and movie discovery catalog. Explore ratings, genres, release schedules, manage your personal watchlist, and find official trailers and legal streaming options.',
    image: `${siteOrigin}/social-preview.jpg`,
    url: `${siteOrigin}/`
  };

  // JustWatch availability links follow the region configured on the server
  // (JUSTWATCH_REGION), so operators can point visitors at their own catalog.
  // It defaults to "us" until (or unless) the setting loads.
  let justWatchRegion = 'us';
  fetchWithPolicy(`${baseURL}/site-config`, {}, { timeout: 'siteConfig', retries: 1 })
    .then(response => response.json())
    .then(config => {
      if (typeof config?.justWatchRegion === 'string' && /^[a-z]{2,3}(?:-[a-z]{2,3})?$/i.test(config.justWatchRegion)) {
        justWatchRegion = config.justWatchRegion.toLowerCase();
      }
    })
    .catch(() => {});

  /**
   * Dynamically update document title, meta description, Open Graph,
   * Twitter Card metadata, and Schema.org structured data.
   */
  function updatePageSeo({ title, description, image, url, schema } = {}) {
    document.title = title || DEFAULT_SEO.title;

    const desc = description || DEFAULT_SEO.description;
    const img = image || DEFAULT_SEO.image;
    const pageUrl = url || window.location.pathname + window.location.search;
    const absolutePageUrl = new URL(pageUrl, siteOrigin).href;
    const absoluteImageUrl = new URL(img, siteOrigin).href;

    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', desc);

    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', document.title);

    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute('content', desc);

    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute('content', absolutePageUrl);

    const ogImg = document.querySelector('meta[property="og:image"]');
    if (ogImg) ogImg.setAttribute('content', absoluteImageUrl);

    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', absolutePageUrl);

    const twTitle = document.querySelector('meta[name="twitter:title"]');
    if (twTitle) twTitle.setAttribute('content', document.title);

    const twDesc = document.querySelector('meta[name="twitter:description"]');
    if (twDesc) twDesc.setAttribute('content', desc);

    const twImg = document.querySelector('meta[name="twitter:image"]');
    if (twImg) twImg.setAttribute('content', absoluteImageUrl);

    // Update dynamic detail schema
    let dynamicSchemaEl = document.getElementById('dynamic-page-schema');
    if (schema) {
      if (!dynamicSchemaEl) {
        dynamicSchemaEl = document.createElement('script');
        dynamicSchemaEl.id = 'dynamic-page-schema';
        dynamicSchemaEl.type = 'application/ld+json';
        document.head.appendChild(dynamicSchemaEl);
      }
      dynamicSchemaEl.textContent = JSON.stringify(schema, null, 2);
    } else if (dynamicSchemaEl) {
      dynamicSchemaEl.remove();
    }
  }

  // XSS protection: escape text before inserting into innerHTML
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getAnimeTitle(anime) {
    return anime.title?.english ||
      anime.title?.romaji ||
      anime.title?.native ||
      (typeof anime.title === 'string' ? anime.title : 'Unknown Anime');
  }

  // AniList format values, normalized so a card can be classified even when a
  // payload carries either the catalog `type` or the raw AniList `format`.
  function animeTypeValue(anime) {
    return String(anime?.type || anime?.format || '').toUpperCase();
  }

  function isMovieEntry(anime) {
    return animeTypeValue(anime) === 'MOVIE';
  }

  function isSeriesEntry(anime) {
    return ['TV', 'TV_SHORT'].includes(animeTypeValue(anime));
  }

  function safeImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return 'https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';
    }
    try {
      const url = new URL(value, window.location.origin);
      if (url.protocol === 'https:') return url.href;
    } catch {
      // Use the placeholder below when metadata contains an invalid image URL.
    }
    return 'https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';
  }

  // Local Watchlist state (persisted in localStorage)
  function loadLocalWatchlist() {
    try {
      const parsed = JSON.parse(localStorage.getItem('anime_hub_watchlist') || '[]');
      if (Array.isArray(parsed)) return parsed;
      console.error('Saved local watchlist must be an array.');
    } catch (error) {
      console.error('Could not load the saved local watchlist:', error);
    }
    return [];
  }

  let watchlist = loadLocalWatchlist();
  let watchlistAuthRequestId = 0;

  // Notification state (in-app, ephemeral — not persisted across reloads).
  // Covers watchlist updates and new-episode alerts so the user always has a
  // single place to check what changed since their last visit.
  let notifications = [];
  let notificationId = 0;
  const MAX_NOTIFICATIONS = 50;

  function addNotification({ type = 'info', title, message, data = {} } = {}) {
    const notification = {
      id: ++notificationId,
      type,
      title: title || '',
      message: message || '',
      data,
      read: false,
      createdAt: Date.now()
    };
    notifications.unshift(notification);
    if (notifications.length > MAX_NOTIFICATIONS) notifications.pop();
    updateNotificationBadge();
    if (document.getElementById('notifications-list')) renderNotifications();
    return notification;
  }

  function markNotificationRead(id) {
    const notification = notifications.find(n => n.id === id);
    if (notification) notification.read = true;
    updateNotificationBadge();
    if (document.getElementById('notifications-list')) renderNotifications();
  }

  function updateNotificationBadge() {
    const badge = document.getElementById('notification-badge');
    if (!badge) return;
    const unread = notifications.filter(n => !n.read).length;
    if (unread > 0) {
      badge.hidden = false;
      badge.textContent = String(unread);
    } else {
      badge.hidden = true;
    }
  }

  function renderNotifications() {
    const list = document.getElementById('notifications-list');
    const empty = document.getElementById('notifications-empty');
    if (!list) return;
    if (notifications.length === 0) {
      if (empty) empty.hidden = false;
      list.replaceChildren();
      return;
    }
    if (empty) empty.hidden = true;
    list.replaceChildren(
      ...notifications.map(notification => {
        const item = document.createElement('div');
        item.className = `notification-item ${notification.read ? 'notification-read' : 'notification-unread'}`;
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `${notification.title}: ${notification.message}`);
        const title = document.createElement('strong');
        title.textContent = notification.title;
        const msg = document.createElement('p');
        msg.textContent = notification.message;
        const time = document.createElement('time');
        time.textContent = new Date(notification.createdAt).toLocaleString();
        const markBtn = document.createElement('button');
        markBtn.type = 'button';
        markBtn.className = 'notification-mark';
        markBtn.textContent = notification.read ? 'Mark unread' : 'Mark read';
        markBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          markNotificationRead(notification.id);
        });
        item.append(title, msg, time, markBtn);
        item.addEventListener('click', () => markNotificationRead(notification.id));
        return item;
      })
    );
  }

  function notifyWatchlistAdded(item) {
    addNotification({
      type: 'success',
      title: 'Added to Watchlist',
      message: getAnimeTitle(item),
      data: { id: String(item.id), type: 'watchlist-add' }
    });
  }

  function notifyWatchlistRemoved(item) {
    addNotification({
      type: 'info',
      title: 'Removed from Watchlist',
      message: getAnimeTitle(item),
      data: { id: String(item.id), type: 'watchlist-remove' }
    });
  }

  function notifyWatchlistUpdated(item, changes) {
    const described = Object.keys(changes)
      .map(key => {
        if (key === 'watchStatus') return `status: ${changes[key]}`;
        if (key === 'currentEpisode') return `episode ${changes[key]}`;
        return `${key}: ${changes[key]}`;
      })
      .join(', ');
    addNotification({
      type: 'info',
      title: 'Watchlist updated',
      message: `${getAnimeTitle(item)} — ${described}`,
      data: { id: String(item.id), type: 'watchlist-update' }
    });
  }

  // Watchlist sort preference and custom tags (client-side, session-only).
  let watchlistSort = 'dateAdded';

  function getWatchlistAuthState() {
    return window.getAnimeHubAuthState?.() || { ready: false, session: null };
  }

  function saveWatchlist() {
    if (getWatchlistAuthState().session) return;
    localStorage.setItem('anime_hub_watchlist', JSON.stringify(watchlist));
  }

  const WATCH_STATUS_LABELS = {
    watching: 'Watching',
    completed: 'Completed',
    plan_to_watch: 'Plan to Watch',
    on_hold: 'On Hold',
    dropped: 'Dropped'
  };
  function withWatchProgress(item) {
    return { ...item, ...normalizeWatchProgress(item) };
  }

  async function toggleWatchlistItem(item) {
    const id = String(item.id);
    const index = watchlist.findIndex(saved => String(saved.id) === id);
    const adding = index < 0;

    if (getWatchlistAuthState().session) {
      if (!window.animeHubCloudWatchlist) throw new Error('Cloud watchlist is unavailable.');
      if (adding) await window.animeHubCloudWatchlist.add(item);
      else await window.animeHubCloudWatchlist.remove(item.id);
    }

    if (adding) watchlist.push(withWatchProgress({ ...item, addedAt: Date.now(), tags: item.tags || [] }));
    else watchlist.splice(index, 1);
    saveWatchlist();
    if (adding) {
      if (typeof notifyWatchlistAdded === 'function') notifyWatchlistAdded(item);
      if (typeof recordWatchlistActivity === 'function') recordWatchlistActivity(item.title, item.poster || item.image, item.watchStatus || 'plan_to_watch');
    } else {
      if (typeof notifyWatchlistRemoved === 'function') notifyWatchlistRemoved(item);
    }
    if (typeof renderContinueWatching === 'function') renderContinueWatching();
    return adding;
  }

  async function updateWatchlistItem(item, changes) {
    const index = watchlist.findIndex(saved => String(saved.id) === String(item.id));
    const result = await updateWatchlistState({
      watchlist,
      index,
      changes,
      hasSession: !!getWatchlistAuthState().session,
      cloudUpdate: async (id, next) => {
        if (!window.animeHubCloudWatchlist?.update) throw new Error('Cloud watchlist is unavailable.');
        await window.animeHubCloudWatchlist.update(id, next);
      },
      save: saveWatchlist
    });
    if (typeof renderContinueWatching === 'function') renderContinueWatching();
    if (typeof notifyWatchlistUpdated === 'function') notifyWatchlistUpdated(item, changes);
    return result;
  }

  window.addEventListener('animehub:toast', event => {
    if (event.detail?.message) showToast(event.detail.message, event.detail.type || 'info');
  });

  function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.className = `toast show ${type}`;
    // Use DOM nodes — never inject message into innerHTML
    toast.textContent = '';
    const iconSpan = document.createElement('span');
    iconSpan.textContent = type === 'success' ? '✓' : 'ℹ';
    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(iconSpan);
    toast.appendChild(msgSpan);
    setTimeout(() => {
      toast.className = 'toast';
    }, 3000);
  }

  // ============================================================
  // RENDER ANIME CARD
  // ============================================================

  // CSP: handlers are delegated (no inline event attributes), so the server can
  // ship a script-src without 'unsafe-inline'.
  function applyImageFallback(image) {
    if (image.dataset.fallbackBound === 'true') return;
    image.dataset.fallbackBound = 'true';
    image.addEventListener('error', () => {
      const fallbackSrc = image.dataset.fallbackSrc;
      const resolvedFallbackSrc = fallbackSrc ? new URL(fallbackSrc, document.baseURI).href : '';
      if (
        resolvedFallbackSrc &&
        image.src !== resolvedFallbackSrc &&
        image.dataset.fallbackApplied !== 'true'
      ) {
        image.dataset.fallbackApplied = 'true';
        image.addEventListener('error', () => {
          image.hidden = true;
        }, { once: true });
        image.src = fallbackSrc;
        return;
      }
      image.hidden = true;
    }, { once: true });
  }

  const POSTER_FALLBACK = 'https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';
  const BANNER_FALLBACK = 'https://placehold.co/1920x420/0b0e14/2d3748?text=Anime+Hub';

  function renderWatchProgressControls(anime, { compact = false } = {}) {
    const progress = normalizeWatchProgress(anime);
    const id = escapeHtml(String(anime.id));
    const isMovie = isMovieEntry(anime);
    const totalEpisodes = progress.totalEpisodes;
    const totalLabel = totalEpisodes === null ? 'episodes' : `of ${totalEpisodes}`;

    const statusOptions = WATCH_STATUS_VALUES.map(value =>
      `<option value="${value}" ${value === progress.watchStatus ? 'selected' : ''}>${WATCH_STATUS_LABELS[value]}</option>`
    ).join('');

    // For movies, only show status selector - no episode controls or progress summary
    if (isMovie) {
      return `
        <div class="watch-progress-controls${compact ? ' compact' : ''}" data-watch-controls data-watch-id="${escapeHtml(String(anime.id))}">
          <label>
            <span>Status</span>
            <select data-watch-status aria-label="Watch status for ${escapeHtml(getAnimeTitle(anime))}">${statusOptions}</select>
          </label>
        </div>
      `;
    }

    // For series, show full episode controls
    let episodeControl;
    if (progress.totalEpisodes !== null && progress.totalEpisodes > 0) {
      const episodeOptions = Array.from({ length: progress.totalEpisodes + 1 }, (_, i) => i)
        .map(ep => `<option value="${ep}" ${ep === progress.currentEpisode ? 'selected' : ''}>${ep === 0 ? 'Not started' : `Episode ${ep}`}</option>`)
        .join('');
      episodeControl = `
        <div class="episode-selector" data-episode-selector data-watch-id="${id}">
          <label>
            <span>Episode</span>
            <div class="episode-selector-wrapper">
              <select data-watch-episode aria-label="Episode for ${escapeHtml(getAnimeTitle(anime))}">${episodeOptions}</select>
              <button type="button" class="episode-selector-search" aria-label="Search episodes" title="Search episodes">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
              </button>
            </div>
          </label>
        `;
    } else {
      episodeControl = `
        <label>
          <span>Episode</span>
          <input data-watch-episode type="number" min="0" value="${progress.currentEpisode}" inputmode="numeric" aria-label="Current episode for ${escapeHtml(getAnimeTitle(anime))}" placeholder="Episode number">
        </label>
      `;
    }
    return `
      <div class="watch-progress-controls${compact ? ' compact' : ''}" data-watch-controls data-watch-id="${escapeHtml(String(anime.id))}">
        <label>
          <span>Status</span>
          <select data-watch-status aria-label="Watch status for ${escapeHtml(getAnimeTitle(anime))}">${statusOptions}</select>
        </label>
        ${episodeControl}
        <span class="watch-progress-summary">${progress.currentEpisode} ${totalLabel}</span>
      </div>
    `;
  }

  // Bind the fallback for every image the app renders (cards, detail views,
  // recommendations) without inline event attributes, keeping the CSP
  // free of 'unsafe-inline' for scripts.
  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.('img[data-fallback-src]')) applyImageFallback(node);
        node.querySelectorAll?.('img[data-fallback-src]').forEach(applyImageFallback);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  function renderAnimeCard(anime, containerId = '') {
    if (COMIC_KINDS.includes(anime.category || anime.contentType)) {
      return renderComicCard(anime, containerId);
    }
    const rating =
      typeof anime.rating === 'number'
        ? anime.rating
        : anime.averageScore
          ? (anime.averageScore / 10)
          : 0;

    const rawTitle = getAnimeTitle(anime);
    const safeTitle = escapeHtml(rawTitle);

    const poster = safeImageUrl(
      anime.poster ||
      anime.image ||
      anime.coverImage?.extraLarge ||
      anime.coverImage?.large ||
      anime.coverImage ||
      'https://placehold.co/300x450/0f172a/ff7200?text=No+Poster'
    );

    const status = escapeHtml(anime.status || 'Unknown');
    const isCompleted = status.toLowerCase() === 'completed' || status.toLowerCase() === 'finished';
    const type = escapeHtml(anime.type || anime.format || 'TV');
    const episodesText = Number(anime.episodes) > 0 ? `${Number(anime.episodes)} eps` : null;
    const id = anime.anilistId || anime.id;
    const isSaved = watchlist.some(w => String(w.id) === String(id));
    const metaText = `${type}${episodesText ? ` • ${episodesText}` : ''}`;
    const cardId = escapeHtml(String(id));
    const watchProgressHtml = containerId === 'watchlist-grid'
      ? renderWatchProgressControls({ ...anime, id: id }, { compact: true })
      : '';

    return `
      <article class="anime-card" data-id="${cardId}"${anime.category ? ` data-category="${escapeHtml(anime.category)}"` : ''} tabindex="0" role="button" aria-label="View details for ${safeTitle}">

        <div class="card-image-wrapper">

          <img
            class="card-image"
            src="${escapeHtml(poster)}"
            alt="${safeTitle} poster"
            loading="lazy"
            data-fallback-src="${POSTER_FALLBACK}"
          >

          <div class="card-overlay">
            <div class="play-btn" aria-hidden="true" title="View details">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="9"/>
                <path d="M11 10h2v7h-2zm0-4h2v2h-2z" fill="var(--bg)"/>
              </svg>
            </div>

            <button type="button" class="card-watchlist-btn ${isSaved ? 'saved' : ''}" data-bookmark-id="${cardId}" data-type="${escapeHtml(animeTypeValue(anime))}" data-episodes="${anime.episodes || 0}" title="${isSaved ? 'Remove from Watchlist' : 'Add to Watchlist'}" aria-label="${isSaved ? 'Remove from Watchlist' : 'Add to Watchlist'}">
              ${isSaved ? '★' : '☆'}
            </button>

            <span class="card-badge ${isCompleted ? 'completed' : ''}">
              ${status}
            </span>
          </div>

        </div>

        <div class="card-info">
          <h3 class="card-title" title="${safeTitle}">
            ${safeTitle}
          </h3>
          ${anime.relationType ? `<span class="detail-relation-label">${escapeHtml(anime.relationType)}</span>` : ''}

          <div class="card-meta">
            <span class="card-type">${metaText}</span>
            <div class="card-rating">
              <span class="star">★</span>
              <span>${rating > 0 ? rating.toFixed(1) : 'N/A'}</span>
            </div>
          </div>
          ${watchProgressHtml}
        </div>

      </article>
    `;
  }

  // ============================================================
  // RENDER ANIME GRID & SKELETONS
  // ============================================================

  function renderSkeletonGrid(containerId, count = 10) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = Array(count).fill(0).map(() => `
      <div class="skeleton-card">
        <div class="skeleton skeleton-img"></div>
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-meta"></div>
      </div>
    `).join('');
  }

  function renderAnimeGrid(animes, containerId) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.removeAttribute('aria-busy');

    if (!Array.isArray(animes) || animes.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
          No anime items found in this section.
        </div>
      `;
      return;
    }

    grid.innerHTML = animes.map(anime => renderAnimeCard(anime, containerId)).join('');
  }

  function renderCatalogLoadError(containerId, message, retry) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.removeAttribute('aria-busy');
    const state = document.createElement('div');
    state.className = 'catalog-load-error';
    state.setAttribute('role', 'alert');
    state.style.gridColumn = '1 / -1';
    const text = document.createElement('p');
    text.textContent = message;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cta-btn secondary-btn';
    button.textContent = 'Try again';
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Retrying…';
      void retry();
    });
    state.append(text, button);
    grid.replaceChildren(state);
    grid.style.display = 'grid';
  }

  // Page size and totals are reported by the server (headers); the client never
  // guesses them from how full a page happens to look. The grid accumulates
  // pages from /api/browse: `catalogPage` is the highest page rendered, and
  // the seen-id set guarantees a title can never appear twice across pages.
  let catalogPage = 1;
  let catalogHasNext = false;
  let catalogTotal = null;
  let catalogShown = 0;
  let catalogLoading = false;
  const catalogSeenIds = new Set();

  function setSelectOptions(select, values, allLabel, ignoreCase = false) {
    if (!select) return;
    const previousValue = select.value;
    const uniqueValues = new Map();
    values.filter(Boolean).forEach(value => {
      const key = ignoreCase ? String(value).toLowerCase() : String(value);
      if (!uniqueValues.has(key)) uniqueValues.set(key, value);
    });
    const options = [...uniqueValues.values()].sort((a, b) => {
      const aYear = Number(a);
      const bYear = Number(b);
      return Number.isNaN(aYear) || Number.isNaN(bYear)
        ? String(a).localeCompare(String(b))
        : bYear - aYear;
    });
    select.innerHTML = `<option value="">${allLabel}</option>${options.map(value =>
      `<option value="${escapeHtml(String(value))}">${escapeHtml(String(value))}</option>`
    ).join('')}`;
    if (options.some(value => String(value) === previousValue)) select.value = previousValue;
  }

  // ============================================================
  // ADVANCED CATALOG FILTERS (server-driven, reflected in the URL)
  // ============================================================
  //
  // The Popular page owns the advanced filters. Every value is validated again
  // by the server (/api/browse); the client only mirrors its own state into the
  // query string, so a refresh or a shared link restores the same view and
  // Back/Forward re-applies it through initPage(). Results load one page at a
  // time and the Load more button appends the next page.

  const CATALOG_SORT_VALUES = ['popularity', 'score', 'newest', 'title'];
  // Form values are friendly lowercase keys; the URL and /api/browse speak the
  // AniList enum spellings, so every sort passes through this map (and back).
  const CATALOG_SORT_ENUMS = {
    popularity: 'POPULARITY_DESC',
    score: 'SCORE_DESC',
    newest: 'START_DATE_DESC',
    title: 'TITLE_ROMAJI'
  };
  const CATALOG_SEASON_VALUES = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  // The Popular page offers exactly the /api/browse allowlists, so a valid
  // form can never produce a 400.
  const CATALOG_FORMAT_VALUES = ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'];
  const CATALOG_STATUS_VALUES = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED'];
  const CATALOG_SCORE_VALUES = ['70', '80', '90'];
  const CATALOG_BROWSE_PER_PAGE = 30;
  let catalogRequestId = 0;

  /** Read the current filter controls into a plain object. */
  function catalogFormValues() {
    const genreSelect = document.getElementById('filter-genre');
    const genres = genreSelect
      ? Array.from(genreSelect.selectedOptions).map(option => option.value).filter(Boolean)
      : [];
    return {
      genre: genres,
      year: (document.getElementById('filter-year')?.value || '').trim(),
      season: document.getElementById('filter-season')?.value || '',
      format: document.getElementById('filter-format')?.value || '',
      status: document.getElementById('filter-status')?.value || '',
      minScore: document.getElementById('filter-score')?.value || '',
      sort: document.getElementById('filter-sort')?.value || 'popularity'
    };
  }

  /** Append the active filters (in /api/browse vocabulary) to any params. */
  function appendFilterParams(params, values) {
    if (values.genre.length) params.set('genre', values.genre.join(','));
    if (values.year) params.set('year', values.year);
    if (values.season) params.set('season', values.season);
    if (values.format) params.set('format', values.format);
    if (values.status) params.set('status', values.status);
    if (values.minScore) params.set('minScore', values.minScore);
    // The sort is written as the browse enum so a shared link reads exactly
    // like the API contract; legacy `sort=score` links still rehydrate. The
    // default (popularity) stays out of the URL, as before.
    if (values.sort && values.sort !== 'popularity' && CATALOG_SORT_ENUMS[values.sort]) {
      params.set('sort', CATALOG_SORT_ENUMS[values.sort]);
    }
    return params;
  }

  /** Mirror the filter state into the shareable page URL. */
  function buildCatalogParams(values) {
    const params = new URLSearchParams();
    params.set('page', 'popular');
    return appendFilterParams(params, values);
  }

  /**
   * Build the /api/browse query. The SPA's `page=popular` route marker never
   * reaches the API — browse validates `page` as 1..50 and would reject it.
   */
  function buildBrowseParams(values, page) {
    const params = appendFilterParams(new URLSearchParams(), values);
    params.set('page', String(page));
    params.set('perPage', String(CATALOG_BROWSE_PER_PAGE));
    return params;
  }

  /** Rehydrate the filter controls from the URL. Unknown values are ignored. */
  function applyCatalogFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);

    const genreSelect = document.getElementById('filter-genre');
    if (genreSelect) {
      const wanted = (params.get('genre') || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
      Array.from(genreSelect.options).forEach(option => {
        option.selected = wanted.includes(option.value.toLowerCase());
      });
    }

    const setEnumValue = (id, allowed) => {
      const element = document.getElementById(id);
      if (!element) return;
      const key = id.replace('filter-', '');
      const raw = (params.get(key) || '').toUpperCase().replace(/[\s-]+/g, '_');
      element.value = allowed.includes(raw) ? raw : '';
    };
    setEnumValue('filter-season', CATALOG_SEASON_VALUES);
    setEnumValue('filter-format', CATALOG_FORMAT_VALUES);
    setEnumValue('filter-status', CATALOG_STATUS_VALUES);

    const yearElement = document.getElementById('filter-year');
    if (yearElement) {
      // Mirror the server's 1960..current+1 range so a hand-edited URL is
      // ignored instead of triggering a 400 round-trip.
      const year = params.get('year') || '';
      const parsedYear = /^\d{4}$/.test(year) ? Number(year) : 0;
      const maxYear = new Date().getFullYear() + 1;
      yearElement.value = parsedYear >= 1960 && parsedYear <= maxYear ? year : '';
    }
    const scoreElement = document.getElementById('filter-score');
    if (scoreElement) {
      scoreElement.value = CATALOG_SCORE_VALUES.includes(params.get('minScore') || '')
        ? params.get('minScore')
        : '';
    }
    const sortElement = document.getElementById('filter-sort');
    if (sortElement) {
      // Read both spellings: browse enums (`SCORE_DESC`) in new links and the
      // legacy friendly keys (`score`) in links shared before Task 2A.
      const rawSort = (params.get('sort') || '').toUpperCase();
      const fromEnum = Object.keys(CATALOG_SORT_ENUMS)
        .find(key => CATALOG_SORT_ENUMS[key] === rawSort);
      const fromLegacy = CATALOG_SORT_VALUES.includes(rawSort.toLowerCase())
        ? rawSort.toLowerCase()
        : '';
      sortElement.value = fromEnum || fromLegacy || 'popularity';
    }
  }

  /** Populate the genre multi-select from the server's genre list. */
  async function loadCatalogGenreOptions() {
    const genreSelect = document.getElementById('filter-genre');
    // A completed load is never repeated; a failed one retries on the next
    // visit instead of leaving the dropdown silently empty forever. The flag
    // — not the option count — records success, so a failure placeholder can
    // never block the retry.
    if (!genreSelect || genreSelect.dataset.genresLoaded === 'true') return;
    try {
      const res = await fetchWithPolicy(`${baseURL}/genres`, {}, { timeout: 'catalog', retries: 1 });
      if (!res.ok) throw new Error(`Genres request failed: ${res.status}`);
      const genres = await res.json();
      genreSelect.innerHTML = (Array.isArray(genres) ? genres : [])
        .map(genre => `<option value="${escapeHtml(String(genre))}">${escapeHtml(String(genre))}</option>`)
        .join('');
      genreSelect.dataset.genresLoaded = 'true';
    } catch (error) {
      console.error('Could not load the genre list:', error);
      // The dropdown must never fail silently: say what happened, keep the
      // control honest (a disabled placeholder, not a dead empty box), and
      // let the next page visit retry.
      genreSelect.innerHTML = '<option value="" disabled>Genre list unavailable</option>';
      showToast('Could not load the genre list. Genre chips still work.', 'error');
    }
  }

  /**
   * Fetch page 1 of the filtered catalog from /api/browse and render it. The
   * URL always mirrors the current filter state; `push` records a history
   * entry for a user-initiated change so Back restores the previous filters,
   * while `replace` (used when rehydrating from the URL) keeps the history
   * clean. Any pages accumulated by Load more are cleared first.
   */
  async function refreshCatalogPage(historyMode = 'replace', allowReset = true) {
    const grid = document.getElementById('popular-page-grid');
    if (!grid) return;

    const requestId = ++catalogRequestId;
    const values = catalogFormValues();
    const nextUrl = `?${buildCatalogParams(values).toString()}`;
    if (window.location.search !== nextUrl) {
      window.history[historyMode === 'push' ? 'pushState' : 'replaceState']({}, '', nextUrl);
    }

    catalogPage = 1;
    catalogHasNext = false;
    catalogTotal = null;
    catalogShown = 0;
    catalogSeenIds.clear();

    renderSkeletonGrid('popular-page-grid', 12);
    const count = document.getElementById('catalog-result-count');
    if (count) count.textContent = 'Loading catalog…';
    setLoadMoreVisible(false);

    try {
      const res = await fetchWithPolicy(`${baseURL}/browse?${buildBrowseParams(values, 1).toString()}`, {}, { timeout: 'catalog', retries: 0 });
      if (requestId !== catalogRequestId) return;
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const error = new Error(payload?.message || 'Catalog request failed.');
        error.status = res.status;
        throw error;
      }
      const items = await res.json();
      if (requestId !== catalogRequestId) return;

      const list = (Array.isArray(items) ? items : []).filter(anime => !catalogSeenIds.has(anime.id));
      list.forEach(anime => catalogSeenIds.add(anime.id));

      // Pagination metadata comes from the server (AniList pageInfo), so a
      // partial page is never mistaken for the last page.
      catalogHasNext = res.headers.get('x-catalog-has-next') === 'true';
      const parsedTotal = Number.parseInt(res.headers.get('x-catalog-total') || '', 10);
      catalogTotal = Number.isInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
      catalogShown = list.length;

      renderAnimeGrid(list, 'popular-page-grid');
      updateCatalogCount();
      setLoadMoreVisible(catalogHasNext);

      const selectedGenres = values.genre.map(value => value.toLowerCase());
      document.querySelectorAll('#popular-genre-filter .genre-btn').forEach(button => {
        const genre = button.dataset.genre;
        const selected = genre === 'All'
          ? selectedGenres.length === 0
          : selectedGenres.includes(genre.toLowerCase());
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    } catch (error) {
      if (requestId !== catalogRequestId) return;
      console.error('Error loading the filtered catalog:', error);
      // A 400 means the client sent something the server rejected: clear the
      // filters and rebuild the URL so the page recovers instead of sticking.
      if (error.status === 400 && allowReset) {
        // Recover once: clear the rejected filters and rebuild the URL. The
        // guard stops a rejected request from retrying itself forever.
        showToast('Those filters were not valid, so they were cleared.', 'error');
        document.getElementById('catalog-filter-form')?.reset();
        await refreshCatalogPage('replace', false);
        return;
      }
      if (error.status === 400) {
        if (count) count.textContent = 'Those filters are not valid.';
        return;
      }
      renderCatalogLoadError('popular-page-grid', 'Unable to load the catalog. Check your connection and try again.', () => refreshCatalogPage('replace', true));
      if (count) count.textContent = '';
    }
  }

  /** Refresh the result counter under the filter form. */
  function updateCatalogCount() {
    const count = document.getElementById('catalog-result-count');
    if (!count) return;
    if (!catalogShown) {
      count.textContent = 'No titles match these filters';
      return;
    }
    count.textContent = catalogTotal !== null
      ? `Showing ${catalogShown} of ${catalogTotal} titles`
      : `Showing ${catalogShown} titles`;
  }

  /** Show or hide the Load more control under the grid. */
  function setLoadMoreVisible(visible) {
    const wrap = document.getElementById('catalog-load-more');
    if (wrap) wrap.hidden = !visible;
  }

  /**
   * Fetch the next /api/browse page and append it to the grid. Titles already
   * rendered are skipped, so a shifting result set can never show a duplicate,
   * and a filter change mid-flight discards the stale page.
   */
  async function loadMoreCatalog() {
    if (catalogLoading || !catalogHasNext) return;
    const requestId = catalogRequestId;
    const nextPage = catalogPage + 1;
    const values = catalogFormValues();

    catalogLoading = true;
    const button = document.getElementById('catalog-load-more-btn');
    if (button) {
      button.disabled = true;
      button.textContent = 'Loading…';
    }

    try {
      const res = await fetchWithPolicy(`${baseURL}/browse?${buildBrowseParams(values, nextPage).toString()}`, {}, { timeout: 'catalog', retries: 1 });
      if (requestId !== catalogRequestId) return;
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const error = new Error(payload?.message || 'Catalog request failed.');
        error.status = res.status;
        throw error;
      }
      const items = await res.json();
      if (requestId !== catalogRequestId) return;

      const fresh = (Array.isArray(items) ? items : []).filter(anime => !catalogSeenIds.has(anime.id));
      fresh.forEach(anime => catalogSeenIds.add(anime.id));
      catalogPage = nextPage;
      catalogShown += fresh.length;
      catalogHasNext = res.headers.get('x-catalog-has-next') === 'true';

      if (fresh.length) {
        document.getElementById('popular-page-grid')
          ?.insertAdjacentHTML('beforeend', fresh.map(renderAnimeCard).join(''));
      }
      updateCatalogCount();
      setLoadMoreVisible(catalogHasNext);
    } catch (error) {
      if (requestId !== catalogRequestId) return;
      // Keep what is already rendered; the button stays available to retry.
      console.error('Error loading more catalog titles:', error);
      showToast('Unable to load more titles. Please try again.', 'error');
    } finally {
      catalogLoading = false;
      if (button) {
        button.disabled = false;
        button.textContent = 'Load more';
      }
    }
  }

  // ============================================================
  // LOAD TRENDING
  // ============================================================

  async function loadTrending() {
    renderSkeletonGrid('trending-grid', 5);
    try {
      const res = await fetchWithPolicy(`${baseURL}/trending`, {}, { timeout: 'catalog', retries: 1 });
      if (!res.ok) throw new Error(`Trending request failed: ${res.status}`);
      const data = await res.json();
      recommendationCatalogCache.push(...(Array.isArray(data) ? data : []));
      renderAnimeGrid(data, 'trending-grid');
      if (typeof loadPersonalizedRecommendations === 'function') void loadPersonalizedRecommendations();
    } catch (err) {
      console.error('Error loading trending:', err);
      renderCatalogLoadError('trending-grid', 'Unable to load trending items. Check your connection and try again.', loadTrending);
    }
  }

  // ============================================================
  // LOAD POPULAR
  // ============================================================

  async function loadPopular() {
    renderSkeletonGrid('popular-grid', 10);
    try {
      const res = await fetchWithPolicy(`${baseURL}/popular`, {}, { timeout: 'catalog', retries: 1 });
      if (!res.ok) throw new Error(`Popular request failed: ${res.status}`);
      const data = await res.json();
      // The home page shows a five-title strip; the Popular page's full grid is
      // served by /api/browse through refreshCatalogPage (filters + Load more).
      recommendationCatalogCache.push(...(Array.isArray(data) ? data : []));
      renderAnimeGrid(data.slice(0, 5), 'popular-grid');
      if (typeof loadPersonalizedRecommendations === 'function') void loadPersonalizedRecommendations();
    } catch (err) {
      console.error('Error loading popular:', err);
      renderCatalogLoadError('popular-grid', 'Unable to load popular items. Check your connection and try again.', loadPopular);
    }
  }

  // ============================================================
  // RELEASE CALENDAR
  // ============================================================
  // The calendar deliberately owns an independent browse state. It requests
  // TV entries only, follows the server's pagination headers, and sorts by the
  // actual start date before grouping releases into Monday-Sunday weeks.
  const CALENDAR_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const CALENDAR_PER_PAGE = 30;
  const calendarState = {
    season: '',
    year: 0,
    seasonYear: 0,
    page: 1,
    hasNext: false,
    loading: false,
    items: [],
    requestId: 0
  };

  function calendarSeasonForDate(date = new Date()) {
    const month = date.getMonth() + 1;
    if (month <= 3) return 'WINTER';
    if (month <= 6) return 'SPRING';
    if (month <= 9) return 'SUMMER';
    return 'FALL';
  }

  function calendarYearOptions() {
    const select = document.getElementById('calendar-year');
    if (!select) return;
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: 8 }, (_, index) => currentYear - 3 + index);
    select.innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join('');
  }

  function calendarDateValue(item) {
    const date = item?.startDate;
    if (date && Number.isInteger(date.year) && Number.isInteger(date.month) && Number.isInteger(date.day)) {
      const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
      if (!Number.isNaN(value.getTime())) return value;
    }
    const parsed = Date.parse(item?.releaseDate || item?.airDate || '');
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }

  function calendarDateKey(date) {
    return date ? date.toISOString().slice(0, 10) : 'unknown';
  }

  function mondayForDate(date) {
    const monday = new Date(date);
    const day = monday.getUTCDay() || 7;
    monday.setUTCDate(monday.getUTCDate() - day + 1);
    return monday;
  }

  function calendarDateLabel(date) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function renderReleaseCalendar() {
    const grid = document.getElementById('calendar-grid');
    const empty = document.getElementById('calendar-empty');
    const error = document.getElementById('calendar-error');
    if (!grid || !empty || !error) return;
    const sorted = [...calendarState.items].sort((a, b) => {
      const aDate = calendarDateValue(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bDate = calendarDateValue(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return aDate - bDate || getAnimeTitle(a).localeCompare(getAnimeTitle(b));
    });
    const weeks = new Map();
    sorted.forEach(item => {
      const date = calendarDateValue(item);
      if (!date) return;
      const week = mondayForDate(date);
      const weekKey = calendarDateKey(week);
      if (!weeks.has(weekKey)) weeks.set(weekKey, { start: week, days: new Map() });
      const group = weeks.get(weekKey);
      const dayKey = calendarDateKey(date);
      if (!group.days.has(dayKey)) group.days.set(dayKey, { date, items: [] });
      group.days.get(dayKey).items.push(item);
    });

    const groups = [...weeks.values()].sort((a, b) => a.start - b.start);
    grid.removeAttribute('aria-busy');
    grid.innerHTML = groups.map(group => {
      const sunday = new Date(group.start);
      sunday.setUTCDate(sunday.getUTCDate() + 6);
      const days = Array.from({ length: 7 }, (_, offset) => {
        const date = new Date(group.start);
        date.setUTCDate(date.getUTCDate() + offset);
        const day = group.days.get(calendarDateKey(date));
        const cards = day ? day.items.map(item => renderAnimeCard(item, 'calendar-grid')).join('') : '<p class="calendar-day-empty">No releases</p>';
        return `<section class="calendar-day" aria-labelledby="calendar-day-${calendarDateKey(date)}"><h3 id="calendar-day-${calendarDateKey(date)}"><span>${date.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })}</span><time datetime="${calendarDateKey(date)}">${calendarDateLabel(date)}</time></h3><div class="calendar-day-items">${cards}</div></section>`;
      }).join('');
      return `<section class="calendar-week" aria-labelledby="calendar-week-${calendarDateKey(group.start)}"><h2 id="calendar-week-${calendarDateKey(group.start)}">Week of ${calendarDateLabel(group.start)} – ${calendarDateLabel(sunday)}</h2><div class="calendar-week-days">${days}</div></section>`;
    }).join('');
    empty.hidden = calendarState.items.length > 0;
    if (!calendarState.items.length) grid.replaceChildren();
    const status = document.getElementById('calendar-result-status');
    if (status) status.textContent = calendarState.items.length ? `${calendarState.items.length} upcoming TV release${calendarState.items.length === 1 ? '' : 's'}` : '';
  }

  function setCalendarFormFromState() {
    calendarYearOptions();
    const season = document.getElementById('calendar-season');
    const year = document.getElementById('calendar-year');
    if (season) season.value = CALENDAR_SEASONS.includes(calendarState.season) ? calendarState.season : calendarSeasonForDate();
    if (year) year.value = String(calendarState.year || new Date().getFullYear());
  }

  function applyCalendarFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const rawSeason = (params.get('season') || '').toUpperCase();
    const rawYear = Number(params.get('year'));
    calendarState.season = CALENDAR_SEASONS.includes(rawSeason) ? rawSeason : calendarSeasonForDate();
    calendarState.year = Number.isInteger(rawYear) && rawYear >= 1960 && rawYear <= new Date().getFullYear() + 1 ? rawYear : new Date().getFullYear();
    calendarState.seasonYear = calendarState.year;
    setCalendarFormFromState();
  }

  function syncCalendarUrl(historyMode = 'replace') {
    const params = new URLSearchParams({ page: 'calendar', season: calendarState.season, year: String(calendarState.year) });
    const next = `?${params.toString()}`;
    if (window.location.search !== next) window.history[historyMode === 'push' ? 'pushState' : 'replaceState']({}, '', next);
  }

  async function loadReleaseCalendar({ append = false, historyMode = 'replace' } = {}) {
    const grid = document.getElementById('calendar-grid');
    if (!grid || (append && calendarState.loading)) return;
    if (!append) {
      calendarState.page = 1;
      calendarState.items = [];
      calendarState.hasNext = false;
      syncCalendarUrl(historyMode);
      setCalendarFormFromState();
      renderSkeletonGrid('calendar-grid', 7);
      document.getElementById('calendar-empty').hidden = true;
      document.getElementById('calendar-error').hidden = true;
    }
    const requestId = ++calendarState.requestId;
    const requestPage = append ? calendarState.page + 1 : 1;
    calendarState.loading = true;
    const status = document.getElementById('calendar-result-status');
    if (status) status.textContent = 'Loading upcoming releases…';
    const loadMore = document.getElementById('calendar-load-more-btn');
    if (loadMore) loadMore.disabled = true;
    try {
      // The browse route calls the AniList variable seasonYear `year`; keeping
      // the route query in its public vocabulary also preserves shared links.
      const seasonYear = calendarState.seasonYear || calendarState.year;
      const params = new URLSearchParams({ format: 'TV', season: calendarState.season, seasonYear: String(seasonYear), year: String(seasonYear), page: String(requestPage), perPage: String(CALENDAR_PER_PAGE) });
      const response = await fetchWithPolicy(`${baseURL}/browse?${params.toString()}`, {}, { timeout: 'catalog', retries: 1 });
      if (!response.ok) throw new Error(`Release calendar request failed: ${response.status}`);
      const payload = await response.json();
      if (requestId !== calendarState.requestId) return;
      const existing = new Set(calendarState.items.map(item => String(item.id ?? item.anilistId)));
      const fresh = (Array.isArray(payload) ? payload : []).filter(item => {
        const id = String(item?.id ?? item?.anilistId ?? '');
        if (!id || existing.has(id) || !isSeriesEntry(item)) return false;
        existing.add(id);
        return true;
      });
      calendarState.items = append ? calendarState.items.concat(fresh) : fresh;
      calendarState.page = requestPage;
      calendarState.hasNext = response.headers.get('x-catalog-has-next') === 'true';
      renderReleaseCalendar();
      document.getElementById('calendar-load-more').hidden = !calendarState.hasNext;
    } catch (error) {
      if (requestId !== calendarState.requestId) return;
      console.error('Error loading the release calendar:', error);
      document.getElementById('calendar-grid').replaceChildren();
      document.getElementById('calendar-error').hidden = false;
      document.getElementById('calendar-empty').hidden = true;
      document.getElementById('calendar-load-more').hidden = true;
      if (status) status.textContent = '';
    } finally {
      if (requestId === calendarState.requestId) {
        calendarState.loading = false;
        if (loadMore) loadMore.disabled = false;
      }
    }
  }

  // ============================================================
  // PERSONALIZED RECOMMENDATIONS
  // ============================================================
  function recommendationGenres(item) {
    const values = item?.genres || item?.genre || [];
    return (Array.isArray(values) ? values : [values]).map(value => String(value).trim().toLowerCase()).filter(Boolean);
  }

  function recommendationProfile() {
    const genreWeights = new Map();
    const favorites = [];
    watchlist.forEach(item => {
      const isFavorite = item.favorite === true || item.isFavorite === true || item.favourited === true || item.starred === true;
      recommendationGenres(item).forEach(genre => genreWeights.set(genre, (genreWeights.get(genre) || 0) + (isFavorite ? 3 : 1)));
      if (isFavorite) favorites.push(item);
    });
    return { genreWeights, favorites };
  }

  function scoreRecommendation(item, profile) {
    const savedIds = new Set(watchlist.map(saved => String(saved.id)));
    if (savedIds.has(String(item.id ?? item.anilistId))) return -Infinity;
    const genreScore = recommendationGenres(item).reduce((score, genre) => score + (profile.genreWeights.get(genre) || 0), 0);
    const rating = Number(item.rating ?? (item.averageScore ? item.averageScore / 10 : 0));
    const favoriteBonus = profile.favorites.some(favorite => recommendationGenres(favorite).some(genre => recommendationGenres(item).includes(genre))) ? 2 : 0;
    return genreScore * 10 + favoriteBonus * 10 + (Number.isFinite(rating) ? rating : 0);
  }

  function recommendationFallback(items) {
    const profile = recommendationProfile();
    return (Array.isArray(items) ? items : []).filter(item => !COMIC_KINDS.includes(item?.category || item?.contentType)).map(item => ({ item, score: scoreRecommendation(item, profile) }))
      .filter(result => Number.isFinite(result.score)).sort((a, b) => b.score - a.score || getAnimeTitle(a.item).localeCompare(getAnimeTitle(b.item))).slice(0, 6).map(result => result.item);
  }

  function renderRecommendations(items, targetId, sectionId) {
    const section = document.getElementById(sectionId);
    const grid = document.getElementById(targetId);
    if (!section || !grid) return;
    const recommendations = recommendationFallback(items);
    section.hidden = !recommendations.length;
    grid.innerHTML = recommendations.map(item => renderAnimeCard(item, targetId)).join('');
    const status = document.getElementById(targetId === 'recommendations-grid' ? 'recommendations-status' : 'watchlist-recommendations-status');
    if (status) status.textContent = recommendations.length ? `Showing ${recommendations.length} picks based on your saved genres.` : '';
  }

  async function loadPersonalizedRecommendations(targetId = 'recommendations-grid', sectionId = 'section-recommendations') {
    const grid = document.getElementById(targetId);
    const section = document.getElementById(sectionId);
    if (!grid || !section) return;
    const profile = recommendationProfile();
    if (!watchlist.length) {
      section.hidden = true;
      return;
    }
    grid.setAttribute('aria-busy', 'true');
    renderSkeletonGrid(targetId, 6);
    const status = document.getElementById(targetId === 'recommendations-grid' ? 'recommendations-status' : 'watchlist-recommendations-status');
    if (status) status.textContent = 'Finding titles for you…';
    try {
      const genres = [...profile.genreWeights.keys()].slice(0, 8).join(',');
      const favorites = profile.favorites.map(item => item.id).filter(Boolean).slice(0, 8).join(',');
      const response = await fetchWithPolicy(`${baseURL}/recommendations?genres=${encodeURIComponent(genres)}&favorites=${encodeURIComponent(favorites)}`, {}, { timeout: 'catalog', retries: 0 });
      if (!response.ok) throw new Error(`Recommendations request failed: ${response.status}`);
      const payload = await response.json();
      const remoteItems = Array.isArray(payload) ? payload : payload?.items;
      if (Array.isArray(remoteItems) && remoteItems.length) renderRecommendations(remoteItems, targetId, sectionId);
      else throw new Error('Recommendations endpoint returned no usable titles.');
    } catch (error) {
      // Recommendations are an enhancement. Existing catalog data remains the
      // deterministic fallback when the optional endpoint is not deployed.
      console.warn('Personalized recommendations unavailable; using catalog fallback.', error);
      const candidates = [...new Map([...recommendationCatalogCache].map(item => [String(item.id), item])).values()];
      renderRecommendations(candidates, targetId, sectionId);
    } finally {
      grid.removeAttribute('aria-busy');
    }
  }

  const recommendationCatalogCache = [];

  // ============================================================
  // ANIMATED MOVIES CATALOG
  // ============================================================
  // This catalog deliberately keeps its own pagination state. The Popular page
  // has a different filter contract, and sharing its seen-id set would make
  // switching between routes drop valid animated movie results.
  const ANIMATED_MOVIE_ORIGINS = Object.freeze({
    JP: 'Anime (Japan)',
    CN: 'Donghua (China)',
    US: 'Western Animation',
    KR: 'Korean Animation',
    IN: 'Indian Animation',
    FR: 'French Animation',
    GB: 'British Animation',
    CA: 'Canadian Animation',
    BR: 'Brazilian Animation',
    OTHER: 'Other Animation'
  });
  const ANIMATED_MOVIE_ORIGIN_CODES = Object.freeze(Object.keys(ANIMATED_MOVIE_ORIGINS));
  const ANIMATED_MOVIE_DEFAULT_ORIGIN = 'JP';
  const animatedMoviesState = {
    page: 1,
    hasNext: false,
    loading: false,
    seenIds: new Set(),
    countryOfOrigin: ANIMATED_MOVIE_DEFAULT_ORIGIN,
    year: '',
    query: '',
    items: []
  };
  let animatedMoviesRequestId = 0;

  function cancelAnimatedMoviesRequest() {
    animatedMoviesRequestId += 1;
    animatedMoviesState.loading = false;
  }

  function animatedMovieOrigin(item) {
    const origin = String(item?.countryOfOrigin || '').trim().toUpperCase();
    return ANIMATED_MOVIE_ORIGIN_CODES.includes(origin) ? origin : 'OTHER';
  }

  function animatedMovieId(item) {
    const id = item?.anilistId ?? item?.id;
    return id === undefined || id === null || id === '' ? null : String(id);
  }

  function matchesAnimatedMovieOrigin(item, origin) {
    if (!isMovieEntry(item)) return false;
    const rawOrigin = String(item?.countryOfOrigin || '').trim().toUpperCase();
    // The browse endpoint is responsible for applying the origin filter. If a
    // provider record omits that optional field, keep it for a named region
    // rather than dropping a valid, already-filtered movie; unknown records
    // still belong in the explicit Other bucket.
    if (!rawOrigin) return origin !== 'OTHER';
    return animatedMovieOrigin(item) === origin;
  }

  function animatedMoviesControlValues() {
    const selectedRegion = document.querySelector('#animated-movies-region-filter [data-country-of-origin].active')?.dataset.countryOfOrigin;
    const year = document.getElementById('animated-movies-year')?.value || '';
    const search = document.getElementById('animated-movies-search')?.value.trim().slice(0, 100) || '';
    const maxYear = new Date().getFullYear() + 1;
    const parsedYear = /^\d{4}$/.test(year) ? Number(year) : 0;
    return {
      countryOfOrigin: ANIMATED_MOVIE_ORIGIN_CODES.includes(selectedRegion) ? selectedRegion : ANIMATED_MOVIE_DEFAULT_ORIGIN,
      year: parsedYear >= 1960 && parsedYear <= maxYear ? String(parsedYear) : '',
      query: search
    };
  }

  function animatedMoviesUrl() {
    const params = new URLSearchParams();
    params.set('page', 'animated-movies');
    params.set('countryOfOrigin', animatedMoviesState.countryOfOrigin);
    if (animatedMoviesState.year) params.set('year', animatedMoviesState.year);
    if (animatedMoviesState.query) params.set('search', animatedMoviesState.query);
    return `?${params.toString()}`;
  }

  function syncAnimatedMoviesUrl(historyMode = 'replace') {
    const nextUrl = animatedMoviesUrl();
    if (window.location.search === nextUrl) return;
    const method = historyMode === 'push' ? 'pushState' : 'replaceState';
    window.history[method]({}, '', nextUrl);
  }

  function setAnimatedMoviesRegionButtons() {
    document.querySelectorAll('#animated-movies-region-filter [data-country-of-origin]').forEach(button => {
      const selected = button.dataset.countryOfOrigin === animatedMoviesState.countryOfOrigin;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  function populateAnimatedMovieYears() {
    const select = document.getElementById('animated-movies-year');
    if (!select || select.dataset.yearsPopulated === 'true') return;
    const maxYear = new Date().getFullYear() + 1;
    select.innerHTML = '<option value="">Any release year</option>';
    for (let year = maxYear; year >= 1960; year -= 1) {
      const option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      select.appendChild(option);
    }
    select.dataset.yearsPopulated = 'true';
  }

  function applyAnimatedMoviesFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const rawOrigin = (params.get('countryOfOrigin') || params.get('origin') || '').trim().toUpperCase();
    const countryOfOrigin = ANIMATED_MOVIE_ORIGIN_CODES.includes(rawOrigin) ? rawOrigin : ANIMATED_MOVIE_DEFAULT_ORIGIN;
    const rawYear = params.get('year') || '';
    const parsedYear = /^\d{4}$/.test(rawYear) ? Number(rawYear) : 0;
    const maxYear = new Date().getFullYear() + 1;
    const year = parsedYear >= 1960 && parsedYear <= maxYear ? String(parsedYear) : '';
    const query = (params.get('search') || '').trim().slice(0, 100);

    animatedMoviesState.countryOfOrigin = countryOfOrigin;
    animatedMoviesState.year = year;
    animatedMoviesState.query = query;

    const yearSelect = document.getElementById('animated-movies-year');
    if (yearSelect) yearSelect.value = year;
    const searchInput = document.getElementById('animated-movies-search');
    if (searchInput) searchInput.value = query;
    setAnimatedMoviesRegionButtons();
  }

  function setAnimatedMoviesLoadMoreVisible(visible) {
    const wrap = document.getElementById('animated-movies-load-more');
    if (wrap) wrap.hidden = !visible;
  }

  function updateAnimatedMoviesLoadMoreButton() {
    const button = document.getElementById('animated-movies-load-more-btn');
    if (!button) return;
    button.disabled = animatedMoviesState.loading;
    button.textContent = animatedMoviesState.loading ? 'Loading…' : 'Load more';
  }

  function renderAnimatedMoviesResults() {
    const grid = document.getElementById('animated-movies-grid');
    const empty = document.getElementById('animated-movies-empty');
    const emptyMessage = document.getElementById('animated-movies-empty-message');
    const resultCount = document.getElementById('animated-movies-result-count');
    if (!grid || !empty) return;

    const normalizedQuery = animatedMoviesState.query.toLocaleLowerCase();
    const visibleItems = animatedMoviesState.items.filter(item => {
      if (!normalizedQuery) return true;
      return getAnimeTitle(item).toLocaleLowerCase().includes(normalizedQuery);
    });

    grid.removeAttribute('aria-busy');
    if (!visibleItems.length) {
      grid.replaceChildren();
      grid.hidden = true;
      empty.hidden = false;
      if (emptyMessage) {
        emptyMessage.textContent = normalizedQuery
          ? `No ${ANIMATED_MOVIE_ORIGINS[animatedMoviesState.countryOfOrigin].toLowerCase()} titles match “${animatedMoviesState.query}”.`
          : `Try another region or release year for ${ANIMATED_MOVIE_ORIGINS[animatedMoviesState.countryOfOrigin].toLowerCase()}.`;
      }
    } else {
      empty.hidden = true;
      grid.hidden = false;
      grid.style.display = 'grid';
      renderAnimeGrid(visibleItems, 'animated-movies-grid');
    }

    if (resultCount) {
      if (!animatedMoviesState.items.length) {
        resultCount.textContent = `No ${ANIMATED_MOVIE_ORIGINS[animatedMoviesState.countryOfOrigin].toLowerCase()} titles found`;
      } else if (normalizedQuery && visibleItems.length !== animatedMoviesState.items.length) {
        resultCount.textContent = `Showing ${visibleItems.length} of ${animatedMoviesState.items.length} animated movies`;
      } else {
        resultCount.textContent = `${animatedMoviesState.items.length} animated movie${animatedMoviesState.items.length === 1 ? '' : 's'} loaded`;
      }
    }
  }

  async function loadAnimatedMovies({ append = false, historyMode = null } = {}) {
    const grid = document.getElementById('animated-movies-grid');
    if (!grid) return;
    if (append && (animatedMoviesState.loading || !animatedMoviesState.hasNext)) return;

    if (!append) {
      const values = animatedMoviesControlValues();
      animatedMoviesState.countryOfOrigin = values.countryOfOrigin;
      animatedMoviesState.year = values.year;
      animatedMoviesState.query = values.query;
      if (historyMode) syncAnimatedMoviesUrl(historyMode);
      animatedMoviesState.page = 1;
      animatedMoviesState.hasNext = false;
      animatedMoviesState.seenIds.clear();
      animatedMoviesState.items = [];
      setAnimatedMoviesRegionButtons();
      renderSkeletonGrid('animated-movies-grid', 8);
      grid.hidden = false;
      document.getElementById('animated-movies-empty')?.setAttribute('hidden', '');
      setAnimatedMoviesLoadMoreVisible(false);
      const resultCount = document.getElementById('animated-movies-result-count');
      if (resultCount) resultCount.textContent = `Loading ${ANIMATED_MOVIE_ORIGINS[animatedMoviesState.countryOfOrigin].toLowerCase()}…`;
    }

    const requestId = ++animatedMoviesRequestId;
    const requestPage = append ? animatedMoviesState.page + 1 : 1;
    animatedMoviesState.loading = true;
    updateAnimatedMoviesLoadMoreButton();

    const params = new URLSearchParams();
    params.set('format', 'MOVIE');
    params.set('countryOfOrigin', animatedMoviesState.countryOfOrigin);
    if (animatedMoviesState.year) params.set('year', animatedMoviesState.year);
    params.set('page', String(requestPage));
    params.set('perPage', String(CATALOG_BROWSE_PER_PAGE));

    try {
      const response = await fetchWithPolicy(`${baseURL}/browse?${params.toString()}`, {}, { timeout: 'catalog', retries: 1 });
      if (requestId !== animatedMoviesRequestId) return;
      if (!response.ok) throw new Error(`Animated movies request failed: ${response.status}`);
      const payload = await response.json();
      if (requestId !== animatedMoviesRequestId) return;
      const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
      const fresh = [];

      list.filter(item => matchesAnimatedMovieOrigin(item, animatedMoviesState.countryOfOrigin)).forEach(item => {
        const id = animatedMovieId(item);
        if (id === null || animatedMoviesState.seenIds.has(id)) return;
        animatedMoviesState.seenIds.add(id);
        fresh.push(item);
      });

      animatedMoviesState.page = requestPage;
      animatedMoviesState.hasNext = response.headers.get('x-catalog-has-next') === 'true';
      animatedMoviesState.items = append
        ? [...animatedMoviesState.items, ...fresh]
        : fresh;
      renderAnimatedMoviesResults();
      setAnimatedMoviesLoadMoreVisible(animatedMoviesState.hasNext);
    } catch (error) {
      if (requestId !== animatedMoviesRequestId) return;
      console.error('Error loading animated movies:', error);
      animatedMoviesState.hasNext = append ? animatedMoviesState.hasNext : false;
      if (append) {
        const resultCount = document.getElementById('animated-movies-result-count');
        if (resultCount) resultCount.textContent = 'Unable to load more animated movies. Try again.';
        setAnimatedMoviesLoadMoreVisible(true);
        showToast('Unable to load more animated movies. Please try again.', 'error');
      } else {
        renderCatalogLoadError('animated-movies-grid', 'Unable to load animated movies. Check your connection and try again.', () => loadAnimatedMovies({ historyMode: 'replace' }));
        setAnimatedMoviesLoadMoreVisible(false);
        const empty = document.getElementById('animated-movies-empty');
        if (empty) empty.hidden = true;
        const resultCount = document.getElementById('animated-movies-result-count');
        if (resultCount) resultCount.textContent = 'Animated movie catalog unavailable';
      }
    } finally {
      if (requestId === animatedMoviesRequestId) {
        animatedMoviesState.loading = false;
        updateAnimatedMoviesLoadMoreButton();
      }
    }
  }

  // Keep the feature callable for integration tests and the rest of the SPA,
  // while retaining the same local state pattern as the existing catalogs.
  window.animatedMoviesState = animatedMoviesState;
  window.loadAnimatedMovies = loadAnimatedMovies;

  // ============================================================
  // SEARCH STATE & FILTERING
  // ============================================================

  const searchCache = new Map();
  let currentSearchResults = [];
  let lastSearchQuery = '';
  let searchRequestId = 0;
  let detailRequestId = 0;
  let detailRequestController = null;

  function cancelDetailRequest() {
    detailRequestId += 1;
    detailRequestController?.abort();
    detailRequestController = null;
  }

  function populateSearchFilters(items) {
    const genreSelect = document.getElementById('search-filter-genre');
    const typeSelect = document.getElementById('search-filter-type');
    if (!genreSelect || !typeSelect) return;

    setSelectOptions(genreSelect, items.flatMap(item => item.genres || item.genre || []), 'All genres');
    setSelectOptions(typeSelect, items.map(item => item.type || item.format), 'All formats');
  }

  function applySearchFilters() {
    const genre = document.getElementById('search-filter-genre')?.value || '';
    const type = document.getElementById('search-filter-type')?.value || '';
    const minRating = Number(document.getElementById('search-filter-rating')?.value || 0);
    const sortBy = document.getElementById('search-sort-by')?.value || 'relevance';

    const searchResultsGrid = document.getElementById('search-results-grid');
    const searchEmpty = document.getElementById('search-empty');
    const searchFilterEmpty = document.getElementById('search-filter-empty');
    const searchError = document.getElementById('search-error');
    const searchFiltersSection = document.getElementById('search-filters-section');
    const resultCount = document.getElementById('search-result-count');

    if (searchError) searchError.style.display = 'none';

    if (!currentSearchResults.length) {
      if (searchFiltersSection) searchFiltersSection.style.display = 'none';
      if (searchResultsGrid) searchResultsGrid.style.display = 'none';
      if (searchFilterEmpty) searchFilterEmpty.style.display = 'none';
      if (searchEmpty) searchEmpty.style.display = 'block';
      if (resultCount) resultCount.textContent = '0 results found';
      return;
    }

    if (searchFiltersSection) searchFiltersSection.style.display = 'block';

    const filtered = currentSearchResults.filter(item => {
      const genres = item.genres || item.genre || [];
      const itemType = item.type || item.format || '';
      const itemRating = Number(item.rating || (item.averageScore || 0) / 10);

      return (!genre || genres.includes(genre)) &&
        (!type || itemType === type) &&
        (!minRating || itemRating >= minRating);
    });

    // Apply sorting
    if (sortBy === 'rating') {
      filtered.sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0));
    } else if (sortBy === 'year') {
      filtered.sort((a, b) => Number(b.year || b.seasonYear || 0) - Number(a.year || a.seasonYear || 0));
    } else if (sortBy === 'title') {
      filtered.sort((a, b) => String(getAnimeTitle(a)).localeCompare(String(getAnimeTitle(b))));
    }

    if (!filtered.length) {
      if (searchResultsGrid) searchResultsGrid.style.display = 'none';
      if (searchEmpty) searchEmpty.style.display = 'none';
      if (searchFilterEmpty) searchFilterEmpty.style.display = 'block';
      if (resultCount) resultCount.textContent = `0 of ${currentSearchResults.length} titles match filters`;
    } else {
      if (searchEmpty) searchEmpty.style.display = 'none';
      if (searchFilterEmpty) searchFilterEmpty.style.display = 'none';
      if (searchResultsGrid) searchResultsGrid.style.display = 'grid';
      renderAnimeGrid(filtered, 'search-results-grid');
      if (resultCount) {
        resultCount.textContent = filtered.length === currentSearchResults.length
          ? `${filtered.length} anime title${filtered.length === 1 ? '' : 's'} found`
          : `Showing ${filtered.length} of ${currentSearchResults.length} titles`;
      }
    }
  }

  document.getElementById('search-retry-btn')?.addEventListener('click', () => {
    if (lastSearchQuery) performSearch(lastSearchQuery);
  });

  // ============================================================
  // SEARCH ANIME (AniList with local DB fallback & caching)
  // ============================================================

  async function performSearch(query) {
    const rawQuery = typeof query === 'string' ? query : '';
    const normalizedQuery = rawQuery.trim();
    const requestId = ++searchRequestId;
    lastSearchQuery = normalizedQuery;

    const searchResultsGrid = document.getElementById('search-results-grid');
    const searchEmpty = document.getElementById('search-empty');
    const searchFilterEmpty = document.getElementById('search-filter-empty');
    const searchError = document.getElementById('search-error');
    const searchFiltersSection = document.getElementById('search-filters-section');
    const searchLabel = document.getElementById('search-query-label');
    const resultCount = document.getElementById('search-result-count');

    if (searchLabel) searchLabel.textContent = normalizedQuery || '…';
    if (searchFilterEmpty) searchFilterEmpty.style.display = 'none';
    if (searchError) searchError.style.display = 'none';

    if (!normalizedQuery || normalizedQuery.length > 100) {
      currentSearchResults = [];
      if (searchFiltersSection) searchFiltersSection.style.display = 'none';
      if (searchResultsGrid) searchResultsGrid.style.display = 'none';
      if (searchEmpty) searchEmpty.style.display = 'block';
      if (resultCount) resultCount.textContent = 'Please enter an anime title of 1 to 100 characters.';
      return;
    }

    if (searchEmpty) searchEmpty.style.display = 'none';
    if (searchResultsGrid) {
      searchResultsGrid.style.display = 'grid';
      renderSkeletonGrid('search-results-grid', 8);
    }
    if (resultCount) resultCount.textContent = 'Searching catalog…';

    // Check cache first
    const cacheKey = normalizedQuery.toLowerCase();
    if (searchCache.has(cacheKey)) {
      currentSearchResults = searchCache.get(cacheKey);
      populateSearchFilters(currentSearchResults);
      applySearchFilters();
      return;
    }

    try {
      const res = await fetchWithPolicy(`${baseURL}/search?q=${encodeURIComponent(normalizedQuery)}`, {}, { timeout: 'search', retries: 1 });
      if (requestId !== searchRequestId) return;
      if (!res.ok) {
        throw new Error(`Search request failed: ${res.status}`);
      }

      const data = await res.json();
      if (requestId !== searchRequestId) return;

      const animeResults = (Array.isArray(data) ? data : []).map(anime => {
        const title = getAnimeTitle(anime);
        const rating = anime.averageScore ? anime.averageScore / 10 : (anime.rating || 0);
        const posterUrl = safeImageUrl(
          anime.coverImage?.extraLarge ||
          anime.coverImage?.large ||
          anime.poster ||
          anime.image
        );

        return {
          id: anime.id || anime.anilistId,
          anilistId: anime.anilistId || anime.id,
          title: title,
          poster: posterUrl,
          image: posterUrl,
          description: anime.description
            ? anime.description.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
            : 'No description available.',
          rating: rating,
          genres: anime.genres || anime.genre || [],
          genre: anime.genres || anime.genre || [],
          type: anime.format || anime.type || 'TV',
          format: anime.format || anime.type || 'TV',
          studio: anime.studios?.nodes?.[0]?.name || anime.studio || '',
          language: ({ JP: 'Japanese', KR: 'Korean', CN: 'Chinese' })[anime.countryOfOrigin] || anime.language || 'Unknown',
          countryOfOrigin: anime.countryOfOrigin || null,
          status: anime.status || 'Unknown',
          episodes: anime.episodes || 0,
          year: anime.seasonYear || anime.year || 'Unknown',
          seasonYear: anime.seasonYear || anime.year || null,
          season: anime.season || null
        };
      });    searchCache.set(cacheKey, animeResults);
    currentSearchResults = animeResults;
    populateSearchFilters(currentSearchResults);
    applySearchFilters();

    } catch (err) {
      if (requestId !== searchRequestId) return;
      console.error('Error searching anime:', err);
      const grid = document.getElementById('search-results-grid');
      if (grid) grid.removeAttribute('aria-busy');
      // Invalidate cache for this query so a retry fetches fresh data
      searchCache.delete(cacheKey);
      currentSearchResults = [];
      if (searchResultsGrid) searchResultsGrid.style.display = 'none';
      if (searchFiltersSection) searchFiltersSection.style.display = 'none';
      if (searchEmpty) searchEmpty.style.display = 'none';
      if (searchFilterEmpty) searchFilterEmpty.style.display = 'none';
      if (searchError) {
        searchError.style.display = 'block';
        const errorMsg = document.getElementById('search-error-message');
        if (errorMsg) errorMsg.textContent = 'Could not load search results. Please check your network connection and try again.';

      }
      if (resultCount) resultCount.textContent = 'Search error';
    }
  }

  // ============================================================
  // LOAD ANIME DETAILS & WATCH FLOW
  // ============================================================

  async function loadAnimeDetails(id, updateHistory = true) {
    if (!id) return;

    const requestId = ++detailRequestId;
    detailRequestController?.abort();
    detailRequestController = new AbortController();
    const requestSignal = detailRequestController.signal;

    // ============================================================
    // RATINGS & REVIEWS (Item 39) — function declarations at function-body root
    // so they are hoisted and callable from within the try block below.
    // ============================================================
    // User star rating (1–10) and text review persisted to localStorage and
    // synced to the cloud watchlist entry when a session exists.

    const REVIEW_PREFIX = 'anime_hub_review_';

    function reviewKey(id) {
      return `${REVIEW_PREFIX}${id}`;
    }

    function loadReview(id) {
      try {
        const raw = localStorage.getItem(reviewKey(id));
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.rating)) {
            return parsed;
          }
        }
      } catch {
        // Keep empty on any read error.
      }
      return null;
    }

    async function saveReview(id, { rating, review }) {
      const entry = {
        rating: Number(rating),
        review: String(review || '').trim(),
        updatedAt: Date.now()
      };
      try {
        localStorage.setItem(reviewKey(id), JSON.stringify(entry));
      } catch {
        // Storage unavailable; review lives only for this session.
      }
      // Sync rating/review to the cloud watchlist entry when possible.
      const index = watchlist.findIndex(saved => String(saved.id) === String(id));
      if (index >= 0) {
        try {
          await updateWatchlistItem(watchlist[index], { rating: entry.rating, review: entry.review });
        } catch {
          // Cloud sync failure is non-fatal; local copy is authoritative.
        }
      }
      showToast('Rating and review saved.', 'success');
      return entry;
    }

    // Spoiler-protected text (Item 40). Text wrapped in ||...|| is rendered
    // as a blurred overlay that reveals on click.
    function renderSpoilerText(text) {
      if (!text) return '';
      const escaped = escapeHtml(text);
      const parts = escaped.split(/\|\|([\s\S]+?)\|\|/);
      return parts.map((part, index) => {
        if (index % 2 === 1) {
          return `<span class="spoiler" role="button" tabindex="0" aria-label="Spoiler — click to reveal">${part}</span>`;
        }
        return part;
      }).join('');
    }

    function renderUserReviewSection(id) {
      const existing = loadReview(id);
      const hasReview = existing && (existing.rating || existing.review);
      return `
        <div class="review-card">
          <h3 style="font-size:1.1rem;margin-bottom:10px;color:var(--text);">Your rating &amp; review</h3>
          <div class="review-form">
            <div class="review-star-input" id="review-star-input-${id}"></div>
            <textarea id="review-text-${id}" placeholder="Write a review…" rows="3" style="width:100%;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2);color:var(--text);padding:10px;margin-top:8px;resize:vertical;font:inherit;">${existing && existing.review ? escapeHtml(existing.review) : ''}</textarea>
            <div style="margin-top:8px;text-align:right;">
              <button type="button" id="review-save-btn-${id}" class="cta-btn primary-btn" style="padding:8px 16px;font-size:14px;">${hasReview ? 'Update review' : 'Save review'}</button>
            </div>
            <p id="review-status-${id}" style="margin-top:8px;font-size:13px;color:var(--text-muted);"></p>
          </div>
          ${hasReview
            ? `<div class="review-existing" style="margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2);"><strong style="color:var(--primary);">Your rating:</strong> <span class="review-user-rating" style="color:var(--primary);font-weight:700;">★ ${existing.rating} / 10</span>${existing.review ? `<p style="margin-top:6px;color:var(--text-dim);">${renderSpoilerText(existing.review)}</p>` : ''}</div>`
            : `<p style="margin-top:10px;font-size:13px;color:var(--text-muted);">You haven’t rated or reviewed this title yet.</p>`}
        </div>
      `;
    }

    function wireReviewSection(id) {
      // Star selection feedback (no server round-trip).
      const starInput = document.getElementById(`review-star-input-${id}`);
      if (!starInput) return;
      starInput.querySelectorAll('.review-star').forEach(btn => {
        btn.addEventListener('click', () => {
          starInput.querySelectorAll('.review-star').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
      const textEl = document.getElementById(`review-text-${id}`);
      const statusEl = document.getElementById(`review-status-${id}`);
      const existing = loadReview(id);
      if (existing) {
        const selectedStar = starInput.querySelector(`[data-rating="${existing.rating}"]`);
        if (selectedStar) selectedStar.classList.add('active');
      }
      const saveBtn = document.getElementById(`review-save-btn-${id}`);
      if (saveBtn && !saveBtn.dataset.reviewBound) {
        saveBtn.dataset.reviewBound = 'true';
        saveBtn.addEventListener('click', async () => {
          const selectedStar = starInput.querySelector('.review-star.active');
          const rating = selectedStar ? Number(selectedStar.dataset.rating) : null;
          const review = textEl ? textEl.value : '';
          if (!rating) {
            if (statusEl) statusEl.textContent = 'Please select a rating (1–10).';
            return;
          }
          try {
            await saveReview(id, { rating, review });
            if (statusEl) statusEl.textContent = 'Saved.';
            setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
            const section = document.getElementById(`detail-reviews-${id}`);
            if (section) section.innerHTML = renderUserReviewSection(id);
            wireReviewSection(id);
          } catch (error) {
            console.error('Could not save review:', error);
            if (statusEl) statusEl.textContent = 'Could not save review. Please try again.';
          }
        });
      }
    }

    const detailContent = document.getElementById('detail-content');
    if (!detailContent) return;

    // Switch to detail page
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-detail').classList.add('active');
    
    // Update URL
    if (updateHistory) window.history.pushState({}, '', `?id=${id}`);

    // Loading state
    detailContent.innerHTML = `
      <div style="text-align: center; padding: 120px 20px; font-size: 18px; color: var(--text-muted);">
        <div style="margin-bottom: 20px; font-size: 40px; animation: float 2s infinite;">⏳</div>
        Loading anime details...
      </div>
    `;
    window.scrollTo(0, 0);

    try {
      const res = await fetchWithPolicy(`${baseURL}/anime/${id}`, { signal: requestSignal }, { timeout: 'detail', retries: 1 });
      if (!res.ok) throw new Error(`Failed to fetch details: ${res.status}`);
      
      const anime = await res.json();
      if (requestId !== detailRequestId) return;
      
      const rawTitle = anime.title?.english || anime.title?.romaji || anime.title?.native || 'Unknown Anime';
      const title = escapeHtml(rawTitle);
      const rawNative = anime.title?.romaji !== rawTitle ? anime.title?.romaji : '';
      const nativeTitle = escapeHtml(rawNative);
      const rating = anime.averageScore ? (anime.averageScore / 10).toFixed(1) : (anime.rating ? anime.rating.toFixed(1) : 'N/A');
      const poster = safeImageUrl(anime.coverImage?.extraLarge || anime.coverImage?.large || anime.poster || anime.image);
      const bannerUrl = anime.bannerImage || anime.banner;
      const banner = safeImageUrl(bannerUrl || poster);
      const bannerFallback = bannerUrl ? poster : BANNER_FALLBACK;
      const totalEpisodes = Number(anime.episodes) > 0 ? Number(anime.episodes) : null;
      const format = escapeHtml(anime.format || anime.type || 'Anime');
      const statusLabels = {
        FINISHED: 'Completed',
        HIATUS: 'On hiatus',
        NOT_YET_RELEASED: 'Upcoming',
        RELEASING: 'Airing'
      };
      const status = escapeHtml(statusLabels[anime.status] || anime.status || 'Unknown');
      const season = escapeHtml(anime.season || '');
      const seasonYear = escapeHtml(String(anime.seasonYear || anime.year || ''));
      const releaseDateParts = [anime.startDate?.year, anime.startDate?.month, anime.startDate?.day]
        .filter(value => Number.isInteger(value))
        .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'));
      const releaseDate = escapeHtml(releaseDateParts.join('-') || seasonYear || 'Not listed');
      const studioNames = (anime.studios?.nodes || [])
        .map(studio => studio?.name)
        .filter(Boolean);
      const studioText = escapeHtml(studioNames.join(', ') || 'Not listed');
      const sourceText = escapeHtml((anime.source || '').replace(/_/g, ' ') || 'Not listed');
      const countryNames = { CN: 'China', JP: 'Japan', KR: 'South Korea', TW: 'Taiwan' };
      const countryText = escapeHtml(countryNames[anime.countryOfOrigin] || 'Not listed');
      const metadataFacts = [
        ['Studio', studioText],
        ['Source', sourceText],
        ['Country of origin', countryText],
        ['Release date', releaseDate],
        ['Episode length', Number(anime.duration) > 0 ? `${Number(anime.duration)} min` : 'Not listed']
      ];
      const metadataFactsHtml = metadataFacts.map(([label, value]) =>
        `<div class="detail-fact"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`
      ).join('');
      
      let genresHtml = '';
      if (anime.genres && anime.genres.length > 0) {
        genresHtml = anime.genres.map(g => `<span class="detail-tag genre-tag">${escapeHtml(g)}</span>`).join('');
      }

      const description = anime.description
        ? escapeHtml(anime.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/\n/g, '<br>')
        : 'No description available.';

      const plainDescription = anime.description
        ? anime.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
        : `${rawTitle} is an anime ${format.toLowerCase()} indexed on AnimeHub.`;

      const animeSchema = {
        '@context': 'https://schema.org',
        '@type': (format.toLowerCase() === 'movie') ? 'Movie' : 'TVSeries',
        'name': rawTitle,
        'description': plainDescription.slice(0, 300),
        'image': poster,
        'genre': anime.genres || [],
        'url': new URL(`/?id=${anime.id}`, siteOrigin).href
      };

      if (rating && parseFloat(rating) > 0) {
        animeSchema.aggregateRating = {
          '@type': 'AggregateRating',
          'ratingValue': parseFloat(rating).toFixed(1),
          'bestRating': '10',
          'worstRating': '0',
          'ratingCount': anime.averageScore ? 100 : 10
        };
      }

      updatePageSeo({
        title: `${rawTitle} (${format}, ${rating}★) — AnimeHub`,
        description: plainDescription.slice(0, 160),
        image: poster,
        url: `/?id=${anime.id}`,
        schema: animeSchema
      });

      let trailerHtml = '';
      if (anime.trailer?.site === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(anime.trailer.id || '')) {
        trailerHtml = `
          <a href="https://www.youtube.com/watch?v=${encodeURIComponent(anime.trailer.id)}" target="_blank" rel="noopener noreferrer" class="cta-btn secondary-btn" aria-label="Watch official trailer for ${title} on YouTube (opens in new tab)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Official Trailer
          </a>
        `;
      }

      const staffEdges = anime.staff?.edges || [];
      const staffHtml = staffEdges.length
        ? `<section class="detail-info-card" aria-labelledby="detail-staff-heading">
            <h2 id="detail-staff-heading">Key staff</h2>
            <ul class="detail-credit-list">
              ${staffEdges.map(edge => `<li><span>${escapeHtml(edge.role || 'Staff')}</span><strong>${escapeHtml(edge.node?.name?.full || 'Unknown')}</strong></li>`).join('')}
            </ul>
          </section>`
        : '';

      const characterEdges = anime.characters?.edges || [];
      const characterCredits = characterEdges.filter(edge => edge.node?.name?.full);
      const charactersHtml = characterCredits.length
        ? `<section class="detail-info-card" aria-labelledby="detail-characters-heading">
            <h2 id="detail-characters-heading">Characters &amp; Japanese voice actors</h2>
            <ul class="detail-credit-list">
              ${characterCredits.map(edge => {
                const voiceActor = edge.voiceActors?.[0];
                const actorName = voiceActor?.name?.full
                  ? `Japanese voice: ${escapeHtml(voiceActor.name.full)}`
                  : 'Japanese voice actor not listed';
                return `<li><span>${escapeHtml(edge.node.name.full)}${edge.role ? ` · ${escapeHtml(edge.role.toLowerCase())}` : ''}</span><strong>${actorName}</strong></li>`;
              }).join('')}
            </ul>
          </section>`
        : '';

      const relatedItems = (anime.relations?.edges || [])
        .filter(edge => edge.node?.type === 'ANIME' && Number(edge.node.id) !== Number(anime.id))
        .map(edge => {
          const related = edge.node;
          const relatedPoster = related.coverImage?.large || null;
          return {
            id: related.id,
            anilistId: related.id,
            title: getAnimeTitle(related),
            image: relatedPoster,
            poster: relatedPoster,
            banner: related.bannerImage || relatedPoster,
            rating: related.averageScore ? related.averageScore / 10 : 0,
            year: related.seasonYear || null,
            type: related.format || 'TV',
            status: statusLabels[related.status] || related.status || 'Unknown',
            relationType: (edge.relationType || 'Related').replace(/_/g, ' ').toLowerCase()
          };
        });
      const relatedHtml = relatedItems.length
        ? `<section class="reco-section" aria-labelledby="detail-related-heading">
            <h2 class="episodes-title" id="detail-related-heading">Related titles</h2>
            <div class="anime-grid">${relatedItems.map(item => renderAnimeCard(item)).join('')}</div>
          </section>`
        : '';

      const legalSearchUrl = `https://www.justwatch.com/${justWatchRegion}/search?q=${encodeURIComponent(rawTitle)}`;

      let recommendationsHtml = '';
      if (anime.recommendations?.edges?.length > 0) {
        const recos = anime.recommendations.edges.map(e => e.node.mediaRecommendation).filter(Boolean);
        
        if (recos.length > 0) {
          recommendationsHtml = `
            <div class="reco-section">
              <h3 class="episodes-title">Recommended Anime</h3>
              <div class="anime-grid">
                ${recos.map(r => renderAnimeCard({
                  id: r.id,
                  anilistId: r.id,
                  title: getAnimeTitle(r),
                  image: r.coverImage?.large,
                  poster: r.coverImage?.large,
                  banner: r.bannerImage || r.coverImage?.large,
                  rating: r.averageScore ? r.averageScore / 10 : 0,
                  year: r.seasonYear || null,
                  type: r.format || 'TV',
                  status: r.status || 'Unknown'
                })).join('')}
              </div>
            </div>
          `;
        }
      }

      const savedAnime = watchlist.find(w => String(w.id) === String(anime.id));
      const isAnimeSaved = !!savedAnime;
      // Legacy guest entries were bookmarked without `type`; the catalog
      // response is the authoritative format source, so fall back to it
      // (never infer from episode counts) and persist the repair so the
      // watchlist page classifies the entry correctly too. Every other field
      // (id, title, poster, status, progress) is left untouched, and a
      // missing/unknown catalog format leaves the entry as-is.
      const catalogType = animeTypeValue(anime);
      if (savedAnime && !savedAnime.type && catalogType) {
        savedAnime.type = catalogType;
        saveWatchlist();
      }
      const detailWatchControls = savedAnime
        ? renderWatchProgressControls({
          ...savedAnime,
          type: savedAnime.type || animeTypeValue(anime) || undefined,
          totalEpisodes: totalEpisodes ?? savedAnime.totalEpisodes,
          id: anime.id
        })
        : '<p class="watch-progress-hint">Add this title to your watchlist to track status and episode progress.</p>';

      detailContent.innerHTML = `
        <div class="detail-banner">
          <img src="${escapeHtml(banner)}" alt="" data-fallback-src="${escapeHtml(bannerFallback)}">
          <div class="detail-banner-overlay"></div>
        </div>
        <div class="detail-content">
          <button class="back-btn" id="detail-back-btn" type="button" aria-label="Go back to previous page">
            ← Back
          </button>
          <div class="detail-top">
            <img src="${escapeHtml(poster)}" alt="${title} poster" class="detail-poster" data-fallback-src="${POSTER_FALLBACK}">
            <div class="detail-info">
              <h1 class="detail-title">${title}</h1>
              ${nativeTitle ? `<div style="color: var(--text-muted); font-size: 16px; margin-bottom: 12px;">${nativeTitle}</div>` : ''}
              <div class="detail-tags">
                ${genresHtml}
              </div>
              <div class="detail-meta-row">
                <span><b>Format:</b> ${format}</span>
                ${totalEpisodes ? `<span><b>Episodes:</b> ${totalEpisodes}</span>` : ''}
                <span><b>Status:</b> ${status}</span>
                ${season || seasonYear ? `<span><b>Season:</b> ${season} ${seasonYear}</span>` : ''}
              </div>
              <dl class="detail-facts" aria-label="Additional title information">
                ${metadataFactsHtml}
              </dl>
              <div class="detail-rating">
                ★ ${rating} / 10
              </div>
              <div class="detail-actions">
                <a class="cta-btn primary-btn" href="${legalSearchUrl}" target="_blank" rel="noopener noreferrer">
                  Find legal viewing options
                </a>
                <button type="button" class="cta-btn ${isAnimeSaved ? 'primary-btn' : 'secondary-btn'}" id="detail-watchlist-btn" aria-pressed="${isAnimeSaved}">
                  ${isAnimeSaved ? '✓ In Watchlist' : '+ Add to Watchlist'}
                </button>
                ${trailerHtml}
              </div>
              ${detailWatchControls}
              <div class="detail-description">
                ${description}
              </div>
              <div class="detail-reviews" id="detail-reviews-${anime.id}">
                ${renderUserReviewSection(anime.id)}
              </div>
            </div>
          </div>
          <p class="legal-availability-note">AnimeHub is an anime discovery catalog and does not host or stream copyrighted video. Availability varies by region; find licensed streaming providers on JustWatch or watch official trailers on YouTube.</p>
          ${(staffHtml || charactersHtml) ? `<div class="detail-credits">${staffHtml}${charactersHtml}</div>` : ''}
          ${relatedHtml}
          ${recommendationsHtml}
        </div>
      `;

      wireReviewSection(id);

      // Back button listener
      document.getElementById('detail-back-btn')?.addEventListener('click', () => {
        window.history.back();
      });

      // Watchlist detail button listener
      const detailWatchlistBtn = document.getElementById('detail-watchlist-btn');
      if (detailWatchlistBtn) {
        detailWatchlistBtn.addEventListener('click', async () => {
          const watchlistAnime = {
            id: anime.id,
            title: rawTitle,
            poster: poster,
            image: poster,
            rating: parseFloat(rating) || 0,
            type: anime.format || anime.type || 'TV',
            status: anime.status || 'Unknown',
            episodes: totalEpisodes,
            totalEpisodes,
            currentEpisode: 0,
            watchStatus: 'plan_to_watch',
            genres: anime.genres || []
          };

          try {
            const adding = await toggleWatchlistItem(watchlistAnime);
            if (adding) {
              detailWatchlistBtn.className = 'cta-btn primary-btn';
              detailWatchlistBtn.innerText = '✓ In Watchlist';
              detailWatchlistBtn.setAttribute('aria-pressed', 'true');
              showToast('Added to Watchlist!', 'success');
              await loadAnimeDetails(anime.id, false);
            } else {
              detailWatchlistBtn.className = 'cta-btn secondary-btn';
              detailWatchlistBtn.innerText = '+ Add to Watchlist';
              detailWatchlistBtn.setAttribute('aria-pressed', 'false');
              showToast('Removed from Watchlist', 'error');
            }
          } catch (error) {
            console.error('Could not update watchlist:', error);
            showToast('Could not update your watchlist. Please try again.', 'error');
          }
        });
      }

    } catch (err) {
      if (requestId !== detailRequestId || requestSignal.aborted) return;
      console.error('Error loading anime details:', err);
      detailContent.innerHTML = `
        <div style="text-align: center; padding: 100px 20px; font-size: 18px; color: var(--danger);">
          <div style="margin-bottom: 20px; font-size: 40px;">❌</div>
          Failed to load anime details.
          <br><br>
          <button class="cta-btn primary-btn" id="detail-error-back-btn">Back to Home</button>
        </div>
      `;
      document.getElementById('detail-error-back-btn')?.addEventListener('click', () => {
        navigateToPage('home');
      });
    } finally {
      if (requestId === detailRequestId) detailRequestController = null;
    }
  }

  // ============================================================
  // GENRE FILTER
  // ============================================================

  let genreRequestId = 0;

  async function filterByGenre(genre) {
    const requestId = ++genreRequestId;
    let targetGridId = 'trending-grid';
    try {
      const activePage = document.querySelector('.page.active');
      let typeKey = null;

      if (!activePage) return;

      if (activePage.id === 'page-home') targetGridId = 'trending-grid';
      else if (activePage.id === 'page-popular') {
        // A chip is a single-genre shortcut: it replaces any multi-select state.
        const genreSelect = document.getElementById('filter-genre');
        if (genreSelect) {
          Array.from(genreSelect.options).forEach(option => {
            option.selected = genre !== 'All' && option.value.toLowerCase() === String(genre).toLowerCase();
          });
        }
        catalogPage = 1;
        refreshCatalogPage('push');
        return;
      }
      else if (activePage.id === 'page-movies') {
        targetGridId = 'movies-grid';
        typeKey = 'movies';
      } else if (activePage.id === 'page-series') {
        targetGridId = 'series-grid';
        typeKey = 'series';
      }

      renderSkeletonGrid(targetGridId, 6);

      // "All" restores the page's own catalog instead of a different one, so a
      // genre click can never replace the TV Series page with films.
      if (genre === 'All') {
        if (activePage.id === 'page-series') return loadSeries();
        if (activePage.id === 'page-movies') return loadMovies();
        return loadTrending();
      }

      const genreUrl = `${baseURL}/genre/${encodeURIComponent(genre)}${typeKey ? `?type=${typeKey}` : ''}`;
      const requester = typeof fetchWithPolicy === 'function' ? fetchWithPolicy : (url => fetch(url));
      const res = await requester(genreUrl, {}, { timeout: 'catalog', retries: 0 });
      if (requestId !== genreRequestId) return;
      if (!res.ok) throw new Error(`Genre request failed: ${res.status}`);
      const data = await res.json();
      if (requestId !== genreRequestId) return;
      if (!Array.isArray(data)) throw new Error('Genre request returned an invalid response.');

      // The genre endpoint honours `type`, but filtering again here means the
      // wrong format can never reach the grid.
      renderAnimeGrid(
        typeKey === 'series'
          ? (Array.isArray(data) ? data : []).filter(isSeriesEntry)
          : (Array.isArray(data) ? data : []),
        targetGridId
      );

    } catch (err) {
      if (requestId !== genreRequestId) return;
      console.error('Error filtering by genre:', err);
      const grid = document.getElementById(targetGridId);
      if (!grid) return;
      grid.removeAttribute('aria-busy');

      const errorState = document.createElement('div');
      errorState.className = 'genre-load-error';
      errorState.setAttribute('role', 'alert');
      const message = document.createElement('p');
      message.textContent = 'Unable to load this genre. Check your connection and try again.';
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'cta-btn secondary-btn';
      retryButton.textContent = 'Try again';
      retryButton.addEventListener('click', () => {
        void filterByGenre(genre);
      });
      errorState.append(message, retryButton);
      grid.replaceChildren(errorState);
      grid.style.display = 'grid';
    }
  }

  // ============================================================
  // MANGA / MANHWA / MANHUA CATALOGS
  // ============================================================
  // These surfaces use the approved Milestone 1 contract: GET /api/{kind}
  // (optionally `?q=`) returns an array (or { items: [] }); detail is
  // GET /api/{kind}/{id}. The payload deliberately accepts common title/image
  // aliases so a backend adapter can evolve without changing the UI.
  const COMIC_KINDS = ['manga', 'manhwa', 'manhua'];
  const COMIC_LABELS = { manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua' };
  let comicRequestId = 0;
  let comicDetailRequestId = 0;
  const comicPages = Object.fromEntries(COMIC_KINDS.map(kind => [kind, { page: 1, hasNext: false, loading: false, failedAppend: false, query: '', sort: 'popularity' }]));

  function cancelComicDetailRequest() {
    comicDetailRequestId += 1;
  }

  function comicTitle(item) {
    const title = item?.title;
    return title?.english || title?.romaji || title?.native ||
      (typeof title === 'string' && title.trim() ? title : '') || item?.name || 'Untitled';
  }

  function comicChapterTotal(item) {
    const total = item.totalChapters === undefined ? item.chapters : item.totalChapters;
    return Number.isSafeInteger(total) && total > 0 ? total : null;
  }

  function normalizeComic(item, category) {
    if (!item || typeof item !== 'object') return null;
    const title = comicTitle(item);
    const image = item.poster || item.image || item.coverImage?.extraLarge || item.coverImage?.large || item.coverImage || '';
    return { ...item, id: item.id ?? item.slug, title, poster: image, image, type: item.type || COMIC_LABELS[category], format: item.format || item.type || COMIC_LABELS[category], category };
  }

  function comicItems(payload, category) {
    const list = Array.isArray(payload) ? payload : payload?.items;
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list.map(item => normalizeComic(item, category)).filter(item => {
      if (!item) return false;
      const key = String(item.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function readingStatusLabel(value) {
    return {
      reading: 'Reading',
      completed: 'Completed',
      plan_to_read: 'Plan to Read',
      on_hold: 'On Hold',
      dropped: 'Dropped'
    }[value] || 'Plan to Read';
  }

  function savedReadingEntry(identity) {
    return readingList.find(entry => readingUtils.readingEntryKey(entry) === identity);
  }

  function comicDetailHref(category, id) {
    return `?page=${encodeURIComponent(category)}&comicId=${encodeURIComponent(id)}`;
  }

  function comicCardMeta(item, category) {
    const total = comicChapterTotal(item);
    return `${COMIC_LABELS[category]}${total === null ? ' • Chapters unknown' : ` • ${total} chapters`}`;
  }

  function readingProgressText(entry) {
    return `Chapter ${entry.currentChapter}${entry.totalChapters === null ? '' : ` of ${entry.totalChapters}`}`;
  }

  function renderComicCard(item, containerId = '') {
    const category = item.category || item.contentType;
    const id = item.providerId ?? item.id;
    const title = comicTitle(item);
    const poster = safeImageUrl(item.poster || item.image);
    const key = readingKeyForComic(item, category);
    const saved = key ? savedReadingEntry(key) : null;
    const isList = containerId === 'reading-list-grid';
    const isContinue = containerId === 'continue-reading-grid';
    const badge = isList || isContinue ? readingStatusLabel(saved?.readingStatus) : item.status || 'Unknown';
    const rating = Number(item.rating ?? item.score ?? (item.averageScore ? item.averageScore / 10 : 0));
    const href = escapeHtml(comicDetailHref(category, id));
    return `<article class="anime-card comic-card${isList ? ' reading-list-card' : ''}${isContinue ? ' continue-reading-card' : ''}" data-id="${escapeHtml(String(id))}" data-category="${escapeHtml(category)}"${key ? ` data-reading-identity="${escapeHtml(key)}"` : ''} data-reading-poster="${escapeHtml(poster)}" aria-label="${escapeHtml(title)}">
      <div class="card-image-wrapper">
        <img class="card-image" src="${escapeHtml(poster)}" alt="${escapeHtml(title)} cover" loading="lazy" data-fallback-src="${POSTER_FALLBACK}">
        <div class="card-overlay"><span class="card-badge">${escapeHtml(badge)}</span></div>
      </div>
      <div class="card-info">
        <a class="comic-detail-link reading-detail-link" data-comic-detail href="${href}"><h3 class="card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h3></a>
        <div class="card-meta"><span class="card-type">${escapeHtml(comicCardMeta(item, category))}</span>${!isList && !isContinue ? `<span class="card-rating"><span class="star" aria-hidden="true">★</span> ${rating > 0 ? rating.toFixed(1) : 'N/A'}</span>` : ''}</div>
        ${isList && saved ? renderReadingControls(saved) : ''}
        ${isContinue && saved ? `<p class="reading-resume-summary">${escapeHtml(readingProgressText(saved))}</p><a class="comic-detail-link reading-detail-link reading-continue-link" data-comic-detail href="${href}" aria-label="Continue reading ${escapeHtml(title)}">Continue reading</a>` : ''}
        <div class="reading-card-actions">${isList && saved ? `<button type="button" class="comic-reading-btn reading-remove-btn" data-reading-remove="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(title)} from reading list">Remove</button>` : renderComicReadingButton(item, category)}</div>
      </div>
    </article>`;
  }

  function renderReadingControls(entry) {
    const statuses = readingUtils.READING_STATUS_VALUES.map(status =>
      `<option value="${escapeHtml(status)}" ${status === entry.readingStatus ? 'selected' : ''}>${escapeHtml(readingStatusLabel(status))}</option>`
    ).join('');
    const chapter = escapeHtml(String(entry.currentChapter));
    const mismatch = entry.progressExceedsTotal ? '<span class="reading-progress-warning" role="alert">Catalog total changed; progress preserved.</span>' : '';
    return `<div class="reading-controls" data-reading-controls="${escapeHtml(readingUtils.readingEntryKey(entry))}">
      <label><span>Status</span><select data-reading-status aria-label="Reading status for ${escapeHtml(entry.title)}">${statuses}</select></label>
      <label><span>Chapter</span><input data-reading-chapter type="number" min="0" step="1" inputmode="numeric" value="${chapter}" aria-label="Current chapter for ${escapeHtml(entry.title)}"></label>
      <span class="reading-progress-summary">${escapeHtml(readingProgressText(entry))}</span>${mismatch}
    </div>`;
  }

  function syncReadingControl(control, entry) {
    // Patch native controls instead of replacing them, including after a failed
    // save. Only assign changed values so focused number inputs keep their caret.
    const status = control.querySelector('[data-reading-status]');
    const chapter = control.querySelector('[data-reading-chapter]');
    if (status.value !== entry.readingStatus) status.value = entry.readingStatus;
    if (chapter.value !== String(entry.currentChapter)) chapter.value = String(entry.currentChapter);
    status.setAttribute('aria-label', `Reading status for ${entry.title}`);
    chapter.setAttribute('aria-label', `Current chapter for ${entry.title}`);
    control.querySelector('.reading-progress-summary').textContent = readingProgressText(entry);
    const warning = control.querySelector('.reading-progress-warning');
    if (entry.progressExceedsTotal && !warning) {
      const message = document.createElement('span');
      message.className = 'reading-progress-warning';
      message.setAttribute('role', 'alert');
      message.textContent = 'Catalog total changed; progress preserved.';
      control.appendChild(message);
    } else if (!entry.progressExceedsTotal) {
      warning?.remove();
    }
  }

  function updateReadingProgressControls(identity) {
    const entry = savedReadingEntry(identity);
    if (!entry) return;
    document.querySelectorAll('[data-reading-controls]').forEach(control => {
      if (control.dataset.readingControls === identity) syncReadingControl(control, entry);
    });
  }

  function compareReadingIdentity(a, b) {
    const first = readingUtils.readingEntryKey(a);
    const second = readingUtils.readingEntryKey(b);
    return first < second ? -1 : first > second ? 1 : 0;
  }

  function compareReadingEntries(a, b, sort = readingView.sort) {
    let difference = 0;
    if (sort === 'title') {
      difference = a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
    } else if (sort === 'status') {
      difference = readingUtils.READING_STATUS_VALUES.indexOf(a.readingStatus) - readingUtils.READING_STATUS_VALUES.indexOf(b.readingStatus);
    } else if (sort === 'progress') {
      difference = b.currentChapter - a.currentChapter;
    } else {
      const aTime = typeof a.updatedAt === 'string' ? Date.parse(a.updatedAt) : NaN;
      const bTime = typeof b.updatedAt === 'string' ? Date.parse(b.updatedAt) : NaN;
      if (Number.isFinite(aTime) && Number.isFinite(bTime)) difference = bTime - aTime;
      else if (Number.isFinite(aTime)) difference = -1;
      else if (Number.isFinite(bTime)) difference = 1;
    }
    return difference || compareReadingIdentity(a, b);
  }

  function setReadingVisible(element, visible, display = '') {
    if (!element) return;
    element.hidden = !visible;
    element.style.display = visible ? display : 'none';
  }

  function captureReadingFocus(grid) {
    const active = document.activeElement;
    if (!grid.contains(active)) return null;
    const cards = [...grid.querySelectorAll('[data-reading-identity]')];
    const card = active.closest('[data-reading-identity]');
    const selector = ['[data-reading-status]', '[data-reading-chapter]', '[data-reading-remove]', '[data-reading-toggle]', 'a'].find(value => active.matches(value));
    return { active, keys: cards.map(item => item.dataset.readingIdentity), index: cards.indexOf(card), selector };
  }

  function restoreReadingFocus(grid, focus) {
    if (!focus || !grid.closest('.page')?.classList.contains('active')) return;
    if (focus.active.isConnected && !grid.hidden) {
      if (document.activeElement !== focus.active) focus.active.focus({ preventScroll: true });
      return;
    }
    const cards = [...grid.querySelectorAll('[data-reading-identity]')];
    const nextKeys = [...focus.keys.slice(focus.index + 1), ...focus.keys.slice(0, focus.index).reverse()];
    const next = !grid.hidden && (nextKeys.map(key => cards.find(card => card.dataset.readingIdentity === key)).find(Boolean) || cards[0]);
    const nextControl = next && (next.querySelector(focus.selector || 'a') || next.querySelector('a, button, select, input'));
    const fallback = grid.id === 'reading-list-grid'
      ? document.getElementById(readingListLoad?.ok === false ? 'reading-list-retry' : 'reading-list-status-filter') || document.getElementById('reading-list-status')
      : document.getElementById('hero-search-input');
    const target = nextControl || fallback;
    if (target) {
      if (!target.matches('a, button, select, input')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }

  function syncReadingCard(card, entry) {
    const title = card.querySelector('.card-title');
    title.title = entry.title;
    title.textContent = entry.title;
    card.setAttribute('aria-label', entry.title);
    const image = card.querySelector('.card-image');
    const poster = safeImageUrl(entry.poster);
    if (card.dataset.readingPoster !== poster) {
      card.dataset.readingPoster = poster;
      image.src = poster;
      image.hidden = false;
    }
    image.alt = `${entry.title} cover`;
    card.querySelector('.card-type').textContent = comicCardMeta(entry, entry.contentType);
    card.querySelector('.card-badge').textContent = readingStatusLabel(entry.readingStatus);
    const controls = card.querySelector('[data-reading-controls]');
    if (controls) syncReadingControl(controls, entry);
    const resume = card.querySelector('.reading-resume-summary');
    if (resume) resume.textContent = readingProgressText(entry);
    card.querySelector('[data-reading-remove]')?.setAttribute('aria-label', `Remove ${entry.title} from reading list`);
    card.querySelector('.reading-continue-link')?.setAttribute('aria-label', `Continue reading ${entry.title}`);
  }

  function reconcileReadingCards(grid, entries) {
    const existing = new Map([...grid.children].map(card => [card.dataset.readingIdentity, card]));
    const wanted = new Set(entries.map(entry => readingUtils.readingEntryKey(entry)));
    existing.forEach((card, key) => { if (!wanted.has(key)) card.remove(); });
    entries.forEach((entry, index) => {
      const key = readingUtils.readingEntryKey(entry);
      let card = existing.get(key);
      if (!card) {
        const template = document.createElement('template');
        template.innerHTML = renderComicCard(entry, grid.id);
        card = template.content.firstElementChild;
      } else {
        syncReadingCard(card, entry);
      }
      const before = grid.children[index] || null;
      if (before !== card) {
        // moveBefore preserves focus where supported; the fallback restores the
        // same control after reordering with change handlers guarded below.
        if (card.parentNode === grid && typeof grid.moveBefore === 'function') grid.moveBefore(card, before);
        else grid.insertBefore(card, before);
      }
    });
  }

  function renderReadingList() {
    const grid = document.getElementById('reading-list-grid');
    const empty = document.getElementById('reading-list-empty');
    const error = document.getElementById('reading-list-error');
    if (!grid || !empty || !error) return;
    const focus = captureReadingFocus(grid);
    const transientFocus = document.activeElement.closest?.('#reading-list-empty, #reading-list-error, #reading-list-no-results');
    const status = document.getElementById('reading-list-status');
    const failed = readingListLoad?.ok === false;
    const entries = failed ? [] : readingList.filter(entry =>
      (readingView.status === 'all' || entry.readingStatus === readingView.status) &&
      (readingView.type === 'all' || entry.contentType === readingView.type)
    ).sort(compareReadingEntries);
    const controls = { 'reading-list-status-filter': readingView.status, 'reading-list-type-filter': readingView.type, 'reading-list-sort': readingView.sort };
    Object.entries(controls).forEach(([id, value]) => {
      const control = document.getElementById(id);
      if (control) control.value = value;
    });
    setReadingVisible(error, failed, 'flex');
    setReadingVisible(empty, !failed && !readingList.length, 'flex');
    setReadingVisible(document.getElementById('reading-list-no-results'), !failed && !!readingList.length && !entries.length, 'flex');
    setReadingVisible(document.getElementById('reading-list-summary'), !failed);
    setReadingVisible(document.getElementById('reading-list-actions'), true);
    setReadingVisible(grid, !failed && !!entries.length, 'grid');
    const summaryIds = { reading: 'reading', completed: 'completed', plan_to_read: 'planned', on_hold: 'on-hold', dropped: 'dropped' };
    Object.entries(summaryIds).forEach(([value, suffix]) => {
      const count = document.getElementById(`reading-summary-${suffix}`);
      if (count) count.textContent = String(readingList.filter(entry => entry.readingStatus === value).length);
    });
    if (failed) {
      const message = document.getElementById('reading-list-error-message');
      if (message) message.textContent = `${readingListLoad.message || 'Saved reading data could not be loaded.'} Your saved data has not been cleared.`;
      if (status) status.textContent = 'Reading list unavailable. Retry to load saved titles.';
    } else if (status) {
      status.textContent = entries.length === readingList.length
        ? `${readingList.length} saved title${readingList.length === 1 ? '' : 's'}`
        : `Showing ${entries.length} of ${readingList.length} saved titles matching filters`;
    }
    reconcileReadingCards(grid, entries);
    restoreReadingFocus(grid, focus);
    if (transientFocus?.hidden && grid.closest('.page')?.classList.contains('active')) {
      const fallback = document.getElementById(failed ? 'reading-list-retry' : transientFocus.id === 'reading-list-no-results' ? 'reading-list-reset' : 'reading-list-status-filter');
      fallback?.focus({ preventScroll: true });
    }
  }

  function renderContinueReading() {
    const section = document.getElementById('section-continue-reading');
    const grid = document.getElementById('continue-reading-grid');
    if (!section || !grid) return;
    const focus = captureReadingFocus(grid);
    const entries = readingListLoad?.ok === false ? [] : readingList
      .filter(entry => entry.readingStatus === 'reading' &&
        (entry.totalChapters === null || entry.currentChapter < entry.totalChapters))
      .sort((a, b) => compareReadingEntries(a, b, 'updated')).slice(0, 6);
    setReadingVisible(section, !!entries.length, 'block');
    grid.hidden = !entries.length;
    reconcileReadingCards(grid, entries);
    restoreReadingFocus(grid, focus);
  }

  function toggleReadingEntry(item, category) {
    const entry = readingEntryForComic(item, category);
    if (!entry) return { ok: false, message: 'This comic cannot be saved.' };
    const key = readingUtils.readingEntryKey(entry);
    return savedReadingEntry(key) ? mutateReadingList('remove', key) : mutateReadingList('add', entry);
  }

  function renderComicReadingButton(item, category) {
    const entry = readingEntryForComic(item, category);
    if (!entry) return '';
    const saved = !!savedReadingEntry(readingUtils.readingEntryKey(entry));
    return `<button type="button" class="comic-reading-btn ${saved ? 'saved' : ''}" data-reading-toggle="${escapeHtml(String(entry.providerId))}" data-reading-category="${escapeHtml(category)}" data-reading-title="${escapeHtml(entry.title)}" data-reading-poster="${escapeHtml(entry.poster)}" data-reading-chapters="${entry.totalChapters === null ? '' : entry.totalChapters}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from reading list' : 'Add to reading list'}" title="${escapeHtml(entry.title)} — ${saved ? 'Remove from reading list' : 'Add to reading list'}">${saved ? '✓ Reading List' : '+ Reading List'}</button>`;
  }

  function syncComicReadingButtons() {
    document.querySelectorAll('[data-reading-toggle]').forEach(button => {
      const identity = `anilist:${button.dataset.readingCategory}:${button.dataset.readingToggle}`;
      const entry = savedReadingEntry(identity);
      const label = entry ? 'Remove from reading list' : 'Add to reading list';
      button.classList.toggle('saved', !!entry);
      button.textContent = entry ? '✓ Reading List' : '+ Reading List';
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(!!entry));
      button.title = `${entry?.title || button.dataset.readingTitle} — ${label}`;
      if (entry && button.closest('#continue-reading-grid')) {
        button.dataset.readingTitle = entry.title;
        button.dataset.readingPoster = entry.poster;
        button.dataset.readingChapters = entry.totalChapters === null ? '' : String(entry.totalChapters);
      }
    });
  }

  function renderComicReadingDetailControls() {
    const detail = document.getElementById('comic-detail-content');
    const button = detail?.querySelector('[data-reading-toggle]');
    const controls = detail?.querySelector('#comic-reading-detail-controls');
    if (!button || !controls) return;
    const key = `anilist:${button.dataset.readingCategory}:${button.dataset.readingToggle}`;
    const entry = readingListLoad?.ok === false ? null : savedReadingEntry(key);
    const active = document.activeElement;
    const hadFocus = controls.contains(active);
    const current = controls.querySelector('[data-reading-controls]');
    if (entry && current?.dataset.readingControls === key) syncReadingControl(current, entry);
    else if (entry) controls.innerHTML = renderReadingControls(entry);
    else if (readingListLoad?.ok === false) {
      if (!controls.querySelector('[data-reading-retry]')) {
        controls.innerHTML = '<p class="reading-storage-error" role="status">Reading-list storage is unavailable. <button class="comic-reading-btn" type="button" data-reading-retry>Retry reading list</button> <a href="?page=reading-list" data-reading-list-link>Open Reading List</a></p>';
      }
    } else controls.replaceChildren();
    if (hadFocus && !active.isConnected && detail.closest('.page')?.classList.contains('active')) button.focus({ preventScroll: true });
  }

  function syncReadingSurfaces() {
    const previous = syncingReadingUI;
    syncingReadingUI = true;
    try {
      renderReadingList();
      renderComicReadingDetailControls();
      renderContinueReading();
      syncComicReadingButtons();
    } finally {
      syncingReadingUI = previous;
    }
  }

  function refreshSavedComicMetadata(item, category) {
    const metadata = readingEntryForComic(item, category);
    const identity = metadata && readingUtils.readingEntryKey(metadata);
    const saved = identity && savedReadingEntry(identity);
    if (!saved || readingListLoad?.ok === false) return;
    const changes = {
      title: metadata.title === 'Untitled' ? saved.title : metadata.title,
      poster: metadata.poster || saved.poster,
      totalChapters: item.totalChapters === undefined && item.chapters === undefined ? saved.totalChapters : metadata.totalChapters
    };
    if (Object.entries(changes).every(([key, value]) => saved[key] === value)) return;
    // A metadata-specific store operation keeps completion normalization from
    // advancing user progress when the provider raises a completed title's total.
    const method = typeof readingStore?.updateMetadata === 'function' ? 'updateMetadata' : 'update';
    if (method === 'update' && saved.readingStatus === 'completed' && changes.totalChapters !== null && saved.currentChapter < changes.totalChapters) {
      showToast('Catalog metadata could not be refreshed; your saved chapter was kept.', 'error');
      return;
    }
    const result = mutateReadingList(method, identity, changes);
    if (!result.ok) showToast(result.message || 'Could not refresh catalog metadata; your saved progress was kept.', 'error');
    else syncReadingSurfaces();
  }

  function setComicState(category, state) {
    const page = document.getElementById(`page-${category}`);
    const grid = document.getElementById(`${category}-grid`);
    if (!page || !grid) return;
    page.querySelector('.comic-empty')?.toggleAttribute('hidden', state !== 'empty');
    page.querySelector('.comic-error')?.toggleAttribute('hidden', state !== 'error');
    grid.hidden = state === 'empty' || state === 'error';
  }

  async function loadComicCatalog(category, query = '', { append = false, sort = comicPages[category]?.sort || 'popularity' } = {}) {
    if (!COMIC_KINDS.includes(category)) return;
    const state = comicPages[category];
    if (state.loading) return;
    if (!append) {
      state.page = 1;
      state.query = query;
    }
    state.sort = sort;
    const requestPage = append ? state.page + 1 : 1;
    state.loading = true;
    const requestId = ++comicRequestId;
    const status = document.getElementById(`${category}-result-status`);
    setComicState(category, 'loading');
    if (!append) renderSkeletonGrid(`${category}-grid`, 8);
    if (status) status.textContent = query ? `Searching ${COMIC_LABELS[category].toLowerCase()}…` : `Loading ${COMIC_LABELS[category].toLowerCase()}…`;
    try {
      const params = new URLSearchParams({ page: String(requestPage), perPage: '20', sort: state.sort });
      if (query) params.set('q', query);
      const response = await fetchWithPolicy(`${baseURL}/${category}?${params.toString()}`, {}, { timeout: 'catalog', retries: 1 });
      if (!response.ok) throw new Error(`Comic catalog request failed: ${response.status}`);
      const items = comicItems(await response.json(), category);
      if (requestId !== comicRequestId) return;
      if (append) state.page = requestPage;
      state.failedAppend = false;
      state.hasNext = response.headers.get('X-Content-Has-Next') === 'true';
      document.getElementById(`${category}-load-more`)?.toggleAttribute('hidden', !state.hasNext);
      if (!items.length && !append) {
        setComicState(category, 'empty');
        if (status) status.textContent = query ? `No ${COMIC_LABELS[category].toLowerCase()} titles found for “${query}”.` : '';
        return;
      }
      setComicState(category, 'results');
      const grid = document.getElementById(`${category}-grid`);
      if (grid) grid.removeAttribute('aria-busy');
      if (append) {
        const existing = new Set([...grid.querySelectorAll('.anime-card')].map(card => card.dataset.id));
        const uniqueItems = items.filter(item => {
          const key = String(item.id);
          if (existing.has(key)) return false;
          existing.add(key);
          return true;
        });
        grid?.insertAdjacentHTML('beforeend', uniqueItems.map(item => renderAnimeCard(item, `${category}-grid`)).join(''));
      }
      else renderAnimeGrid(items, `${category}-grid`);
      const count = grid?.querySelectorAll('.anime-card').length || items.length;
      if (status) status.textContent = `${count} ${COMIC_LABELS[category].toLowerCase()} title${count === 1 ? '' : 's'} found`;
    } catch (error) {
      if (requestId !== comicRequestId) return;
      console.error(`Error loading ${category}:`, error);
      const grid = document.getElementById(`${category}-grid`);
      if (grid) grid.removeAttribute('aria-busy');
      if (append) {
        state.failedAppend = true;
        document.getElementById(`${category}-load-more`)?.toggleAttribute('hidden', true);
      }
      setComicState(category, 'error');
      if (status) status.textContent = '';
    } finally {
      state.loading = false;
    }
  }

  async function loadComicDetail(category, id, updateHistory = true) {
    if (!COMIC_KINDS.includes(category) || !id) return;
    const requestId = ++comicDetailRequestId;
    const content = document.getElementById('comic-detail-content');
    if (!content) return;
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    document.getElementById('page-comic-detail')?.classList.add('active');
    if (updateHistory) window.history.pushState({}, '', `?page=${category}&comicId=${encodeURIComponent(id)}`);
    content.innerHTML = '<div class="comic-detail-loading" role="status">Loading title details…</div>';
    updatePageSeo({ title: `${COMIC_LABELS[category]} title — AnimeHub`, description: `Discover this ${COMIC_LABELS[category].toLowerCase()} title on AnimeHub.`, url: `/?page=${category}&comicId=${encodeURIComponent(id)}` });
    try {
      const response = await fetchWithPolicy(`${baseURL}/${category}/${encodeURIComponent(id)}`, {}, { timeout: 'detail', retries: 1 });
      if (!response.ok) throw new Error(`Detail request failed: ${response.status}`);
      const item = normalizeComic(await response.json(), category);
      if (requestId !== comicDetailRequestId) return;
      if (!item) throw new Error('Comic details are unavailable.');
      refreshSavedComicMetadata(item, category);
      const title = comicTitle(item);
      const description = String(item.description || item.synopsis || 'No description available.').replace(/<[^>]*>/g, '').trim();
      const score = Number(item.rating ?? item.score ?? (item.averageScore ? Number(item.averageScore) / 10 : 0));
      const image = safeImageUrl(item.poster || item.image);
      const genres = Array.isArray(item.genres || item.genre) ? (item.genres || item.genre) : [];
      updatePageSeo({ title: `${title} (${COMIC_LABELS[category]}) — AnimeHub`, description: description.slice(0, 160), image, url: `/?page=${category}&comicId=${encodeURIComponent(id)}`, schema: { '@context': 'https://schema.org', '@type': 'Book', name: title, description: description.slice(0, 300), image, url: new URL(`/?page=${category}&comicId=${encodeURIComponent(id)}`, siteOrigin).href } });
       const staffNames = (item.staff?.edges || item.authors?.edges || []).map(edge => edge?.node?.name?.full).filter(Boolean);
       content.innerHTML = `<div class="comic-detail-content"><button class="back-btn" id="comic-detail-back" type="button">← Back to ${escapeHtml(COMIC_LABELS[category])}</button><div class="comic-detail-top"><img class="detail-poster" src="${escapeHtml(image)}" alt="${escapeHtml(title)} cover" data-fallback-src="${POSTER_FALLBACK}"><div class="detail-info"><p class="comic-detail-label">${escapeHtml(COMIC_LABELS[category])}</p><h1 class="detail-title">${escapeHtml(title)}</h1><div class="detail-tags">${genres.map(genre => `<span class="detail-tag genre-tag">${escapeHtml(genre)}</span>`).join('')}</div><div class="detail-meta-row"><span><b>Status:</b> ${escapeHtml(item.status || 'Not listed')}</span>${Number.isSafeInteger(item.chapters) && item.chapters > 0 ? `<span><b>Chapters:</b> ${escapeHtml(item.chapters)}</span>` : ''}${Number.isSafeInteger(item.volumes) && item.volumes > 0 ? `<span><b>Volumes:</b> ${escapeHtml(item.volumes)}</span>` : ''}${item.author ? `<span><b>Author:</b> ${escapeHtml(item.author)}</span>` : ''}${staffNames.length ? `<span><b>Staff:</b> ${escapeHtml(staffNames.slice(0, 3).join(', '))}</span>` : ''}</div><div class="detail-rating">★ ${score > 0 ? score.toFixed(1) : 'N/A'} / 10</div><p class="detail-description">${escapeHtml(description)}</p>${renderComicReadingButton(item, category)}<div id="comic-reading-detail-controls">${(() => { const entry = readingList.find(saved => readingUtils.readingEntryKey(saved) === `anilist:${category}:${item.id}`); return entry ? renderReadingControls(entry) : ''; })()}</div></div></div></div>`;
       syncReadingSurfaces();
    } catch (error) {
      if (requestId !== comicDetailRequestId) return;
      content.innerHTML = `<div class="empty-state comic-error"><div class="empty-icon" aria-hidden="true">⚠️</div><h1>Title details unavailable</h1><p>We couldn't load this ${escapeHtml(COMIC_LABELS[category].toLowerCase())} title. Saved reading-list entries are still available in your Reading List.</p><button class="cta-btn primary-btn" id="comic-detail-retry" type="button">Try again</button><button class="back-btn" id="comic-detail-back" type="button">← Back to ${escapeHtml(COMIC_LABELS[category])}</button><a class="cta-btn secondary-btn" href="?page=reading-list" data-reading-list-link>Open Reading List</a></div>`;
      document.getElementById('comic-detail-retry')?.addEventListener('click', () => loadComicDetail(category, id, false));
    }
    document.getElementById('comic-detail-back')?.addEventListener('click', () => {
      const state = comicPages[category];
      const params = new URLSearchParams({ page: category, comicSort: state.sort });
      if (state.query) params.set('comicSearch', state.query);
      window.history.pushState({}, '', `?${params.toString()}`);
      navigateToPage(category, false);
    });
    // A title link/retry leaves the old focused node hidden or removed. Place
    // keyboard/screen-reader focus on the newly loaded detail (or error) heading.
    if (document.getElementById('page-comic-detail')?.classList.contains('active')) {
      const heading = content.querySelector('h1');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      }
    }
  }

  // ============================================================
  // NAVIGATION & ROUTING
  // ============================================================

  async function navigateToPage(navName, updateHistory = true) {
    cancelComicDetailRequest();
    if (navName !== 'animated-movies') {
      cancelAnimatedMoviesRequest();
    }
    if (navName !== 'detail') {
      cancelDetailRequest();
    }
    if (navName === 'profile') {
      if (!getWatchlistAuthState().ready) {
        await window.animeHubAuthReady;
      }
      if (!getWatchlistAuthState().session) {
        if (!updateHistory) window.history.replaceState({}, '', '/');
        window.openAuthModal?.('login');
        return;
      }
    }

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    const targetPage = document.getElementById(`page-${navName}`);
    const activeLink = document.querySelector(`.nav-link[data-nav="${navName}"]`);

    if (targetPage) targetPage.classList.add('active');
    if (activeLink) activeLink.classList.add('active');

    if (updateHistory) {
      if (navName === 'popular') catalogPage = 1;
      window.history.pushState({}, '', navName === 'home' ? '/' : `?page=${navName}`);
    }

    window.scrollTo(0, 0);

    if (navName === 'home') {
      updatePageSeo();
      loadReadingList();
      syncReadingSurfaces();
      loadTrending();
      loadPopular();
    } else if (navName === 'popular') {
      updatePageSeo({
        title: 'Most Popular Anime Catalog — AnimeHub',
        description: 'Explore the highest-rated and most popular anime series and movies on AnimeHub.',
        url: '/?page=popular'
      });
      loadPopular();
      // Filter state comes from the URL so a refresh, a shared link and
      // Back/Forward all reproduce the same catalog view.
      await loadCatalogGenreOptions();
      applyCatalogFiltersFromUrl();
      await refreshCatalogPage('replace');
    } else if (navName === 'movies') {
      updatePageSeo({
        title: 'Anime Movies Catalog — AnimeHub',
        description: 'Discover feature-length anime films, release dates, ratings, and legal streaming options.',
        url: '/?page=movies'
      });
      loadMovies();
    } else if (navName === 'animated-movies') {
      updatePageSeo({
        title: 'Animated Movies Catalog — AnimeHub',
        description: 'Browse animated movies from Japan, China, the United States, and animation communities around the world.',
        url: '/?page=animated-movies'
      });
      populateAnimatedMovieYears();
      applyAnimatedMoviesFiltersFromUrl();
      // Navigation itself creates the page entry; normalize the selected
      // region/year/search into the same shareable URL without adding a second
      // history entry. Back/Forward re-enters through initPage().
      syncAnimatedMoviesUrl('replace');
      loadAnimatedMovies();
    } else if (navName === 'series') {
      updatePageSeo({
        title: 'Anime TV Series Catalog — AnimeHub',
        description: 'Browse top anime television series, broadcast schedules, episodes, and official trailers on AnimeHub.',
        url: '/?page=series'
      });
      loadSeries();
    } else if (navName === 'calendar') {
      applyCalendarFiltersFromUrl();
      updatePageSeo({
        title: 'Release Calendar — AnimeHub',
        description: 'Browse upcoming anime TV releases by season and week on AnimeHub.',
        url: `/?page=calendar&season=${calendarState.season}&year=${calendarState.year}`
      });
      syncCalendarUrl('replace');
      loadReleaseCalendar();
    } else if (navName === 'gallery') {
      applyGalleryFiltersFromUrl();
      updatePageSeo({
        title: 'Art Gallery — AnimeHub',
        description: 'Official posters, banners, key visuals, character art, and wallpapers with artist attribution.',
        url: `/?page=gallery${galleryState.category ? `&category=${encodeURIComponent(galleryState.category)}` : ''}${galleryState.search ? `&gallerySearch=${encodeURIComponent(galleryState.search)}` : ''}`
      });
      syncGalleryUrl();
      setupGalleryControls();
      loadGallery();
    } else if (COMIC_KINDS.includes(navName)) {
      const label = COMIC_LABELS[navName];
      updatePageSeo({
        title: `${label} Catalog — AnimeHub`,
        description: `Browse ${label.toLowerCase()} titles, creators, ratings, and story details on AnimeHub.`,
        url: `/?page=${navName}`
      });
      const params = new URLSearchParams(window.location.search);
      const search = params.get('comicSearch') || '';
      const sort = params.get('comicSort') || 'popularity';
      const input = document.getElementById(`${navName}-search`);
      if (input) input.value = search;
      const sortInput = document.getElementById(`${navName}-sort`);
      if (sortInput) sortInput.value = sort;
      loadComicCatalog(navName, search, { sort });
    } else if (navName === 'watchlist') {
      updatePageSeo({
        title: 'My Watchlist — AnimeHub',
        description: 'View and manage anime titles saved in this browser.',
        url: '/?page=watchlist'
      });
      loadWatchlist();
      setupWatchlistControls();
      if (typeof loadPersonalizedRecommendations === 'function') void loadPersonalizedRecommendations('watchlist-recommendations-grid', 'section-watchlist-recommendations');
    } else if (navName === 'reading-list') {
      updatePageSeo({
        title: 'My Reading List — AnimeHub',
        description: 'View and manage manga, manhwa, and manhua reading progress.',
        url: '/?page=reading-list'
      });
      loadReadingList();
      syncReadingSurfaces();
    } else if (navName === 'profile') {
      updatePageSeo({
        title: 'My Profile — AnimeHub',
        description: 'Manage your AnimeHub account and profile settings.',
        url: '/?page=profile'
      });
      loadProfileSettings();
      renderProfile();
    }
  }

  // ============================================================
  // PROFILE & PRIVACY CONTROLS (Item 38)
  // ============================================================
  //
  // Account settings are stored client-side (localStorage) and synced to the
  // cloud watchlist entry where a session exists, so preferences roam across
  // devices without requiring a new backend endpoint.

  const PROFILE_SETTINGS_KEY = 'anime_hub_profile_settings';
  const DEFAULT_PROFILE_SETTINGS = {
    watchlistVisibility: 'private',   // 'public' | 'private'
    shareActivity: false              // include watch updates in activity feeds
  };

  let profileSettings = { ...DEFAULT_PROFILE_SETTINGS };

  function loadProfileSettings() {
    try {
      const raw = localStorage.getItem(PROFILE_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          profileSettings = {
            watchlistVisibility: ['public', 'private'].includes(parsed.watchlistVisibility)
              ? parsed.watchlistVisibility
              : DEFAULT_PROFILE_SETTINGS.watchlistVisibility,
            shareActivity: Boolean(parsed.shareActivity)
          };
        }
      }
    } catch {
      // Keep defaults on any read error.
    }
    return profileSettings;
  }

  function saveProfileSettings() {
    try {
      localStorage.setItem(PROFILE_SETTINGS_KEY, JSON.stringify(profileSettings));
    } catch {
      // Storage unavailable; settings live only for this session.
    }
    return profileSettings;
  }

  function renderProfile() {
    const emailEl = document.getElementById('profile-email');
    const verifiedEl = document.getElementById('profile-verified-status');
    const visibilityToggle = document.getElementById('profile-watchlist-public');
    const activityToggle = document.getElementById('profile-activity-pref');

    const authState = getWatchlistAuthState();
    const session = authState.session;

    if (emailEl) {
      emailEl.textContent = (session && session.user && session.user.email) || 'Not logged in';
      emailEl.style.color = session ? 'var(--text)' : 'var(--text-muted)';
    }
    if (verifiedEl) {
      if (session && session.user) {
        const confirmed = session.user.email_confirmed_at;
        verifiedEl.textContent = confirmed
          ? 'Email verified'
          : 'Email not yet verified — check your inbox';
        verifiedEl.style.color = confirmed ? 'var(--success)' : 'var(--text-dim)';
      } else {
        verifiedEl.textContent = '';
      }
    }

    // Apply persisted settings.
    if (visibilityToggle) visibilityToggle.checked = profileSettings.watchlistVisibility === 'public';
    if (activityToggle) activityToggle.checked = profileSettings.shareActivity;

    // Wire toggles (idempotent via data-attr guard).
    if (visibilityToggle && !visibilityToggle.dataset.profileBound) {
      visibilityToggle.dataset.profileBound = 'true';
      visibilityToggle.addEventListener('change', () => {
        profileSettings.watchlistVisibility = visibilityToggle.checked ? 'public' : 'private';
        saveProfileSettings();
        showToast(
          profileSettings.watchlistVisibility === 'public'
            ? 'Watchlist is now public.'
            : 'Watchlist is now private.',
          'success'
        );
      });
    }
    if (activityToggle && !activityToggle.dataset.profileBound) {
      activityToggle.dataset.profileBound = 'true';
      activityToggle.addEventListener('change', () => {
        profileSettings.shareActivity = activityToggle.checked;
        saveProfileSettings();
        showToast(
          profileSettings.shareActivity
            ? 'Watch activity sharing enabled.'
            : 'Watch activity sharing disabled.',
          'info'
        );
      });
    }

    // Social follows & activity feed preview (Item 41).
    loadFollows();
    loadActivity();
    renderFollowingPreview();
    renderActivityFeed();
  }

  // ============================================================
  // SOCIAL FOLLOWS & ACTIVITY FEED (Item 41)
  // ============================================================
  //
  // Client-side follow graph and activity feed preview. Follows are stored in
  // localStorage (keyed as anime_hub_follows) and surfaced on the profile page
  // as a following/follower preview plus an activity feed of watchlist updates
  // from followed users. No backend endpoint is required; everything roams via
  // localStorage until a cloud follows API is wired up.

  const FOLLOWS_KEY = 'anime_hub_follows';
  const ACTIVITY_KEY = 'anime_hub_activity';
  const MAX_ACTIVITY_ITEMS = 50;

  let follows = new Set();
  let activityFeed = [];

  function loadFollows() {
    try {
      const raw = localStorage.getItem(FOLLOWS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) follows = new Set(parsed.map(String));
      }
    } catch {
      // Keep empty on read error.
    }
  }

  function saveFollows() {
    try {
      localStorage.setItem(FOLLOWS_KEY, JSON.stringify([...follows]));
    } catch {
      // Storage unavailable; follows live only for this session.
    }
  }

  function isFollowing(userId) {
    return follows.has(String(userId));
  }

  function toggleFollow(userId) {
    const id = String(userId);
    if (isFollowing(id)) {
      follows.delete(id);
      saveFollows();
      return false;
    }
    follows.add(id);
    saveFollows();
    addActivity({ type: 'follow', target: id, title: 'Started following a user' });
    return true;
  }

  function loadActivity() {
    try {
      const raw = localStorage.getItem(ACTIVITY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) activityFeed = parsed.slice(0, MAX_ACTIVITY_ITEMS);
      }
    } catch {
      // Keep empty on read error.
    }
  }

  function saveActivity() {
    try {
      localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activityFeed.slice(0, MAX_ACTIVITY_ITEMS)));
    } catch {
      // Storage unavailable.
    }
  }

  function addActivity(entry) {
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      createdAt: Date.now(),
      ...entry
    };
    activityFeed.unshift(item);
    saveActivity();
    return item;
  }

  function recordWatchlistActivity(title, poster, status) {
    if (!profileSettings.shareActivity) return;
    addActivity({
      type: 'watchlist',
      title,
      poster,
      status,
      label: `Updated watch status: ${status}`
    });
  }

  function renderFollowingPreview() {
    const container = document.getElementById('profile-following-preview');
    if (!container) return;
    container.replaceChildren(
      document.createElement('span'),
      ...[...follows].map(id => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'follow-chip';
        chip.textContent = id;
        chip.title = `Following ${id}`;
        chip.addEventListener('click', () => {
          toggleFollow(id);
          renderFollowingPreview();
          renderActivityFeed();
        });
        return chip;
      })
    );
    container.hidden = follows.size === 0;
  }

  function renderActivityFeed() {
    const container = document.getElementById('profile-activity-feed');
    const empty = document.getElementById('profile-activity-empty');
    if (!container) return;
    const feed = activityFeed.filter(item => {
      if (item.type === 'follow') return isFollowing(item.target);
      return true;
    });
    if (feed.length === 0) {
      container.replaceChildren();
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    container.replaceChildren(
      ...feed.map(item => {
        const card = document.createElement('article');
        card.className = 'activity-card';
        const when = new Date(item.createdAt).toLocaleString();
        let body = '';
        if (item.type === 'follow') {
          body = `Started following <strong>${escapeHtml(item.target)}</strong>.`;
        } else if (item.type === 'watchlist') {
          body = `${escapeHtml(item.label || '')} — <strong>${escapeHtml(item.title)}</strong>`;
        } else {
          body = escapeHtml(item.label || item.title || 'Activity update');
        }
        card.innerHTML = `
          <div class="activity-meta" style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${when}</div>
          <div class="activity-body" style="font-size:14px;color:var(--text);">${body}</div>
          ${item.poster ? `<img src="${escapeHtml(item.poster)}" alt="" class="activity-thumb" data-fallback-src="${POSTER_FALLBACK}">` : ''}
        `;
        return card;
      })
    );
  }

  // ============================================================
  // ANIME ART GALLERY (Items 42-50)
  // ============================================================
  //
  // Official-artwork gallery with category filtering, search, artist
  // attribution, copyright disclosures, and DMCA takedown report links.
  // Artwork entries are client-side curated; each item carries its source
  // and rights information so the gallery stays truthful about provenance.

  const GALLERY_CATEGORIES = ['Official Art', 'Key Visuals', 'Character Wallpapers', 'Fan Art'];

  const GALLERY_ARTWORK = [
    {
      id: 'gallery-001',
      title: 'Jujutsu Kaisen — Key Visual',
      category: 'Key Visuals',
      image: 'https://placehold.co/600x900/090c12/ff7200?text=Jujutsu+Kaisen+Key+Visual',
      artist: 'MAPPA',
      source: 'Official promotional art',
      copyright: '© Gege Akutami/Shueisha, Jujutsu Kaisen Production Committee',
      dmcaUrl: '/dmca.html',
      year: 2020
    },
    {
      id: 'gallery-002',
      title: 'Solo Leveling — Character Wallpaper',
      category: 'Character Wallpapers',
      image: 'https://placehold.co/600x900/090c12/ff7200?text=Solo+Leveling+Sung+Jin-Woo',
      artist: 'D&C Webtoon Biz / REDICE Studio',
      source: 'Official character art',
      copyright: '© Chugong / D&C Media / Redice Studio',
      dmcaUrl: '/dmca.html',
      year: 2024
    },
    {
      id: 'gallery-003',
      title: 'Demon Slayer — Kimetsu no Yaiba Official Poster',
      category: 'Official Art',
      image: 'https://placehold.co/600x900/090c12/ff7200?text=Demon+Slayer+Poster',
      artist: 'ufotable',
      source: 'Official theatrical poster',
      copyright: '© Koyoharu Gotouge/Shueisha, Aniplex, ufotable',
      dmcaUrl: '/dmca.html',
      year: 2019
    },
    {
      id: 'gallery-004',
      title: 'Attack on Titan — The Final Season Key Visual',
      category: 'Key Visuals',
      image: 'https://placehold.co/600x900/090c12/ff7200?text=Attack+on+Titan+Final+Season',
      artist: 'MAPPA',
      source: 'Official key visual',
      copyright: '© Hajime Isayama/Kodansha, Attack on Titan Production Committee',
      dmcaUrl: '/dmca.html',
      year: 2022
    },
    {
      id: 'gallery-005',
      title: 'Ne Zha — Character Wallpaper',
      category: 'Character Wallpapers',
      image: 'https://placehold.co/600x900/090c12/ff7200?text=Ne+Zha+Wallpaper',
      artist: 'Chengdu Coco Cartoon',
      source: 'Official character art',
      copyright: '© Chengdu Coco Cartoon',
      dmcaUrl: '/dmca.html',
      year: 2019
    },
    {
      id: 'gallery-006',
      title: 'The King\'s Avatar — Official Poster',
      category: 'Official Art',
      image: 'https://placehold.co/600x900/090c12/ff7200?text=The+Kings+Avatar+Poster',
      artist: 'B.CMAY PICTURES / Tencent',
      source: 'Official promotional poster',
      copyright: '© Butterfly Blue / Tencent Animation',
      dmcaUrl: '/dmca.html',
      year: 2017
    },
    {
      id: 'gallery-007',
      title: 'Link Click — Season 2 Key Visual',
      category: 'Key Visuals',
      image: 'https://placehold.co/600x900/090c12/ff7200?text=Link+Click+Season+2',
      artist: 'LAN Studio',
      source: 'Official key visual',
      copyright: '© LAN Studio, bilibili',
      dmcaUrl: '/dmca.html',
      year: 2021
    },
    {
      id: 'gallery-008',
      title: 'Fan Art — Gojo Satoru Interpretation',
      category: 'Fan Art',
      image: 'https://placehold.co/600x900/090c12/ff7200?text=Fan+Art+Gojo+Satoru',
      artist: 'Community contributor',
      source: 'Fan-submitted illustration',
      copyright: 'Fan art based on Jujutsu Kaisen (© Gege Akutami/Shueisha). Not official.',
      dmcaUrl: '/dmca.html',
      year: 2024
    }
  ];

  const galleryState = {
    category: '',
    search: '',
    page: 1,
    perPage: 12
  };

  function filteredGalleryArtwork() {
    let items = GALLERY_ARTWORK;
    if (galleryState.category) {
      items = items.filter(item => item.category === galleryState.category);
    }
    if (galleryState.search) {
      const term = galleryState.search.toLowerCase();
      items = items.filter(item =>
        item.title.toLowerCase().includes(term) ||
        item.artist.toLowerCase().includes(term) ||
        item.category.toLowerCase().includes(term)
      );
    }
    return items;
  }

  function renderGalleryArtwork(items) {
    const grid = document.getElementById('gallery-grid');
    const empty = document.getElementById('gallery-empty');
    const countEl = document.getElementById('gallery-count');
    if (!grid) return;

    const total = filteredGalleryArtwork().length;
    if (countEl) countEl.textContent = `${total} artwork${total !== 1 ? 's' : ''}`;

    if (items.length === 0) {
      grid.style.display = 'none';
      if (empty) empty.hidden = false;
      return;
    }
    grid.style.display = 'grid';
    if (empty) empty.hidden = true;

    grid.replaceChildren(
      ...items.map(item => {
        const card = document.createElement('article');
        card.className = 'gallery-card';
        card.innerHTML = `
          <div class="gallery-image-wrap">
            <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" class="gallery-image" data-fallback-src="${POSTER_FALLBACK}">
            <div class="gallery-badge">${escapeHtml(item.category)}</div>
          </div>
          <div class="gallery-info">
            <h3 class="gallery-title">${escapeHtml(item.title)}</h3>
            <p class="gallery-artist">by ${escapeHtml(item.artist)}</p>
            <p class="gallery-source" style="font-size:12px;color:var(--text-muted);">${escapeHtml(item.source)} (${item.year})</p>
            <p class="gallery-copyright" style="font-size:11px;color:var(--text-dim);margin-top:6px;">${escapeHtml(item.copyright)}</p>
            <a href="${escapeHtml(item.dmcaUrl)}" class="gallery-dmca" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:var(--primary);">Report copyright / DMCA takedown</a>
          </div>
        `;
        return card;
      })
    );
  }

  function applyGalleryFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const category = params.get('category') || '';
    const search = params.get('gallerySearch') || '';
    galleryState.category = GALLERY_CATEGORIES.includes(category) ? category : '';
    galleryState.search = search;
    const catSelect = document.getElementById('gallery-category');
    const searchInput = document.getElementById('gallery-search');
    if (catSelect) catSelect.value = galleryState.category;
    if (searchInput) searchInput.value = galleryState.search;
  }

  function syncGalleryUrl() {
    const params = new URLSearchParams();
    if (galleryState.category) params.set('category', galleryState.category);
    if (galleryState.search) params.set('gallerySearch', galleryState.search);
    const next = `?${params.toString()}`;
    if (window.location.search !== next) window.history.pushState({}, '', next);
  }

  async function loadGallery() {
    const grid = document.getElementById('gallery-grid');
    const empty = document.getElementById('gallery-empty');
    const error = document.getElementById('gallery-error');
    if (!grid) return;
    grid.setAttribute('aria-busy', 'true');
    renderSkeletonGrid('gallery-grid', 8);
    if (empty) empty.hidden = true;
    if (error) error.hidden = true;
    try {
      const items = filteredGalleryArtwork().slice((galleryState.page - 1) * galleryState.perPage, galleryState.page * galleryState.perPage);
      renderGalleryArtwork(items);
    } catch (error) {
      console.error('Error loading gallery:', error);
      grid.replaceChildren();
      grid.style.display = 'none';
      if (empty) empty.hidden = true;
      if (error) error.hidden = false;
    } finally {
      grid.removeAttribute('aria-busy');
    }
  }

  let galleryControlsBound = false;
  function setupGalleryControls() {
    if (galleryControlsBound) return;
    galleryControlsBound = true;
    const catSelect = document.getElementById('gallery-category');
    const searchInput = document.getElementById('gallery-search');
    const resetBtn = document.getElementById('gallery-reset');
    const resetEmpty = document.getElementById('gallery-reset-empty');
    const retryBtn = document.getElementById('gallery-retry');
    if (catSelect) {
      catSelect.value = galleryState.category;
      catSelect.addEventListener('change', () => {
        galleryState.category = catSelect.value;
        galleryState.page = 1;
        syncGalleryUrl();
        loadGallery();
      });
    }
    if (searchInput) {
      searchInput.value = galleryState.search;
      searchInput.addEventListener('input', () => {
        galleryState.search = searchInput.value.trim();
        galleryState.page = 1;
        syncGalleryUrl();
        loadGallery();
      });
    }
    if (resetBtn) resetBtn.addEventListener('click', () => {
      galleryState.category = '';
      galleryState.search = '';
      galleryState.page = 1;
      if (catSelect) catSelect.value = '';
      if (searchInput) searchInput.value = '';
      syncGalleryUrl();
      loadGallery();
    });
    if (resetEmpty) resetEmpty.addEventListener('click', () => {
      galleryState.category = '';
      galleryState.search = '';
      galleryState.page = 1;
      if (catSelect) catSelect.value = '';
      if (searchInput) searchInput.value = '';
      syncGalleryUrl();
      loadGallery();
    });
    if (retryBtn) retryBtn.addEventListener('click', loadGallery);
  }

  async function loadMovies() {
    renderSkeletonGrid('movies-grid', 6);
    try {
      const res = await fetchWithPolicy(`${baseURL}/movies`, {}, { timeout: 'catalog', retries: 1 });
      if (!res.ok) throw new Error(`Movies request failed: ${res.status}`);
      const data = await res.json();
      // `/api/movies` already filters to films; this keeps the page honest even
      // if a cached or curated fallback payload ever carries another format.
      const movies = (Array.isArray(data) ? data : []).filter(isMovieEntry);
      const emptyState = document.getElementById('movies-empty');
      const grid = document.getElementById('movies-grid');
      
      if (movies.length === 0) {
        if (grid) grid.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
      } else {
        if (grid) grid.style.display = 'grid';
        if (emptyState) emptyState.style.display = 'none';
        renderAnimeGrid(movies, 'movies-grid');
      }
    } catch (err) {
      console.error('Error loading movies:', err);
      renderCatalogLoadError('movies-grid', 'Unable to load movies. Check your connection and try again.', loadMovies);
    }
  }

  async function loadSeries() {
    renderSkeletonGrid('series-grid', 8);
    try {
      const res = await fetchWithPolicy(`${baseURL}/series`, {}, { timeout: 'catalog', retries: 1 });
      if (!res.ok) throw new Error(`Series request failed: ${res.status}`);
      const data = await res.json();
      // `/api/series` already filters to television formats; without this the
      // page used to render the whole catalog, films included.
      renderAnimeGrid((Array.isArray(data) ? data : []).filter(isSeriesEntry), 'series-grid');
    } catch (err) {
      console.error('Error loading series:', err);
      renderCatalogLoadError('series-grid', 'Unable to load series. Check your connection and try again.', loadSeries);
    }
  }

  function renderWatchlist() {
    const grid = document.getElementById('watchlist-grid');
    const emptyState = document.getElementById('watchlist-empty');

    if (watchlist.length === 0) {
      if (grid) grid.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
    } else {
      if (emptyState) emptyState.style.display = 'none';
      if (grid) grid.style.display = 'grid';
      // Inline sort keeps this function self-contained for the watchlist test
      // harness, which extracts renderWatchlist verbatim into a vm sandbox.
      const sort = typeof watchlistSort === 'string' ? watchlistSort : 'dateAdded';
      const sorted = [...watchlist];
      if (sort === 'title') {
        sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
      } else if (sort === 'rating') {
        sorted.sort((a, b) => Number(b.rating ?? b.averageScore ?? 0) - Number(a.rating ?? a.averageScore ?? 0));
      } else if (sort === 'progress') {
        sorted.sort((a, b) => {
          const progressA = a.totalEpisodes ? Number(a.currentEpisode) / Number(a.totalEpisodes) : 0;
          const progressB = b.totalEpisodes ? Number(b.currentEpisode) / Number(b.totalEpisodes) : 0;
          return progressB - progressA;
        });
      } else {
        // dateAdded: newest first; fall back to id for stability.
        sorted.sort((a, b) => Number(b.addedAt || b.id || 0) - Number(a.addedAt || a.id || 0));
      }
      renderAnimeGrid(sorted, 'watchlist-grid');
    }
  }

  let watchlistControlsSetup = false;
  function setupWatchlistControls() {
    if (watchlistControlsSetup) return;
    watchlistControlsSetup = true;
    const sortSelect = document.getElementById('watchlist-sort');
    if (sortSelect) {
      sortSelect.value = watchlistSort;
      sortSelect.addEventListener('change', (event) => {
        watchlistSort = event.target.value;
        renderWatchlist();
      });
    }
    const exportBtn = document.getElementById('watchlist-export');
    if (exportBtn) exportBtn.addEventListener('click', exportWatchlist);
    const importBtn = document.getElementById('watchlist-import');
    const importFile = document.getElementById('watchlist-import-file');
    if (importBtn) importBtn.addEventListener('click', () => importFile?.click());
    if (importFile) {
      importFile.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        if (file) importWatchlistFile(file);
        event.target.value = '';
      });
    }
  }

  function exportWatchlist() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      itemCount: watchlist.length,
      items: watchlist.map(item => ({
        id: item.id,
        title: item.title,
        type: item.type,
        rating: item.rating,
        watchStatus: item.watchStatus,
        currentEpisode: item.currentEpisode,
        totalEpisodes: item.totalEpisodes,
        tags: item.tags || [],
        addedAt: item.addedAt
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `animehub-watchlist-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    addNotification({ type: 'success', title: 'Watchlist exported', message: `${watchlist.length} title(s) exported.` });
  }

  async function importWatchlistFile(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.items)
          ? parsed.items
          : null;
      if (!items) {
        throw new Error('Invalid watchlist file: expected an array or { items: [...] }.');
      }
      const validated = items.map((value, index) => validateWatchlistImportItem(value, index));
      const existingIds = new Set(watchlist.map(saved => String(saved.id)));
      const newItems = validated.filter(item => !existingIds.has(String(item.id)));
      if (!newItems.length) {
        addNotification({ type: 'info', title: 'Import complete', message: 'No new titles to import.' });
        return;
      }
      watchlist.push(...newItems);
      saveWatchlist();
      if (getWatchlistAuthState().session && window.animeHubCloudWatchlist) {
        await Promise.all(newItems.map(item => window.animeHubCloudWatchlist.add(item)));
      }
      renderWatchlist();
      if (typeof renderContinueWatching === 'function') renderContinueWatching();
      addNotification({ type: 'success', title: 'Watchlist imported', message: `${newItems.length} title(s) imported.` });
    } catch (error) {
      console.error('Watchlist import failed:', error);
      showToast(`Import failed: ${error.message}`, 'error');
    }
  }

  function validateWatchlistImportItem(value, index) {
    const where = `item #${index + 1}`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${where} must be an object.`);
    }
    if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1) {
      throw new Error(`${where} must have a numeric id.`);
    }
    if (typeof value.title !== 'string' || !value.title.trim()) {
      throw new Error(`${where} must have a title.`);
    }
    if (typeof value.type !== 'string' || !value.type.trim()) {
      throw new Error(`${where} must have a type.`);
    }
    if (value.watchStatus !== undefined && !WATCH_STATUS_VALUES.includes(String(value.watchStatus))) {
      throw new Error(`${where} has an invalid watch status.`);
    }
    if (value.currentEpisode !== undefined) {
      const ep = Number(value.currentEpisode);
      if (!Number.isSafeInteger(ep) || ep < 0) throw new Error(`${where} has an invalid current episode.`);
    }
    if (value.totalEpisodes !== undefined) {
      const total = Number(value.totalEpisodes);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${where} has an invalid total episode count.`);
    }
    if (value.tags !== undefined && !Array.isArray(value.tags)) {
      throw new Error(`${where} tags must be an array.`);
    }
    return {
      id: value.id,
      title: String(value.title).trim(),
      type: String(value.type).trim(),
      rating: value.rating !== undefined ? Number(value.rating) : undefined,
      watchStatus: value.watchStatus || 'plan_to_watch',
      currentEpisode: value.currentEpisode !== undefined ? Number(value.currentEpisode) : 0,
      totalEpisodes: value.totalEpisodes !== undefined ? Number(value.totalEpisodes) : null,
      tags: Array.isArray(value.tags) ? value.tags.map(String).filter(Boolean) : [],
      addedAt: value.addedAt || Date.now()
    };
  }

  // In-app notifications panel (watchlist updates + new-episode alerts).
  let notificationsPanelOpen = false;
  function setupNotifications() {
    const trigger = document.getElementById('nav-notification-trigger');
    const panel = document.getElementById('notifications-panel');
    const backdrop = document.getElementById('notifications-backdrop');
    const closeBtn = document.getElementById('notifications-close');
    if (!trigger || !panel || !backdrop || !closeBtn) return;
    function openPanel() {
      panel.hidden = false;
      backdrop.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      notificationsPanelOpen = true;
      renderNotifications();
    }
    function closePanel() {
      panel.hidden = true;
      backdrop.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      notificationsPanelOpen = false;
    }
    trigger.addEventListener('click', () => {
      if (notificationsPanelOpen) closePanel(); else openPanel();
    });
    closeBtn.addEventListener('click', closePanel);
    backdrop.addEventListener('click', closePanel);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && notificationsPanelOpen) closePanel();
    });
  }
  setupNotifications();

  // Continue Watching is a title-level resume shelf, not a playback system.
  // It uses the same guest/cloud watchlist source and shows only unfinished
  // entries with positive progress, so it remains safe across reloads and
  // never invents episode or streaming data.
  function renderContinueWatching() {
    const section = document.getElementById('section-continue-watching');
    const inProgress = watchlist
      .filter(item => Number(item.currentEpisode) > 0 && item.watchStatus !== 'completed')
      .sort((a, b) => Number(b.updatedAt || b.updated_at || 0) - Number(a.updatedAt || a.updated_at || 0));
    if (!section) return;
    section.style.display = inProgress.length ? 'block' : 'none';
    if (inProgress.length) renderAnimeGrid(inProgress.slice(0, 6), 'continue-watching-grid');
  }

  // Inline error state for a failed cloud watchlist load. Built with DOM APIs
  // rather than an innerHTML string so no markup is interpolated, and it clears
  // the skeletons renderSkeletonGrid left behind (AH-004a).
  function renderWatchlistError() {
    const grid = document.getElementById('watchlist-grid');
    const emptyState = document.getElementById('watchlist-empty');
    if (emptyState) emptyState.style.display = 'none';
    if (!grid) return;
    // One container keeps the AH-004a contract (a single hint element) while
    // giving the "Please try again" message the retry action it promised; a
    // full page reload used to be the only way out.
    const state = document.createElement('div');
    state.className = 'watch-progress-hint';
    const message = document.createElement('p');
    message.textContent = 'Unable to load your watchlist. Please try again.';
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'cta-btn secondary-btn';
    retryButton.textContent = 'Try again';
    retryButton.addEventListener('click', () => {
      // Disabled before the load starts, so a second click can never queue a
      // duplicate request; a repeated failure re-renders this same state.
      retryButton.disabled = true;
      void loadWatchlist();
    });
    state.append(message, retryButton);
    grid.replaceChildren(state);
    grid.style.display = 'grid';
  }

  // Repair legacy guest entries that predate `type` persistence: the catalog
  // is the authoritative format source, so each untyped entry is hydrated
  // once via /api/anime/:id and the repaired type is persisted. A failed
  // lookup leaves the entry completely untouched (never guess from episode
  // counts). Entries already carrying a `type` are never re-fetched, so this
  // converges after the first successful visit.
  async function repairUntypedWatchlistEntries() {
    const untyped = watchlist.filter(item => !item.type);
    if (!untyped.length) return;
    const repairs = await Promise.all(untyped.map(async item => {
      try {
        const response = await fetchWithPolicy(`${baseURL}/anime/${encodeURIComponent(String(item.id))}`, {}, { timeout: 'detail', retries: 1 });
        if (!response.ok) return null;
        const media = await response.json();
        const type = animeTypeValue(media);
        return type ? { id: String(item.id), type } : null;
      } catch {
        return null;
      }
    }));

    // Re-resolve by id on the CURRENT array. An `animehub:auth-state` refresh
    // can replace `watchlist` (with a freshly parsed, still-untyped copy) while
    // these requests are in flight; mutating the discarded array would persist
    // nothing and the entry would stay untyped on the next render.
    let repaired = false;
    for (const repair of repairs) {
      if (!repair) continue;
      const target = watchlist.find(entry => String(entry.id) === repair.id && !entry.type);
      if (!target) continue;
      target.type = repair.type;
      repaired = true;
    }
    if (repaired) saveWatchlist();
  }

  async function loadWatchlist() {
    const authState = getWatchlistAuthState();
    if (authState.ready && authState.session && window.animeHubCloudWatchlist) {
      renderSkeletonGrid('watchlist-grid', 6);
      try {
        watchlist = await window.animeHubCloudWatchlist.list();
      } catch (error) {
        console.error('Could not load cloud watchlist:', error);
        const grid = document.getElementById('watchlist-grid');
        if (grid) grid.removeAttribute('aria-busy');
        showToast('Could not load your cloud watchlist. Please try again.', 'error');
        renderWatchlistError();
        return;
      }
    } else {
      // Guest path only: cloud items already carry `type` from hydration.
      await repairUntypedWatchlistEntries();
    }
    renderWatchlist();
    if (typeof renderContinueWatching === 'function') renderContinueWatching();
    if (typeof loadPersonalizedRecommendations === 'function') void loadPersonalizedRecommendations('watchlist-recommendations-grid', 'section-watchlist-recommendations');
  }

  window.addEventListener('animehub:auth-state', async event => {
    const requestId = ++watchlistAuthRequestId;
    const authenticatedUserId = event.detail?.userId || null;
    try {
      const nextWatchlist = event.detail?.authenticated
        ? await window.animeHubCloudWatchlist.list()
        : loadLocalWatchlist();
      if (requestId !== watchlistAuthRequestId) return;
      const currentAuthState = getWatchlistAuthState();
      if ((currentAuthState.session?.user?.id || null) !== authenticatedUserId) return;
      watchlist = nextWatchlist;
      if (document.getElementById('page-watchlist')?.classList.contains('active')) {
        renderWatchlist();
      }
      if (typeof renderContinueWatching === 'function') renderContinueWatching();
      if (document.getElementById('page-watchlist')?.classList.contains('active')) {
        void loadPersonalizedRecommendations('watchlist-recommendations-grid', 'section-watchlist-recommendations');
      }
    } catch (error) {
      console.error('Could not refresh watchlist after authentication changed:', error);
      showToast('Could not refresh your watchlist.', 'error');
    }
  });

  // ============================================================
  // INITIALIZE PAGE
  // ============================================================

  async function initPage() {
    if (typeof renderContinueWatching === 'function') renderContinueWatching();
    const urlParams = new URLSearchParams(window.location.search);
    const query = urlParams.get('q');
    const id = urlParams.get('id');
    const page = urlParams.get('page');
    const comicId = urlParams.get('comicId');
    // Search and ordinary pages are reached directly by Back/Forward too;
    // those branches do not go through navigateToPage, so explicitly cancel a
    // detail request before replacing the visible page.
    if (!id) cancelDetailRequest();
    if (!comicId) cancelComicDetailRequest();
    // Legacy `catalogPage` links predate Load more: their filters are still
    // rehydrated below, and paging restarts at page 1 (the next URL write
    // normalises the stale parameter away).

    if (comicId && COMIC_KINDS.includes(page)) {
      await loadComicDetail(page, comicId, false);
    } else if (id) {
      await loadAnimeDetails(id, false);
    } else if (query) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-search').classList.add('active');
      const searchLabel = document.getElementById('search-query-label');
      if (searchLabel) searchLabel.textContent = query;
      updatePageSeo({
        title: `Search: "${query}" — AnimeHub`,
        description: `Explore anime search results for "${query}" on AnimeHub discovery catalog.`,
        url: `/?q=${encodeURIComponent(query)}`
      });
      await performSearch(query);
    } else if (['home', 'popular', 'movies', 'animated-movies', 'series', 'calendar', 'gallery', 'watchlist', 'reading-list', 'profile', ...COMIC_KINDS].includes(page)) {
      navigateToPage(page, false);
    } else {
      if (page) window.history.replaceState({}, '', '/');
      navigateToPage('home', false);
    }
  }

  // ============================================================
  // EVENT LISTENERS & DELEGATION
  // ============================================================

  // Search Triggers
  const closeSuggestionPanels = [];

  function triggerSearch(query) {
    if (!query) return;
    cancelDetailRequest();
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-search').classList.add('active');
    window.history.pushState({}, '', `?q=${encodeURIComponent(query)}`);

    const searchLabel = document.getElementById('search-query-label');
    if (searchLabel) searchLabel.textContent = query;

    updatePageSeo({
      title: `Search: "${query}" — AnimeHub`,
      description: `Explore anime search results for "${query}" on AnimeHub discovery catalog.`,
      url: `/?q=${encodeURIComponent(query)}`
    });

    performSearch(query);

    // Close search overlay if open
    const searchOverlay = document.getElementById('search-overlay');
    if (searchOverlay) {
      searchOverlay.classList.remove('open');
      searchOverlay.hidden = true;
    }
    document.getElementById('nav-search-trigger')?.setAttribute('aria-expanded', 'false');
    closeSuggestionPanels.forEach(close => close());
  }

  const suggestionCache = new Map();

  function connectAutocomplete(inputId, suggestionsId, optionsId, statusId) {
    const input = document.getElementById(inputId);
    const panel = document.getElementById(suggestionsId);
    const options = document.getElementById(optionsId);
    const status = document.getElementById(statusId);
    if (!input || !panel || !options || !status) return;

    const state = { items: [], activeIndex: -1, timer: null, controller: null, lastQuery: '', requestId: 0 };

    function closeSuggestions() {
      clearTimeout(state.timer);
      state.controller?.abort();
      state.requestId += 1;
      state.lastQuery = '';
      panel.hidden = true;
      options.replaceChildren();
      status.textContent = '';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      state.items = [];
      state.activeIndex = -1;
      if (inputId === 'search-overlay-input') input.value = '';
    }

    closeSuggestionPanels.push(closeSuggestions);

    function selectSuggestion(index) {
      const item = state.items[index];
      if (!item) return;
      const title = getAnimeTitle(item);
      input.value = title;
      closeSuggestions();
      triggerSearch(title);
    }

    function updateActiveOption() {
      const optionElements = options.querySelectorAll('[role="option"][data-index]');
      optionElements.forEach((option, index) => {
        const selected = index === state.activeIndex;
        option.setAttribute('aria-selected', String(selected));
        option.classList.toggle('active', selected);
      });
      const activeOption = optionElements[state.activeIndex];
      if (activeOption) {
        input.setAttribute('aria-activedescendant', activeOption.id);
        activeOption.scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function showResults(items) {
      state.items = items.slice(0, 6);
      state.activeIndex = -1;
      options.innerHTML = state.items.map((item, index) => {
        const title = getAnimeTitle(item);
        const format = item.format || item.type || 'Anime';
        const year = item.seasonYear || item.year || '';
        const rating = Number(item.averageScore || (item.rating ? item.rating * 10 : 0));
        const detail = [format, year, rating ? `★ ${(rating / 10).toFixed(1)}` : ''].filter(Boolean).join(' · ');
        return `<li id="${inputId}-option-${index}" role="option" aria-selected="false" data-index="${index}">
          <span>${escapeHtml(title)}</span>
          <small>${escapeHtml(detail)}</small>
        </li>`;
      }).join('');
      status.textContent = state.items.length ? '' : 'No anime found.';
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    input.addEventListener('input', () => {
      const query = input.value.trim().replace(/\s+/g, ' ');
      const normalizedQuery = query.toLowerCase();
      if (query.length < 2) {
        closeSuggestions();
        return;
      }
      if (normalizedQuery === state.lastQuery) return;

      state.lastQuery = normalizedQuery;
      state.requestId += 1;
      const requestId = state.requestId;
      clearTimeout(state.timer);
      state.controller?.abort();
      state.activeIndex = -1;
      state.items = [];
      options.replaceChildren();
      input.removeAttribute('aria-activedescendant');

      const cached = suggestionCache.get(normalizedQuery);
      if (cached) {
        showResults(cached);
        return;
      }

      status.textContent = 'Searching…';
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      state.timer = setTimeout(async () => {
        state.timer = null;
        state.controller = new AbortController();
        try {
          const response = await fetchWithPolicy(`${baseURL}/search/suggestions?q=${encodeURIComponent(query)}`, {
            signal: state.controller.signal
          }, { timeout: 'suggestions', retries: 0 });
          if (!response.ok) throw new Error(`Suggestions request failed: ${response.status}`);
          const results = await response.json();
          if (requestId !== state.requestId || input.value.trim().replace(/\s+/g, ' ').toLowerCase() !== normalizedQuery) return;
          if (suggestionCache.size >= 50) {
            suggestionCache.delete(suggestionCache.keys().next().value);
          }
          suggestionCache.set(normalizedQuery, results);
          showResults(results);
        } catch (error) {
          if (error.name === 'AbortError' || requestId !== state.requestId) return;
          console.error('Unable to load search suggestions:', error);
          status.textContent = 'Suggestions unavailable. Press Enter to search.';
        }
      }, 180);
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!state.items.length) return;
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        state.activeIndex = (state.activeIndex + direction + state.items.length) % state.items.length;
        updateActiveOption();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (state.activeIndex >= 0) selectSuggestion(state.activeIndex);
        else triggerSearch(input.value.trim());
      } else if (event.key === 'Escape' && !panel.hidden && inputId !== 'search-overlay-input') {
        event.preventDefault();
        closeSuggestions();
      } else if (event.key === 'Escape' && inputId === 'search-overlay-input') {
        event.preventDefault();
        _closeOverlaySuggestions();
        closeSearchOverlay(true);
      }
    });

    options.addEventListener('pointerdown', event => {
      if (event.target.closest('[role="option"][data-index]')) event.preventDefault();
    });

    options.addEventListener('click', event => {
      const option = event.target.closest('[role="option"][data-index]');
      if (option) selectSuggestion(Number(option.dataset.index));
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (inputId === 'search-overlay-input' && document.getElementById('search-overlay')?.classList.contains('open')) return;
        if (!panel.contains(document.activeElement)) closeSuggestions();
      }, 100);
    });

    input.addEventListener('focus', () => {
      if (state.items.length) {
        panel.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      }
    });

    // Return closeSuggestions so callers can invoke it after listeners exist.
    return closeSuggestions;
  }

  const _closeHeroSuggestions = connectAutocomplete('hero-search-input', 'hero-search-suggestions', 'hero-search-options', 'hero-search-status');
  const _closeOverlaySuggestions = connectAutocomplete('search-overlay-input', 'nav-search-suggestions', 'nav-search-options', 'nav-search-status');

  const filterForm = document.getElementById('catalog-filter-form');
  filterForm?.addEventListener('change', () => {
    catalogPage = 1;
    refreshCatalogPage('push');
  });
  filterForm?.addEventListener('reset', () => {
    catalogPage = 1;
    // Wait for the form controls to actually reset before reading them back.
    setTimeout(() => refreshCatalogPage('push'), 0);
  });

  const calendarFilterForm = document.getElementById('calendar-filter-form');
  calendarFilterForm?.addEventListener('submit', event => {
    event.preventDefault();
    const season = document.getElementById('calendar-season')?.value;
    const year = Number(document.getElementById('calendar-year')?.value);
    if (!CALENDAR_SEASONS.includes(season) || !Number.isInteger(year)) return;
    calendarState.season = season;
    calendarState.year = year;
    calendarState.seasonYear = year;
    void loadReleaseCalendar({ historyMode: 'push' });
  });
  document.getElementById('calendar-load-more-btn')?.addEventListener('click', () => {
    void loadReleaseCalendar({ append: true });
  });
  document.getElementById('calendar-retry')?.addEventListener('click', () => {
    void loadReleaseCalendar({ historyMode: 'replace' });
  });

  const searchFilterForm = document.getElementById('search-filter-form');
  searchFilterForm?.addEventListener('change', applySearchFilters);
  searchFilterForm?.addEventListener('reset', () => {
    setTimeout(applySearchFilters, 0);
  });
  document.getElementById('search-clear-filters-btn')?.addEventListener('click', () => {
    searchFilterForm?.reset();
  });

  document.querySelectorAll('.comic-search-form').forEach(form => {
    form.addEventListener('submit', event => {
      event.preventDefault();
      const category = form.dataset.comicSearch;
      if (!COMIC_KINDS.includes(category)) return;
      const query = String(new FormData(form).get('q') || '').trim();
      const sort = document.getElementById(`${category}-sort`)?.value || 'popularity';
      const params = new URLSearchParams({ page: category, comicSort: sort });
      if (query) params.set('comicSearch', query);
      window.history.pushState({}, '', `?${params.toString()}`);
      loadComicCatalog(category, query, { sort });
    });
  });

  const animatedMoviesSearchForm = document.getElementById('animated-movies-search-form');
  animatedMoviesSearchForm?.addEventListener('submit', event => {
    event.preventDefault();
    animatedMoviesState.query = String(new FormData(animatedMoviesSearchForm).get('search') || '').trim().slice(0, 100);
    syncAnimatedMoviesUrl('push');
    renderAnimatedMoviesResults();
  });

  document.querySelectorAll('#animated-movies-region-filter [data-country-of-origin]').forEach(button => {
    button.addEventListener('click', () => {
      const origin = button.dataset.countryOfOrigin;
      if (!ANIMATED_MOVIE_ORIGIN_CODES.includes(origin) || origin === animatedMoviesState.countryOfOrigin) return;
      animatedMoviesState.countryOfOrigin = origin;
      setAnimatedMoviesRegionButtons();
      void loadAnimatedMovies({ historyMode: 'push' });
    });
  });

  const animatedMoviesFilterForm = document.getElementById('animated-movies-filter-form');
  animatedMoviesFilterForm?.addEventListener('change', () => {
    void loadAnimatedMovies({ historyMode: 'push' });
  });
  animatedMoviesFilterForm?.addEventListener('reset', () => {
    setTimeout(() => {
      void loadAnimatedMovies({ historyMode: 'push' });
    }, 0);
  });

  document.getElementById('animated-movies-load-more-btn')?.addEventListener('click', () => {
    void loadAnimatedMovies({ append: true });
  });

  document.querySelectorAll('[data-comic-retry]').forEach(button => {
    button.addEventListener('click', () => {
      const category = button.dataset.comicRetry;
      const state = comicPages[category];
      if (!COMIC_KINDS.includes(category) || !state) return;
      if (state.failedAppend) {
        void loadComicCatalog(category, state.query, { append: true, sort: state.sort });
        return;
      }
      loadComicCatalog(category, state.query, { sort: state.sort });
    });
  });
  document.querySelectorAll('[data-comic-more]').forEach(button => {
    button.addEventListener('click', () => {
      const category = button.dataset.comicMore;
      if (!COMIC_KINDS.includes(category) || !comicPages[category].hasNext || comicPages[category].loading) return;
      void loadComicCatalog(category, comicPages[category].query, { append: true, sort: comicPages[category].sort });
    });
  });

  document.getElementById('reading-list-retry')?.addEventListener('click', () => {
    const result = loadReadingList();
    syncReadingSurfaces();
    showToast(result.ok ? 'Reading list loaded.' : result.message, result.ok ? 'success' : 'error');
  });
  document.getElementById('reading-list-clear')?.addEventListener('click', () => {
    if (!window.confirm('Clear all saved reading-list data from this browser?')) return;
    const result = mutateReadingList('clearReadingList', { confirmed: true });
    if (!result.ok) {
      syncReadingSurfaces();
      showToast(result.message || 'Could not clear your reading list.', 'error');
      return;
    }
    syncReadingSurfaces();
    showToast('Reading list cleared.', 'success');
  });

  ['reading-list-status-filter', 'reading-list-type-filter', 'reading-list-sort'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', event => {
      const value = event.target.value;
      if (id === 'reading-list-status-filter') readingView.status = readingUtils?.READING_STATUS_VALUES.includes(value) ? value : 'all';
      else if (id === 'reading-list-type-filter') readingView.type = COMIC_KINDS.includes(value) ? value : 'all';
      else readingView.sort = ['updated', 'title', 'status', 'progress'].includes(value) ? value : 'updated';
      syncReadingSurfaces();
    });
  });
  document.querySelectorAll('#reading-list-reset, [data-reading-reset]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      Object.assign(readingView, { status: 'all', type: 'all', sort: 'updated' });
      syncReadingSurfaces();
    });
  });

  document.addEventListener('change', event => {
    const input = event.target;
    if (syncingReadingUI || writingReadingList || !input.isConnected || !input.matches?.('[data-reading-status], [data-reading-chapter]')) return;
    const control = input.closest('[data-reading-controls]');
    if (!control) return;
    const identity = control.dataset.readingControls;
    const entry = savedReadingEntry(identity);
    if (!entry) return;
    // Change only the edited field; a pending edit must not restore a different
    // field's stale value after a cross-tab change. The store owns validation.
    const field = input.matches('[data-reading-status]') ? 'readingStatus' : 'currentChapter';
    if (String(entry[field]) === input.value) {
      if (pendingReadingStorageRefresh) {
        pendingReadingStorageRefresh = false;
        loadReadingList();
        syncReadingSurfaces();
      }
      return;
    }
    const result = mutateReadingList('update', identity, { [field]: input.value });
    if (!result.ok) {
      updateReadingProgressControls(identity);
      syncReadingSurfaces();
      showToast(result.message || 'Could not save reading progress.', 'error');
      return;
    }
    syncReadingSurfaces();
    showToast('Reading progress saved.', 'success');
  });

  document.addEventListener('click', event => {
    const listLink = event.target.closest?.('[data-reading-list-link]');
    if (listLink) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigateToPage('reading-list');
      return;
    }
    const retry = event.target.closest?.('[data-reading-retry]');
    if (retry) {
      event.preventDefault();
      const result = loadReadingList();
      syncReadingSurfaces();
      showToast(result.ok ? 'Reading list loaded.' : result.message, result.ok ? 'success' : 'error');
      return;
    }
    const button = event.target.closest?.('[data-reading-toggle], [data-reading-remove]');
    if (!button || syncingReadingUI || writingReadingList || !button.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.hasAttribute('data-reading-remove')) {
      const result = mutateReadingList('remove', button.dataset.readingRemove);
      if (!result.ok) {
        syncReadingSurfaces();
        showToast(result.message || 'Could not remove this saved title.', 'error');
        return;
      }
      syncReadingSurfaces();
      showToast('Removed from Reading List.', 'success');
      return;
    }
    const parsedChapters = Number(button.dataset.readingChapters);
    // Use this comic's original metadata, independent of hidden anime details or image fallbacks.
    const item = {
      id: button.dataset.readingToggle,
      title: button.dataset.readingTitle || 'Untitled',
      poster: button.dataset.readingPoster || '',
      chapters: Number.isSafeInteger(parsedChapters) && parsedChapters > 0 ? parsedChapters : null
    };
    const category = button.dataset.readingCategory;
    const result = toggleReadingEntry(item, category);
    if (!result.ok) {
      syncReadingSurfaces();
      showToast(result.message || 'Could not update your reading list.', 'error');
      return;
    }
    syncReadingSurfaces();
    const saved = readingList.some(entry => readingUtils.readingEntryKey(entry) === `anilist:${category}:${item.id}`);
    showToast(saved ? 'Added to Reading List.' : 'Removed from Reading List.', 'success');
  });

  function hasPendingReadingDraft() {
    const input = document.activeElement;
    if (!input?.matches('[data-reading-chapter]')) return false;
    const entry = savedReadingEntry(input.closest('[data-reading-controls]')?.dataset.readingControls);
    return !!entry && input.value !== String(entry.currentChapter);
  }

  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== readingUtils?.READING_LIST_KEY) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch {
      // The guarded loader below reports storage access becoming unavailable.
    }
    if (hasPendingReadingDraft()) {
      pendingReadingStorageRefresh = true;
      showToast('Reading list changed in another tab. Finish editing to refresh.', 'info');
      return;
    }
    const result = loadReadingList();
    syncReadingSurfaces();
    if (!result.ok) showToast(result.message, 'error');
  });
  document.addEventListener('focusout', event => {
    if (!pendingReadingStorageRefresh || !event.target.matches?.('[data-reading-chapter]')) return;
    // A native change fires during blur. Wait until its synchronous save and
    // focus restoration finish before applying a deferred cross-tab refresh.
    queueMicrotask(() => {
      if (!pendingReadingStorageRefresh || syncingReadingUI || writingReadingList || hasPendingReadingDraft()) return;
      pendingReadingStorageRefresh = false;
      const result = loadReadingList();
      syncReadingSurfaces();
      if (!result.ok) showToast(result.message, 'error');
    });
  });

  document.getElementById('catalog-load-more-btn')?.addEventListener('click', () => {
    loadMoreCatalog();
  });

  // Navbar Search Trigger Toggle
  const searchTrigger = document.getElementById('nav-search-trigger');
  const searchOverlay = document.getElementById('search-overlay');
  const searchClose = document.getElementById('search-close-btn');

  function closeSearchOverlay(restoreFocus = false) {
    if (!searchOverlay) return;
    searchOverlay.classList.remove('open');
    searchOverlay.hidden = true;
    searchTrigger?.setAttribute('aria-expanded', 'false');
    document.getElementById('search-overlay-input')?.setAttribute('aria-expanded', 'false');
    const suggestions = document.getElementById('nav-search-suggestions');
    if (suggestions) suggestions.hidden = true;
    if (restoreFocus) searchTrigger?.focus();
  }

  if (searchTrigger && searchOverlay) {
    searchTrigger.addEventListener('click', () => {
      const isOpen = !searchOverlay.classList.contains('open');
      if (isOpen) {
        searchOverlay.hidden = false;
        searchOverlay.classList.add('open');
      } else {
        closeSearchOverlay(true);
      }
      searchTrigger.setAttribute('aria-expanded', String(isOpen));
      if (isOpen) {
        document.getElementById('search-overlay-input')?.focus();
      }
    });
  }

  if (searchClose && searchOverlay) {
    searchClose.addEventListener('click', () => {
      closeSearchOverlay(true);
    });
  }

  // Hero Search Input & Button
  const heroSearchBtn = document.getElementById('hero-search-btn');
  const heroSearchInput = document.getElementById('hero-search-input');

  if (heroSearchBtn && heroSearchInput) {
    heroSearchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      triggerSearch(heroSearchInput.value.trim());
    });

  }

  // Top Search Tags Click
  document.querySelectorAll('.tag[data-search]').forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.preventDefault();
      const q = tag.dataset.search;
      if (q) triggerSearch(q);
    });
  });

  // Genre Button Clicks
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.genre-btn');
    if (!btn) return;

    btn.parentElement.querySelectorAll('.genre-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    btn.parentElement.querySelectorAll('.genre-btn').forEach(b => {
      b.setAttribute('aria-pressed', String(b === btn));
    });

    filterByGenre(btn.dataset.genre);
  });

  document.addEventListener('change', async event => {
    const control = event.target.closest?.('[data-watch-controls]');
    if (!control) return;
    const id = control.dataset.watchId;
    const item = watchlist.find(saved => String(saved.id) === String(id));
    if (!item) return;
    const isMovie = isMovieEntry(item);
    const status = control.querySelector('[data-watch-status]')?.value;

    // For movies, episode is optional (they don't have episodes)
    let episode = 0;
    if (!isMovie) {
      const episodeInput = control.querySelector('[data-watch-episode]')?.value?.trim();
      const parsedEpisode = episodeInput === '' || episodeInput == null ? NaN : Number(episodeInput);
      if (!Number.isSafeInteger(parsedEpisode) || parsedEpisode < 0) {
        showToast('Enter a valid episode number.', 'error');
        return;
      }
      episode = parsedEpisode;
      // Mirror normalizeWatchProgress: a total of 0 means UNKNOWN (the card
      // bookmark path stores `episodes: 0` for series with no listed count),
      // not a known total of zero — otherwise every episode > 0 is rejected.
      const knownTotal = item.totalEpisodes ?? item.episodes;
      const total = knownTotal != null && Number(knownTotal) > 0 ? Number(knownTotal) : null;
      if (total !== null && episode > total) {
        showToast(`Current episode cannot exceed the known total of ${total}.`, 'error');
        return;
      }
    }

    if (!WATCH_STATUS_VALUES.includes(status)) {
      showToast('Enter a valid watch status.', 'error');
      return;
    }

    const button = control.querySelector('[data-watch-status]');
    if (button) button.disabled = true;
    try {
      await updateWatchlistItem(item, { watchStatus: status, currentEpisode: episode });
      showToast('Watch progress saved.', 'success');
      const activePage = document.querySelector('.page.active')?.id;
      if (activePage === 'page-watchlist') await loadWatchlist();
      else if (activePage === 'page-detail') await loadAnimeDetails(id, false);
    } catch (error) {
      console.error('Could not update watch progress:', error);
      showToast(error instanceof RangeError ? error.message : 'Could not save watch progress. Please try again.', 'error');
    } finally {
      if (button) button.disabled = false;
    }
  });

  // Episode selector search button
  document.addEventListener('click', async event => {
    const searchBtn = event.target.closest?.('.episode-selector-search');
    if (!searchBtn) return;
    event.preventDefault();
    event.stopPropagation();

    const selector = searchBtn.closest('.episode-selector');
    if (!selector) return;
    const select = selector.querySelector('[data-watch-episode]');
    if (!select) return;

    // Toggle search mode. The class belongs on the wrapper that CONTAINS the
    // search input and the button: every CSS rule for it is descendant-based
    // (.episode-selector-searching .episode-search-input), and putting it on
    // the <select> itself — a sibling of both — left the input invisible.
    const searchRoot = selector.querySelector('.episode-selector-wrapper') || selector;
    const isSearchMode = searchRoot.classList.toggle('episode-selector-searching');
    searchBtn.setAttribute('aria-label', isSearchMode ? 'Close search' : 'Search episodes');
    searchBtn.title = isSearchMode ? 'Close search' : 'Search episodes';

    if (isSearchMode) {
      // Create search input
      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'episode-search-input';
      searchInput.placeholder = 'Search episode...';
      searchInput.setAttribute('aria-label', 'Search episode number');
      searchInput.setAttribute('autocomplete', 'off');
      searchInput.setAttribute('inputmode', 'numeric');

      // Insert search input before the select
      select.parentNode.insertBefore(searchInput, select);
      searchInput.focus();

      // Filter options as user types
      const options = select.querySelectorAll('option');
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        options.forEach(option => {
          const text = option.textContent.toLowerCase();
          const value = option.value;
          const match = query === '' || text.includes(query) || value.includes(query);
          option.style.display = match ? '' : 'none';
        });
      });

      // Handle keyboard navigation
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchRoot.classList.remove('episode-selector-searching');
          searchBtn.setAttribute('aria-label', 'Search episodes');
          searchBtn.title = 'Search episodes';
          searchInput.remove();
          // Detach the outside-click listener too, or it outlives the search
          // input and fires on a later click.
          document.removeEventListener('click', closeSearch);
        } else if (e.key === 'Enter') {
          // Select the first visible option
          const visibleOptions = Array.from(select.options).filter(o => o.style.display !== 'none');
          if (visibleOptions.length > 0) {
            select.value = visibleOptions[0].value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          searchRoot.classList.remove('episode-selector-searching');
          searchBtn.setAttribute('aria-label', 'Search episodes');
          searchBtn.title = 'Search episodes';
          searchInput.remove();
          document.removeEventListener('click', closeSearch);
        }
      });

      // Close search when clicking outside
      const closeSearch = (e) => {
        if (!selector.contains(e.target) && e.target !== searchBtn) {
          searchRoot.classList.remove('episode-selector-searching');
          searchBtn.setAttribute('aria-label', 'Search episodes');
          searchBtn.title = 'Search episodes';
          const searchInput = selector.querySelector('.episode-search-input');
          if (searchInput) searchInput.remove();
          document.removeEventListener('click', closeSearch);
        }
      };
      // Registered OUTSIDE the handler body: previously this call sat inside the
      // arrow function, so the listener was never attached and outside-click
      // closing never worked.
      document.addEventListener('click', closeSearch);
    } else {
      // Clean up search input if it exists
      const searchInput = selector.querySelector('.episode-search-input');
      if (searchInput) searchInput.remove();
    }
  });

  // Global Anime Card Click & Watchlist Toggle
  document.addEventListener('click', async (e) => {
    if (e.target.closest?.('[data-reading-controls], [data-reading-toggle], [data-reading-remove]')) return;
    if (e.target.closest?.('[data-watch-controls]')) {
      e.stopPropagation();
      return;
    }

    // Watchlist Bookmark Button
    const bookmarkBtn = e.target.closest('.card-watchlist-btn');
    if (bookmarkBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = bookmarkBtn.closest('.anime-card');
      const id = bookmarkBtn.dataset.bookmarkId || card?.dataset.id;
      if (!id) return;

      const title = card.querySelector('.card-title')?.innerText || 'Anime';
      const poster = card.querySelector('.card-image')?.src || '';
      const episodes = Number(bookmarkBtn.dataset.episodes) || 0;
      // Persist the card's format so isMovieEntry() can classify the stored
      // item later; without it movies were saved as untyped and rendered
      // episode controls on the detail and watchlist pages.
      const type = bookmarkBtn.dataset.type || '';
      try {
        const adding = await toggleWatchlistItem({ id, title, poster, image: poster, episodes, type });
        bookmarkBtn.classList.toggle('saved', adding);
        bookmarkBtn.innerText = adding ? '★' : '☆';
        bookmarkBtn.setAttribute('aria-label', adding ? 'Remove from Watchlist' : 'Add to Watchlist');
        bookmarkBtn.title = adding ? 'Remove from Watchlist' : 'Add to Watchlist';
        showToast(adding ? 'Added to Watchlist!' : 'Removed from Watchlist', adding ? 'success' : 'error');
      } catch (error) {
        console.error('Could not update watchlist:', error);
        showToast('Could not update your watchlist. Please try again.', 'error');
        return;
      }

      // If currently viewing Watchlist page, refresh grid
      const activePage = document.querySelector('.page.active');
      if (activePage && activePage.id === 'page-watchlist') {
        await loadWatchlist();
      }
      return;
    }

    // Card Click -> Details Page
    const card = e.target.closest('.anime-card');
    if (card) {
      const id = card.dataset.id;
      if (id) {
        const category = card.dataset.category;
        if (category && COMIC_KINDS.includes(category)) {
          if (e.defaultPrevented || e.target.closest('button, input, select, textarea, label')) return;
          const link = e.target.closest('a');
          if (link && (!link.hasAttribute('data-comic-detail') || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return;
          e.preventDefault();
          loadComicDetail(category, id);
        } else {
          e.preventDefault();
          loadAnimeDetails(id);
        }
      }
    }
  });

  const mobileMenuBtn = document.getElementById('mobile-menu');
  const navLinksContainer = document.getElementById('nav-links');
  const navScrim = document.getElementById('nav-scrim');

  function closeMobileNav(restoreFocus = false) {
    navLinksContainer?.classList.remove('open');
    mobileMenuBtn?.classList.remove('active');
    mobileMenuBtn?.setAttribute('aria-expanded', 'false');
    mobileMenuBtn?.setAttribute('aria-label', 'Open navigation');
    if (navScrim) navScrim.hidden = true;
    document.body.classList.remove('nav-open');
    if (restoreFocus) mobileMenuBtn?.focus();
  }

  // Navbar Links Navigation
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetNav = link.dataset.nav;
      if (targetNav) {
        navigateToPage(targetNav);
        closeMobileNav(true);
      }
    });
  });

  // Mobile Menu Drawer Toggle
  if (mobileMenuBtn && navLinksContainer) {
    mobileMenuBtn.addEventListener('click', () => {
      const isOpen = mobileMenuBtn.getAttribute('aria-expanded') !== 'true';
      mobileMenuBtn.classList.toggle('active', isOpen);
      navLinksContainer.classList.toggle('open', isOpen);
      mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
      mobileMenuBtn.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
      if (navScrim) navScrim.hidden = !isOpen;
      document.body.classList.toggle('nav-open', isOpen);
    });
  }

  navScrim?.addEventListener('click', () => closeMobileNav(true));

  document.addEventListener('click', event => {
    if (!navLinksContainer?.classList.contains('open') || !(event.target instanceof Element)) return;

    if (navLinksContainer.contains(event.target)) {
      if (event.target.closest('a')) closeMobileNav(!event.target.closest('#nav-login'));
      return;
    }
    if (!mobileMenuBtn?.contains(event.target)) closeMobileNav();
  });

  window.matchMedia('(min-width: 901px)').addEventListener('change', event => {
    if (event.matches) closeMobileNav();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navLinksContainer?.classList.contains('open')) {
      event.preventDefault();
      closeMobileNav(true);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.matches?.('[data-reading-chapter]') && event.key === 'Enter') {
      event.preventDefault();
      event.target.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (event.target.closest?.('[data-reading-controls], [data-reading-toggle], [data-reading-remove]')) return;
    if (!shouldActivateCardFromTarget(event.target)) return;
    const card = event.target.closest?.('.anime-card');
    if (!card) return;
    // Comic cards expose native links/buttons, with their own keyboard behavior.
    if (COMIC_KINDS.includes(card.dataset.category)) return;
    event.preventDefault();
    card.click();
  });

  // Navbar Scroll Glassmorphism Effect
  window.addEventListener('scroll', () => {
    const navbar = document.getElementById('navbar');
    if (navbar) {
      if (window.scrollY > 30) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
    }
  });

  // Browser History Navigation (Back / Forward)
  window.addEventListener('popstate', () => {
    initPage();
  });

  // Click-to-reveal spoiler overlays (Item 40). Delegated so spoilers rendered
  // anywhere (reviews, comments) are handled without re-wiring.
  document.addEventListener('click', event => {
    const spoiler = event.target.closest('.spoiler');
    if (!spoiler) return;
    const revealed = spoiler.getAttribute('data-revealed') === 'true';
    if (revealed) {
      spoiler.removeAttribute('data-revealed');
    } else {
      spoiler.setAttribute('data-revealed', 'true');
    }
  });

  // Start Application
  initPage();

});
