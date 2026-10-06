document.addEventListener('DOMContentLoaded', () => {

  // Use relative URL so it works regardless of host/port
  const baseURL = '/api';

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

  function getWatchlistAuthState() {
    return window.getAnimeHubAuthState?.() || { ready: false, session: null };
  }

  function saveWatchlist() {
    if (getWatchlistAuthState().session) return;
    localStorage.setItem('anime_hub_watchlist', JSON.stringify(watchlist));
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

    if (adding) watchlist.push(item);
    else watchlist.splice(index, 1);
    saveWatchlist();
    return adding;
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

  function renderAnimeCard(anime) {
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
    const animeId = anime.anilistId || anime.id;
    const isSaved = watchlist.some(w => String(w.id) === String(animeId));
    const metaText = `${type}${episodesText ? ` • ${episodesText}` : ''}`;
    const cardId = escapeHtml(String(animeId));

    return `
      <article class="anime-card" data-id="${cardId}" tabindex="0" role="button" aria-label="View details for ${safeTitle}">

        <div class="card-image-wrapper">

          <img
            class="card-image"
            src="${escapeHtml(poster)}"
            alt="${safeTitle} poster"
            loading="lazy"
            onerror="this.onerror=null; this.src='https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';"
          >

          <div class="card-overlay">
            <div class="play-btn" aria-hidden="true" title="View details">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="9"/>
                <path d="M11 10h2v7h-2zm0-4h2v2h-2z" fill="var(--bg)"/>
              </svg>
            </div>

            <button type="button" class="card-watchlist-btn ${isSaved ? 'saved' : ''}" data-bookmark-id="${cardId}" title="${isSaved ? 'Remove from Watchlist' : 'Add to Watchlist'}" aria-label="${isSaved ? 'Remove from Watchlist' : 'Add to Watchlist'}">
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

    if (!Array.isArray(animes) || animes.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
          No anime items found in this section.
        </div>
      `;
      return;
    }

    grid.innerHTML = animes.map(renderAnimeCard).join('');
  }

  let catalogItems = [];
  let catalogPage = 1;
  const catalogPageSize = 24;

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

  function populateCatalogFilters(items) {
    setSelectOptions(document.getElementById('filter-genre'), items.flatMap(item => item.genre || item.genres || []), 'All genres');
    setSelectOptions(document.getElementById('filter-year'), items.map(item => item.year), 'All years');
    setSelectOptions(document.getElementById('filter-studio'), items.map(item => item.studio), 'All studios', true);
    setSelectOptions(document.getElementById('filter-language'), items.map(item => item.language), 'All languages');
    setSelectOptions(document.getElementById('filter-type'), items.map(item => item.type || item.format), 'All types');
  }

  function applyCatalogFilters() {
    const genre = document.getElementById('filter-genre')?.value || '';
    const year = document.getElementById('filter-year')?.value || '';
    const minRating = Number(document.getElementById('filter-rating')?.value || 0);
    const studio = document.getElementById('filter-studio')?.value || '';
    const language = document.getElementById('filter-language')?.value || '';
    const type = document.getElementById('filter-type')?.value || '';
    const sortBy = document.getElementById('filter-sort')?.value || 'popularity';

    const filtered = catalogItems.filter(item => {
      const genres = item.genre || item.genres || [];
      const itemType = item.type || item.format || '';
      return (!genre || genres.includes(genre)) &&
        (!year || String(item.year || item.seasonYear || '') === year) &&
        (!minRating || Number(item.rating || (item.averageScore || 0) / 10) >= minRating) &&
        (!studio || String(item.studio || '').toLowerCase() === studio.toLowerCase()) &&
        (!language || item.language === language) &&
        (!type || itemType === type);
    });

    // Apply sorting
    if (sortBy === 'rating') {
      filtered.sort((a, b) => Number(b.rating || (b.averageScore || 0) / 10) - Number(a.rating || (a.averageScore || 0) / 10));
    } else if (sortBy === 'year') {
      filtered.sort((a, b) => Number(b.year || b.seasonYear || 0) - Number(a.year || a.seasonYear || 0));
    } else if (sortBy === 'title') {
      filtered.sort((a, b) => String(getAnimeTitle(a)).localeCompare(String(getAnimeTitle(b))));
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / catalogPageSize));
    catalogPage = Math.min(Math.max(catalogPage, 1), totalPages);
    const urlParams = new URLSearchParams(window.location.search);
    const requestedPage = Number.parseInt(urlParams.get('catalogPage') || '1', 10);
    if (urlParams.get('page') === 'popular' && requestedPage !== catalogPage) {
      if (catalogPage === 1) urlParams.delete('catalogPage');
      else urlParams.set('catalogPage', String(catalogPage));
      window.history.replaceState({}, '', `?${urlParams.toString()}`);
    }
    const startIndex = (catalogPage - 1) * catalogPageSize;
    renderAnimeGrid(filtered.slice(startIndex, startIndex + catalogPageSize), 'popular-page-grid');

    const count = document.getElementById('catalog-result-count');
    const firstTitle = filtered.length ? startIndex + 1 : 0;
    const lastTitle = Math.min(startIndex + catalogPageSize, filtered.length);
    if (count) count.textContent = `Showing ${firstTitle}-${lastTitle} of ${filtered.length} titles`;

    const pagination = document.getElementById('catalog-pagination');
    const previousButton = document.getElementById('catalog-previous-page');
    const nextButton = document.getElementById('catalog-next-page');
    const pageIndicator = document.getElementById('catalog-page-indicator');
    if (pagination) pagination.hidden = totalPages <= 1;
    if (previousButton) previousButton.disabled = catalogPage === 1;
    if (nextButton) nextButton.disabled = catalogPage === totalPages;
    if (pageIndicator) pageIndicator.textContent = `Page ${catalogPage} of ${totalPages}`;

    document.querySelectorAll('#popular-genre-filter .genre-btn').forEach(button => {
      button.classList.toggle('active', button.dataset.genre === (genre || 'All'));
    });
  }

  // ============================================================
  // LOAD TRENDING
  // ============================================================

  async function loadTrending() {
    renderSkeletonGrid('trending-grid', 5);
    try {
      const res = await fetch(`${baseURL}/trending`);
      if (!res.ok) throw new Error(`Trending request failed: ${res.status}`);
      const data = await res.json();
      renderAnimeGrid(data, 'trending-grid');
    } catch (err) {
      console.error('Error loading trending:', err);
      const grid = document.getElementById('trending-grid');
      if (grid) grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted);">Unable to load trending items.</div>`;
    }
  }

  // ============================================================
  // LOAD POPULAR
  // ============================================================

  async function loadPopular() {
    renderSkeletonGrid('popular-grid', 10);
    renderSkeletonGrid('popular-page-grid', 12);
    try {
      const res = await fetch(`${baseURL}/popular`);
      if (!res.ok) throw new Error(`Popular request failed: ${res.status}`);
      const data = await res.json();
      catalogItems = data;
      populateCatalogFilters(catalogItems);
      renderAnimeGrid(data.slice(0, 5), 'popular-grid');
      applyCatalogFilters();
    } catch (err) {
      console.error('Error loading popular:', err);
    }
  }

  // ============================================================
  // SEARCH STATE & FILTERING
  // ============================================================

  const searchCache = new Map();
  let currentSearchResults = [];
  let lastSearchQuery = '';
  let searchRequestId = 0;

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
      const res = await fetch(`${baseURL}/search?q=${encodeURIComponent(normalizedQuery)}`);
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
          status: anime.status || 'Unknown',
          episodes: anime.episodes || 0,
          year: anime.seasonYear || anime.year || 'Unknown',
          seasonYear: anime.seasonYear || anime.year || null,
          season: anime.season || null
        };
      });

      searchCache.set(cacheKey, animeResults);
      currentSearchResults = animeResults;
      populateSearchFilters(currentSearchResults);
      applySearchFilters();

    } catch (err) {
      if (requestId !== searchRequestId) return;
      console.error('Error searching anime:', err);
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
      const res = await fetch(`${baseURL}/anime/${id}`);
      if (!res.ok) throw new Error(`Failed to fetch details: ${res.status}`);
      
      const anime = await res.json();
      
      const rawTitle = anime.title?.english || anime.title?.romaji || anime.title?.native || 'Unknown Anime';
      const title = escapeHtml(rawTitle);
      const rawNative = anime.title?.romaji !== rawTitle ? anime.title?.romaji : '';
      const nativeTitle = escapeHtml(rawNative);
      const rating = anime.averageScore ? (anime.averageScore / 10).toFixed(1) : (anime.rating ? anime.rating.toFixed(1) : 'N/A');
      const banner = safeImageUrl(anime.bannerImage || anime.banner);
      const poster = safeImageUrl(anime.coverImage?.extraLarge || anime.coverImage?.large || anime.poster || anime.image);
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
        .map(edge => ({
          id: edge.node.id,
          title: edge.node.title,
          poster: edge.node.coverImage?.large,
          rating: edge.node.averageScore ? edge.node.averageScore / 10 : 0,
          type: edge.node.format || 'TV',
          status: statusLabels[edge.node.status] || edge.node.status || 'Unknown',
          relationType: (edge.relationType || 'Related').replace(/_/g, ' ').toLowerCase()
        }));
      const relatedHtml = relatedItems.length
        ? `<section class="reco-section" aria-labelledby="detail-related-heading">
            <h2 class="episodes-title" id="detail-related-heading">Related titles</h2>
            <div class="anime-grid">${relatedItems.map(item => renderAnimeCard(item)).join('')}</div>
          </section>`
        : '';

      const legalSearchUrl = `https://www.justwatch.com/us/search?q=${encodeURIComponent(rawTitle)}`;

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
                  title: r.title?.english || r.title?.romaji || 'Unknown',
                  poster: r.coverImage?.large,
                  rating: r.averageScore ? r.averageScore / 10 : 0,
                  type: r.format || 'TV',
                  status: r.status || 'Unknown'
                })).join('')}
              </div>
            </div>
          `;
        }
      }

      const isAnimeSaved = watchlist.some(w => String(w.id) === String(anime.id));

      detailContent.innerHTML = `
        <div class="detail-banner">
          <img src="${escapeHtml(banner)}" alt="" onerror="this.onerror=null; this.src='https://placehold.co/1920x420/0b0e14/2d3748?text=Anime+Hub';">
          <div class="detail-banner-overlay"></div>
        </div>
        <div class="detail-content">
          <button class="back-btn" id="detail-back-btn" type="button" aria-label="Go back to previous page">
            ← Back
          </button>
          <div class="detail-top">
            <img src="${escapeHtml(poster)}" alt="${title} poster" class="detail-poster" onerror="this.onerror=null; this.src='https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';">
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
              <div class="detail-description">
                ${description}
              </div>
            </div>
          </div>
          <p class="legal-availability-note">AnimeHub is an anime discovery catalog and does not host or stream copyrighted video. Availability varies by region; find licensed streaming providers on JustWatch or watch official trailers on YouTube.</p>
          ${(staffHtml || charactersHtml) ? `<div class="detail-credits">${staffHtml}${charactersHtml}</div>` : ''}
          ${relatedHtml}
          ${recommendationsHtml}
        </div>
      `;

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
            genres: anime.genres || []
          };

          try {
            const adding = await toggleWatchlistItem(watchlistAnime);
            if (adding) {
              detailWatchlistBtn.className = 'cta-btn primary-btn';
              detailWatchlistBtn.innerText = '✓ In Watchlist';
              detailWatchlistBtn.setAttribute('aria-pressed', 'true');
              showToast('Added to Watchlist!', 'success');
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
    }
  }

  // ============================================================
  // GENRE FILTER
  // ============================================================

  async function filterByGenre(genre) {
    try {
      const activePage = document.querySelector('.page.active');
      let targetGridId = 'trending-grid';
      let typeKey = null;

      if (!activePage) return;

      if (activePage.id === 'page-home') targetGridId = 'trending-grid';
      else if (activePage.id === 'page-popular') {
        const genreSelect = document.getElementById('filter-genre');
        if (genreSelect) genreSelect.value = genre === 'All' ? '' : genre;
        catalogPage = 1;
        applyCatalogFilters();
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
      const res = await fetch(genreUrl);
      if (!res.ok) throw new Error(`Genre request failed: ${res.status}`);
      const data = await res.json();

      // The genre endpoint honours `type`, but filtering again here means the
      // wrong format can never reach the grid.
      renderAnimeGrid(
        typeKey === 'series'
          ? (Array.isArray(data) ? data : []).filter(isSeriesEntry)
          : (Array.isArray(data) ? data : []),
        targetGridId
      );

    } catch (err) {
      console.error('Error filtering by genre:', err);
    }
  }

  // ============================================================
  // NAVIGATION & ROUTING
  // ============================================================

  async function navigateToPage(navName, updateHistory = true) {
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
      loadTrending();
      loadPopular();
    } else if (navName === 'popular') {
      updatePageSeo({
        title: 'Most Popular Anime Catalog — AnimeHub',
        description: 'Explore the highest-rated and most popular anime series and movies on AnimeHub.',
        url: '/?page=popular'
      });
      loadPopular();
    } else if (navName === 'movies') {
      updatePageSeo({
        title: 'Anime Movies Catalog — AnimeHub',
        description: 'Discover feature-length anime films, release dates, ratings, and legal streaming options.',
        url: '/?page=movies'
      });
      loadMovies();
    } else if (navName === 'series') {
      updatePageSeo({
        title: 'Anime TV Series Catalog — AnimeHub',
        description: 'Browse top anime television series, broadcast schedules, episodes, and official trailers on AnimeHub.',
        url: '/?page=series'
      });
      loadSeries();
    } else if (navName === 'watchlist') {
      updatePageSeo({
        title: 'My Watchlist — AnimeHub',
        description: 'View and manage anime titles saved in this browser.',
        url: '/?page=watchlist'
      });
      loadWatchlist();
    } else if (navName === 'profile') {
      updatePageSeo({
        title: 'My Profile — AnimeHub',
        description: 'Manage your AnimeHub account and profile settings.',
        url: '/?page=profile'
      });
    }
  }

  // Expose navigateToPage globally so auth-ui.js can call it
  window.navigateToPage = navigateToPage;

  async function loadMovies() {
    renderSkeletonGrid('movies-grid', 6);
    try {
      const res = await fetch(`${baseURL}/movies`);
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
    }
  }

  async function loadSeries() {
    renderSkeletonGrid('series-grid', 8);
    try {
      const res = await fetch(`${baseURL}/series`);
      if (!res.ok) throw new Error(`Series request failed: ${res.status}`);
      const data = await res.json();
      // `/api/series` already filters to television formats; without this the
      // page used to render the whole catalog, films included.
      renderAnimeGrid((Array.isArray(data) ? data : []).filter(isSeriesEntry), 'series-grid');
    } catch (err) {
      console.error('Error loading series:', err);
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
      renderAnimeGrid(watchlist, 'watchlist-grid');
    }
  }

  async function loadWatchlist() {
    const authState = getWatchlistAuthState();
    if (authState.ready && authState.session && window.animeHubCloudWatchlist) {
      renderSkeletonGrid('watchlist-grid', 6);
      try {
        watchlist = await window.animeHubCloudWatchlist.list();
      } catch (error) {
        console.error('Could not load cloud watchlist:', error);
        showToast('Could not load your cloud watchlist. Please try again.', 'error');
        return;
      }
    }
    renderWatchlist();
  }

  window.addEventListener('animehub:auth-state', async event => {
    try {
      watchlist = event.detail?.authenticated
        ? await window.animeHubCloudWatchlist.list()
        : loadLocalWatchlist();
      if (document.getElementById('page-watchlist')?.classList.contains('active')) {
        renderWatchlist();
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
    const urlParams = new URLSearchParams(window.location.search);
    const query = urlParams.get('q');
    const id = urlParams.get('id');
    const page = urlParams.get('page');
    const requestedCatalogPage = Number.parseInt(urlParams.get('catalogPage') || '1', 10);
    catalogPage = Number.isInteger(requestedCatalogPage) && requestedCatalogPage > 0
      ? requestedCatalogPage
      : 1;

    if (id) {
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
    } else if (['home', 'popular', 'movies', 'series', 'watchlist', 'profile'].includes(page)) {
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
    document.getElementById('search-overlay')?.classList.remove('open');
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

    const state = { items: [], activeIndex: -1, timer: null, controller: null };

    function closeSuggestions() {
      clearTimeout(state.timer);
      state.controller?.abort();
      panel.hidden = true;
      options.replaceChildren();
      status.textContent = '';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      state.items = [];
      state.activeIndex = -1;
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
      status.textContent = state.items.length ? '' : 'No matches yet. Press Enter to search.';
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    input.addEventListener('input', () => {
      clearTimeout(state.timer);
      state.controller?.abort();
      state.activeIndex = -1;
      state.items = [];
      options.replaceChildren();
      input.removeAttribute('aria-activedescendant');
      const query = input.value.trim();
      if (query.length < 2) {
        closeSuggestions();
        return;
      }

      const cached = suggestionCache.get(query.toLowerCase());
      if (cached) {
        showResults(cached);
        return;
      }

      status.textContent = 'Searching…';
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      state.timer = setTimeout(async () => {
        state.controller = new AbortController();
        try {
          const response = await fetch(`${baseURL}/search?q=${encodeURIComponent(query)}`, {
            signal: state.controller.signal
          });
          if (!response.ok) throw new Error(`Suggestions request failed: ${response.status}`);
          const results = await response.json();
          if (input.value.trim() !== query) return;
          if (suggestionCache.size >= 50) {
            suggestionCache.delete(suggestionCache.keys().next().value);
          }
          suggestionCache.set(query.toLowerCase(), results);
          showResults(results);
        } catch (error) {
          if (error.name === 'AbortError') return;
          console.error('Unable to load search suggestions:', error);
          status.textContent = 'Suggestions unavailable. Press Enter to search.';
        }
      }, 280);
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
      } else if (event.key === 'Escape' && !panel.hidden) {
        event.preventDefault();
        closeSuggestions();
      } else if (event.key === 'Escape' && inputId === 'search-overlay-input') {
        document.getElementById('search-overlay')?.classList.remove('open');
        document.getElementById('nav-search-trigger')?.setAttribute('aria-expanded', 'false');
        document.getElementById('nav-search-trigger')?.focus();
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
        if (!panel.contains(document.activeElement)) closeSuggestions();
      }, 100);
    });

    input.addEventListener('focus', () => {
      if (state.items.length) {
        panel.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      }
    });
  }

  connectAutocomplete('hero-search-input', 'hero-search-suggestions', 'hero-search-options', 'hero-search-status');
  connectAutocomplete('search-overlay-input', 'nav-search-suggestions', 'nav-search-options', 'nav-search-status');

  const filterForm = document.getElementById('catalog-filter-form');
  filterForm?.addEventListener('change', () => {
    catalogPage = 1;
    applyCatalogFilters();
  });
  filterForm?.addEventListener('reset', () => {
    catalogPage = 1;
    setTimeout(applyCatalogFilters, 0);
  });

  const searchFilterForm = document.getElementById('search-filter-form');
  searchFilterForm?.addEventListener('change', applySearchFilters);
  searchFilterForm?.addEventListener('reset', () => {
    setTimeout(applySearchFilters, 0);
  });
  document.getElementById('search-clear-filters-btn')?.addEventListener('click', () => {
    searchFilterForm?.reset();
  });

  function setCatalogPage(page) {
    catalogPage = page;
    const params = new URLSearchParams(window.location.search);
    params.set('page', 'popular');
    params.set('catalogPage', String(catalogPage));
    window.history.pushState({}, '', `?${params.toString()}`);
    applyCatalogFilters();
    document.getElementById('popular-page-grid')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  document.getElementById('catalog-previous-page')?.addEventListener('click', () => {
    setCatalogPage(catalogPage - 1);
  });
  document.getElementById('catalog-next-page')?.addEventListener('click', () => {
    setCatalogPage(catalogPage + 1);
  });

  // Navbar Search Trigger Toggle
  const searchTrigger = document.getElementById('nav-search-trigger');
  const searchOverlay = document.getElementById('search-overlay');
  const searchClose = document.getElementById('search-close-btn');

  if (searchTrigger && searchOverlay) {
    searchTrigger.addEventListener('click', () => {
      searchOverlay.classList.toggle('open');
      const isOpen = searchOverlay.classList.contains('open');
      searchTrigger.setAttribute('aria-expanded', String(isOpen));
      if (searchOverlay.classList.contains('open')) {
        document.getElementById('search-overlay-input')?.focus();
      } else {
        const input = document.getElementById('search-overlay-input');
        const panel = document.getElementById('nav-search-suggestions');
        if (input) input.setAttribute('aria-expanded', 'false');
        if (panel) panel.hidden = true;
      }
    });
  }

  if (searchClose && searchOverlay) {
    searchClose.addEventListener('click', () => {
      searchOverlay.classList.remove('open');
      searchTrigger?.setAttribute('aria-expanded', 'false');
      document.getElementById('search-overlay-input')?.setAttribute('aria-expanded', 'false');
      const suggestions = document.getElementById('nav-search-suggestions');
      if (suggestions) suggestions.hidden = true;
      searchTrigger?.focus();
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

    filterByGenre(btn.dataset.genre);
  });

  // Global Anime Card Click & Watchlist Toggle
  document.addEventListener('click', async (e) => {
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
      try {
        const adding = await toggleWatchlistItem({ id, title, poster, image: poster });
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
        e.preventDefault();
        loadAnimeDetails(id);
      }
    }
  });

  // Navbar Links Navigation
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetNav = link.dataset.nav;
      if (targetNav) {
        navigateToPage(targetNav);
        document.getElementById('nav-links')?.classList.remove('open');
        const menuButton = document.getElementById('mobile-menu');
        menuButton?.classList.remove('active');
        menuButton?.setAttribute('aria-expanded', 'false');
      }
    });
  });

  // Mobile Menu Drawer Toggle
  const mobileMenuBtn = document.getElementById('mobile-menu');
  const navLinksContainer = document.getElementById('nav-links');

  if (mobileMenuBtn && navLinksContainer) {
    mobileMenuBtn.addEventListener('click', () => {
      const isOpen = mobileMenuBtn.getAttribute('aria-expanded') !== 'true';
      mobileMenuBtn.classList.toggle('active', isOpen);
      navLinksContainer.classList.toggle('open', isOpen);
      mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
      mobileMenuBtn.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
    });
  }

  document.addEventListener('keydown', event => {
    const card = event.target.closest?.('.anime-card');
    if (!card || event.target.closest('button') || (event.key !== 'Enter' && event.key !== ' ')) return;
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

  // Start Application
  initPage();

});