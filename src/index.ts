// Hawk – Cloudflare Worker that answers Discord slash commands.
// Discord POSTs every interaction here. We check the signature (so only Discord can
// talk to Hawk), then reply.

export interface Env {
  DISCORD_PUBLIC_KEY: string;
}

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4 } as const;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      switch (interaction.data.name) {
        case "ping":
          return reply({
            type: ResponseType.CHANNEL_MESSAGE,
            data: { content: "🦅 Pong! Hawk is awake and watching." },
          });
      }
    }

    return reply({
      type: ResponseType.CHANNEL_MESSAGE,
      data: { content: "I don't know that command yet.", flags: EPHEMERAL },
    });
  },
};
