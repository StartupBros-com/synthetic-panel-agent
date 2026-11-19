// Registers this site's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
// SPIKE VERSION: the page action only scores. The page object and its results panel come next.
import { inputSchema, score } from "./js/scoring-service.mjs";

class SiteActions {
  static registerActions(actions) {
    actions.register(SiteActions.scoreAction());
  }

  static scoreAction() {
    return {
      name: "score_reactions",
      description: "Score persona reactions to 2-4 versions of short marketing copy with Semantic Similarity Rating, in the visitor's browser. Call it once, after every persona has answered, with each reaction exactly as written. Returns a directional ranking for comparing these versions with each other, the score per persona, and the method. The first call can take up to a minute while the model loads.",
      effect: "write",
      timeoutMs: 170000,
      inputSchema: inputSchema(),
      execute: (args) => score(args),
    };
  }
}

export const registerActions = SiteActions.registerActions;
