import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const DREAM_SECRET = Deno.env.get("DREAM_SECRET") ?? "";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// spec 4.3: keep the weekly review ritual at ~15 minutes. Quality over volume.
const WEEKLY_PROPOSAL_CAP = 10;

// ─── Structural Signature Extraction ─────────────────────────────────────────

async function extractStructuralSig(
  text: string,
): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-5",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You identify deep structural patterns underlying observations.\n\nAbstract the thought to its essential dynamic. Strip domain-specific surface details. Identify the underlying pattern that could appear in completely different domains.\n\nReturn JSON with exactly these fields:\n- "pattern": snake_case name for the abstract structural pattern (e.g. "feedback_loop_without_brake", "missing_coordinator", "local_optimum_trap", "cascade_failure", "principal_agent_divergence")\n- "problem_type": abstract problem class (e.g. "missing_actor", "constraint_violation", "incentive_misalignment", "information_asymmetry", "threshold_not_met")\n- "dynamic": active process or trajectory (e.g. "escalation_to_degenerate_outcome", "stagnation", "oscillation_without_convergence", "slow_drift")\n- "domain": surface domain of this thought (e.g. "geopolitics", "software_architecture", "sales_process", "personal_workflow", "art_practice")\n- "analogy_surface": one sentence describing the pattern in domain-neutral language that would make sense to someone in a different field\n\nBe specific. Vague patterns produce useless connections.`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return null;
  }
}

// ─── Insight Edge Generation ──────────────────────────────────────────────────

interface Thought {
  id: string;
  content: string;
  structural_sig: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

async function generateInsightEdge(
  thoughtA: Thought,
  thoughtB: Thought,
): Promise<{
  label: string;
  weight: number;
  insight: string;
  rationale: string;
} | null> {
  try {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-5",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are identifying genuinely non-obvious structural connections between ideas from different domains.\n\nYou will be given two thoughts with their structural signatures. Your job is to determine if they share a meaningful structural analog worth surfacing as an insight.\n\nA connection is worth making ONLY if:\n1. The two thoughts come from clearly different domains\n2. The underlying dynamic or problem type is genuinely similar\n3. Understanding one would actually help solve or understand the other\n4. The insight would surprise someone who only read the surface content\n\nDo NOT make connections that are:\n- Superficially similar in topic but structurally different\n- So abstract they apply to everything\n- Already obvious from the surface text\n\nReturn JSON with:\n- "connected": boolean - is this a real insight worth storing?\n- "label": if connected, one of: STRUCTURAL_ANALOG, SOLUTION_TRANSFER, CONTRADICTS, PATTERN_INSTANCE\n- "weight": float 0.0-1.0, confidence this is a genuine non-obvious insight (0.7+ means store it)\n- "insight": if connected, one sentence explaining the non-obvious connection and why it matters\n- "rationale": if connected, one FALSIFIABLE sentence of the form "X because Y" stating the specific non-obvious link. "Both relate to art" is NOT a rationale. If you cannot write a concrete because-clause, return {"connected": false} instead.\n\nIf not connected, just return {"connected": false}.`,
          },
          {
            role: "user",
            content: `THOUGHT A (domain: ${thoughtA.structural_sig.domain}):\n${thoughtA.content}\n\nSignature A: ${JSON.stringify(thoughtA.structural_sig)}\n\n---\n\nTHOUGHT B (domain: ${thoughtB.structural_sig.domain}):\n${thoughtB.content}\n\nSignature B: ${JSON.stringify(thoughtB.structural_sig)}`,
          },
        ],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const result = JSON.parse(d.choices[0].message.content);
    if (!result.connected || result.weight < 0.7) return null;
    // spec 4.3: no falsifiable because-clause → not a proposable edge.
    if (
      typeof result.rationale !== "string" ||
      !/because/i.test(result.rationale)
    ) {
      return null;
    }
    return {
      label: result.label,
      weight: result.weight,
      insight: result.insight,
      rationale: result.rationale,
    };
  } catch {
    return null;
  }
}

