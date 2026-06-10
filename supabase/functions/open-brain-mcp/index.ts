import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

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
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

const PROJECT_KEYWORDS: Record<string, string[]> = {
  grendel: ["grendel", "gregor", "art platform", "art crm", "artist crm"],
  "open-brain": [
    "open brain",
    "open-brain",
    "memory system",
    "capture_thought",
    "ingest-thought",
    "thought ingestion",
  ],
  "theo-van-gogh": [
    "theo van gogh",
    "theo-van-gogh",
    "theo's book",
    "van gogh book",
  ],
  "theo-hits-the-road": ["theo hits the road", "theo-hits-the-road"],
  "notes-world": ["notes world", "notes-world", "notesworld"],
  "geopolitical-sim": [
    "geopolitical sim",
    "geopolitical-sim",
    "geo sim",
    "monte carlo simulation",
    "geopolitics simulation",
  ],
  personal: ["personal", "family", "health", "christopher rehm", "chris rehm"],
};

function detectProject(text: string): string {
  const lower = text.toLowerCase();
  for (const [project, keywords] of Object.entries(PROJECT_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return project;
  }
  return "general";
}

// spec 3.3: the author is the implicit subject of every thought — a "Christopher
// Rehm" tag on 141/249 rows carried zero information. Hard-filter all variants.
const SELF_TAGS = new Set([
  "christopher rehm",
  "chris rehm",
  "christopher",
  "chris",
  "c. rehm",
]);

async function normalizePeople(people: string[]): Promise<string[]> {
  if (!people.length) return people;
  const [aliasRes, exclusionRes] = await Promise.all([
    supabase.from("people_aliases").select("alias, canonical_name"),
    supabase.from("people_exclusions").select("name"),
  ]);
  const aliasMap = new Map<string, string>();
  for (const row of aliasRes.data || []) {
    aliasMap.set(row.alias.toLowerCase(), row.canonical_name);
  }
  const exclusions = new Set<string>(
    (exclusionRes.data || []).map((r: { name: string }) =>
      r.name.toLowerCase(),
    ),
  );
  return [
    ...new Set(
      people
        .map((p) => aliasMap.get(p.toLowerCase()) ?? p)
        .filter((p) => !exclusions.has(p.toLowerCase()))
        .filter((p) => !SELF_TAGS.has(p.toLowerCase())),
    ),
  ];
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
- "single_topic": boolean — true if the thought makes one claim about one topic, false if it bundles several topics or claims
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

// --- Read instrumentation (spec 3.4) ---

/**
 * Fire-and-forget: failures are logged and swallowed; a read response is
 * never blocked or degraded by instrumentation.
 */
async function recordRetrieval(
  tool: string,
  query: string | null,
  ids: string[],
): Promise<void> {
  try {
    if (!ids.length) return;
    const [inc, log] = await Promise.all([
      supabase.rpc("increment_retrieval", { ids }),
      supabase.from("retrieval_log").insert({ tool, query, result_ids: ids }),
    ]);
    if (inc.error || log.error) {
      console.error(
        JSON.stringify({
          level: "warn",
          where: "recordRetrieval",
          tool,
          inc_error: inc.error?.message ?? null,
          log_error: log.error?.message ?? null,
        }),
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "warn",
        where: "recordRetrieval",
        tool,
        error: String(err),
      }),
    );
  }
}

// --- Format helpers ---

const TRUNCATE_WORDS = 80;
const TRUNCATION_NOTE = "(truncated — get_thought for full text)";

/** First N words of text; flags whether anything was cut. */
function truncateWords(
  text: string,
  maxWords = TRUNCATE_WORDS,
): { text: string; truncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { text, truncated: false };
  return { text: words.slice(0, maxWords).join(" ") + " …", truncated: true };
}

function formatThought(
  t: {
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    similarity?: number;
    created_at: string;
  },
  i: number,
  truncState?: { any: boolean },
): string {
  const m = t.metadata || {};
  const parts: string[] = [];
  if (t.similarity !== undefined) {
    parts.push(
      `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
    );
  } else {
    parts.push(`--- Thought ${i + 1} ---`);
  }
  parts.push(`ID: ${t.id}`);
  parts.push(`Captured: ${new Date(t.created_at).toLocaleDateString()}`);
  parts.push(`Type: ${m.type || "unknown"}`);
  if (m.project) parts.push(`Project: ${m.project}`);
  if (m.status) parts.push(`Status: ${m.status}`);
  if (Array.isArray(m.topics) && m.topics.length)
    parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
  if (Array.isArray(m.people) && m.people.length)
    parts.push(`People: ${(m.people as string[]).join(", ")}`);
  if (Array.isArray(m.action_items) && m.action_items.length)
    parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
  const body = truncateWords(t.content);
  if (body.truncated && truncState) truncState.any = true;
  parts.push(`\n${body.text}`);
  return parts.join("\n");
}

// --- MCP Server ---

const server = new McpServer({
  name: "open-brain",
  version: "2.0.0",
});

// Tool 1: search_thoughts
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });
      if (error)
        return {
          content: [
            { type: "text" as const, text: `Search error: ${error.message}` },
          ],
          isError: true,
        };
      if (!data || data.length === 0)
        return {
          content: [
            {
              type: "text" as const,
              text: `No thoughts found matching "${query}".`,
            },
          ],
        };
      const truncState = { any: false };
      const results = data.map(
        (
          t: {
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            similarity: number;
            created_at: string;
          },
          i: number,
        ) => formatThought(t, i, truncState),
      );
      await recordRetrieval(
        "search_thoughts",
        query,
        data.map((t: { id: string }) => t.id),
      );
      const note = truncState.any ? `\n\n${TRUNCATION_NOTE}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}${note}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// Tool 2: list_thoughts
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z
        .string()
        .optional()
        .describe(
          "Filter by type: observation, task, idea, reference, person_note",
        ),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z
        .number()
        .optional()
        .describe("Only thoughts from the last N days"),
      project: z
        .string()
        .optional()
        .describe(
          "Filter by project (e.g. 'grendel', 'open-brain', 'personal')",
        ),
      status: z
        .string()
        .optional()
        .describe("Filter by status: active, completed, superseded, archived"),
    },
  },
  async ({ limit, type, topic, person, days, project, status }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (project) q = q.contains("metadata", { project });
      if (status) q = q.contains("metadata", { status });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }
      const { data, error } = await q;
      if (error)
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      if (!data || !data.length)
        return {
          content: [{ type: "text" as const, text: "No thoughts found." }],
        };
      const truncState = { any: false };
      const results = data.map(
        (
          t: {
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            created_at: string;
          },
          i: number,
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics)
            ? (m.topics as string[]).join(", ")
            : "";
          const proj = m.project ? ` | ${m.project}` : "";
          const stat =
            m.status && m.status !== "active" ? ` [${m.status}]` : "";
          const body = truncateWords(t.content);
          if (body.truncated) truncState.any = true;
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""}${proj}${stat})\n   ID: ${t.id}\n   ${body.text}`;
        },
      );
      await recordRetrieval(
        "list_thoughts",
        null,
        data.map((t: { id: string }) => t.id),
      );
      const note = truncState.any ? `\n\n${TRUNCATION_NOTE}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}${note}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// Tool 3: thought_stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description:
      "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true });
      const { data } = await supabase
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });
      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};
      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type)
          types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics)
            topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people)
            people[p as string] = (people[p as string] || 0) + 1;
      }
      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${data?.length ? new Date(data[data.length - 1].created_at).toLocaleDateString() + " → " + new Date(data[0].created_at).toLocaleDateString() : "N/A"}`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }
      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// Tool 4: capture_thought
const KNOWLEDGE_MAX_WORDS = 70;

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. " +
      "lane='journal' (default) for session summaries, tasks, observations. " +
      "lane='knowledge' for atomic, single-topic insights (≤60 words) — these feed the insight graph.",
    inputSchema: {
      content: z
        .string()
        .describe(
          "The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI",
        ),
      project: z
        .string()
        .optional()
        .describe(
          "Project this thought belongs to. Auto-detected from content if omitted.",
        ),
      lane: z
        .enum(["journal", "knowledge"])
        .optional()
        .default("journal")
        .describe(
          "'journal' = session state (verbose OK). 'knowledge' = one atomic claim, one topic, ≤60 words — graph material.",
        ),
    },
  },
  async ({ content, project, lane }) => {
    try {
      const resolvedLane = lane ?? "journal";
      // spec 4.1: hard atomicity gate for the knowledge lane — cheap check first
      if (resolvedLane === "knowledge") {
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        if (wordCount > KNOWLEDGE_MAX_WORDS) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Rejected: knowledge-lane thoughts must be atomic (≤60 words, one claim, one topic); this one has ${wordCount} words. Split it into separate insights and capture each on its own, or capture it as lane='journal'.`,
              },
            ],
            isError: true,
          };
        }
      }
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        fetchTopicHints().then((hints) => extractMetadata(content, hints)),
      ]);
      const meta = metadata as Record<string, unknown>;
      if (resolvedLane === "knowledge" && meta.single_topic === false) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Rejected: this reads as multi-topic. Knowledge-lane thoughts must make ONE claim about ONE topic. Split it into separate insights and capture each on its own.",
            },
          ],
          isError: true,
        };
      }
      delete meta.single_topic;
      if (Array.isArray(meta.people))
        meta.people = await normalizePeople(meta.people as string[]);
      const resolvedProject = project ?? detectProject(content);
      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        lane: resolvedLane,
        metadata: {
          ...meta,
          source: "mcp",
          status: "active",
          project: resolvedProject,
        },
      });
      if (error)
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to capture: ${error.message}`,
            },
          ],
          isError: true,
        };
      let confirmation = `Captured as ${meta.type || "thought"} [${resolvedProject}]${resolvedLane === "knowledge" ? " (knowledge lane)" : ""}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;
      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─── v2 Tool: distill_session (spec 4.2) ─────────────────────────────────────

