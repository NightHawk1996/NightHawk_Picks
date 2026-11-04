# Hawk – status and plan (4 Nov 2026)

## Live and running unattended (Cloudflare Workers, free plan)
- **Football (9am Dublin):** league posts, bet builders, daily, weekend and Champions League accas, #results, Tuesday #model-check. Uses football-data.org, The Odds API (bookies' % shown separately from Hawk's %) and football-data.co.uk history (Tue/Fri 03:20 UTC refresh).
- **Racing collector (The Racing API, free plan):** 07:40 UTC today's cards · 21:40 results · 21:41 tomorrow's cards. Saved in KV for 400 days (`racecards:DATE`, `raceresults:DATE`). GB and Irish racing only.
- **Racing posts:** 07:41 UTC #racecards (cleared daily) · 21:42 UTC #racing-results with a 30-day jockey and trainer form table (kept). The layout is staying as it is.
- **/trends:** 28 races (27 Cheltenham + the Grand National) from Wikipedia winners lists. Only the Champion Hurdle, Stayers', County Hurdle, Gold Cup and National have SPs so far.
- Crons: `["0-6,8-18 8,9 * * *", "20-31 3 * * 2,5", "40-42 7,21 * * *"]`

## Free-plan racing data
- Results: positions, horse, age, sex, weight, headgear, OR, jockey, trainer, owner, breeding, course, distance, class, going, surface.
- **Not included:** SPs, beaten distances, winning times, comments.

## Plan
1. **Now to February:** leave the collector running; no racing model yet.
2. **February:** one month of the Racing API Standard plan to backfill 2–3 years of full results (SPs, beaten distances), top up /trends prices, ages and trainers, and fill past Festival results.
3. **Late February:** build and backtest a racing model (win %, fair price, each-way, racing accas), labelled "a second opinion, not a tip". Ready before Cheltenham (16–19 March 2027) and Aintree (8–10 April 2027).
4. **Later:** UFC and boxing (user's next session), auto-deploy from GitHub, remove Manage Channels and Manage Messages from Hawk's role once setup is finished, and keep an eye on the 👨‍⚖️ referee counts.

## Rules kept throughout
No unofficial APIs or scraping against terms · no AI write-ups · Hawk's % kept separate from bookies' % · fractional odds · "Powered by Hawk 🦅" footers (Wikipedia credit kept on /trends) · secrets only in Wrangler / password manager, never in chat or the repo.
