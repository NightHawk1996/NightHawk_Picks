// Registers Hawk's slash commands on your server.
// Run again whenever a command is added or changed.
// Needs: DISCORD_TOKEN, DISCORD_APPLICATION_ID, GUILD_ID (environment variables).

const { DISCORD_TOKEN, DISCORD_APPLICATION_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, DISCORD_APPLICATION_ID or GUILD_ID.");
  process.exit(1);
}

const commands = [
  { name: "ping", description: "Check Hawk is awake" },
  {
    name: "fixtures",
    description: "Upcoming fixtures for the next 7 days",
    options: [
      {
        name: "league",
        description: "Which competition (default: Premier League)",
        type: 3, // string
        required: false,
        choices: [
          { name: "Premier League", value: "PL" },
          { name: "Championship", value: "ELC" },
          { name: "La Liga", value: "PD" },
          { name: "Serie A", value: "SA" },
          { name: "Bundesliga", value: "BL1" },
          { name: "Ligue 1", value: "FL1" },
          { name: "Champions League", value: "CL" },
          { name: "Eredivisie", value: "DED" },
          { name: "Primeira Liga", value: "PPL" },
        ],
      },
    ],
  },
  {
    name: "daily-post",
    description: "Run today's 9am fixtures post now (admin only)",
    default_member_permissions: "0", // hidden from everyone except server admins
  },
];

const res = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${GUILD_ID}/commands`,
  {
    method: "PUT", // replaces the full list, so removed commands disappear too
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (nighthawk-picks, 1.0)",
    },
    body: JSON.stringify(commands),
  },
);

if (!res.ok) {
  console.error(`✖ Discord said ${res.status}: ${await res.text()}`);
  if (res.status === 401) console.error("  Token rejected – check it's the bot token.");
  if (res.status === 403 || res.status === 404) console.error("  Check the Application ID and Server ID, and that Hawk was invited with applications.commands.");
  process.exit(1);
}

const saved = await res.json();
console.log(`✔ Registered ${saved.length} command(s): ${saved.map((c) => "/" + c.name).join(", ")}`);
