document.addEventListener('DOMContentLoaded', () => {

  const baseURL = 'http://localhost:3000/api';

  // Local Watchlist state (persisted in localStorage)
  let watchlist = JSON.parse(localStorage.getItem('anime_hub_watchlist') || '[]');

  function saveWatchlist() {
    localStorage.setItem('anime_hub_watchlist', JSON.stringify(watchlist));
  }

  function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.className = `toast show ${type}`;
    toast.innerHTML = `
      <span>${type === 'success' ? '✓' : 'ℹ'}</span>
      <span>${message}</span>
    `;
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

    const safeTitle =
      anime.title?.english ||
      anime.title?.romaji ||
      (typeof anime.title === 'string' ? anime.title : 'Unknown Anime');

    const poster =
      anime.poster ||
      anime.image ||
      anime.coverImage?.extraLarge ||
      anime.coverImage?.large ||
      anime.coverImage ||
      'https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';

    const status = anime.status || 'Unknown';
    const isCompleted = status.toLowerCase() === 'completed' || status.toLowerCase() === 'finished';
    const type = anime.type || anime.format || 'TV';
    const episodes = anime.episodes ? `${anime.episodes} eps` : null;
    const isSaved = watchlist.some(w => String(w.id) === String(anime.id));

    return `
      <div class="anime-card" data-id="${anime.id}">

        <div class="card-image-wrapper">

          <img
            class="card-image"
            src="${poster}"
            alt="${safeTitle} poster"
            loading="lazy"
            onerror="this.onerror=null; this.src='https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';"
          >

          <div class="card-overlay">
            <div class="play-btn" aria-label="Play ${safeTitle}">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>

            <button class="card-watchlist-btn ${isSaved ? 'saved' : ''}" data-bookmark-id="${anime.id}" title="${isSaved ? 'Remove from Watchlist' : 'Add to Watchlist'}">
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

          <div class="card-meta">
            <span class="card-type">${type}${episodes ? ` • ${episodes}` : ''}</span>
            <div class="card-rating">
              <span class="star">★</span>
              <span>${rating > 0 ? rating.toFixed(1) : 'N/A'}</span>
            </div>
          </div>
        </div>

      </div>
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
      renderAnimeGrid(data, 'popular-grid');
      renderAnimeGrid(data, 'popular-page-grid');
    } catch (err) {
      console.error('Error loading popular:', err);
    }
  }

  // ============================================================
  // SEARCH ANIME USING ANILIST
  // ============================================================

  async function performSearch(query) {
    if (!query) return;

    const searchResultsGrid = document.getElementById('search-results-grid');
    const emptyState = document.getElementById('search-empty');

    if (searchResultsGrid) {
      searchResultsGrid.style.display = 'grid';
      renderSkeletonGrid('search-results-grid', 8);
    }
    if (emptyState) {
      emptyState.style.display = 'none';
    }

    try {
      const res = await fetch(`${baseURL}/anime/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query })
      });

      if (!res.ok) {
        throw new Error(`Search request failed: ${res.status}`);
      }

      const data = await res.json();

      const animeResults = data.map(anime => {
        const title =
          anime.title?.english ||
          anime.title?.romaji ||
          anime.title?.native ||
          'Unknown Anime';

        const rating = anime.averageScore ? anime.averageScore / 10 : 0;
        const posterUrl = anime.coverImage?.extraLarge || anime.coverImage?.large || 'https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';

        return {
          id: anime.id,
          title: title,
          poster: posterUrl,
          image: posterUrl,
          description: anime.description
            ? anime.description.replace(/<br>/g, ' ').replace(/<[^>]*>/g, '')
            : 'No description available.',
          rating: rating,
          genres: anime.genres || [],
          type: anime.format || 'TV',
          status: anime.status || 'Unknown',
          episodes: anime.episodes || 0,
          year: anime.seasonYear || 'Unknown',
          season: anime.season || null
        };
      });

      if (animeResults.length === 0) {
        if (emptyState && searchResultsGrid) {
          emptyState.style.display = 'block';
          searchResultsGrid.style.display = 'none';
        }
      } else {
        if (emptyState) emptyState.style.display = 'none';
        if (searchResultsGrid) searchResultsGrid.style.display = 'grid';
        renderAnimeGrid(animeResults, 'search-results-grid');
      }

    } catch (err) {
      console.error('Error searching AniList:', err);
      if (searchResultsGrid) {
        searchResultsGrid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 40px;">
            ❌ Unable to search anime at this moment.
            <br><small style="color: var(--text-muted);">Please make sure the Anime Hub server is running.</small>
          </div>
        `;
      }
    }
  }

  // ============================================================
  // LOAD ANIME DETAILS
  // ============================================================

  async function loadAnimeDetails(id) {
    if (!id) return;

    const detailContent = document.getElementById('detail-content');
    if (!detailContent) return;

    // Switch to detail page
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-detail').classList.add('active');
    
    // Update URL
    window.history.pushState({}, '', `?id=${id}`);

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
      
      const title = anime.title?.english || anime.title?.romaji || anime.title?.native || 'Unknown Anime';
      const nativeTitle = anime.title?.romaji !== title ? anime.title?.romaji : '';
      const rating = anime.averageScore ? (anime.averageScore / 10).toFixed(1) : (anime.rating ? anime.rating.toFixed(1) : 'N/A');
      const banner = anime.bannerImage || anime.banner || 'https://placehold.co/1920x420/0b0e14/2d3748?text=Anime+Hub+Details';
      const poster = anime.coverImage?.extraLarge || anime.coverImage?.large || anime.poster || anime.image || 'https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';
      
      let genresHtml = '';
      if (anime.genres && anime.genres.length > 0) {
        genresHtml = anime.genres.map(g => `<span class="detail-tag genre-tag">${g}</span>`).join('');
      }

      const description = anime.description 
        ? anime.description.replace(/<br\s*\/?>/gi, '<br>').replace(/<(?!\/?br\s*\/?>)[^>]*>/gi, '')
        : 'No description available.';

      let trailerHtml = '';
      if (anime.trailer && anime.trailer.site === 'youtube') {
        trailerHtml = `
          <a href="https://www.youtube.com/watch?v=${anime.trailer.id}" target="_blank" class="cta-btn secondary-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Watch Trailer
          </a>
        `;
      }

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
          <img src="${banner}" alt="${title} banner" onerror="this.onerror=null; this.src='https://placehold.co/1920x420/0b0e14/2d3748?text=Anime+Hub';">
          <div class="detail-banner-overlay"></div>
        </div>
        <div class="detail-content">
          <button class="back-btn" id="detail-back-btn">
            ← Back
          </button>
          <div class="detail-top">
            <img src="${poster}" alt="${title} poster" class="detail-poster" onerror="this.onerror=null; this.src='https://placehold.co/300x450/0f172a/ff7200?text=No+Poster';">
            <div class="detail-info">
              <h1 class="detail-title">${title}</h1>
              ${nativeTitle ? `<div style="color: var(--text-muted); font-size: 16px; margin-bottom: 12px;">${nativeTitle}</div>` : ''}
              <div class="detail-tags">
                ${genresHtml}
              </div>
              <div class="detail-meta-row">
                <span><b>Format:</b> ${anime.format || anime.type || 'TV'}</span>
                <span><b>Episodes:</b> ${anime.episodes || '?'}</span>
                <span><b>Status:</b> ${anime.status || 'Unknown'}</span>
                <span><b>Season:</b> ${anime.season || ''} ${anime.seasonYear || anime.year || ''}</span>
              </div>
              <div class="detail-rating">
                ★ ${rating} / 10
              </div>
              <div class="detail-actions">
                <button class="cta-btn ${isAnimeSaved ? 'primary-btn' : 'secondary-btn'}" id="detail-watchlist-btn">
                  ${isAnimeSaved ? '✓ In Watchlist' : '+ Add to Watchlist'}
                </button>
                ${trailerHtml}
              </div>
              <div class="detail-description">
                ${description}
              </div>
            </div>
          </div>
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
        detailWatchlistBtn.addEventListener('click', () => {
          const watchlistAnime = {
            id: anime.id,
            title: title,
            poster: poster,
            image: poster,
            rating: parseFloat(rating) || 0,
            type: anime.format || anime.type || 'TV',
            status: anime.status || 'Unknown',
            episodes: anime.episodes || 0,
            genres: anime.genres || []
          };

          const idx = watchlist.findIndex(w => String(w.id) === String(anime.id));
          if (idx >= 0) {
            watchlist.splice(idx, 1);
            saveWatchlist();
            detailWatchlistBtn.className = 'cta-btn secondary-btn';
            detailWatchlistBtn.innerText = '+ Add to Watchlist';
            showToast('Removed from Watchlist', 'error');
          } else {
            watchlist.push(watchlistAnime);
            saveWatchlist();
            detailWatchlistBtn.className = 'cta-btn primary-btn';
            detailWatchlistBtn.innerText = '✓ In Watchlist';
            showToast('Added to Watchlist!', 'success');
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

      if (!activePage) return;

      if (activePage.id === 'page-home') targetGridId = 'trending-grid';
      else if (activePage.id === 'page-popular') targetGridId = 'popular-page-grid';
      else if (activePage.id === 'page-movies') targetGridId = 'movies-grid';
      else if (activePage.id === 'page-series') targetGridId = 'series-grid';

      renderSkeletonGrid(targetGridId, 6);

      if (genre === 'All') {
        const res = await fetch(`${baseURL}/popular`);
        const data = await res.json();
        renderAnimeGrid(data, targetGridId);
        return;
      }

      const res = await fetch(`${baseURL}/genre/${encodeURIComponent(genre)}`);
      if (!res.ok) throw new Error(`Genre request failed: ${res.status}`);
      const data = await res.json();

      renderAnimeGrid(data, targetGridId);

    } catch (err) {
      console.error('Error filtering by genre:', err);
    }
  }

  // ============================================================
  // NAVIGATION & ROUTING
  // ============================================================

  function navigateToPage(navName, updateHistory = true) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    const targetPage = document.getElementById(`page-${navName}`);
    const activeLink = document.querySelector(`.nav-link[data-nav="${navName}"]`);

    if (targetPage) targetPage.classList.add('active');
    if (activeLink) activeLink.classList.add('active');

    if (updateHistory) {
      window.history.pushState({}, '', navName === 'home' ? '/' : `?page=${navName}`);
    }

    window.scrollTo(0, 0);

    if (navName === 'home') {
      loadTrending();
      loadPopular();
    } else if (navName === 'popular') {
      loadPopular();
    } else if (navName === 'movies') {
      loadMovies();
    } else if (navName === 'series') {
      loadSeries();
    } else if (navName === 'watchlist') {
      loadWatchlist();
    }
  }

  async function loadMovies() {
    renderSkeletonGrid('movies-grid', 6);
    try {
      const res = await fetch(`${baseURL}/popular`);
      const data = await res.json();
      const movies = data.filter(a => a.type === 'Movie' || a.genre.includes('Movie'));
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
      const res = await fetch(`${baseURL}/popular`);
      const data = await res.json();
      renderAnimeGrid(data, 'series-grid');
    } catch (err) {
      console.error('Error loading series:', err);
    }
  }

  function loadWatchlist() {
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

  // ============================================================
  // INITIALIZE PAGE
  // ============================================================

  async function initPage() {
    const urlParams = new URLSearchParams(window.location.search);
    const query = urlParams.get('q');
    const id = urlParams.get('id');
    const page = urlParams.get('page');

    if (id) {
      await loadAnimeDetails(id);
    } else if (query) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-search').classList.add('active');
      const searchLabel = document.getElementById('search-query-label');
      if (searchLabel) searchLabel.textContent = query;
      await performSearch(query);
    } else if (page) {
      navigateToPage(page, false);
    } else {
      navigateToPage('home', false);
    }
  }

  // ============================================================
  // EVENT LISTENERS & DELEGATION
  // ============================================================

  // Search Triggers
  function triggerSearch(query) {
    if (!query) return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-search').classList.add('active');
    window.history.pushState({}, '', `?q=${encodeURIComponent(query)}`);

    const searchLabel = document.getElementById('search-query-label');
    if (searchLabel) searchLabel.textContent = query;

    performSearch(query);

    // Close search overlay if open
    document.getElementById('search-overlay')?.classList.remove('open');
  }

  // Navbar Search Trigger Toggle
  const searchTrigger = document.getElementById('nav-search-trigger');
  const searchOverlay = document.getElementById('search-overlay');
  const searchClose = document.getElementById('search-close-btn');

  if (searchTrigger && searchOverlay) {
    searchTrigger.addEventListener('click', () => {
      searchOverlay.classList.toggle('open');
      if (searchOverlay.classList.contains('open')) {
        document.getElementById('search-overlay-input')?.focus();
      }
    });
  }

  if (searchClose && searchOverlay) {
    searchClose.addEventListener('click', () => {
      searchOverlay.classList.remove('open');
    });
  }

  // Overlay Input Enter Key
  document.getElementById('search-overlay-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      triggerSearch(e.target.value.trim());
    }
  });

  // Hero Search Input & Button
  const heroSearchBtn = document.getElementById('hero-search-btn');
  const heroSearchInput = document.getElementById('hero-search-input');

  if (heroSearchBtn && heroSearchInput) {
    heroSearchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      triggerSearch(heroSearchInput.value.trim());
    });

    heroSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        triggerSearch(heroSearchInput.value.trim());
      }
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
  document.addEventListener('click', (e) => {
    // Watchlist Bookmark Button
    const bookmarkBtn = e.target.closest('.card-watchlist-btn');
    if (bookmarkBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = bookmarkBtn.closest('.anime-card');
      const id = bookmarkBtn.dataset.bookmarkId || card?.dataset.id;
      if (!id) return;

      const idx = watchlist.findIndex(w => String(w.id) === String(id));
      if (idx >= 0) {
        watchlist.splice(idx, 1);
        bookmarkBtn.classList.remove('saved');
        bookmarkBtn.innerText = '☆';
        showToast('Removed from Watchlist', 'error');
      } else {
        const title = card.querySelector('.card-title')?.innerText || 'Anime';
        const poster = card.querySelector('.card-image')?.src || '';
        watchlist.push({ id, title, poster });
        bookmarkBtn.classList.add('saved');
        bookmarkBtn.innerText = '★';
        showToast('Added to Watchlist!', 'success');
      }
      saveWatchlist();

      // If currently viewing Watchlist page, refresh grid
      const activePage = document.querySelector('.page.active');
      if (activePage && activePage.id === 'page-watchlist') {
        loadWatchlist();
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
        document.getElementById('mobile-menu')?.classList.remove('active');
      }
    });
  });

  // Mobile Menu Drawer Toggle
  const mobileMenuBtn = document.getElementById('mobile-menu');
  const navLinksContainer = document.getElementById('nav-links');

  if (mobileMenuBtn && navLinksContainer) {
    mobileMenuBtn.addEventListener('click', () => {
      mobileMenuBtn.classList.toggle('active');
      navLinksContainer.classList.toggle('open');
    });
  }

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