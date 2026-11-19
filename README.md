# Synthetic Panel — an agentic website

Built for the Open Agentic Web Challenge. Open the page to score a saved sample run with no
key, or save two or three versions of your own copy and ask the page's assistant to run the
panel on them with your own LLM key.

A static website whose agent network compares 2–3 versions of short marketing copy (a
headline, an email subject line, an offer) with a panel of three synthetic personas, then
scores each persona's written reaction with Semantic Similarity Rating (SSR) in the
visitor's browser. No server and no key of ours: the agents run on the visitor's own LLM
key, and the scoring model runs locally in the page.

Other agent sites can use the scorer too. `score_reactions` is shared through the site's
action bridge as a read open to every origin: a caller's runtime opens
`bridge/action-bridge.html` in a hidden frame, and the reactions are scored there, with the
model and onnxruntime-web served from this site.

## What the scores mean

Directional only. Use the ranking to compare the versions tested in one run, with the same
personas, anchors and model. The scores do not predict conversion or survey results. The
SSR paper (Maier et al., 2025, arXiv:2510.08338) reports that, on 57 personal-care product
surveys with 9,300 human responses, SSR reached 90% of human test-retest reliability with
realistic response distributions (KS similarity above 0.85). That was measured with the
paper's own anchors, products and models, not with this site's.

## Credits

- Scoring method and personas: [synthetic-panel](https://github.com/StartupBros-com/synthetic-panel)
  (MIT), ported to JavaScript and checked against its Python output.
- SSR: B. F. Maier et al., "LLMs Reproduce Human Purchase Intent via Semantic Similarity
  Elicitation of Likert Ratings", arXiv:2510.08338, 2025.
- Agent runtime: `runtime/` from
  [cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web) at
  commit 29a42261, unchanged (Apache-2.0, `runtime/LICENSE.txt`).
- Embedding model: all-MiniLM-L6-v2, ONNX export by Xenova (Apache-2.0, see
  `models/Xenova/all-MiniLM-L6-v2/NOTICE.txt`).
- transformers.js 4.3.2 (Apache-2.0) and onnxruntime-web (MIT), in `vendor/` with their
  licences.

## Licence

The site's own code is MIT (`LICENSE`). Third-party files keep their own licences, listed
above.
