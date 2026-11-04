// Hawk – Cloudflare Worker that answers Discord slash commands.
// Discord POSTs every interaction here. We check the signature (so only Discord can
// talk to Hawk), then reply.

import { leagueDay, tableEmbed, formEmbed, predictEmbed, historyCutoff } from "./football";
import { loadHistory } from "./history";
import { loadOdds } from "./odds";
import { whichLeague } from "./teams";
import { loadTrends, raceChoices, trendsEmbed } from "./trends";
import { loadSetPieceRatings } from "./setpiece-live";
import { whyMenu, whyButton, parseWhy, explainMatch } from "./reasoning";
import { racingTaskForRun, runRacingTask, runRacingNow } from "./racing";
import { runLeaguePost, runAccaPost, runWeekendPost, runChampionsLeaguePost, runSpecialPosts, jobForRun, historyTaskForRun, runHistoryImport } from "./daily";
import { runResultsPost, hasPending } from "./results";
import { runModelCheck } from "./modelcheck";
import { dublinDate } from "./discord";

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  FOOTBALL_DATA_TOKEN: string;
  DISCORD_TOKEN: string;
  GUILD_ID: string;
  BET_BUILDERS_CHANNEL_ID?: string;
  HAWK?: KVNamespace;
  ODDS_API_KEY?: string;
  RACING_USER?: string;
  RACING_PASS?: string;
}

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4 } as const;
const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4, DEFERRED_MESSAGE: 5 } as const;
const EPHEMERAL = 64; // reply only the person who ran the command can see

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/.{1,2}/g) ?? [];
  return new Uint8Array(pairs.map((b) => parseInt(b, 16)));
}

// Discord signs every request with Ed25519. Reject anything that doesn't verify.
export async function isFromDiscord(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKey) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Discord only waits 3 seconds for a reply. For slower work we answer "Hawk is thinking…"
// straight away, then fill in the real message here when the data arrives.
async function finishReply(interaction: any, data: unknown): Promise<void> {
  await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
}

function option(interaction: any, name: string): string | undefined {
  return interaction.data.options?.find((o: any) => o.name === name)?.value;
}

// No league picked? Find the team in any league Hawk covers.
async function resolveLeague(env: Env, team: string, chosen: string | undefined, mode: "next" | "domestic") {
  if (chosen) return chosen;
  const found = await whichLeague(env.HAWK, env.FOOTBALL_DATA_TOKEN, team, mode);
  if (!found) throw new Error(`Couldn't find "${team}" in any league Hawk covers – check the spelling, or pick the league from the list.`);
  return found;
}

// Re-grade a day that was still waiting on corners and cards (or late results).
async function regrade(env: Env, when: Date, daysBack: number) {
  const date = dublinDate(new Date(when.getTime() - daysBack * 864e5));
  return (await hasPending(env, date)) ? runResultsPost(env, date) : "nothing to re-grade";
}

