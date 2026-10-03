document.addEventListener('DOMContentLoaded', () => {

  const baseURL = 'http://localhost:3000/api';


  // ============================================================
  // RENDER ANIME CARD
  // ============================================================

  function renderAnimeCard(anime) {

    const rating =
      typeof anime.rating === 'number'
        ? anime.rating
        : 0;

    const safeTitle =
      anime.title || 'Unknown Anime';

    const poster =
      anime.poster ||
      'https://placehold.co/300x450/0d1117/ff7200?text=No+Image';

    return `
      <div class="anime-card" data-id="${anime.id}">

        <div class="card-image-wrapper">

          <img
            class="card-image"
            src="${poster}"
            alt="${safeTitle} poster"
          >

          <div class="card-overlay">

            <div
              class="play-btn"
              aria-label="Play ${safeTitle}"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>

            <span
              class="card-badge"
              data-status="${anime.status || 'Unknown'}"
            >
              ${anime.status || 'Unknown'}
            </span>

          </div>

        </div>

        <div class="card-info">

          <h3 class="card-title">
            ${safeTitle}
          </h3>

          <div class="card-meta">

            <span class="card-type">
              ${anime.type || 'TV'}
            </span>

            <div class="card-rating">

              ${Array(5)
                .fill('')
                .map(() => `<span class="star">★</span>`)
                .join('')}

              ${rating.toFixed(1)}

            </div>

          </div>

        </div>

      </div>
    `;
  }


  // ============================================================
  // RENDER ANIME GRID
  // ============================================================

  function renderAnimeGrid(animes, containerId) {

    const grid =
      document.getElementById(containerId);

    if (!grid) return;

    if (!Array.isArray(animes) || animes.length === 0) {

      grid.innerHTML = '';

      return;
    }

    grid.innerHTML =
      animes.map(renderAnimeCard).join('');
  }


  // ============================================================
  // LOAD TRENDING
  // ============================================================

  async function loadTrending() {

    try {

      const res =
        await fetch(`${baseURL}/trending`);

      if (!res.ok) {
        throw new Error(
          `Trending request failed: ${res.status}`
        );
      }

      const data =
        await res.json();

      renderAnimeGrid(
        data,
        'trending-grid'
      );

    } catch (err) {

      console.error(
        'Error loading trending:',
        err
      );

    }
  }


  // ============================================================
  // LOAD POPULAR
  // ============================================================

  async function loadPopular() {

    try {

      const res =
        await fetch(`${baseURL}/popular`);

      if (!res.ok) {
        throw new Error(
          `Popular request failed: ${res.status}`
        );
      }

      const data =
        await res.json();

      renderAnimeGrid(
        data,
        'popular-grid'
      );

    } catch (err) {

      console.error(
        'Error loading popular:',
        err
      );

    }
  }


  // ============================================================
  // SEARCH ANIME USING ANILIST
  // ============================================================

  async function performSearch(query) {

    if (!query) return;


    // ----------------------------------------------------------
    // Show loading state
    // ----------------------------------------------------------

    const searchResultsGrid =
      document.getElementById(
        'search-results-grid'
      );

    const emptyState =
      document.getElementById(
        'search-empty'
      );

    if (searchResultsGrid) {

      searchResultsGrid.style.display =
        'grid';

      searchResultsGrid.innerHTML = `
        <div style="
          grid-column: 1 / -1;
          text-align: center;
          padding: 40px;
          font-size: 18px;
        ">
          🔎 Searching for
          <strong>${query}</strong>...
        </div>
      `;
    }

    if (emptyState) {
      emptyState.style.display = 'none';
    }


    try {

      // --------------------------------------------------------
      // Send POST request to our Node server
      // --------------------------------------------------------

      const res = await fetch(
        `${baseURL}/anime/search`,
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json'
          },

          body: JSON.stringify({
            query: query
          })
        }
      );


      if (!res.ok) {

        throw new Error(
          `Search request failed: ${res.status}`
        );

      }


      // --------------------------------------------------------
      // Receive AniList results
      // --------------------------------------------------------

      const data =
        await res.json();


      console.log(
        'AniList results:',
        data
      );


      // --------------------------------------------------------
      // Convert AniList format to Anime Hub format
      // --------------------------------------------------------

      const animeResults =
        data.map(anime => {

          const title =
            anime.title?.english ||
            anime.title?.romaji ||
            anime.title?.native ||
            'Unknown Anime';


          const rating =
            anime.averageScore
              ? anime.averageScore / 10
              : 0;


          return {

            id: anime.id,

            title: title,

            poster:
              anime.coverImage?.large ||
              'https://placehold.co/300x450/0d1117/ff7200?text=No+Image',

            description:
              anime.description
                ? anime.description
                    .replace(/<br>/g, ' ')
                    .replace(/<[^>]*>/g, '')
                : 'No description available.',

            rating: rating,

            genres:
              anime.genres || [],

            type:
              anime.format || 'TV',

            status:
              anime.status || 'Unknown',

            episodes:
              anime.episodes || 0,

            year:
              anime.seasonYear || 'Unknown',

            season:
              anime.season || null

          };

        });


      // --------------------------------------------------------
      // Display results
      // --------------------------------------------------------

      renderAnimeGrid(
        animeResults,
        'search-results-grid'
      );


      // --------------------------------------------------------
      // Empty state
      // --------------------------------------------------------

      if (emptyState && searchResultsGrid) {

        if (animeResults.length === 0) {

          emptyState.style.display =
            'block';

          searchResultsGrid.style.display =
            'none';

        } else {

          emptyState.style.display =
            'none';

          searchResultsGrid.style.display =
            'grid';

        }

      }


    } catch (err) {

      console.error(
        'Error searching AniList:',
        err
      );


      if (searchResultsGrid) {

        searchResultsGrid.innerHTML = `
          <div style="
            grid-column: 1 / -1;
            text-align: center;
            padding: 40px;
          ">
            ❌ Unable to search anime.
            <br>
            <small>
              Please make sure the Anime Hub server is running.
            </small>
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
      <div style="text-align: center; padding: 100px 20px; font-size: 18px; color: var(--text-muted);">
        <div style="margin-bottom: 20px; font-size: 32px;">⏳</div>
        Loading anime details...
      </div>
    `;
    window.scrollTo(0, 0);

    try {
      const res = await fetch(`${baseURL}/anime/${id}`);
      if (!res.ok) throw new Error(`Failed to fetch details: ${res.status}`);
      
      const anime = await res.json();
      
      const title = anime.title?.english || anime.title?.romaji || anime.title?.native || 'Unknown Anime';
      const rating = anime.averageScore ? (anime.averageScore / 10).toFixed(1) : 'N/A';
      const banner = anime.bannerImage || 'https://placehold.co/1920x420/0b0e14/2d3748?text=No+Banner';
      const poster = anime.coverImage?.extraLarge || anime.coverImage?.large || 'https://placehold.co/300x450/0d1117/ff7200?text=No+Image';
      
      let genresHtml = '';
      if (anime.genres && anime.genres.length > 0) {
        genresHtml = anime.genres.map(g => `<span class="detail-tag genre-tag">${g}</span>`).join('');
      }

      const description = anime.description || 'No description available.';

      let trailerHtml = '';
      if (anime.trailer && anime.trailer.site === 'youtube') {
        trailerHtml = `
          <a href="https://www.youtube.com/watch?v=${anime.trailer.id}" target="_blank" class="cta-btn secondary-btn" style="margin-top: 16px;">
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
              <div class="reco-grid">
                ${recos.map(r => {
                  const rTitle = r.title?.english || r.title?.romaji || 'Unknown';
                  const rPoster = r.coverImage?.large || 'https://placehold.co/300x450/0d1117/ff7200?text=No+Image';
                  const rRating = r.averageScore ? (r.averageScore / 10).toFixed(1) : '?';
                  return `
                    <div class="watch-reco-card anime-card" data-id="${r.id}" style="flex-direction: column; padding: 0;">
                      <img src="${rPoster}" class="watch-reco-img" style="width: 100%; height: auto; aspect-ratio: 2/3;" alt="${rTitle}">
                      <div class="watch-reco-info" style="padding: 8px 4px;">
                        <div class="watch-reco-title">${rTitle}</div>
                        <div class="watch-reco-meta" style="display: flex; justify-content: space-between;">
                          <span>${r.format || 'TV'}</span>
                          <span style="color: var(--star);">★ ${rRating}</span>
                        </div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }
      }

      detailContent.innerHTML = `
        <div class="detail-banner">
          <img src="${banner}" alt="${title} banner">
          <div class="detail-banner-overlay"></div>
        </div>
        <div class="detail-content">
          <div class="detail-top">
            <img src="${poster}" alt="${title} poster" class="detail-poster">
            <div class="detail-info">
              <h1 class="detail-title">${title}</h1>
              <div class="detail-tags">
                ${genresHtml}
              </div>
              <div class="detail-meta-row">
                <span><b>Format:</b> ${anime.format || 'Unknown'}</span>
                <span><b>Episodes:</b> ${anime.episodes || '?'}</span>
                <span><b>Status:</b> ${anime.status || 'Unknown'}</span>
                <span><b>Season:</b> ${anime.season || '?'} ${anime.seasonYear || ''}</span>
              </div>
              <div class="detail-rating">
                ★ ${rating} / 10
              </div>
              <div class="detail-description">
                ${description}
              </div>
              ${trailerHtml}
            </div>
          </div>
          ${recommendationsHtml}
        </div>
      `;

    } catch (err) {
      console.error('Error loading anime details:', err);
      detailContent.innerHTML = `
        <div style="text-align: center; padding: 100px 20px; font-size: 18px; color: var(--danger);">
          <div style="margin-bottom: 20px; font-size: 32px;">❌</div>
          Failed to load anime details.
          <br><br>
          <button class="cta-btn primary-btn" onclick="location.href='/'">Back to Home</button>
        </div>
      `;
    }
  }


  // ============================================================
  // GENRE FILTER
  // ============================================================

  async function filterByGenre(genre) {

    try {

      const res =
        await fetch(
          `${baseURL}/genre/${encodeURIComponent(genre)}`
        );


      if (!res.ok) {

        throw new Error(
          `Genre request failed: ${res.status}`
        );

      }


      const data =
        await res.json();


      const activePage =
        document.querySelector('.page.active');


      if (!activePage) return;


      if (
        activePage.id ===
        'page-home'
      ) {

        renderAnimeGrid(
          data,
          'trending-grid'
        );

      }

      else if (
        activePage.id ===
        'page-popular'
      ) {

        renderAnimeGrid(
          data,
          'popular-page-grid'
        );

      }

      else if (
        activePage.id ===
        'page-movies'
      ) {

        renderAnimeGrid(
          data,
          'movies-grid'
        );

      }

      else if (
        activePage.id ===
        'page-series'
      ) {

        renderAnimeGrid(
          data,
          'series-grid'
        );

      }


    } catch (err) {

      console.error(
        'Error filtering by genre:',
        err
      );

    }

  }


  // ============================================================
  // INITIALIZE PAGE
  // ============================================================

  async function initPage() {

    // Check URL parameters for direct navigation
    const urlParams = new URLSearchParams(window.location.search);
    const query = urlParams.get('q');
    const id = urlParams.get('id');

    if (id) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-detail').classList.add('active');
    } else if (query) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-search').classList.add('active');
    }

    const activePage =
      document.querySelector('.page.active');


    if (!activePage) return;


    // ----------------------------------------------------------
    // HOME
    // ----------------------------------------------------------

    if (
      activePage.id ===
      'page-home'
    ) {

      await loadTrending();

      await loadPopular();

    }


    // ----------------------------------------------------------
    // POPULAR
    // ----------------------------------------------------------

    else if (
      activePage.id ===
      'page-popular'
    ) {

      await loadPopular();

    }


    // ----------------------------------------------------------
    // SEARCH PAGE
    // ----------------------------------------------------------

    else if (
      activePage.id ===
      'page-search'
    ) {

      const urlParams =
        new URLSearchParams(
          window.location.search
        );


      const query =
        urlParams.get('q') || '';


      const searchLabel =
        document.getElementById(
          'search-query-label'
        );


      if (searchLabel) {

        searchLabel.textContent =
          query;

      }


      if (query) {

        await performSearch(
          query
        );

      }

    }


    // ----------------------------------------------------------
    // DETAIL PAGE
    // ----------------------------------------------------------

    else if (
      activePage.id ===
      'page-detail'
    ) {

      const urlParams =
        new URLSearchParams(
          window.location.search
        );

      const id =
        urlParams.get('id');

      if (id) {
        await loadAnimeDetails(id);
      }

    }


    // ==========================================================
    // GENRE BUTTONS
    // ==========================================================

    document
      .querySelectorAll('.genre-btn')
      .forEach(btn => {

        btn.addEventListener(
          'click',
          () => {

            document
              .querySelectorAll(
                '.genre-btn'
              )
              .forEach(b =>
                b.classList.remove(
                  'active'
                )
              );


            btn.classList.add(
              'active'
            );


            const genre =
              btn.dataset.genre;


            filterByGenre(
              genre
            );

          }
        );

      });


    // ==========================================================
    // SEARCH FORM
    // ==========================================================

    const searchButton =
      document.querySelector(
        '#page-home .search-btn, #hero-search-btn'
      );


    if (searchButton) {

      searchButton.addEventListener(
        'click',
        async (e) => {

          e.preventDefault();


          const input =
            document.getElementById(
              'hero-search-input'
            ) ||
            document.getElementById(
              'search-overlay-input'
            );


          if (!input) return;


          const query =
            input.value.trim();


          if (!query) return;


          // ----------------------------------------------------
          // Switch to search page
          // ----------------------------------------------------

          document
            .querySelectorAll('.page')
            .forEach(p =>
              p.classList.remove(
                'active'
              )
            );


          const searchPage =
            document.getElementById(
              'page-search'
            );


          if (searchPage) {

            searchPage.classList.add(
              'active'
            );

          }


          // ----------------------------------------------------
          // Update browser URL
          // ----------------------------------------------------

          window.history.pushState(
            {},
            '',
            `?q=${encodeURIComponent(query)}`
          );


          // ----------------------------------------------------
          // Update search heading
          // ----------------------------------------------------

          const searchLabel =
            document.getElementById(
              'search-query-label'
            );


          if (searchLabel) {

            searchLabel.textContent =
              query;

          }


          // ----------------------------------------------------
          // SEARCH ANIList
          // ----------------------------------------------------

          await performSearch(
            query
          );

        }
      );

    }


    // ==========================================================
    // ANIME CARD CLICK
    // ==========================================================
    
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.anime-card');
      if (!card) return;
      
      const id = card.dataset.id;
      if (id) {
        e.preventDefault();
        loadAnimeDetails(id);
      }
    });


    // ==========================================================
    // NAVIGATION LINKS
    // ==========================================================

    document
      .querySelectorAll('.nav-link')
      .forEach(link => {

        link.addEventListener(
          'click',
          (e) => {

            e.preventDefault();


            const nav =
              link.dataset.nav;


            document
              .querySelectorAll('.page')
              .forEach(p =>
                p.classList.remove(
                  'active'
                )
              );


            const targetPage =
              document.getElementById(
                `page-${nav}`
              );


            if (targetPage) {

              targetPage.classList.add(
                'active'
              );

            }

          }
        );

      });

  }


  // ============================================================
  // BROWSER HISTORY
  // ============================================================
  
  window.addEventListener('popstate', () => {
    initPage();
  });


  // ============================================================
  // START APPLICATION
  // ============================================================

  initPage();

});