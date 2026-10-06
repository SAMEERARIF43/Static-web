# PRD — AnimeHub (Product Requirements, current state)

> Legend: **CURRENT** (exists and works) · **PLANNED** (agreed, not built) · **NOT IMPLEMENTED** (absent) · **NOT FOUND / NEEDS CONFIRMATION**.
> Snapshot: 2026-10-05, branch `agents/anime-movie-website-audit-and-build`. Sources: `server.js`, `public/*`, README.
> This PRD documents the product **as it exists today**. Planned items are explicitly marked and are not commitments.

## 1. Product purpose (CURRENT)

AnimeHub is a **discovery catalog** for anime and movies. It indexes third-party metadata (from the AniList public API), lets visitors search, browse, filter, and save titles, shows where titles can be legally watched, and links to official trailers on YouTube.

The product explicitly positions itself as a catalog/index — **not a streaming platform**:

> "Anime Hub is a discovery catalog for anime and movies. It displays third-party metadata, lets visitors keep a local watchlist, links to trailers on YouTube when metadata provides one, and points visitors to legal viewing availability. It does not host, stream, or provide downloads of copyrighted video." — README

Every legal page and the site footer repeat this non-hosting statement. **AnimeHub must never be described as a streaming service.**

## 2. Target users (CURRENT, inferred from the product; formal personas NOT FOUND)

- Visitors who want to discover anime/movies and see ratings, genres, studios, and legal availability.
- Visitors who want a personal watchlist without creating an account (browser-local storage).
- Registered users who want their watchlist synced to an account (Supabase) and who can delete that account themselves.

## 3. Current pages (CURRENT)

| Page | Route form | Purpose |
| --- | --- | --- |
| Home | `/` | Hero + search + Top Searches + genre bar + Trending Now + Most Popular preview |
| Most Popular | `/?page=popular` | Full catalog with 7 filters, 4 sort modes, pagination (24/page), shareable `catalogPage` URL |
| Movies | `/?page=movies` | Movies filtered from the live catalog |
| TV Series | `/?page=series` | Catalog view — **currently unfiltered** (see Product limitations) |
| Watchlist | `/?page=watchlist` | Saved titles (guest-local or cloud) |
| Search | `/?q=…` | Results for a query, with genre/format/rating filters + sorting |
| Detail | `/?id=<anilistId>` | Full title details, staff, JP voice actors, related titles, recommendations, trailer, legal-viewing link |
| Profile | `/?page=profile` | Signed-in email + verification status + account deletion (Danger Zone) |
| Legal pages | `/privacy.html`, `/terms.html`, `/contact.html`, `/dmca.html` | Static legal/info pages |

## 4. Current capabilities (CURRENT)

- Search across the AniList catalog with autocomplete suggestions, plus client-side filters and sorting.
- Popular catalog of up to 50 non-adult AniList titles merged with 12 curated local entries; in-memory 10-minute cache; graceful fallback to the local catalog if AniList is unavailable.
- Rich detail pages (metadata, staff, Japanese voice actors, relations, recommendations, trailer link).
- Watchlist: browser-local for guests; Supabase-backed for signed-in users, with a consent-based one-time migration from local to cloud.
- Authentication: email/password sign-up, sign-in, password reset, email-verification display, session persistence, logout, irreversible self-service account deletion.
- SEO: per-page title/description/Open Graph/Twitter/canonical, dynamic JSON-LD on detail pages, `robots.txt`, `sitemap.xml`.
- Legal/compliance posture: 4 legal pages + footer statement + JustWatch deep links for legal availability.
- Security: origin allowlist (CORS), security headers, static-root protection, server-side description sanitisation, SRI on the Supabase CDN script.

## 5. Current limitations (CURRENT — verified in the audit)

**Resolved 2026-10-06 (Phase 1, owner-approved) — all four of the following are fixed and verified:**

