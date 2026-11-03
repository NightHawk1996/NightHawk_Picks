// setup-server.mjs
// One-off setup for the NightHawk Picks Discord server.
// - Creates every category and channel (skips any that already exist, so it's safe to re-run)
// - Makes Info / pick channels read-only for everyone except Hawk (the server owner can always post)
// - Makes #bot-log private
// - Replaces Hawk's posts in #how-it-works and #rules with the latest text, and pins the first post in each
//
// Needs Node 18+ (uses built-in fetch). No npm packages required.
// Reads DISCORD_TOKEN and GUILD_ID from environment variables. Never hard-code the token.

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN or GUILD_ID environment variable. See the run instructions.");
  process.exit(1);
}

const API = "https://discord.com/api/v10";
const COLOUR = 0xf2a900; // NightHawk amber
const FOOTER = { text: "NightHawk Picks · 18+ · Please gamble responsibly" };

// Permission bits
const P = {
  VIEW: 1n << 10n,
  SEND: 1n << 11n,
  EMBED: 1n << 14n,
  ATTACH: 1n << 15n,
  HISTORY: 1n << 16n,
};
const BOT_ALLOW = (P.VIEW | P.SEND | P.EMBED | P.ATTACH | P.HISTORY).toString();

// ---------------------------------------------------------------------------
// Layout. readOnly = only Hawk (and you, as owner) can post. private = hidden from everyone else.
// ---------------------------------------------------------------------------
const LAYOUT = [
  {
    name: "📌 Info",
    readOnly: true,
    channels: [
      { name: "how-it-works", topic: "How Hawk's picks work – start here" },
      { name: "rules", topic: "House rules – please read" },
      { name: "announcements", topic: "Server news and updates" },
    ],
  },
  {
    name: "⚽ Football",
    readOnly: true,
    channels: [
      { name: "premier-league" },
      { name: "la-liga" },
      { name: "serie-a" },
      { name: "bundesliga" },
      { name: "ligue-1" },
      { name: "champions-league" },
      { name: "europa-league" },
      { name: "conference-league" },
    ],
  },
  {
    name: "🏇 Racing",
    readOnly: true,
    channels: [
      { name: "racecards", topic: "Daily UK & Irish racecards" },
      { name: "going-reports", topic: "Going updates – ratings are re-run when the ground changes" },
      { name: "racing-results", topic: "Daily racing results" },
      { name: "cheltenham-2027", topic: "Cheltenham Festival · 16–19 March 2027" },
      { name: "aintree-2027", topic: "Grand National Festival · 8–10 April 2027" },
    ],
  },
  {
    name: "🥊 Combat",
    readOnly: true,
    channels: [
      { name: "ufc" },
      { name: "boxing" },
      { name: "fight-cards", topic: "Upcoming UFC and boxing events" },
    ],
  },
  {
    name: "🎯 Picks",
    readOnly: true,
    channels: [
      { name: "hawk-acca", topic: "Hawk's acca – the strongest legs across every sport" },
      { name: "results", topic: "Yesterday's legs – ✅ won · ❌ lost · ➖ void" },
      { name: "model-check", topic: "Every Monday – how honest were Hawk's numbers?" },
    ],
  },
  {
    name: "💬 Community",
    channels: [
      { name: "general", topic: "Chat about anything" },
      { name: "bet-slips", topic: "Share and log your slips" },
    ],
  },
  {
    name: "🤖 Bot",
    channels: [
      { name: "bot-commands", topic: "Run Hawk's slash commands here" },
      { name: "bot-log", topic: "Hawk's job reports and errors", private: true },
    ],
  },
];

