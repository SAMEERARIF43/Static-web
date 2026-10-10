# Rill walkthrough — Guest watchlist flow (Anime Hub)

**Flow:** Add a title to the guest (browser-local) watchlist, view it, and remove it.
**Target:** the local app at `http://localhost:3000` (run with `npm start`).
**No account or credentials are needed** — this is the guest path, stored under the `localStorage` key `anime_hub_watchlist` ([public/script.js](public/script.js)).

## Numbered steps and expected behavior

1. Start the app: run `npm start`, then open http://localhost:3000.
   - Expected: Home loads with the **Trending Now** and **Most Popular** grids.
2. In the hero search box type `One Piece` and press Enter.
   - Expected: the Search Results page opens, headed *Search Results for "One Piece"*, with matching cards.
3. Click the hollow star in the corner of any result card.
   - Expected: a toast reads **Added to Watchlist!** and the star fills in.
4. In the top navigation click **My Watchlist**.
   - Expected: the starred title shows as a card and the empty state is hidden.
5. Reload the page, then open **My Watchlist** again.
   - Expected: the title is still listed, because a guest list is stored under the `localStorage` key `anime_hub_watchlist`.
6. Click the filled star on the watchlist card.
   - Expected: a toast reads **Removed from Watchlist** and the empty state **Your watchlist is empty** returns.

**Test data:** search query `"One Piece"`; any AniList result, for example AniList id `21`, works.

## Missing inputs

- **No public app URL was supplied.** The handoff link therefore carries only `#task=` (no `&url=`). The app runs on `http://localhost:3000`, which Rill cloud runs cannot reach.
- No account, credentials or API keys are required for this guest flow.
- Rill is not installed or invoked here; this document is the deliverable and no recording has been made.

Because the target is a local/private app, for a recording use one of:

- Manual screen recording: https://userill.dev/record?utm_source=freebuff&utm_medium=paid&utm_campaign=rill
- Recording an existing browser agent: https://userill.dev/docs/agent-quickstart?utm_source=freebuff&utm_medium=paid&utm_campaign=rill

## Handoff link

[Open your walkthrough in Rill](https://userill.dev/freebuff?utm_source=freebuff&utm_medium=paid&utm_campaign=rill&utm_content=text-ad&bfcid=bfc_1.eyJpZCI6IjNjZDE1NjA5LTM1YTYtNDFhMS04MjZlLWJjNGJlMmY3OTBmNiIsImMiOiIxNDQyMTUzOS1kYjNiLTQ1YzEtYjQ5OC1hYTMxOTFmNDkxYzAiLCJrIjoiNDU4ODZlNWEtYzkyZC00ZDUxLTg1ZjgtYzc4YTRmMTY3ZWYwIiwiaWF0IjoxNzkxNjQ4MDkwfQ.2VD664b18JCEZiq_bKpG0DEquONnx4jDNIVvREToXrY#task=Guest%20watchlist%3A%20star%20a%20title%20and%20manage%20it%20locally%0A%0A1.%20Start%20the%20app%3A%20run%20%60npm%20start%60%2C%20then%20open%20http%3A%2F%2Flocalhost%3A3000.%0A%20%20%20Expected%3A%20Home%20loads%20with%20the%20Trending%20Now%20and%20Most%20Popular%20grids.%0A2.%20In%20the%20hero%20search%20box%20type%20%60One%20Piece%60%20and%20press%20Enter.%0A%20%20%20Expected%3A%20the%20Search%20Results%20page%20opens%2C%20headed%20Search%20Results%20for%20%22One%20Piece%22%2C%20with%20matching%20cards.%0A3.%20Click%20the%20hollow%20star%20in%20the%20corner%20of%20any%20result%20card.%0A%20%20%20Expected%3A%20a%20toast%20reads%20Added%20to%20Watchlist!%20and%20the%20star%20fills%20in.%0A4.%20In%20the%20top%20navigation%20click%20My%20Watchlist.%0A%20%20%20Expected%3A%20the%20starred%20title%20shows%20as%20a%20card%20and%20the%20empty%20state%20is%20hidden.%0A5.%20Reload%20the%20page%2C%20then%20open%20My%20Watchlist%20again.%0A%20%20%20Expected%3A%20the%20title%20is%20still%20listed%2C%20because%20a%20guest%20list%20is%20stored%20under%20localStorage%20key%20anime_hub_watchlist.%0A6.%20Click%20the%20filled%20star%20on%20the%20watchlist%20card.%0A%20%20%20Expected%3A%20a%20toast%20reads%20Removed%20from%20Watchlist%20and%20the%20empty%20state%20Your%20watchlist%20is%20empty%20returns.%0A%0ATest%20data%3A%20search%20query%20%22One%20Piece%22%3B%20any%20AniList%20result%2C%20for%20example%20AniList%20id%2021%2C%20works.)

Your walkthrough is prepared. No recording has been made yet. In Rill, review the steps, add a public app URL, and choose Sign up to run if you need an account. The walkthrough uses Interact mode. Press Run to start it.
