# NightHawk Picks 🦅

A personal Discord server with a sports-data bot, **Hawk**, covering football, horse racing and combat sports (UFC and boxing). Hawk gathers form, conditions and prices, and posts picks and accas into the server.

Hawk is an HTTP interactions bot: it will run on Cloudflare Workers (free tier) and answer slash commands, with scheduled jobs posting daily picks and collecting racing results.

> Personal project. Picks are estimates, not advice. 18+ only – please gamble responsibly.

## What's here so far

| File | What it does |
|---|---|
| `setup-server.mjs` | One-off script that builds the Discord server layout and posts the `#how-it-works` and `#rules` content |
| `.gitignore` | Keeps secrets, dependencies and local files out of the repo |

## Server setup script

Builds every category and channel, sets read-only and private permissions, and posts and pins the info channels. It is safe to re-run: existing channels are skipped, and Hawk's posts in `#how-it-works` and `#rules` are replaced with the latest text.

**Needs:** Node.js LTS (18 or later). No npm packages.

**Run it (PowerShell):**

```powershell
$env:DISCORD_TOKEN = Read-Host "Bot token" -MaskInput
$env:GUILD_ID = "your-server-id"
node setup-server.mjs
```

The bot token is read at runtime and is **never** stored in this repo. The bot needs **Manage Channels** (to build the layout) and **Manage Messages** (to pin posts) while the script runs; remove both afterwards.

To change the channel text, edit the `HOW_IT_WORKS` or `RULES` sections in the script and run it again.

## Roadmap

- [x] Discord server layout and info channels
- [ ] Cloudflare Worker with slash commands (`/ping` first)
- [ ] Daily racing collector (The Racing API free tier → Cloudflare D1)
- [ ] Football fixtures and form
- [ ] Racing commands (`/horse`, `/race`) and going reports
- [ ] Cheltenham (16–19 March 2027) and Aintree (8–10 April 2027) features
- [ ] UFC and boxing
- [ ] Auto-deploy from GitHub to Cloudflare

## Secrets

Never commit any of these. They belong in a password manager, and later in Cloudflare Worker secrets:

- Discord bot token
- The Racing API username and password
- Any other API keys