// ---------------------------------------------------------------------------
// Info posts. {#channel-name} is replaced with a clickable channel link.
// ---------------------------------------------------------------------------
const HOW_IT_WORKS = [
  {
    title: "🦅 Welcome to NightHawk Picks",
    description: `Hawk does the homework so you don't have to. Every day it gathers the numbers – form, conditions, matchups and prices – turns them into a chance for each outcome, then compares that with what the bookies are offering.

What you get is plain English: what's likely, how sure Hawk is, and whether the price is worth taking.

**Find your way around**
⚽ {#premier-league} through to {#conference-league} – one channel per competition
🏇 {#racecards} · {#going-reports} · {#racing-results}
🏆 {#cheltenham-2027} · {#aintree-2027}
🥊 {#ufc} · {#boxing} · {#fight-cards}
🎟️ {#hawk-acca} · {#results} · {#model-check}`,
  },
  {
    title: "⚽ Football – what Hawk looks at",
    description: `**Ratings** – each side has an attacking and a defensive score, built from the last two seasons and weighted towards recent matches.

**Venue** – plenty of teams are a different animal at home. Their home and away splits feed in, carefully at first while the sample is small.

**Who's missing** – absent first-choice players drag a team's score down and are left out of player markets.

**The man in the middle** – each referee's booking rate shifts the cards numbers.

**Fixture load and weather** – a midweek European away day, a downpour or a gale all get factored in.

**The market** – bookmaker prices carry information Hawk can't see, so they're mixed into the final figure.

**Keeping score** – once the final whistle goes, every pick is graded. Markets that keep underperforming get dialled back, so the percentages stay believable.`,
  },
  {
    title: "🏇 Racing – what Hawk looks at",
    description: `**Recent runs** – the last few outings matter most, along with how long the horse has been off the track.

**Ground, trip and track** – how each runner has handled today's going, today's distance and this course. Proven on soft? That counts. Never shown anything on heavy? That counts too.

**Class and handicap mark** – up or down in grade, and is it racing off a mark it has won from before?

**Yard and saddle** – how the trainer's horses are running right now, the jockey's form, and both of their records at the track.

**Festival profiles** – at Cheltenham and Aintree, each runner is measured against the type of horse that has won that race before: age, weight carried, starting price and preparation.

**The market** – prices are blended in, same as football.

🌧️ Ground can change mid-meeting. When it does, an update goes up in {#going-reports} and Hawk re-rates the field.`,
  },
  {
    title: "🥊 Fights – what Hawk looks at",
    description: `**The record** – not just the win-loss column, but the quality of opposition behind it.

**Finishing style** – does a fighter get it done by stoppage, submission or on the scorecards? That shapes the method and round predictions.

**Size and shape** – age, height, reach, and orthodox v southpaw.

**Ring rust and weight** – long lay-offs and changes of division are both flagged.

**The market** – prices blended in.

📅 Events are listed in {#fight-cards}; predictions appear in {#ufc} and {#boxing}.`,
  },
  {
    title: "🃏 Reading Hawk's cards",
    description: `**The traffic lights**
✅ 70% or higher – a strong lean
🟡 55–69% – only if the price is right
❌ Below 55% – leave it

**Two numbers side by side** – the bold figure is Hawk's estimate; the smaller one is what the bookies' price implies once their margin is stripped out.

**Confidence** – 🟢 high · 🟡 medium · 🔴 low. ⭐ marks a standout.

**Form strings** – 🟢🟡🔴 for wins, draws and losses in football and fights; finishing positions in racing.

**What each card covers**
⚽ predicted score, goals markets, corners, bookings, referee, absentees and player picks
🏇 going, distance and course record, yard and jockey form, festival-profile score
🥊 winner, method and round`,
  },
  {
    title: "🎟️ Accas, bankers and value",
    description: `🔒 **Bankers** – the day's most probable selections, across every sport.

🎟️ **Hawk's Acca** – posted in {#hawk-acca}. Only legs Hawk rates at 80% or more make the cut. You'll always see the combined chance of the whole thing, plus a shorter 4-leg alternative when the full version is a stretch.

📐 **The acca maths, honestly** – chances multiply. Four 80% legs together come out at roughly 41%, so an acca is never as safe as its individual legs look. That's why the combined figure is always shown.

💰 **Value** – flagged when Hawk's estimate is at least 3 points above the bookies'. The risk is still there; the price just favours you.

🔢 **Minimum odds** – each pick lists the lowest price worth taking. Anything shorter and the bet isn't paying enough for the risk.`,
  },
  {
    title: "⏰ The daily routine",
    description: `☀️ **9am** – football predictions and racecards for the next 24 hours
🌙 **Evening** – the day's racing results logged into Hawk's form book
📈 **Morning** – yesterday's selections graded ✅ ❌ ➖ in {#results}
🧪 **Monday** – the weekly accuracy report in {#model-check}
🥊 **Fight week** – cards and predictions in the run-up to each event`,
  },
];

