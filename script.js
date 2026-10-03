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
  // START APPLICATION
  // ============================================================

  initPage();

});