// Grades yesterday, and re-grades the day before if any of its games hadn't finished.
async function runDailyResults(env: Env, when: Date) {
  const yesterday = dublinDate(new Date(when.getTime() - 864e5));
  const dayBefore = dublinDate(new Date(when.getTime() - 2 * 864e5));
  if (await hasPending(env, dayBefore)) await runResultsPost(env, dayBefore);
  return runResultsPost(env, yesterday);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Visiting the URL in a browser just confirms Hawk is deployed.
    if (request.method === "GET") return new Response("🦅 Hawk is running");
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = await request.text();
    if (!(await isFromDiscord(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response("Bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);

    // Discord sends a PING when you save the Interactions Endpoint URL.
    if (interaction.type === InteractionType.PING) {
      return reply({ type: ResponseType.PONG });
    }

    // Suggestions while typing (the race list for /trends)
    if (interaction.type === InteractionType.AUTOCOMPLETE) {
      const typed = interaction.data.options?.find((o: any) => o.focused)?.value ?? "";
      return reply({ type: 8, data: { choices: raceChoices(await loadTrends(env.HAWK), String(typed)) } });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      switch (interaction.data.name) {
        case "trends": {
          const race = option(interaction, "race") ?? "";
          const years = Number(option(interaction, "years") ?? 10);
          ctx.waitUntil(
            loadTrends(env.HAWK)
              .then((t) => {
                if (!t) throw new Error("Festival trends haven't been loaded yet – run scripts/festival-trends.mjs and upload the file.");
                return finishReply(interaction, { embeds: [trendsEmbed(t, race, years)] });
              })
              .catch((err) => finishReply(interaction, { content: `⚠️ ${err.message}` })),
          );
          return reply({ type: ResponseType.DEFERRED_MESSAGE });
        }

        case "ping":
          return reply({
            type: ResponseType.CHANNEL_MESSAGE,
            data: { content: "🦅 Pong! Hawk is awake and watching." },
          });

        case "fixtures": {
          const league = option(interaction, "league") ?? "PL";
          const now = new Date();
          ctx.waitUntil(
            loadHistory(env.HAWK, league, historyCutoff(now), now)
              .then(async (history) => leagueDay(league, env.FOOTBALL_DATA_TOKEN, now, 168, env.BET_BUILDERS_CHANNEL_ID, undefined, history, await loadOdds(env.HAWK, league), await loadSetPieceRatings(env.HAWK, league, now)))
              .then((day) => finishReply(interaction, { embeds: [day.fixtures], components: whyMenu(league, now, day.predictions, "fx") }))
              .catch((err) => finishReply(interaction, { content: `⚠️ ${err.message}` })),
          );
          return reply({ type: ResponseType.DEFERRED_MESSAGE });
        }

        case "table": {
          const league = option(interaction, "league") ?? "PL";
          ctx.waitUntil(
            tableEmbed(league, env.FOOTBALL_DATA_TOKEN)
              .then((embed) => finishReply(interaction, { embeds: [embed] }))
              .catch((err) => finishReply(interaction, { content: `⚠️ ${err.message}` })),
          );
          return reply({ type: ResponseType.DEFERRED_MESSAGE });
        }

        case "form": {
          const team = option(interaction, "team") ?? "";
          const chosen = option(interaction, "league");
          ctx.waitUntil(
            resolveLeague(env, team, chosen, "domestic")
              .then((league) => formEmbed(league, team, env.FOOTBALL_DATA_TOKEN))
              .then((embed) => finishReply(interaction, { embeds: [embed] }))
              .catch((err) => finishReply(interaction, { content: `⚠️ ${err.message}` })),
          );
          return reply({ type: ResponseType.DEFERRED_MESSAGE });
        }

        case "predict": {
          const team = option(interaction, "team") ?? "";
          const chosen = option(interaction, "league");
          const now = new Date();
          ctx.waitUntil(
            resolveLeague(env, team, chosen, "next")
              .then(async (league) => {
                const history = await loadHistory(env.HAWK, league, historyCutoff(now), now);
                const { why, ...embed } = await predictEmbed(league, team, env.FOOTBALL_DATA_TOKEN, now, history, await loadOdds(env.HAWK, league), await loadSetPieceRatings(env.HAWK, league, now));
                return finishReply(interaction, { embeds: [embed], components: whyButton(league, now, why.homeId, why.awayId) });
              })
              .catch((err) => finishReply(interaction, { content: `⚠️ ${err.message}` })),
          );
          return reply({ type: ResponseType.DEFERRED_MESSAGE });
        }

        // Admin-only: import history from football-data.co.uk for one league and season.
        case "history": {
          const league = option(interaction, "league") ?? "PL";
          const back = option(interaction, "season") === "last" ? 1 : 0;
          ctx.waitUntil(
            runHistoryImport(env, league, back as 0 | 1, new Date(), true)
              .then((summary) => finishReply(interaction, { content: summary }))
              .catch((err) => finishReply(interaction, { content: `⚠️ ${err.message}` })),
          );
          return reply({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
        }

        // Admin-only: run one league's 9am post (or the acca) now, for testing.
        case "daily-post": {
          const league = option(interaction, "league") ?? "PL";
          const today = dublinDate(new Date()), yesterday = dublinDate(new Date(Date.now() - 864e5));
          const job =
            league === "ACCA" ? runAccaPost(env)
            : league === "WEEKEND" ? runWeekendPost(env)
            : league === "CLACCAS" ? runChampionsLeaguePost(env, new Date(), true)
            : league === "RESULTS" ? runResultsPost(env, yesterday)
            : league === "MODELCHECK" ? runModelCheck(env, new Date(), false)
            : league === "RESULTS_TODAY" ? runResultsPost(env, today)
            : league === "RACING" ? runRacingNow(env)
            : runLeaguePost(env, league, new Date(), true);
          ctx.waitUntil(
            job
              .then((summary) => finishReply(interaction, { content: summary }))
              .catch((err) => finishReply(interaction, { content: `⚠️ Daily post failed: ${err.message}` })),
          );
          return reply({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
        }
      }
    }

    // 🔍 Why? menus and buttons – the reasoning only the person who asked can see.
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      const why = parseWhy(interaction.data.custom_id, interaction.data.values);
      if (why) {
        ctx.waitUntil(
          loadHistory(env.HAWK, why.code, historyCutoff(why.postedAt), why.postedAt)
            .then(async (history) => explainMatch(why.code, env.FOOTBALL_DATA_TOKEN, why.postedAt, why.homeId, why.awayId, history, await loadOdds(env.HAWK, why.code), await loadSetPieceRatings(env.HAWK, why.code, why.postedAt)))
            .then((embed) => finishReply(interaction, { embeds: [embed] }))
            .catch((err) => finishReply(interaction, { content: `⚠️ ${err.message}` })),
        );
        return reply({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
      }
    }

    return reply({
      type: ResponseType.CHANNEL_MESSAGE,
      data: { content: "I don't know that command yet.", flags: EPHEMERAL },
    });
  },

  // Runs on the schedule in wrangler.toml.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const when = new Date(controller.scheduledTime);
    const racing = racingTaskForRun(when);
    if (racing) {
      ctx.waitUntil(runRacingTask(env, racing, when).then(() => {}));
      return;
    }
    const task = historyTaskForRun(when);
    if (task) {
      ctx.waitUntil(runHistoryImport(env, task[0], task[1], when).then(() => {}));
      return;
    }
    const job = jobForRun(when);
    if (!job) return;
    const run =
      job === "ACCA" ? runAccaPost(env, when)
      : job === "SPECIAL" ? runSpecialPosts(env, when)
      : job === "MODELCHECK" ? runModelCheck(env, when)
      : job.startsWith("REGRADE:") ? regrade(env, when, Number(job.split(":")[1]))
      : job === "RESULTS" ? runDailyResults(env, when)
      : runLeaguePost(env, job, when);
    ctx.waitUntil(run.then(() => {}));
  },
};
