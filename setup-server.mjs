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
      { name: "championship" },
      { name: "la-liga" },
      { name: "serie-a" },
      { name: "bundesliga" },
      { name: "ligue-1" },
      { name: "champions-league" },
      { name: "europa-league" },
      { name: "conference-league" },
      { name: "team-news", topic: "📋 Confirmed line-ups about an hour before kick-off, for every game in Hawk's bets" },
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
      { name: "hawk-nap", topic: "⭐ The NAP – Hawk's most confident win of the day" },
      { name: "hawk-singles", topic: "🎯 Today's straight wins Hawk rates at 55%+, most likely first" },
      { name: "hawk-doubles", topic: "✌️ The two most likely wins of the day together" },
      { name: "hawk-trebles", topic: "🎲 The three most likely wins of the day together" },
      { name: "live-bets", topic: "🔴 Today's bets with live scores – updated every 10 minutes" },
      { name: "hawk-daily-accas", from: "hawk-acca", topic: "Today's acca – the strongest legs from the domestic leagues" },
      { name: "hawk-weekend-accas", topic: "Posted Fridays – the weekend acca and Around the Leagues" },
      { name: "hawk-cl-accas", topic: "Champions League – the matchweek acca and tonight's acca" },
      { name: "bet-builders", topic: "Hawk's bet builders – legs from one match, priced together" },
      { name: "hawk-reasoning", topic: "Daily summary of why Hawk made today's picks – use 🔍 Why? on any post for the full reasoning" },
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
    description: `Hawk is the bot behind this server. Every morning it studies the football, works out how likely each outcome is, and posts it in plain English – what's likely, how sure it is, and the lowest price worth taking.

Then it checks itself. Every pick is graded the next day, and every Monday Hawk reports whether its percentages are holding up. Nothing gets quietly forgotten.

**⚽ Leagues covered**
Premier League · Championship · La Liga · Serie A · Bundesliga · Ligue 1 · Champions League

**🏇 Racing and 🥊 combat sports are on the way** – racing in time for Cheltenham (16–19 March) and Aintree (8–10 April).`,
  },
  {
    title: "🧠 How Hawk makes a prediction",
    description: `**1️⃣ Attack and defence ratings** – every team is rated on the goals it scores and concedes this season, allowing for who it played and where. Recent games count more.

**2️⃣ Home advantage** – built in from how home and away teams actually score in each league.

**3️⃣ Early-season caution** – with only a few games played, ratings are pulled towards average, so one freak result can't dominate.

**4️⃣ Expected goals** – the ratings give how many goals each side should score, and from that the chance of every scoreline.

**5️⃣ Every market from one grid** – win, draw, goals, both teams to score and builders all come from the same scoreline chances, so they always agree with each other.

**6️⃣ Corners and cards** – each side gets corners and cards ratings the same way, from this season and last. Corners and cards vary a lot from game to game, and Hawk allows for that. Cards also allow for how strict the referee is, where the referee is known. _(Not for the Champions League – there's no history for it yet.)_

**Hawk's numbers are its own.** Bookies' prices are shown next to them for comparison but never mixed in – so you always know what Hawk thinks.

**What Hawk can't see (yet):** injuries, team news, the referee or the weather. When something big changes – a star striker out – use your own judgement.`,
  },
  {
    title: "📅 What gets posted, and when",
    description: `**☀️ 9:00–9:06** – each league's games for today in its own channel, with form and Hawk's pick
**🧩 9:00–9:06** – that league's bet builders in {#bet-builders}
**🔍 9:00–9:06** – a short summary of why in {#hawk-reasoning}
**⭐ 9:07** – the NAP in {#hawk-nap}, plus {#hawk-singles}, {#hawk-doubles} and {#hawk-trebles}
**🎟️ 9:08** – the daily acca in {#hawk-daily-accas} _(domestic leagues)_
**🗓️ 9:09 Fridays** – the weekend acca and Around the Leagues in {#hawk-weekend-accas}
**🇪🇺 9:09 Champions League days** – the matchweek acca and tonight's acca in {#hawk-cl-accas}
**📈 9:10** – yesterday's picks graded in {#results}
**🧪 9:18 Tuesdays** – the weekly accuracy check in {#model-check}, including 💷 profit
**📋 ~1 hour before kick-off** – confirmed line-ups in {#team-news} for every game in Hawk's bets
**🔴 From the first kick-off** – {#live-bets}: every bet with live scores, updated every 10 minutes

League channels, builders and accas are cleared each morning so only the current picks are up. The full record lives in {#results} and {#model-check}.`,
  },
  {
    title: "🃏 Reading Hawk's posts",
    description: `**🎯 Arsenal 74% (70%) · Draw 19% (21%) · Spurs 8% (9%) → Arsenal ✅ · 2-0**
Hawk's chance for each result, the bookies' chance in brackets (their margin taken out), Hawk's pick, and the most likely score.

**The traffic lights**
✅ 70%+ strong · 🟡 55–69% only at the right price · ❌ under 55% a lean, not a bet

**Form** – 🟢 win · 🟡 draw · 🔴 loss, last five games in that competition, latest on the right.

**Hawk's fair price** – the odds that match Hawk's chance, e.g. 58% → 8/11. It's what the price would be if Hawk is right.

**💷 Bookie prices** – next to Hawk's fair price you'll see the best bookie price, e.g. _bet365 **4/5**_, and for accas the top 3 bookies that price every leg. bet365 and Paddy Power cover every market; Sky Bet, William Hill, BoyleSports and others cover results and goals. Prices are from the morning and move, so check before you bet.

**📊 Bookies' price bigger than Hawk's** – flagged when the bookies offer, say, Evens and Hawk's fair price is 8/11. Hawk has been tested against two full seasons of bookies' prices and **hasn't beaten them** – when they disagree, the bookies are usually right. So treat 📊 as a second opinion, not a tip. Every one is tracked in {#results} and {#model-check}.

**🔍 Why?** – under every post. Pick a game and Hawk shows its full reasoning, visible only to you.`,
  },
  {
    title: "🧩 Bet builders",
    description: `One builder per game, posted in {#bet-builders}, most likely first.

• Always built around the result – a win or a double chance
• Can include one corners leg and one cards leg
• Every leg is a real pick on its own (55–90%) – no filler
• No leg that's already implied by another
• The whole builder lands at least 40% of the time

**Priced as one bet, not leg by leg.** Legs from the same game are linked – a win and over 1.5 goals tend to go together – so Hawk works out the real chance of them all landing, the same way bookies price builders. Corners and cards come from their own model and are priced separately from the score.`,
  },
  {
    title: "🎟️ Accas",
    description: `**Every acca follows the same rules:**
• One leg per game, each rated **80% or more**
• Straight wins first, then double chances, then other markets
• Up to 6 legs – and at least 3, or no acca at all
• A 🛡️ safer 4-leg version when the full one is under 30%

**{#hawk-daily-accas}** – today's acca from the domestic leagues.
**{#hawk-weekend-accas}** – posted Friday: the 🗓️ weekend acca (Friday night to Sunday) and 🌍 Around the Leagues, the single strongest pick from each league.
**{#hawk-cl-accas}** – the 🇪🇺 matchweek acca across the whole Champions League week, and 🌙 tonight's acca on each match night.

📐 **The maths, honestly:** every leg has to land. Four 80% legs together come to about 41% – an acca is never as safe as its legs look. That's why the combined chance is always shown.`,
  },
  {
    title: "⭐ NAP, singles, doubles & trebles",
    description: `**Straight wins first** – no double chances. Posted at 9:07 from today's games.

**{#hawk-nap}** – the NAP: Hawk's single most confident win of the day.
**{#hawk-singles}** – up to 5 wins Hawk rates at **55% or more**, most likely first. Each is its own bet.
**{#hawk-doubles}** – the two most likely wins together.
**{#hawk-trebles}** – the three most likely wins together.

**Quiet days:** if there aren't enough wins at 55%+, Hawk tops up with its best **goals, BTTS or team-to-score** picks rated **55–75%** – marked ➕. Never the 1/8 "safe" legs. With no games at all, the channels say so. Every pick is graded in {#results}.`,
  },
  {
    title: "🔴 Live bets & 📋 team news",
    description: `**{#live-bets}** – one message per bet (NAP, singles, double, treble, accas), updated every 10 minutes:
✅ landed · ❌ gone · 🟢 on course – would land if it ended now · 🟠 needs a change · ⏳ to play
Legs like _over 1.5 goals_ show ✅ as soon as they're safe. The official result still comes in {#results} the next morning.

**{#team-news}** – confirmed line-ups about an hour before kick-off, for every game in Hawk's bets: each XI, what changed from that team's last line-up, and ⚠️ any **regular starter missing** (once Hawk has seen a few of their line-ups). Hawk's percentages are set at 9am, before line-ups are known – so a big name missing is worth a second look.`,
  },
  {
    title: "📈 Keeping Hawk honest",
    description: `**{#results}** – every morning, everything from the day before: each pick with the final score, each builder and acca **leg by leg** with ✅ or ❌, and a tally.
• Settled on the **90-minute score**, like the bookies
• Postponed games are ➖ **void** and drop out of builders and accas
• Games not finished in time show ⏳ and are re-checked the next morning
• 🚩🟨 Corners and cards legs are graded the next morning with everything else – if the stats are late, they show ⏳ and are re-checked on Tuesday and Friday

**💷 Profit tracker** – every NAP, single, double, treble and acca is tracked as a **€1 stake at the best bookie price when it was posted**. Each day's result is in {#results}; the running total and return for each bet type is in {#model-check}. This is the real test of whether following Hawk pays.

**{#model-check}** – every Tuesday: when Hawk says 70%, does it land about 70% of the time? Each band is marked ✅ on target, ⚠️ too confident or 🔼 too cautious. It takes a few weeks of results before these numbers mean much.

**{#hawk-reasoning}** – a running history of why Hawk made each day's picks.`,
  },
  {
    title: "⌨️ Commands",
    description: `Use these in {#bot-commands}:

**/fixtures** – the next 7 days for any league, with form and predictions
**/table** – the league table, with form
**/form** – a team's form, home and away record and recent results
**/predict** – Hawk's full prediction and bet builder for a team's next game

Pick a league from the list, or leave it blank for the Premier League. Team names are flexible – \`spurs\`, \`man city\` and \`MCI\` all work.`,
  },
];