const RULES = [
  {
    title: "📜 Server Rules",
    description: `Keep it simple and everyone gets on.

**1. Respect first** – wind-ups and banter are part of sport. Personal abuse isn't, and it will get you removed.

**2. Adults only** – betting is discussed here, so you need to be 18+ or the legal gambling age where you live.

**3. No selling, no spam** – paid tipping services, affiliate links and self-promotion aren't allowed.

**4. Right channel, right chat** – talk in {#general} and share slips in {#bet-slips}. Every other channel is kept for Hawk's posts.

**5. Your bets are your decision** – Hawk gives estimates, not guarantees or financial advice. What you stake is down to you.

🎲 **Staying in control**
Gambling should be entertainment – never income, and never a way to win back what you've lost.
• Decide your budget before you bet, and stop when it's gone
• Never stake money you need for anything else
• A losing run isn't something to chase
• Step away regularly – the sport is just as good without money on it

No pick is a sure thing. Even an 80% selection loses about once in every five.`,
  },
  {
    title: "🆘 Help is always there",
    description: `If gambling has stopped being fun, talking to someone helps. These lines are free and confidential.

🇮🇪 **Ireland** – Problem Gambling helpline, 24/7: **1800 936 725** · [problemgambling.ie](https://www.problemgambling.ie)
🇬🇧 **Great Britain** – National Gambling Helpline, 24/7: **0808 8020 133** · [gamcare.org.uk](https://www.gamcare.org.uk)
**Northern Ireland** – **08000 886 725**

⏸️ **Blocking tools** – [GAMSTOP](https://www.gamstop.co.uk/) lets you exclude yourself from UK gambling sites for free. Irish bookmakers have self-exclusion in your account settings.

🧭 **More advice** – [GambleAware](https://www.gambleaware.org/)`,
  },
];

// Which channel gets which posts. Each entry is posted as its own message; the first is pinned.
const POSTS = [
  { channel: "how-it-works", embeds: HOW_IT_WORKS },
  { channel: "rules", embeds: RULES, together: true }, // rules + helplines in one message
];