- ~~**Split catalog sources:** Trending, genre filtering, `/api/detail`, and `/api/genres` use only the 12-entry local catalog while Popular/Search/Details use live AniList. Example: the home "Comedy" genre button returns **0** results although the live catalog contains comedies.~~ → Every catalog list is now live-backed through one shared cached query path; `Comedy` returns 30 titles.
- ~~**Two incompatible anime ID spaces:** local catalog `id` (1–12) vs AniList `id`. `/api/detail/1` → Jujutsu Kaisen; `/api/anime/1` → Cowboy Bebop.~~ → One canonical AniList ID (`id === anilistId` everywhere); `/api/detail/:id` now 308-redirects to `/api/anime/:id`.
- ~~**TV Series page is unfiltered** — it renders the whole catalog, including movies.~~ → `/api/series` is `format_in: [TV, TV_SHORT]`; verified 0 films.
- ~~**Trending is static** — a fixed slice of the local array, not computed from AniList popular/trending data.~~ → Real AniList `TRENDING_DESC`.
- **Episodes are only a count.** No episode list, numbering, air dates, or per-episode data of any kind.
- **No Favorites, Watch History, Continue Watching, or Admin** (see `docs/FEATURES.md`).
- **No user-visible failure states** for the Popular, Movies, Series, and genre paths (failures only reach the console).
- **No API rate limiting** on the public AniList proxy endpoints.

## 6. Current legal positioning (CURRENT)

- Discovery/index only; no hosting, streaming, downloading, or file distribution.
- Third-party metadata and artwork belong to their owners; AniList is the metadata source; trailers link to YouTube; availability links point to JustWatch (hardcoded **US** locale).
- Legal pages are self-described drafts and require review before launch; a DMCA page alone does not register a designated agent or establish safe-harbor eligibility (README statement).
- Contact/DMCA addresses are configuration-driven (`CONTACT_EMAIL`, `DMCA_EMAIL`); when unset, the pages say the operator has not configured an address.

## 7. Approved scope and recorded decisions (2026-10-05) — PLANNED, not built

These decisions were recorded with the product owner on 2026-10-05. **Approved is not implemented**: nothing in this section exists in the codebase yet, and no section of this PRD should be read as claiming otherwise.

| Decision | Outcome |
| --- | --- |
| Canonical anime ID | **AniList ID everywhere** — local 1–12 IDs stop being exposed in APIs, URLs, and stored rows. **IMPLEMENTED 2026-10-06 (Phase 1):** the local id field is deleted, `catalog-utils.withCanonicalId` enforces `id === anilistId`, and `/api/detail/:id` now redirects to `/api/anime/:id` |
| Favorites | **YES** — approved to build |
| Watch History | **YES** — approved to build |
| Continue Watching | **YES** — approved to build |
| Episode-level progress | **YES** — approved to build (requires an episode identity that does not exist yet) |
| Admin | **LATER** — deferred; curation stays in code for now |
| Anime data source | **Hybrid** — AniList is the primary catalog; the local layer is curation + offline fallback only |
| Node.js version | **24.x LTS** — to be pinned (`engines` + `.nvmrc`) and reflected in CI |
| Hosting | **Persistent Node host (managed PaaS)** — vendor not yet chosen |
| Supabase environment | **Verify first** — the currently configured project is undetermined (dashboard check required) |
| Separate environments | **YES** — development and production will be separate |
| Restoring deletion tests | **YES — before Phase 1** (completed 2026-10-05; see `docs/TESTING.md` §3) |

Ordering implied by these decisions: Phase 1 (canonical ID + hybrid catalog) → episode identity → progress/history schema → Continue Watching UI, with Favorites as the early independent piece. Admin remains deferred.

Open sub-decisions (Phase 4; not blocking Phase 1): favourites storage shape, episode identity source, and whether history is derived from progress or stored append-only.

## 8. NOT FOUND / NEEDS CONFIRMATION

- Formal product owner, success metrics, KPIs, analytics — none exist in the codebase (no analytics is loaded, by design).
- Target regions/markets (legal availability links are US-only today).
- Monetisation intent — none present (no ads, no payments).
- Which Supabase project the local `.env` points at (development/test vs production) — to be verified before schema work.