const RULES = [
  {
    title: "📜 Server Rules",
    description: `Keep it simple and everyone gets on.

**1. Respect first** – wind-ups and banter are part of sport. Personal abuse isn't, and it will get you removed.

**2. Adults only** – betting is discussed here, so you need to be 18+ or the legal gambling age where you live.

**3. No selling, no spam** – paid tipping services, affiliate links and self-promotion aren't allowed.

**4. Right channel, right chat** – talk in {#general}, share slips in {#bet-slips}, and use commands in {#bot-commands}. Every other channel is kept for Hawk's posts.

**5. Your bets are your decision** – Hawk gives estimates, not guarantees or financial advice. It can't see team news or injuries, and it gets things wrong – {#results} shows every miss. What you stake is down to you.

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
      const old = !channel && ch.from && existing.find((c) => c.type === 0 && c.name === ch.from);
      if (channel) {
        console.log(`   ✔ exists: #${ch.name}`);
      } else if (old) {
        // Rename rather than recreate, so the channel keeps its ID, history and permissions.
        channel = await api("PATCH", `/channels/${old.id}`, { name: ch.name, topic: ch.topic, parent_id: category.id });
        console.log(`   ✏️ renamed: #${ch.from} → #${ch.name}`);
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

  // Put every category and channel in the order listed in LAYOUT, so new channels
  // slot into the right place instead of landing at the bottom.
  const order = [];
  let pos = 0;
  existing = await api("GET", `/guilds/${GUILD_ID}/channels`);
  for (const [catIndex, cat] of LAYOUT.entries()) {
    const category = existing.find((c) => c.type === 4 && c.name === cat.name);
    if (category) order.push({ id: category.id, position: catIndex });
    for (const ch of cat.channels) {
      if (ids[ch.name]) order.push({ id: ids[ch.name], position: pos++ });
    }
  }
  await api("PATCH", `/guilds/${GUILD_ID}/channels`, order);
  console.log("\n↕ Channel order updated");

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