// ─── Edge already exists check ────────────────────────────────────────────────
// spec 4.4: pair-level, label-agnostic — a rejected pair must never be
// re-proposed. Rejected edges stay in the table (confirmed=false), so any
// existing row between the pair blocks a new proposal. A unique index on
// (least(source,target), greatest(source,target)) backs this at the DB level.

async function edgeExists(
  sourceId: string,
  targetId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("thought_edges")
    .select("id")
    .or(
      `and(source_id.eq.${sourceId},target_id.eq.${targetId}),and(source_id.eq.${targetId},target_id.eq.${sourceId})`,
    )
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// ─── Main Dream Logic ─────────────────────────────────────────────────────────

async function runDream(
  manualLimit?: number,
): Promise<Record<string, unknown>> {
  const { data: runData } = await supabase
    .from("dream_runs")
    .insert({ status: "running" })
    .select("id")
    .single();
  const runId = runData?.id;

  let thoughtsProcessed = 0;
  let edgesProposed = 0;

  try {
    // spec 4.3: hard weekly proposal budget — quality over volume; the review
    // ritual must stay at ~15 minutes.
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { count: proposedThisWeek } = await supabase
      .from("thought_edges")
      .select("*", { count: "exact", head: true })
      .eq("created_by", "dream")
      .gte("created_at", weekAgo);
    const budget = Math.max(0, WEEKLY_PROPOSAL_CAP - (proposedThisWeek ?? 0));
    if (budget === 0) {
      await supabase
        .from("dream_runs")
        .update({
          status: "complete",
          completed_at: new Date().toISOString(),
          thoughts_processed: 0,
          edges_proposed: 0,
          notes: `Weekly proposal cap (${WEEKLY_PROPOSAL_CAP}) already reached`,
        })
        .eq("id", runId);
      return {
        status: "complete",
        thoughts_processed: 0,
        edges_proposed: 0,
        notes: "weekly cap reached",
      };
    }

    // Step 1: Backfill missing structural signatures.
    // spec 4.3: knowledge lane ONLY — journal summaries are excluded; this is
    // the single biggest edge-quality fix.
    const { data: unsignedThoughts } = await supabase
      .from("thoughts")
      .select("id, content")
      .eq("lane", "knowledge")
      .is("structural_sig", null)
      .neq("content", "")
      .limit(manualLimit ?? 50);

    for (const t of unsignedThoughts ?? []) {
      const sig = await extractStructuralSig(t.content);
      if (sig) {
        await supabase
          .from("thoughts")
          .update({ structural_sig: sig })
          .eq("id", t.id);
      }
    }

    // Step 2: Load thoughts that have structural signatures
    // Focus on recent thoughts (last 90 days) vs full corpus to keep cost bounded
    const since = new Date();
    since.setDate(since.getDate() - 90);

    const { data: signedThoughts } = await supabase
      .from("thoughts")
      .select("id, content, structural_sig, metadata")
      .eq("lane", "knowledge")
      .not("structural_sig", "is", null)
      .gte("created_at", since.toISOString())
      .neq("content", "")
      .order("created_at", { ascending: false })
      .limit(200);

    const thoughts = (signedThoughts ?? []) as Thought[];
    thoughtsProcessed = thoughts.length;

    if (thoughts.length < 2) {
      await supabase
        .from("dream_runs")
        .update({
          status: "complete",
          completed_at: new Date().toISOString(),
          thoughts_processed: 0,
          edges_proposed: 0,
          notes: "Not enough signed thoughts to compare",
        })
        .eq("id", runId);
      return { status: "complete", thoughts_processed: 0, edges_proposed: 0 };
    }

    // Step 3: Find candidate pairs — same pattern or problem_type, different domain
    // Group by pattern first to avoid O(n^2) LLM calls
    const patternGroups = new Map<string, Thought[]>();
    const problemGroups = new Map<string, Thought[]>();

    for (const t of thoughts) {
      const sig = t.structural_sig;
      if (!sig) continue;
      const p = sig.pattern as string;
      const pt = sig.problem_type as string;
      if (p) {
        if (!patternGroups.has(p)) patternGroups.set(p, []);
        patternGroups.get(p)!.push(t);
      }
      if (pt) {
        if (!problemGroups.has(pt)) problemGroups.set(pt, []);
        problemGroups.get(pt)!.push(t);
      }
    }

    // Collect candidate pairs: same pattern OR problem_type, DIFFERENT domain
    const candidatePairs = new Set<string>();
    const pairs: [Thought, Thought][] = [];

    const checkGroup = (group: Thought[]) => {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          // Only cross-domain pairs
          if (a.structural_sig?.domain === b.structural_sig?.domain) continue;
          const key = [a.id, b.id].sort().join("|");
          if (!candidatePairs.has(key)) {
            candidatePairs.add(key);
            pairs.push([a, b]);
          }
        }
      }
    };

    for (const group of patternGroups.values()) checkGroup(group);
    for (const group of problemGroups.values()) checkGroup(group);

    // spec 4.3: cross-domain bias — the goal is connections ACROSS
    // art/engineering/business/geopolitics, not within-project adjacency.
    // Pairs sharing a project AND a topic sort last.
    const sharesProjectAndTopic = (a: Thought, b: Thought): boolean => {
      const projA = a.metadata?.project as string | undefined;
      const projB = b.metadata?.project as string | undefined;
      if (!projA || projA !== projB) return false;
      const topicsA = new Set(
        Array.isArray(a.metadata?.topics)
          ? (a.metadata.topics as string[])
          : [],
      );
      const topicsB = Array.isArray(b.metadata?.topics)
        ? (b.metadata.topics as string[])
        : [];
      return topicsB.some((t) => topicsA.has(t));
    };
    pairs.sort(
      (p1, p2) =>
        Number(sharesProjectAndTopic(p1[0], p1[1])) -
        Number(sharesProjectAndTopic(p2[0], p2[1])),
    );

    // Step 4: For each candidate pair, ask Claude if it's a real insight
    // Cap at 100 pairs per run to bound cost
    const cappedPairs = pairs.slice(0, 100);

    for (const [thoughtA, thoughtB] of cappedPairs) {
      if (edgesProposed >= budget) break; // weekly cap

      // Skip if ANY edge already exists between the pair (incl. rejected)
      const exists = await edgeExists(thoughtA.id, thoughtB.id);
      if (exists) continue;

      const edge = await generateInsightEdge(thoughtA, thoughtB);
      if (!edge) continue;

      const { error: insertError } = await supabase
        .from("thought_edges")
        .insert({
          source_id: thoughtA.id,
          target_id: thoughtB.id,
          label: edge.label,
          weight: edge.weight,
          insight: edge.insight,
          rationale: edge.rationale,
          created_by: "dream",
          confirmed: null, // unreviewed
        });
      // Unique pair index may race with edgeExists — a conflict just means
      // the pair is already covered; not a failure.
      if (!insertError) edgesProposed++;
    }

    await supabase
      .from("dream_runs")
      .update({
        status: "complete",
        completed_at: new Date().toISOString(),
        thoughts_processed: thoughtsProcessed,
        edges_proposed: edgesProposed,
        notes: `Checked ${cappedPairs.length} candidate pairs from ${thoughts.length} signed thoughts`,
      })
      .eq("id", runId);

    return {
      status: "complete",
      thoughts_processed: thoughtsProcessed,
      edges_proposed: edgesProposed,
      pairs_checked: cappedPairs.length,
    };
  } catch (err) {
    const msg = String(err);
    await supabase
      .from("dream_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        thoughts_processed: thoughtsProcessed,
        edges_proposed: edgesProposed,
        error: msg,
      })
      .eq("id", runId);
    throw err;
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    // Accept secret via header or query param
    const url = new URL(req.url);
    const provided =
      req.headers.get("x-dream-secret") ?? url.searchParams.get("secret") ?? "";
    if (DREAM_SECRET && provided !== DREAM_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    const body =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const result = await runDream(body.limit);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
    });
  }
});
