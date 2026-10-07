# Product — Anime Hub

## What It Is
AnimeHub is a **discovery and cataloging platform** for anime and anime movies.
It shows ratings, genres, release info, official trailers (YouTube via AniList),
and "where to watch" links to legitimate streaming services (JustWatch).

Users can create an account, maintain a cloud watchlist, and browse titles from
a live AniList catalog (with a curated fallback when AniList is unreachable).

## What It Is NOT
- **Not a streaming service.** AnimeHub does not host, store, embed, or link to
  pirated video content. No unlicensed episode embeds or torrent links, ever.
- **Not a social platform.** No public comments, public profiles, or community
  features exist today.
- **Not production-deployed** from this repository as of the current work phase.
  DEPLOYMENT IS OUT OF SCOPE.

## Legal Stance
- All anime metadata, cover art, and banner images are sourced exclusively via
  the AniList GraphQL API and remain the property of their respective copyright
  holders. An AniList attribution appears in the footer.
- The Watch page (detail view) shows only the official trailer from AniList
  (`trailer.site === 'youtube'`) and a JustWatch "where to watch" link.
- Any feature that streams, embeds, or links to unlicensed episodes must be
  refused, removed, or blocked — with no exceptions.
- DMCA contact, Privacy Policy, Terms of Service, and a Copyright notice page
  are shipped as static HTML in `public/`.

## Target User
Anime fans who want a fast, clean way to discover titles, check ratings/genres,
save a watchlist, and find out where to stream legally.

## AniList Attribution (required in footer)
> "Anime data and images provided by [AniList](https://anilist.co)."
