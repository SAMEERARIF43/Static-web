# TECH_SPEC — technology stack (as found in the repository)

> Snapshot: 2026-10-05. Only technologies actually present in the repository are listed.
> `NOT FOUND / NEEDS CONFIRMATION` marks anything the repository cannot answer.

## Runtime and language

| Item | Value | Evidence |
| --- | --- | --- |
| Runtime | Node.js — **24.x LTS decided 2026-10-05**; not yet pinned (no `engines`/`.nvmrc`) and CI still tests 18.x/20.x | `package.json`, `.github/workflows/ci.yml` |
| Language | JavaScript, CommonJS (`"type": "commonjs"`) | `package.json` |
| Entry point | `server.js` (`"main": "server.js"`, `npm start`) | `package.json` |
| Frontend language | Vanilla JavaScript (no framework, no bundler, no build step) | `public/script.js`, `public/auth-ui.js` |
| Markup / styling | Plain HTML + CSS (single 1687-line stylesheet, CSS custom properties) | `public/index.html`, `public/style.css` |

## Backend

| Package | Version | Role |
| --- | --- | --- |
| `express` | `^5.2.1` | HTTP server, routing, static hosting, JSON body parsing |
| `cors` | `^2.8.6` | Origin allowlist middleware |
| `axios` | `^1.20.0` | Outbound HTTP: AniList GraphQL + Supabase Auth/Admin REST |
| `dotenv` | `^18.0.5` | Loads `.env` into `process.env` at server start |

Backend helper modules (no external dependencies): `catalog-utils.js` (AniList→catalog mapping + merge policy), `search-utils.js` (local search, dedup, local→AniList shape).

## Frontend

| Item | Value |
| --- | --- |
| Supabase client | `@supabase/supabase-js@2.49.1` UMD build from jsDelivr, pinned with a **Subresource Integrity** hash (`sha384-YieC…Uoy`, verified correct during the audit) |
| Fonts | Google Fonts: `Outfit` (display) and `Inter` (body), loaded via `<link>` |
| Icons | Inline SVG in HTML/JS (no icon library) |
| Placeholder images | `https://placehold.co` (fallback for missing/invalid posters) |
| Image hosts used | `s4.anilist.co` (AniList CDN) |

## Data and platform services

| Service | Use | Notes |
| --- | --- | --- |
| AniList GraphQL API (`https://graphql.anilist.co`) | Anime metadata for popular catalog, search, and details | Public, keyless; called server-side only; timeouts 10–15 s |
| Supabase (PostgreSQL) | `public.profiles`, `public.watchlist` tables | Schema in `supabase-schema.sql`, applied manually |
| Supabase Auth | Email/password auth, sessions, password reset | Browser-side via supabase-js |
| Supabase Admin API | Account self-deletion | Server-side only, with the service-role key |
| JustWatch | Legal-availability link target | Deep link, `justwatch.com/us/…` (US locale hardcoded) |
| YouTube | Official trailer links | Link-only, no embedding |

## Tooling

| Tool | Version / config | Role |
| --- | --- | --- |
| ESLint | `^8.57.1`, `.eslintrc.json` (`eslint:recommended`, `browser`+`node`+`es2021`, `no-undef: error`, `no-unused-vars: warn`) | `npm run lint` |
| GitHub Actions | `.github/workflows/ci.yml` | `npm ci` → lint → test on Node 18.x and 20.x, push/PR to `main`/`master` only |
| npm | lockfile v3 (`package-lock.json`) | dependency install |
| Git | repository `github.com/SAMEERARIF43/Static-web` | version control |

## Repository layout (current)

```
server.js             Express API + static host + AniList proxy        (1205 lines)
catalog-utils.js      AniList→catalog mapping + merge + canonical ID    (163 lines)
search-utils.js       local search, dedupe, local→AniList mapping      (103 lines)
test-search.js        end-to-end API/SEO/unit test suite               (563 lines)
supabase-schema.sql   database schema, RLS, signup trigger             (149 lines)
public/               entire frontend, served statically
  index.html (475) · script.js (1564) · auth-ui.js (471) · style.css (1687)
  legal.css (88) · legal.js (23) · privacy/terms/contact/dmca.html
  favicon.svg · assets/favicon-64.png · social-preview.jpg · websites picture.png
docs/                 this documentation set
.github/workflows/    CI
```

## Deliberate non-technologies

- No frontend framework, no TypeScript, no build/bundle step, no CSS preprocessor.
- No analytics, no advertising, no payment processing, no service worker, no PWA manifest.
- No server-side rendering framework — the SPA is a single HTML document with client-side page switching.

## NOT FOUND / NEEDS CONFIRMATION

- Node.js version requirement and lockfile-managed runtime constraints.
- Deployment platform, container config, reverse proxy, TLS termination (no Dockerfile/Procfile/platform config).
- Any staging/production separation, monitoring, or log aggregation.
- Whether Supabase project is production or a scratch project (**NEEDS CONFIRMATION**).
