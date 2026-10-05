# UI_SPEC — user interface (current)

> Snapshot: 2026-10-05. Documents the UI as built. **No redesign is proposed here.**
> Sources: `public/index.html` (475 lines), `public/style.css` (1687 lines), `public/script.js`, `public/auth-ui.js`, `public/legal.css`.

## 1. Structure and navigation (CURRENT)

- Single-page application: one HTML document containing eight `.page` sections; exactly one has `.active` at a time. Page switching is done in `navigateToPage()`; URLs are updated with `?page=`, `?q=`, `?id=`, `?catalogPage=`, and browser Back/Forward re-runs `initPage()`.
- Pages: `#page-home`, `#page-popular`, `#page-movies`, `#page-series`, `#page-watchlist`, `#page-search`, `#page-detail`, `#page-profile`.
- Navbar (`.topnav`, `#navbar`): brand logo (Anime**Hub**), mobile menu toggle (hamburger, ARIA-expanded), links — Profile (hidden unless signed in), Log In, Log Out (hidden unless signed in), Home, Movies, TV Series, Most Popular, My Watchlist — plus a search icon that toggles a drop-down search overlay with autocomplete.
- Navbar gains a `scrolled` class past 30 px of scroll (glassmorphism effect).
- Mobile: nav links collapse into a drawer toggled by `#mobile-menu`; the button flips `aria-expanded` and its label between "Open navigation"/"Close navigation".
- Footer: brand line, non-hosting/compliance statement, and legal navigation (Privacy, Terms, Contact, Copyright/DMCA).

## 2. Home page (CURRENT)

- **Hero:** badge ("🎌 Discover your next favorite"), headline, subtitle, search input + Search button + autocomplete panel, "Top Searches:" tag buttons (One Piece, Attack on Titan, Jujutsu Kaisen, Solo Leveling, Demon Slayer), two CTAs (Explore Catalog → Most Popular; My Watchlist), floating info cards ("9.0+ Ratings", "Official Trailers", "AniList Discovery"), decorative ambient blobs.
- **Genre filter bar:** All, Action, Adventure, Fantasy, Supernatural, Drama, Comedy, Sci-Fi, Shounen — the active button is highlighted; clicking filters the Trending grid (see `docs/ANIME_DATA.md` for the data-source caveat).
- **Trending Now:** header with "View All →" (→ Most Popular) and a 5-card grid.
- **Most Popular:** header with "View All →" and a 5-card preview grid.

## 3. Cards (CURRENT — `.anime-card`)

- Poster image (lazy-loaded) with `onerror` placeholder swap; overlay with a "view details" glyph, a star bookmark button (`☆`/`★`, `title`/`aria-label` switching between Add/Remove), and a status badge (`completed` variant styling).
- Info block: title (also used as the image `alt` and the `title` attribute), an optional relation label (used on detail-page related cards), meta line (`TYPE • N eps`) and rating (`★ 8.6`, or "N/A").
- Cards are keyboard-operable (`tabindex=0`, `role=button`, Enter/Space activate) and clicking anywhere except the star opens the detail page.
- Grids: `.anime-grid` (home/preview) and `.anime-grid.large-grid` (catalog/search/watchlist pages).

## 4. Popular page (CURRENT)

- Heading, a quick genre bar (All, Action, Adventure, Fantasy, Supernatural, Drama), then the **Filter catalog** panel: genre, release year, minimum rating, studio, language, type, and sort (Most Popular / Highest Rating / Newest Year / Title A–Z), with "Clear filters" and a live result count.
- Pagination bar (Previous / "Page X of Y" / Next), hidden when a single page exists.
- The filter form is a real `<form>`: `change` re-applies filters immediately and `reset` re-applies after clearing.
- URL state: `?page=popular&catalogPage=n`; changing pages scrolls the grid into view.

## 5. Movies / TV Series pages (CURRENT)

- Movies: heading, `large-grid`, and an empty state ("No Movies Found") shown only when the filtered set is empty.
- TV Series: heading, a 4-button genre bar, and a grid — **note:** the grid is currently unfiltered by type (movies appear), and has no empty state.

## 6. Search page (CURRENT)

- Heading `Search Results for "<query>"` with a live result count.
- Filter panel (genre, format, minimum rating, sort by relevance/rating/year/title) with "Clear filters" — hidden until results exist.
- Results grid, plus three distinct empty/error states:
  - **No results** — "No anime found" with suggested tag buttons and a "Back to Home" button.
  - **Filter empty** — "No matching titles with current filters" with a "Reset Filters" button.
  - **Error** — "Search temporarily unavailable" with a "Retry Search" button.
