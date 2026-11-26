import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreDetailed } from "../js/scoring-service.mjs";

const args = {
  variants: [{ id: "a", copy: "A" }, { id: "b", copy: "B" }],
  reactions: ["a", "b"].map((id) => ({
    variant_id: id,
    persona_id: "alex",
    reaction: "This is a complete fixture reaction, long enough to be scored.",
  })),
};

const anchors = { sample: { 1: [-1, 0], 2: [0, -1], 3: [0, 1], 4: [1, 1], 5: [1, 0] } };

function score(vectors, anchorEmbeddings = anchors) {
  return scoreDetailed(args, undefined, async () => ({
    embed: async () => vectors,
    anchors: {},
    anchorEmbeddings,
  }));
}

async function assertRefused(result) {
  const detailed = await result;
  assert.equal(detailed.result.ok, false);
  assert.match(detailed.result.reason, /invalid embedding/i);
  assert.equal(detailed.full, null);
}

for (const [name, bad] of [
  ["zero norm", [0, 0]],
  ["nonfinite", [Infinity, 1]],
  ["wrong dimension", [1, 0, 1]],
  ["missing", undefined],
]) {
  test(`refuses a ${name} reaction embedding without inventing a ranking`, () =>
    assertRefused(score([[1, 0], bad])));
}

test("refuses an invalid anchor before returning any scores", () =>
  assertRefused(score([[1, 0], [-1, 0]], { sample: { ...anchors.sample, 3: [0, 0] } })));

test("preserves a valid directional ranking", async () => {
  const { result } = await score([[1, 0], [-1, 0]]);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "comparable");
  assert.deepEqual(result.ranking, [
    { rank: 1, variant_id: "a", score: 3.825 },
    { rank: 2, variant_id: "b", score: 1.904 },
  ]);
});

test("keeps genuinely tied nonzero similarities neutral", async () => {
  const tied = Object.fromEntries([1, 2, 3, 4, 5].map((k) => [k, [1, 0]]));
  const { result } = await score([[1, 0], [0, 1]], { sample: tied });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "comparable");
  assert.deepEqual(result.ranking.map((row) => row.score), [3, 3]);
});
