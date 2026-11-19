// Browser glue for the SSR scorer, shared by the page (site-actions.js, the sample-run demo)
// and the action bridge (bridge/bridge-actions.js). Nothing here reads the page: it loads the
// model and anchors from this site's origin and scores the reactions it is given.
// transformers.js is imported on first use, so loading this module costs nothing.
import { createEmbedder } from "./embedder.mjs";
import { embedAnchors, scoreReactions, MIN_REACTION_LENGTH } from "./ssr.mjs";

const SITE = new URL("../", import.meta.url).href;

export const LIMITS = {
  minVariants: 2,
  // 3 personas x 3 variants = 9 interviews + 1 score + 1 answer = 11 steps, inside the
  // caller's 12-step limit when the model makes one tool call per step.
  maxVariants: 3,
  maxCopy: 600,
  maxReactions: 24,
  minReaction: MIN_REACTION_LENGTH,
  maxReaction: 1500,
};

// fp16 halves the download (45 MB). Measured 2026-11-19 in headless Chrome against
// synthetic-panel's Python sample run: same ranking, max per-sample |diff| 0.0033 on 1-5.
export const DTYPE = "fp16";

export const STIMULUS_TYPES = ["headline", "email_subject", "offer", "value_prop", "cta", "price", "other"];

export const METHOD = "Semantic Similarity Rating (arXiv:2510.08338): each reaction is embedded with all-MiniLM-L6-v2 and compared with three sets of five Likert anchor statements, giving a 1-5 distribution.";
export const LIMITS_NOTE = "Directional only: use the ranking to compare these variants with each other in this run. The scores are not predictions of real conversion or survey results.";

/**
 * The JSON Schema the page action and the bridge action share.
 */
export function inputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["variants", "reactions"],
    properties: {
      stimulus_type: {
        type: "string",
        enum: STIMULUS_TYPES,
        description: "What the copy is. Default headline.",
      },
      variants: {
        type: "array",
        minItems: LIMITS.minVariants,
        maxItems: LIMITS.maxVariants,
        description: "The versions of the copy being compared.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "copy"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 24, description: "Short id: lowercase letters, digits, _ or -, such as a, b or plain." },
            copy: { type: "string", minLength: 1, maxLength: LIMITS.maxCopy },
          },
        },
      },
      reactions: {
        type: "array",
        minItems: LIMITS.minVariants,
        maxItems: LIMITS.maxReactions,
        description: "One entry per persona reaction, with the reaction text exactly as the persona wrote it.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["variant_id", "persona_id", "reaction"],
          properties: {
            variant_id: { type: "string", minLength: 1, maxLength: 24 },
            persona_id: { type: "string", minLength: 1, maxLength: 40 },
            reaction: { type: "string", minLength: 1, maxLength: LIMITS.maxReaction },
          },
        },
      },
    },
  };
}

// The runtime's schema subset has no pattern keyword, so ids are checked here.
const ID = /^[a-z0-9_-]{1,40}$/;

let embedderPromise = null;
let anchorsPromise = null;

/**
 * Load (once per frame) the embedder and the embedded anchor statements.
 *
 * :param progress: Optional callback(fraction 0-1, label) while the model downloads.
 */
export function warmUp(progress) {
  embedderPromise ??= (async () => {
    const lib = await import("../vendor/transformers/transformers.min.js");
    const seen = new Map();
    const onProgress = progress && ((event) => {
      if (event.status === "progress" && event.total) {
        seen.set(event.file, [event.loaded, event.total]);
        let loaded = 0;
        let total = 0;
        for (const [l, t] of seen.values()) { loaded += l; total += t; }
        progress(loaded / total, "Downloading the scoring model");
      }
    });
    return createEmbedder(lib, {
      // A path, not a URL: transformers.js treats an http(s) localModelPath as remote and,
      // with remote models off, refuses it. The path keeps the model on this origin.
      localModelPath: new URL("models/", SITE).pathname,
      wasmPaths: {
        mjs: new URL("vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs", SITE).href,
        wasm: new URL("vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm", SITE).href,
      },
      progress: onProgress,
      dtype: DTYPE,
    });
  })();
  anchorsPromise ??= (async () => {
    const [embed, anchors] = await Promise.all([
      embedderPromise,
      fetch(new URL("data/anchors.json", SITE)).then((r) => {
        if (!r.ok) throw new Error("Could not load the anchor statements (HTTP " + r.status + ").");
        return r.json();
      }),
    ]);
    return { embed, anchors, anchorEmbeddings: await embedAnchors(embed, anchors) };
  })();
  // A failed model or anchors load is retried on the next call instead of kept.
  anchorsPromise.catch(() => { embedderPromise = null; anchorsPromise = null; });
  return anchorsPromise;
}