server.registerTool(
  "distill_session",
  {
    title: "Distill Session Insights",
    description:
      "Session-close step 3: store 1-3 atomic insights distilled from a just-captured journal summary. " +
      "Insights are what was LEARNED, not what was done — one claim, one topic, ≤60 words each. " +
      "Each is stored on the knowledge lane and linked to the source session for traceability.",
    inputSchema: {
      session_summary_id: z
        .string()
        .uuid()
        .describe("UUID of the just-captured journal summary thought"),
      insights: z
        .array(
          z.object({
            content: z
              .string()
              .describe("One atomic insight, ≤60 words, single topic"),
            topics: z.array(z.string()).optional(),
          }),
        )
        .min(1)
        .max(3)
        .describe("1-3 atomic insights"),
    },
  },
  async ({ session_summary_id, insights }) => {
    try {
      // Verify the source session exists so linkage is never dangling.
      const { data: sourceRow, error: sourceError } = await supabase
        .from("thoughts")
        .select("id, metadata")
        .eq("id", session_summary_id)
        .maybeSingle();
      if (sourceError)
        return {
          content: [
            { type: "text" as const, text: `Error: ${sourceError.message}` },
          ],
          isError: true,
        };
      if (!sourceRow)
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: no thought with id ${session_summary_id} — capture the journal summary first, then distill.`,
            },
          ],
          isError: true,
        };

      // Atomicity gate before any writes — reject the whole batch with guidance.
      for (const ins of insights) {
        const wordCount = ins.content.split(/\s+/).filter(Boolean).length;
        if (wordCount > 60) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Rejected: insight "${ins.content.slice(0, 60)}…" has ${wordCount} words (max 60). Distill it further — one claim, one topic.`,
              },
            ],
            isError: true,
          };
        }
      }

      const sourceMeta = (sourceRow.metadata ?? {}) as Record<string, unknown>;
      const project = (sourceMeta.project as string) ?? "general";
      const stored: string[] = [];
      const failed: string[] = [];

      for (const ins of insights) {
        try {
          const embedding = await getEmbedding(ins.content);
          let topics = ins.topics;
          if (!topics || !topics.length) {
            const extracted = await fetchTopicHints().then((hints) =>
              extractMetadata(ins.content, hints),
            );
            topics = Array.isArray(extracted.topics)
              ? (extracted.topics as string[])
              : ["uncategorized"];
          }
          const { data: row, error } = await supabase
            .from("thoughts")
            .insert({
              content: ins.content,
              embedding,
              lane: "knowledge",
              metadata: {
                type: "insight",
                topics,
                people: [],
                source: "mcp",
                status: "active",
                project,
                source_session_id: session_summary_id,
              },
            })
            .select("id")
            .single();
          if (error)
            failed.push(`"${ins.content.slice(0, 40)}…": ${error.message}`);
          else stored.push(row.id);
        } catch (err) {
          failed.push(`"${ins.content.slice(0, 40)}…": ${String(err)}`);
        }
      }

      const lines = [
        `Distilled ${stored.length}/${insights.length} insight(s) from session ${session_summary_id}`,
        ...stored.map((id) => `  ✓ ${id}`),
        ...failed.map((f) => `  ✗ ${f}`),
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        ...(failed.length ? { isError: true } : {}),
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// Tool 5: add_topic_hint
server.registerTool(
  "add_topic_hint",
  {
    title: "Add Topic Hint",
    description:
      "Add a new topic area hint to Open Brain so it better recognizes this topic in future thought ingestions.",
    inputSchema: {
      topic: z.string().describe("The topic name, e.g. 'quantum computing'"),
      description: z
        .string()
        .describe("Brief description of what this topic covers"),
      category: z
        .string()
        .optional()
        .default("general")
        .describe(
          "Category grouping: ai, engineering, projects, art, geopolitics, robotics, infrastructure, personal, or a new category",
        ),
    },
  },
  async ({ topic, description, category }) => {
    try {
      const { error } = await supabase
        .from("topic_hints")
        .upsert(
          { topic, description, category: category ?? "general", active: true },
          { onConflict: "topic" },
        )
        .select();
      if (error)
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      return {
        content: [
          {
            type: "text" as const,
            text: `Topic hint "${topic}" added to category "${category ?? "general"}".`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// Tool 6: list_topic_hints
server.registerTool(
  "list_topic_hints",
  {
    title: "List Topic Hints",
    description:
      "List all active topic hints that Open Brain uses to guide topic extraction during ingestion.",
    inputSchema: {
      category: z.string().optional().describe("Optional: filter by category"),
    },
  },
  async ({ category }) => {
    try {
      let q = supabase
        .from("topic_hints")
        .select("topic, description, category")
        .eq("active", true)
        .order("category")
        .order("topic");
      if (category) q = q.eq("category", category);
      const { data, error } = await q;
      if (error)
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      if (!data || data.length === 0)
        return {
          content: [{ type: "text" as const, text: "No topic hints found." }],
        };
      const grouped: Record<string, string[]> = {};
      for (const h of data) {
        if (!grouped[h.category]) grouped[h.category] = [];
        grouped[h.category].push(`  - ${h.topic}: ${h.description}`);
      }
      const lines = Object.entries(grouped).map(
        ([cat, hints]) => `**${cat}**\n${hints.join("\n")}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} active topic hint(s):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// Tool 7: push_artifact
server.registerTool(
  "push_artifact",
  {
    title: "Push Artifact",
    description:
      "Push a structured spec or task document from a planning session to Open Brain, tagged for a specific project.",
    inputSchema: {
      project: z.string().describe("Project this artifact belongs to"),
      title: z.string().describe("Short descriptive title"),
      spec: z.string().describe("The executable spec"),
      rationale: z
        .string()
        .optional()
        .describe("Why we made the key decisions"),
      priority: z.enum(["high", "normal", "low"]).optional().default("normal"),
    },
  },
  async ({ project, title, spec, rationale, priority }) => {
    try {
      const content = [
        `# ${title}`,
        `**Project:** ${project}`,
        `**Priority:** ${priority ?? "normal"}`,
        "",
        "## Spec",
        spec,
        ...(rationale ? ["", "## Rationale", rationale] : []),
      ].join("\n");
      const [embedding] = await Promise.all([getEmbedding(content)]);
      const { data, error } = await supabase
        .from("thoughts")
        .insert({
          content,
          embedding,
          metadata: {
            type: "artifact",
            source: "claude.ai",
            status: "pending",
            project,
            title,
            priority: priority ?? "normal",
            topics: ["artifact", "handoff", project],
            people: [],
            action_items: [],
            dates_mentioned: [],
          },
        })
        .select("id")
        .single();
      if (error)
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to push artifact: ${error.message}`,
            },
          ],
          isError: true,
        };
      return {
        content: [
          {
            type: "text" as const,
            text: `Artifact pushed ✓\nID: ${data.id}\nProject: ${project}\nTitle: ${title}\nStatus: pending\nPriority: ${priority ?? "normal"}\n\nClaude Code can retrieve with: get_artifacts("${project}")`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// Tool 8: get_artifacts
server.registerTool(
  "get_artifacts",
  {
    title: "Get Artifacts",
    description: "Retrieve pending work artifacts for a specific project.",
    inputSchema: {
      project: z.string().describe("Project to retrieve artifacts for"),
      status: z
        .enum(["pending", "claimed", "complete", "failed", "all"])
        .optional()
        .default("pending"),
      limit: z.number().optional().default(10),
    },
  },
  async ({ project, status, limit }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .contains("metadata", { type: "artifact", project })
        .order("created_at", { ascending: false })
        .limit(limit ?? 10);
      if (status && status !== "all") q = q.contains("metadata", { status });
      const { data, error } = await q;
      if (error)
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      if (!data || data.length === 0)
        return {
          content: [
            {
              type: "text" as const,
              text: `No ${status ?? "pending"} artifacts for project '${project}'.`,
            },
          ],
        };
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      const sorted = [...data].sort((a, b) => {
        const pa =
          priorityOrder[
            (a.metadata?.priority as keyof typeof priorityOrder) ?? "normal"
          ] ?? 1;
        const pb =
          priorityOrder[
            (b.metadata?.priority as keyof typeof priorityOrder) ?? "normal"
          ] ?? 1;
        if (pa !== pb) return pa - pb;
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      });
      const results = sorted.map(
        (
          t: {
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            created_at: string;
          },
          i: number,
        ) => {
          const m = t.metadata || {};
          return `--- Artifact ${i + 1} ---\nID: ${t.id}\nTitle: ${m.title || "(untitled)"}\nStatus: ${m.status} | Priority: ${m.priority}\nCreated: ${new Date(t.created_at).toLocaleDateString()}${m.result ? `\nResult: ${m.result}` : ""}\n\n${t.content}`;
        },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} artifact(s) for '${project}' [${status ?? "pending"}]:\n\n${results.join("\n\n---\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// Tool 9: complete_artifact
server.registerTool(
  "complete_artifact",
  {
    title: "Complete Artifact",
    description: "Mark an artifact as complete and record what was done.",
    inputSchema: {
      id: z.string().uuid().describe("The artifact ID"),
      status: z.enum(["claimed", "complete", "failed"]),
      result: z.string().optional().describe("What was done or why it failed"),
    },
  },
  async ({ id, status, result }) => {
    try {
      const { data: existing, error: fetchError } = await supabase
        .from("thoughts")
        .select("metadata")
        .eq("id", id)
        .single();
      if (fetchError || !existing)
        return {
          content: [
            { type: "text" as const, text: `Artifact not found: ${id}` },
          ],
          isError: true,
        };
      const updatedMetadata = {
        ...(existing.metadata as Record<string, unknown>),
        status,
        ...(result ? { result } : {}),
        ...(status === "complete" || status === "failed"
          ? { completed_at: new Date().toISOString() }
          : {}),
        ...(status === "claimed"
          ? { claimed_at: new Date().toISOString() }
          : {}),
      };
      const { error: updateError } = await supabase
        .from("thoughts")
        .update({
          metadata: updatedMetadata,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (updateError)
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to update: ${updateError.message}`,
            },
          ],
          isError: true,
        };
      return {
        content: [
          {
            type: "text" as const,
            text: `Artifact ${status} ✓\nID: ${id}${result ? `\nResult: ${result}` : ""}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─── NEW Tool 10: get_connected ───────────────────────────────────────────────

server.registerTool(
  "get_connected",
  {
    title: "Get Connected Thoughts",
    description:
      "Traverse the graph from a thought to find all connected thoughts via insight edges. " +
      "Use this after finding a thought to discover non-obvious cross-domain connections the dream job found.",
    inputSchema: {
      thought_id: z.string().uuid().describe("Starting thought ID"),
      depth: z
        .number()
        .optional()
        .default(2)
        .describe(
          "How many hops to traverse (1=direct, 2=connections of connections)",
        ),
      edge_types: z
        .array(z.string())
        .optional()
        .describe(
          "Filter by edge label e.g. ['STRUCTURAL_ANALOG']. Omit for all.",
        ),
      include_unconfirmed: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include edges not yet reviewed"),
    },
  },
  async ({ thought_id, depth, edge_types, include_unconfirmed }) => {
    try {
      const visited = new Set<string>([thought_id]);
      const frontier: string[] = [thought_id];
      const allEdges: Array<{
        source_id: string;
        target_id: string;
        label: string;
        weight: number;
        insight: string;
        confirmed: boolean | null;
        id: string;
      }> = [];
      const allNodeIds = new Set<string>([thought_id]);

      for (let hop = 0; hop < (depth ?? 2); hop++) {
        if (frontier.length === 0) break;

        let edgeQuery = supabase
          .from("thought_edges")
          .select("id, source_id, target_id, label, weight, insight, confirmed")
          .or(
            frontier
              .map((id) => `source_id.eq.${id},target_id.eq.${id}`)
              .join(","),
          );

        if (edge_types && edge_types.length > 0)
          edgeQuery = edgeQuery.in("label", edge_types);

        if (!include_unconfirmed) {
          edgeQuery = edgeQuery.eq("confirmed", true);
        } else {
          edgeQuery = edgeQuery.or("confirmed.is.null,confirmed.eq.true");
        }

        const { data: edges, error } = await edgeQuery;
        if (error)
          return {
            content: [
              { type: "text" as const, text: `Graph error: ${error.message}` },
            ],
            isError: true,
          };

        const nextFrontier: string[] = [];
        for (const edge of edges ?? []) {
          allEdges.push(edge);
          const neighbor = frontier.includes(edge.source_id)
            ? edge.target_id
            : edge.source_id;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
          allNodeIds.add(edge.source_id);
          allNodeIds.add(edge.target_id);
        }
        frontier.length = 0;
        frontier.push(...nextFrontier);
      }

      if (allEdges.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No connections found for thought ${thought_id}.\nThe dream job may not have run yet, or this thought has no structural analogs in the corpus.`,
            },
          ],
        };
      }

      const nodeIds = [...allNodeIds].filter((id) => id !== thought_id);
      const { data: nodes } = await supabase
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .in("id", nodeIds);
      const nodeMap = new Map(
        (nodes ?? []).map(
          (n: {
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            created_at: string;
          }) => [n.id, n],
        ),
      );

      const lines: string[] = [
        `Graph from thought ${thought_id} (depth=${depth ?? 2}):\n`,
      ];
      const seenEdges = new Set<string>();

      for (const edge of allEdges) {
        const key =
          [edge.source_id, edge.target_id].sort().join("|") + "|" + edge.label;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);

        const confirmLabel =
          edge.confirmed === true
            ? "[confirmed]"
            : edge.confirmed === false
              ? "[rejected]"
              : "[unreviewed]";
        lines.push(
          `── ${edge.label} (${(edge.weight * 100).toFixed(0)}% confidence) ${confirmLabel}`,
        );
        lines.push(`   EDGE ID: ${edge.id}`);
        lines.push(`   INSIGHT: ${edge.insight}`);

        const otherId =
          frontier.includes(edge.source_id) || edge.source_id === thought_id
            ? edge.target_id
            : edge.source_id;
        const other = nodeMap.get(otherId);
        if (other) {
          const m = other.metadata || {};
          lines.push(
            `   CONNECTED THOUGHT [${m.project || "general"} | ${m.type || "?"}]:`,
          );
          lines.push(`   ID: ${other.id}`);
          lines.push(`   ${truncateWords(other.content).text}`);
        }
        lines.push("");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─── NEW Tool 11: confirm_edge ────────────────────────────────────────────────

server.registerTool(
  "confirm_edge",
  {
    title: "Confirm or Reject Edge",
    description:
      "Confirm or reject an insight edge proposed by the dream job. " +
      "Confirmed edges are used preferentially in graph traversal. Rejected edges are hidden.",
    inputSchema: {
      edge_id: z.string().uuid().describe("The edge ID to confirm or reject"),
      confirmed: z
        .boolean()
        .describe("true = real insight, false = reject as noise"),
      note: z.string().optional().describe("Optional note about why"),
    },
  },
  async ({ edge_id, confirmed, note }) => {
    try {
      const updateData: Record<string, unknown> = { confirmed };
      if (note) updateData.note = note;
      const { error } = await supabase
        .from("thought_edges")
        .update(updateData)
        .eq("id", edge_id);
      if (error)
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      return {
        content: [
          {
            type: "text" as const,
            text: `Edge ${edge_id} ${confirmed ? "confirmed ✓" : "rejected ✗"}${note ? ` — ${note}` : ""}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─── NEW Tool 12: search_with_graph ──────────────────────────────────────────

server.registerTool(
  "search_with_graph",
  {
    title: "Search with Graph Expansion",
    description:
      "Vector search + automatic graph expansion. Finds semantically similar thoughts then traverses " +
      "insight edges to surface connected thoughts from different domains. " +
      "This is the primary tool for surfacing non-obvious cross-domain connections.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Number of vector search entry points"),
      threshold: z.number().optional().default(0.5),
      graph_depth: z
        .number()
        .optional()
        .default(1)
        .describe("Hops to traverse from each entry point"),
    },
  },
  async ({ query, limit, threshold, graph_depth: _graph_depth }) => {
    try {
      // Step 1: Vector search
      const qEmb = await getEmbedding(query);
      const { data: vectorResults, error: vectorError } = await supabase.rpc(
        "match_thoughts",
        {
          query_embedding: qEmb,
          match_threshold: threshold,
          match_count: limit,
          filter: {},
        },
      );
      if (vectorError)
        return {
          content: [
            {
              type: "text" as const,
              text: `Search error: ${vectorError.message}`,
            },
          ],
          isError: true,
        };
      if (!vectorResults || vectorResults.length === 0)
        return {
          content: [
            {
              type: "text" as const,
              text: `No thoughts found matching "${query}".`,
            },
          ],
        };

      const truncState = { any: false };
      const lines: string[] = [
        `=== VECTOR RESULTS (${vectorResults.length} entry points) ===\n`,
      ];
      for (const t of vectorResults)
        lines.push(
          formatThought(t, vectorResults.indexOf(t), truncState) + "\n",
        );
      if (truncState.any) lines.push(TRUNCATION_NOTE + "\n");

      // Step 2: Graph expansion
      const entryIds: string[] = vectorResults.map((t: { id: string }) => t.id);
      const graphLines: string[] = [];
      const seenConnected = new Set<string>(entryIds);

      for (const entryId of entryIds) {
        const { data: edges } = await supabase
          .from("thought_edges")
          .select("id, source_id, target_id, label, weight, insight, confirmed")
          .or(`source_id.eq.${entryId},target_id.eq.${entryId}`)
          .or("confirmed.is.null,confirmed.eq.true")
          .gte("weight", 0.7)
          .order("weight", { ascending: false })
          .limit(3);

        for (const edge of edges ?? []) {
          const connectedId =
            edge.source_id === entryId ? edge.target_id : edge.source_id;
          if (seenConnected.has(connectedId)) continue;
          seenConnected.add(connectedId);

          const { data: connectedThought } = await supabase
            .from("thoughts")
            .select("id, content, metadata, created_at")
            .eq("id", connectedId)
            .single();

          if (connectedThought) {
            const m = connectedThought.metadata || {};
            const confirmLabel =
              edge.confirmed === true ? "confirmed" : "unreviewed";
            graphLines.push(
              `── ${edge.label} from entry ${entryId.slice(0, 8)}... (${(edge.weight * 100).toFixed(0)}% | ${confirmLabel})`,
            );
            graphLines.push(`   EDGE ID: ${edge.id}`);
            graphLines.push(`   INSIGHT: ${edge.insight}`);
            graphLines.push(
              `   CONNECTED [${m.project || "general"} | ${m.type || "?"}] ID: ${connectedThought.id}`,
            );
            graphLines.push(
              `   ${truncateWords(connectedThought.content).text}`,
            );
            graphLines.push("");
          }
        }
      }

      if (graphLines.length > 0) {
        lines.push(`\n=== GRAPH EXPANSIONS (non-obvious connections) ===\n`);
        lines.push(...graphLines);
      } else {
        lines.push(
          `\n=== GRAPH EXPANSIONS ===\nNo cross-domain connections found yet. Run the dream job or wait for tonight's cron.`,
        );
      }

      // entry points + every connected thought actually returned
      await recordRetrieval("search_with_graph", query, [...seenConnected]);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─── v2 Tool 13: update_thought_status (spec 3.1) ────────────────────────────

server.registerTool(
  "update_thought_status",
  {
    title: "Update Thought Status",
    description:
      "Update the lifecycle status of a thought (usually a task). Call this at session close for " +
      "every open task that was completed or superseded during the session, BEFORE capturing the new summary. " +
      "A memory that is confidently wrong is worse than no memory.",
    inputSchema: {
      id: z.string().uuid().describe("The thought ID to update"),
      status: z
        .enum(["active", "completed", "superseded", "archived"])
        .describe("New lifecycle status"),
      reason: z
        .string()
        .optional()
        .describe("Why the status changed — recorded into status_history"),
    },
  },
  async ({ id, status, reason }) => {
    try {
      const { data: existing, error: fetchError } = await supabase
        .from("thoughts")
        .select("id, metadata")
        .eq("id", id)
        .maybeSingle();
      if (fetchError)
        return {
          content: [
            { type: "text" as const, text: `Error: ${fetchError.message}` },
          ],
          isError: true,
        };
      if (!existing)
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: no thought with id ${id}. Check the ID and try again.`,
            },
          ],
          isError: true,
        };
      const meta = (existing.metadata ?? {}) as Record<string, unknown>;
      const oldStatus = (meta.status as string) ?? "active";
      const history = Array.isArray(meta.status_history)
        ? (meta.status_history as unknown[])
        : [];
      history.push({
        status,
        reason: reason ?? null,
        ts: new Date().toISOString(),
      });
      const { error: updateError } = await supabase
        .from("thoughts")
        .update({
          metadata: { ...meta, status, status_history: history },
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (updateError)
        return {
          content: [
            { type: "text" as const, text: `Error: ${updateError.message}` },
          ],
          isError: true,
        };
      return {
        content: [
          {
            type: "text" as const,
            text: `Status updated ✓\nID: ${id}\n${oldStatus} → ${status}${reason ? `\nReason: ${reason}` : ""}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─── v2 Tool 14: get_thought (spec 3.2) ──────────────────────────────────────

server.registerTool(
  "get_thought",
  {
    title: "Get Thought",
    description:
      "Fetch one thought by ID with FULL content and metadata. Use after search/list results, " +
      "which truncate long thoughts to 80 words.",
    inputSchema: {
      id: z.string().uuid().describe("The thought ID"),
    },
  },
  async ({ id }) => {
    try {
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .eq("id", id)
        .maybeSingle();
      if (error)
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      if (!data)
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: no thought with id ${id}.`,
            },
          ],
          isError: true,
        };
      await recordRetrieval("get_thought", null, [data.id]);
      const lines = [
        `ID: ${data.id}`,
        `Captured: ${new Date(data.created_at).toLocaleDateString()}`,
        `Metadata: ${JSON.stringify(data.metadata ?? {}, null, 2)}`,
        "",
        data.content,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─── v2 Tool 15: retrieval_stats (spec 3.4) ──────────────────────────────────

server.registerTool(
  "retrieval_stats",
  {
    title: "Retrieval Statistics",
    description:
      "Read-side instrumentation report: reads by tool, most-retrieved thoughts, " +
      "never-retrieved share, and reads-per-day trend. Use this to judge what the " +
      "memory is actually worth.",
    inputSchema: {
      days: z
        .number()
        .optional()
        .default(30)
        .describe("Lookback window in days"),
    },
  },
  async ({ days }) => {
    try {
      const lookback = days ?? 30;
      const since = new Date(Date.now() - lookback * 86400000).toISOString();

      const [logsRes, totalRes, neverRes, topRes] = await Promise.all([
        supabase
          .from("retrieval_log")
          .select("tool, ts")
          .gte("ts", since)
          .limit(10000),
        supabase.from("thoughts").select("*", { count: "exact", head: true }),
        supabase
          .from("thoughts")
          .select("*", { count: "exact", head: true })
          .eq("retrieval_count", 0),
        supabase
          .from("thoughts")
          .select("id, content, metadata, retrieval_count, last_retrieved_at")
          .gt("retrieval_count", 0)
          .order("retrieval_count", { ascending: false })
          .limit(10),
      ]);
      if (logsRes.error)
        return {
          content: [
            { type: "text" as const, text: `Error: ${logsRes.error.message}` },
          ],
          isError: true,
        };

      const byTool: Record<string, number> = {};
      const byDay: Record<string, number> = {};
      for (const row of logsRes.data ?? []) {
        byTool[row.tool] = (byTool[row.tool] || 0) + 1;
        const day = (row.ts as string).slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
      }

      const total = totalRes.count ?? 0;
      const never = neverRes.count ?? 0;
      const lines: string[] = [
        `Retrieval stats — last ${lookback} day(s)`,
        "",
        `Reads by tool (${(logsRes.data ?? []).length} total):`,
        ...Object.entries(byTool)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `  ${k}: ${v}`),
        "",
        `Never-retrieved thoughts: ${never}/${total} (${total ? ((never / total) * 100).toFixed(0) : 0}%)`,
        "",
        "Top 10 most-retrieved:",
        ...(topRes.data ?? []).map(
          (t: {
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            retrieval_count: number;
          }) =>
            `  [${t.retrieval_count}x] ${t.id} — ${truncateWords(t.content, 15).text}`,
        ),
        "",
        "Reads per day:",
        ...Object.entries(byDay)
          .sort()
          .map(([d, n]) => `  ${d}: ${n}`),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─── Hono App ─────────────────────────────────────────────────────────────────

const app = new Hono();

app.all("*", async (c) => {
  // Support both custom x-brain-key header and standard Authorization: Bearer
  const provided =
    c.req.header("x-brain-key") ||
    new URL(c.req.url).searchParams.get("key") ||
    c.req.header("Authorization")?.replace("Bearer ", "");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
