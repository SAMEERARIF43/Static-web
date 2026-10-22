# Anime Hub — Future Roadmap & Post-Launch Backlog

## Multi-Provider API Aggregation

### Motivation
AniList is the sole catalog source today. Western animation (cartoon, Disney/Pixar, DreamWorks, etc.) and live-action series are poorly covered, limiting the catalog's breadth. Aggregating additional providers closes this gap.

### Proposed Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Client     │────▶│  Express proxy   │────▶│   AniList   │
│  (browser)  │     │  /api/catalog/*  │     │  (anime)    │
└─────────────┘     └──────────────────┘     └─────────────┘
                           │
                           ▼
                    ┌──────────────────┐
                    │ Provider router  │
                    │ (by countryOfOrigin│
                    │  / media type)   │
                    └──────────────────┘
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
        ┌─────────┐   ┌─────────┐   ┌──────────┐
        │  AniList│   │  Kitsu  │   │  TVDB    │
        │(anime)  │   │(anime)  │   │(TV/Western│
        └─────────┘   └─────────┘   │ animation)│
                                    └──────────┘
```

### Implementation Items
- [ ] Provider abstraction layer: normalize each provider's response into the Anime Hub catalog item shape (`id`, `title`, `coverImage`, `genres`, `countryOfOrigin`, `format`, `status`, `averageScore`, `seasonYear`)
- [ ] `countryOfOrigin`-based provider routing (e.g., JP → AniList, US → TVDB, CN → AniList)
- [ ] Kitsu proxy endpoint (`/api/kitsu/*`) for Western/anime titles missing from AniList
- [ ] TVDB proxy endpoint (`/api/tvdb/*`) for Western animation and live-action series
- [ ] Provider health checks and circuit breakers (skip a provider after repeated failures)
- [ ] Deduplication by canonical ID across providers (prevent duplicate titles)
- [ ] Source attribution per item (`X-Catalog-Source`-style field showing provider)
- [ ] Rate-limit scoping per provider (separate windows for AniList vs. Kitsu vs. TVDB)
- [ ] Update `docs/DEPLOYMENT_CHECKLIST.md` with new provider env vars (`KITSU_API_URL`, `TVDB_API_KEY`, etc.)

---

## Progressive Web App (PWA)

### Motivation
Enable installable, offline-capable access on mobile and desktop without relying on a third-party app store.

### Proposed Architecture

```
├── public/
│   ├── manifest.json          # PWA manifest (name, icons, start_url, theme_color)
│   ├── sw.js                  # Service worker (offline caching, cache-first assets)
│   ├── icon-192.png, icon-512.png
│   └── ...existing static assets
```

### Implementation Items
- [ ] `public/manifest.json`: name "Anime Hub", short_name "AnimeHub", start_url "/", display "standalone", theme_color matching `--primary` (`#ff7200`), icons at 192×192 and 512×512
- [ ] `public/sw.js`: cache-first strategy for `public/` assets (HTML, CSS, JS, images); network-first for `/api/*`; cache expiration / versioning
- [ ] Register service worker in `public/index.html` (`navigator.serviceWorker.register('/sw.js')`)
- [ ] Offline fallback UI for catalog pages when the network is unavailable
- [ ] Add `manifest.json` link tag to `<head>` in `public/index.html`
- [ ] Test PWA install prompt and offline behavior in Chrome DevTools (Application panel)
- [ ] Add PWA to `docs/DEPLOYMENT_CHECKLIST.md` (HTTPS required for service workers)

### Out of Scope for v1.1
- Push notifications (requires VAPID keys + backend subscription store)
- Background sync
- Native wrapper (Capacitor/Cordova) — consider only after PWA is stable

---

## Prioritization (Suggested)

| Priority | Item | Rationale |
|---|---|---|
| P1 | Multi-provider aggregation (Kitsu/TVDB) | Broadens catalog beyond AniList's anime focus |
| P1 | PWA manifest + service worker | Installable, offline-capable mobile access |
| P2 | Native mobile wrapper (Capacitor) | Distribute via app stores (after PWA stable) |
| P2 | Provider health checks + circuit breakers | Production resilience when aggregating |
| P3 | Push notifications | Re-engagement; depends on backend subscription store |
