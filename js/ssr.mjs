// Semantic Similarity Rating (SSR, arXiv:2510.08338), ported line for line from
// synthetic-panel's synthetic_panel/scoring.py and testing.py (MIT, commit 291475d).
// Pure functions: the caller supplies embeddings, so the same code runs in Node and in the
// browser. Scores are directional and for relative ranking only (see the synthetic-panel README).

export const DEFAULT_DIST_TEMPERATURE = 1.0;
export const MIN_REACTION_LENGTH = 40;
export const COLLAPSE_SCORE_SPREAD_FLOOR = 0.01;
export const COLLAPSE_EMBEDDING_DISTANCE_FLOOR = 0.002;
const LIKERT = [1, 2, 3, 4, 5];

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Equations 8-9: subtract the minimum similarity, normalize, apply p^(1/T), re-normalize.
// `sims` maps a Likert point (1-5) to the cosine similarity with that anchor.
export function distributionFromSimilarities(sims, temperature = DEFAULT_DIST_TEMPERATURE) {
  const minSim = Math.min(...LIKERT.map((k) => sims[k]));
  const adjusted = Object.fromEntries(LIKERT.map((k) => [k, sims[k] - minSim]));
  const totalAdj = LIKERT.reduce((s, k) => s + adjusted[k], 0);
  const raw = Object.fromEntries(LIKERT.map((k) => [k, totalAdj > 0 ? adjusted[k] / totalAdj : 0.2]));
  const scaled = Object.fromEntries(LIKERT.map((k) => [k, raw[k] > 0 ? raw[k] ** (1 / temperature) : 0]));
  const totalScaled = LIKERT.reduce((s, k) => s + scaled[k], 0);
  return LIKERT.map((k) => (totalScaled > 0 ? scaled[k] / totalScaled : 0.2));
}

// anchorEmbeddings: { set_1: { "1": vec, ..., "5": vec }, ... } (the multi-set, paper format).
export function ssrScore(responseEmbedding, anchorEmbeddings, temperature = DEFAULT_DIST_TEMPERATURE) {
  const sets = Object.values(anchorEmbeddings);
  const perSet = sets.map((set) => {
    const sims = Object.fromEntries(LIKERT.map((k) => [k, cosine(responseEmbedding, set[String(k)])]));
    return distributionFromSimilarities(sims, temperature);
  });
  const distribution = LIKERT.map((_, i) => perSet.reduce((s, p) => s + p[i], 0) / perSet.length);
  const score = distribution.reduce((s, p, i) => s + (i + 1) * p, 0);
  return { score, distribution };
}

// embed(texts) -> Promise<number[][]>, one normalized mean-pooled vector per text.
export async function embedAnchors(embed, anchors) {
  const out = {};
  for (const [setName, set] of Object.entries(anchors)) {
    const keys = Object.keys(set);
    const vecs = await embed(keys.map((k) => set[k]));
    out[setName] = Object.fromEntries(keys.map((k, i) => [k, vecs[i]]));
  }
  return out;
}

function average(rows) {
  return rows[0].map((_, i) => rows.reduce((s, r) => s + r[i], 0) / rows.length);
}

// Mirrors testing.py score_reactions: per-sample SSR, then the mean per persona-variant,
// then the mean per variant, then a ranking. Issues make the run "not_comparable".
// precomputed: optional anchor embeddings from embedAnchors(embed, anchors), to skip re-embedding.
export async function scoreReactions(handoff, embed, anchors, temperature = DEFAULT_DIST_TEMPERATURE, precomputed = null) {
  const { variants, personas, n_samples: nSamples, records } = handoff;
  const personaIds = personas.map((p) => (typeof p === 'string' ? p : p.persona_id ?? p.id));
  const anchorEmbeddings = precomputed ?? await embedAnchors(embed, anchors);
  const issues = [];
  const byKey = new Map(records.map((r) => [`${r.variant_id}|${r.persona_id}|${r.sample_index}`, r]));
  const kept = [];
  for (const variantId of Object.keys(variants)) {
    for (const personaId of personaIds) {
      for (let s = 0; s < nSamples; s++) {
        const rec = byKey.get(`${variantId}|${personaId}|${s}`);
        if (!rec) {
          issues.push({ code: 'missing_sample', variant_id: variantId, persona_id: personaId, sample_index: s });
          continue;
        }
        const reaction = String(rec.reaction ?? '').trim();
        if (reaction.length < MIN_REACTION_LENGTH) {
          issues.push({ code: 'degenerate_reaction', variant_id: variantId, persona_id: personaId, sample_index: s });
          continue;
        }
        kept.push({ variantId, personaId, sampleIndex: s, reaction });
      }
    }
  }
  const vecs = kept.length ? await embed(kept.map((k) => k.reaction)) : [];
  kept.forEach((k, i) => {
    k.embedding = vecs[i];
    Object.assign(k, ssrScore(vecs[i], anchorEmbeddings, temperature));
  });

  const perPersonaVariant = {};
  for (const variantId of Object.keys(variants)) {
    for (const personaId of personaIds) {
      const samples = kept
        .filter((k) => k.variantId === variantId && k.personaId === personaId)
        .sort((a, b) => a.sampleIndex - b.sampleIndex);
      if (samples.length !== nSamples) continue;
      const scores = samples.map((k) => k.score);
      const spread = Math.max(...scores) - Math.min(...scores);
      const dists = [];
      for (let i = 0; i < samples.length; i++) {
        for (let j = i + 1; j < samples.length; j++) dists.push(1 - cosine(samples[i].embedding, samples[j].embedding));
      }
      const embeddingDistance = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : Infinity;
      if (spread < COLLAPSE_SCORE_SPREAD_FLOOR && embeddingDistance < COLLAPSE_EMBEDDING_DISTANCE_FLOOR) {
        issues.push({ code: 'collapsed_samples', variant_id: variantId, persona_id: personaId });
      }
      perPersonaVariant[`${variantId}:${personaId}`] = {
        variant_id: variantId,
        persona_id: personaId,
        score: scores.reduce((a, b) => a + b, 0) / scores.length,
        distribution: average(samples.map((k) => k.distribution)),
        sample_scores: scores,
        score_spread: spread,
        embedding_distance: embeddingDistance,
      };
    }
  }
  const perVariant = {};
  for (const [variantId, copy] of Object.entries(variants)) {
    const groups = personaIds.map((p) => perPersonaVariant[`${variantId}:${p}`]).filter(Boolean);
    perVariant[variantId] = {
      variant_id: variantId,
      copy,
      score: groups.length ? groups.reduce((s, g) => s + g.score, 0) / groups.length : null,
      persona_scores: Object.fromEntries(groups.map((g) => [g.persona_id, g.score])),
    };
  }
  const ranking = Object.values(perVariant)
    .filter((v) => v.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((v, i) => ({ variant_id: v.variant_id, score: v.score, rank: i + 1 }));
  const verdict = issues.length ? 'not_comparable' : 'comparable';
  return {
    n_samples: nSamples,
    dist_temperature: temperature,
    score_scale: '1-5 directional',
    comparability: {
      verdict,
      message:
        verdict === 'comparable'
          ? 'Comparable directional ranking. Absolute scores are directional only.'
          : 'Not comparable; ranking is unreliable. Re-run with complete, independent draws.',
      issues,
    },
    per_variant: perVariant,
    per_persona_variant: perPersonaVariant,
    ranking,
  };
}
