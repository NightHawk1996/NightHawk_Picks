# Hawk – status and plan (6 Nov 2026)

## Live and running unattended (Cloudflare Workers, free plan)
- **Football (9am Dublin):** league posts, bet builders, daily, weekend and Champions League accas, #results, Tuesday #model-check. Uses football-data.org, The Odds API (bookies' % shown separately from Hawk's %) and football-data.co.uk history (Tue/Fri 03:20 UTC refresh).
- **Corners & cards settling (step 24):** ESPN's public app data (`site.api.espn.com`, unofficial, no key) gives corners, yellows and reds for all nine leagues, so corners and cards builder legs settle at 9:10 the next morning. Results are cached in KV for 60 days (`espn:CODE:EVENTID`). football-data.co.uk (Tue/Fri) is the backup. Confirmed working for 4 Nov.
- **`/daily-post` results option** has `days_ago` (1–7) to re-post any recent day's results.
- **Racing collector (The Racing API, free plan):** 07:40 UTC today's cards · 21:40 results · 21:41 tomorrow's cards. Saved in KV for 400 days (`racecards:DATE`, `raceresults:DATE`). GB and Irish racing only.
- **Racing posts:** 07:41 UTC #racecards (cleared daily) · 21:42 UTC #racing-results with a 30-day jockey and trainer form table (kept). The layout is staying as it is.
- **/trends:** 28 races (27 Cheltenham + the Grand National) from Wikipedia winners lists. Only the Champion Hurdle, Stayers', County Hurdle, Gold Cup and National have SPs so far.
- Crons: `["0-6,8-18 8,9 * * *", "20-31 3 * * 2,5", "40-42 7,21 * * *"]`

## Data-source rule (changed 6 Nov)
- Previously: official or allowed sources only. On 6 Nov the user agreed to use unofficial sources against their terms where no free official one exists, for this private server. ESPN is the first, used only for corners and cards settling, with an official source as backup.

## Free-plan racing data
- Results: positions, horse, age, sex, weight, headgear, OR, jockey, trainer, owner, breeding, course, distance, class, going, surface.
- **Not included:** SPs, beaten distances, winning times, comments.

## Bet builders: corners and cards
- Corners and cards legs are already in the builder pool for the six leagues with history. They're picked on likelihood only (55–90% per leg; highest-chance combination wins), so cards rarely make the cut. **Decision:** don't force them in; add only on value.
- **OddsPapi (key stored by user as ODDSPAPI_KEY env var; probe done 6 Nov):**
  - League IDs: PL 17 · ELC 18 · LaLiga 8 · Serie A 23 · Bundesliga 35 · Ligue 1 34 · UCL 7 · UEL 679 · UECL 34480.
  - Pinnacle prices corners O/U (8.5–10.5), corners handicap, bookings 1X2 and bookings O/U.
  - Settlements: match result and goals settle WIN/LOSE; **corners and bookings stay UNDECIDED** (no stats feed), so it isn't used for settling.
  - 250 requests a month; 1 call = 1 request; historical odds are free of quota.
- **Next, optional:** add Pinnacle corners and bookings prices to /predict as a 📊 value check. Check whether a "booking" counts a red as 2 before comparing.
- Ruled out for settling: Highlightly (terms ban betting use), API-Football (no current season on free), football-data.org stats (paid), TheSportsDB (free stats are a demo).

## To do
- Update the pinned **How it works** text (setup-server.mjs line ~204): corners and cards are now graded next morning, not Tue/Fri.
- UFC and boxing (next).
- February: one month of the Racing API Standard plan to backfill 2–3 years of results with SPs and beaten distances; top up /trends.
- Late February: build and backtest the racing model ("a second opinion, not a tip") before Cheltenham (16–19 March 2027) and Aintree (8–10 April 2027).
- Later: auto-deploy from GitHub; remove Manage Channels and Manage Messages from Hawk's role once setup is finished; watch the 👨‍⚖️ referee counts.

## Rules kept throughout
No AI write-ups · Hawk's % kept separate from bookies' % · fractional odds · "Powered by Hawk 🦅" footers (Wikipedia credit kept on /trends) · secrets only in Wrangler / password manager, never in chat or the repo.