// ---------------------------------------------------------------------------
// Discord API helper with rate-limit handling
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (nighthawk-picks-setup, 1.0)",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const wait = Math.ceil((data.retry_after ?? 1) * 1000) + 250;
      console.log(`   …rate limited, waiting ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`${method} ${path} → still rate limited after several retries`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const me = await api("GET", "/users/@me");
  const guild = await api("GET", `/guilds/${GUILD_ID}`);
  console.log(`Logged in as ${me.username} – setting up "${guild.name}"\n`);

  const overwritesFor = ({ readOnly, private: isPrivate }) => {
    if (isPrivate) {
      return [
        { id: GUILD_ID, type: 0, allow: "0", deny: P.VIEW.toString() }, // @everyone can't see it
        { id: me.id, type: 1, allow: BOT_ALLOW, deny: "0" },
      ];
    }
    if (readOnly) {
      return [
        { id: GUILD_ID, type: 0, allow: "0", deny: P.SEND.toString() }, // @everyone can read, not post
        { id: me.id, type: 1, allow: BOT_ALLOW, deny: "0" },
      ];
    }
    return [];
  };

  let existing = await api("GET", `/guilds/${GUILD_ID}/channels`);
  const ids = {}; // channel name → id

  for (const [catIndex, cat] of LAYOUT.entries()) {
    let category = existing.find((c) => c.type === 4 && c.name === cat.name);
    if (category) {
      console.log(`✔ Category exists: ${cat.name}`);
    } else {
      category = await api("POST", `/guilds/${GUILD_ID}/channels`, {
        name: cat.name,
        type: 4,
        position: catIndex,
        permission_overwrites: overwritesFor(cat),
      });
      console.log(`＋ Created category: ${cat.name}`);
    }

    for (const [chIndex, ch] of cat.channels.entries()) {
      const flags = { readOnly: cat.readOnly, private: ch.private };
      let channel = existing.find((c) => c.type === 0 && c.name === ch.name && c.parent_id === category.id);
      if (channel) {
        console.log(`   ✔ exists: #${ch.name}`);
      } else {
        channel = await api("POST", `/guilds/${GUILD_ID}/channels`, {
          name: ch.name,
          type: 0,
          parent_id: category.id,
          position: chIndex,
          topic: ch.topic,
          permission_overwrites: overwritesFor(flags),
        });
        const tag = ch.private ? " (private)" : cat.readOnly ? " (read-only)" : "";
        console.log(`   ＋ created: #${ch.name}${tag}`);
      }
      ids[ch.name] = channel.id;
    }
  }

  // Replace {#channel-name} with a clickable channel mention
  const linkify = (text) =>
    text.replace(/\{#([a-z0-9-]+)\}/g, (_, name) => (ids[name] ? `<#${ids[name]}>` : `#${name}`));
  const toEmbed = (e) => ({ title: e.title, description: linkify(e.description), color: COLOUR, footer: FOOTER });

  console.log("\nPosting info channels…");
  for (const post of POSTS) {
    const channelId = ids[post.channel];
    const recent = await api("GET", `/channels/${channelId}/messages?limit=50`);
    const oldPosts = recent.filter((m) => m.author?.id === me.id);
    for (const m of oldPosts) {
      await api("DELETE", `/channels/${channelId}/messages/${m.id}`); // Hawk can always delete its own posts
    }
    if (oldPosts.length) console.log(`   🗑 removed ${oldPosts.length} old post(s) from #${post.channel}`);

    const batches = post.together ? [post.embeds] : post.embeds.map((e) => [e]);
    let first = null;
    for (const batch of batches) {
      const msg = await api("POST", `/channels/${channelId}/messages`, { embeds: batch.map(toEmbed) });
      first ??= msg;
    }
    console.log(`   ＋ posted ${post.embeds.length} section(s) in #${post.channel}`);

    try {
      try {
        await api("PUT", `/channels/${channelId}/messages/pins/${first.id}`);
      } catch (e) {
        if (e.status !== 404) throw e;
        await api("PUT", `/channels/${channelId}/pins/${first.id}`); // older endpoint
      }
      console.log(`   📌 pinned the first post in #${post.channel}`);
    } catch (e) {
      console.log(`   ⚠ couldn't pin in #${post.channel} (${e.status ?? "error"}) – pin it manually, no harm done`);
    }
  }

  console.log("\nAll done. Check the server, then remove Manage Channels and Manage Messages from Hawk's role.");
}

main().catch((err) => {
  console.error("\n✖ Setup stopped:", err.message);
  if (err.status === 401) console.error("  The token was rejected – check you pasted the bot token, not the Public Key.");
  if (err.status === 403) console.error("  Missing permission – check Hawk was invited with Manage Channels.");
  if (err.status === 404) console.error("  Server not found – check GUILD_ID is your Server ID and Hawk is in that server.");
  process.exit(1);
});