/**
 * Check the input with the site's rules. The schema already bounds sizes; this checks the
 * links between variants and reactions.
 *
 * :return: null when the input is fine, else {ok: false, reason}.
 */
export function refusal(args) {
  const ids = args.variants.map((v) => v.id);
  const badId = [...ids, ...args.reactions.flatMap((r) => [r.variant_id, r.persona_id])].find((id) => !ID.test(id));
  if (badId !== undefined) return { ok: false, reason: `Id "${badId.slice(0, 40)}" has characters other than lowercase letters, digits, _ and -.` };
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "Two variants have the same id. Give each variant its own id." };
  const unknown = args.reactions.filter((r) => !ids.includes(r.variant_id)).map((r) => r.variant_id);
  if (unknown.length) return { ok: false, reason: `Reactions name variants that are not in variants: ${[...new Set(unknown)].join(", ")}.` };
  const missing = ids.filter((id) => !args.reactions.some((r) => r.variant_id === id));
  if (missing.length) return { ok: false, reason: `No reactions for variant ${missing.join(", ")}. Each variant needs reactions from the same personas.` };
  return null;
}

/**
 * Turn the action input into synthetic-panel's reactions handoff: each (variant, persona)
 * pair's reactions get sample indexes in the order given.
 */
export function toHandoff(args) {
  const personas = [...new Set(args.reactions.map((r) => r.persona_id))];
  const counts = new Map();
  const records = args.reactions.map((r) => {
    const key = `${r.variant_id}|${r.persona_id}`;
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    return { variant_id: r.variant_id, persona_id: r.persona_id, sample_index: index, reaction: r.reaction };
  });
  return {
    schema_version: 1,
    stimulus_type: args.stimulus_type ?? "headline",
    variants: Object.fromEntries(args.variants.map((v) => [v.id, v.copy])),
    personas,
    n_samples: Math.max(...counts.values()),
    records,
  };
}

/**
 * Score the reactions and return a compact result for an agent, or {ok: false, reason}.
 *
 * :param args: Input matching inputSchema().
 * :param progress: Optional download progress callback.
 */
export async function score(args, progress) {
  const detailed = await scoreDetailed(args, progress);
  return detailed.result;
}

/**
 * Score the reactions. Returns {result, full, handoff}: result is the compact agent result
 * (or the refusal), full is synthetic-panel's full result shape for the page to render.
 */
export async function scoreDetailed(args, progress) {
  const refused = refusal(args);
  if (refused) return { result: refused, full: null, handoff: null };
  const { embed, anchors, anchorEmbeddings } = await warmUp(progress);
  const handoff = toHandoff(args);
  const full = await scoreReactions(handoff, embed, anchors, undefined, anchorEmbeddings);
  const perReaction = handoff.records.map((rec) => {
    const group = full.per_persona_variant[`${rec.variant_id}:${rec.persona_id}`];
    return {
      variant_id: rec.variant_id,
      persona_id: rec.persona_id,
      score: group ? round(group.sample_scores[rec.sample_index]) : null,
      reaction_start: rec.reaction.slice(0, 80),
    };
  });
  const result = {
    ok: true,
    verdict: full.comparability.verdict,
    message: full.comparability.message,
    issues: full.comparability.issues.map((i) => `${i.code}: ${i.variant_id ?? ""} ${i.persona_id ?? ""}`.trim()),
    ranking: full.ranking.map((r) => ({ rank: r.rank, variant_id: r.variant_id, score: round(r.score) })),
    persona_scores: Object.fromEntries(Object.values(full.per_variant).map((v) => [v.variant_id, mapValues(v.persona_scores, round)])),
    per_reaction: perReaction,
    n_samples: full.n_samples,
    method: METHOD,
    limits: LIMITS_NOTE,
  };
  return { result, full, handoff };
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}