- While loading, a skeleton grid placeholder is rendered.

## 7. Detail page (CURRENT — rendered by JS into `#detail-content`)

- Banner image (with fallback), Back button (browser history), poster, title, optional native title, genre tags, meta row (format, episodes, status, season), a facts list (studio, source, country of origin, release date, episode length), rating ("★ x / 10"), action row ("Find legal viewing options" → JustWatch (US), Add/In-Watchlist toggle, "Official Trailer" when a YouTube trailer exists), and the sanitised description.
- A legal-availability note restates the non-hosting position.
- Optional sections: Key staff (6), Characters & Japanese voice actors (6), Related titles (AniList relations of type ANIME, excluding the title itself), Recommended Anime (up to 6).
- Loading state: centred "⏳ Loading anime details…". Error state: "❌ Failed to load anime details." with "Back to Home".
- Dynamic `application/ld+json` (`TVSeries`/`Movie`, with `AggregateRating` when a rating exists) is injected per title.

## 8. Watchlist page (CURRENT)

- Grid of saved titles; empty state ("Your watchlist is empty") with a "Browse Anime" button. Refresh happens after toggles while the page is open and after auth state changes (cloud vs local source switch).

## 9. Profile page (CURRENT)

- Email, verification status text, and a Danger Zone card with the "Delete My Account" button and explanatory note about permanent cloud-data deletion.

## 10. Authentication modal (CURRENT)

- Backdrop + card, `role="dialog"`, `aria-modal`, `aria-labelledby`.
- Modes: Log In / Sign Up / Reset Password (title, password field visibility, autocomplete hints, switch-link label all update).
- Fields: email (required, autofocus), password (required except in reset mode); Submit + Cancel; live error region (`aria-live`, `aria-atomic`); footer links "Need an account? Sign Up"/"Already have an account? Log In" and "Forgot password?" (hidden in reset mode).
- Keyboard/focus: focus trap (Tab/Shift+Tab), Escape closes, backdrop click closes, focus returns to the invoking element.

## 11. Loading, empty and feedback states (CURRENT)

- **Skeletons:** shimmering placeholder cards for trending (5), popular preview (10), catalog (12), movies (6), series (8), search (8), watchlist (6).
- **Empty states:** watchlist, movies, search-no-results, search-filter-empty, search-error, detail-error. Trending shows inline text if its request fails.
- **Toasts:** one element, success/info/error styling, 3-second auto-dismiss, messages inserted as text nodes; used for watchlist actions and sync failures.

## 12. Styling system (CURRENT)

- One stylesheet, sectioned with banners: ROOT TOKENS, NAVBAR, SPA PAGES, HERO, GENRE FILTER, PREMIUM ANIME CARD, ANIME DETAIL PAGE, LOADING SKELETON, BACK BUTTON, FOOTER, RESPONSIVE BREAKPOINTS.
- Design tokens (CSS custom properties) in `:root`: dark palette (`--bg #090c12`, `--surface`, `--surface-2`, glass surface), orange accent (`--primary #ff7200`, `--primary-dark`, `--primary-glow`), text colours, `--star`, `--success`, `--danger`, four radius tokens, two shadow tokens, one easing token, transition token, fonts (`--font-head #Outfit`, `--font-body #Inter`), and `--nav-h: 72px`.
- Typography loaded from Google Fonts (Outfit 400–900, Inter 400–700).
- Responsive breakpoints: `max-width: 1024px`, `768px`, `480px`, plus `@media (prefers-reduced-motion: reduce)`.
- Body background uses `websites picture.png` (1.94 MB asset).
- Legal pages use a separate small stylesheet (`legal.css`, 88 lines) sharing the palette; `legal.js` injects configured contact/DMCA addresses.

## 13. Accessibility (CURRENT)

- Landmarks: `nav`, `main`, `footer`, `contentinfo`; labelled legal navigation.
- Combobox pattern on both search inputs (`role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`; options rendered in a `role=listbox` with `role=option`).
- Live regions: search suggestion status, result counts, auth error.
- Keyboard operation for cards and the modal; `aria-pressed` on the detail watchlist button; `aria-label`s on icon-only controls.
- Reduced-motion media query honoured.

## 14. NOT FOUND / NEEDS CONFIRMATION

- Browser support matrix (no browserslist, no polyfills).
- Whether a design system/component library is intended (none exists — hand-written classes only).
- Whether any dark/light theme switch is planned (dark only today).
