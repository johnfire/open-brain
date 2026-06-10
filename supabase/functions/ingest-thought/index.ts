import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const SLACK_CAPTURE_CHANNEL = Deno.env.get("SLACK_CAPTURE_CHANNEL")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  const d = await r.json();
  return d.data[0].embedding;
}

async function fetchTopicHints(): Promise<string> {
  const { data } = await supabase
    .from("topic_hints")
    .select("topic, description")
    .eq("active", true);
  if (!data || data.length === 0) return "";
  return data
    .map(
      (h: { topic: string; description: string }) =>
        `- ${h.topic}: ${h.description}`,
    )
    .join("\n");
}

async function extractMetadata(
  text: string,
  hintBlock = "",
): Promise<Record<string, unknown>> {
  const hintSection = hintBlock
    ? `\n\nControlled topic vocabulary. FIRST try to match against these known topic areas; only invent a new topic when none of them fits:\n\n${hintBlock}`
    : "";
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none). NEVER include the author Christopher Rehm (any variant: "Christopher", "Chris", "Chris Rehm") — he is the implicit subject of every thought; list only OTHER people.
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-5 short topic tags (always at least one). Prefer reusing the known topic areas below over inventing new ones.
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.${hintSection}`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

function detectProject(text: string): string {
  const lower = text.toLowerCase();
  if (/grendel|rpi cluster|raspberry pi/.test(lower)) return "grendel";
  if (/open brain|open-brain/.test(lower)) return "open-brain";
  if (/theo-van-gogh|theo van gogh/.test(lower)) return "theo-van-gogh";
  if (/theo-hits-the-road/.test(lower)) return "theo-hits-the-road";
  if (/notes-world/.test(lower)) return "notes-world";
  if (/geopolitical|monte carlo simulation/.test(lower))
    return "geopolitical-sim";
  return "general";
}

// spec 3.3: the author is the implicit subject of every thought — never tag him.
const SELF_TAGS = new Set([
  "christopher rehm",
  "chris rehm",
  "christopher",
  "chris",
  "c. rehm",
]);

async function normalizePeople(people: string[]): Promise<string[]> {
  const [aliasRes, exclusionRes] = await Promise.all([
    supabase.from("people_aliases").select("alias, canonical_name"),
    supabase.from("people_exclusions").select("name"),
  ]);

  const aliasMap = new Map<string, string>();
  for (const row of aliasRes.data ?? []) {
    aliasMap.set(row.alias, row.canonical_name);
  }
  const exclusions = new Set<string>(
    (exclusionRes.data ?? []).map((r: { name: string }) => r.name),
  );

  const normalized = people
    .map((p) => aliasMap.get(p) ?? p)
    .filter((p) => !exclusions.has(p))
    .filter((p) => !SELF_TAGS.has(p.toLowerCase()));

  return [...new Set(normalized)];
}

async function replyInSlack(
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const body = await req.json();

    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Direct test mode: POST { content: "..." } or { thought: "..." } bypasses Slack filtering
    if ((body.content || body.thought) && !body.event) {
      const messageText: string = body.content ?? body.thought;
      const [embedding, metadata] = await Promise.all([
        getEmbedding(messageText),
        fetchTopicHints().then((hints) => extractMetadata(messageText, hints)),
      ]);
      if (!metadata.status) metadata.status = "active";
      if (!metadata.project) metadata.project = detectProject(messageText);
      if (Array.isArray(metadata.people) && metadata.people.length > 0) {
        metadata.people = await normalizePeople(metadata.people as string[]);
      }
      const { error } = await supabase.from("thoughts").insert({
        content: messageText,
        embedding,
        metadata: { ...metadata, source: "direct" },
      });
      if (error) {
        console.error("Direct insert error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ ok: true, metadata }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const event = body.event;
    if (
      !event ||
      event.type !== "message" ||
      event.subtype ||
      event.bot_id ||
      event.channel !== SLACK_CAPTURE_CHANNEL
    ) {
      return new Response("ok", { status: 200 });
    }

    const messageText: string = event.text;
    const channel: string = event.channel;
    const messageTs: string = event.ts;
    if (!messageText || messageText.trim() === "")
      return new Response("ok", { status: 200 });

    const [embedding, metadata] = await Promise.all([
      getEmbedding(messageText),
      fetchTopicHints().then((hints) => extractMetadata(messageText, hints)),
    ]);

    // v2: status default
    if (!metadata.status) {
      metadata.status = "active";
    }

    // v2: project auto-detection
    if (!metadata.project) {
      metadata.project = detectProject(messageText);
    }

    // v2: people normalization + dedup
    if (Array.isArray(metadata.people) && metadata.people.length > 0) {
      metadata.people = await normalizePeople(metadata.people as string[]);
    }

    const { error } = await supabase.from("thoughts").insert({
      content: messageText,
      embedding,
      metadata: { ...metadata, source: "slack", slack_ts: messageTs },
    });

    if (error) {
      console.error("Supabase insert error:", error);
      await replyInSlack(
        channel,
        messageTs,
        `Failed to capture: ${error.message}`,
      );
      return new Response("error", { status: 500 });
    }

    const meta = metadata as Record<string, unknown>;
    let confirmation = `Captured as *${meta.type || "thought"}*`;
    if (Array.isArray(meta.topics) && meta.topics.length > 0)
      confirmation += ` - ${meta.topics.join(", ")}`;
    if (Array.isArray(meta.people) && meta.people.length > 0)
      confirmation += `\nPeople: ${meta.people.join(", ")}`;
    if (Array.isArray(meta.action_items) && meta.action_items.length > 0)
      confirmation += `\nAction items: ${meta.action_items.join("; ")}`;

    await replyInSlack(channel, messageTs, confirmation);
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
    });
  }
});
