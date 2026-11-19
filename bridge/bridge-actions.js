// The action this site shares with other agent sites through its action bridge.
// bridge/agent-manifest.json loads this module in the bridge frame, which has no panel page.
// The scorer reads nothing from any page: it loads the model and anchors from this site's
// origin and scores the reactions the caller's agent sends. It has the same name and input as
// the page's own action (site-actions.js), so the network's instructions fit both.
import { inputSchema, score, LIMITS } from "../js/scoring-service.mjs";

/**
 * Shares one read, score_reactions, with every agent site.
 *
 * It is a pure function of its input: no visitor data is kept, and the reactions are scored
 * in this hidden frame, in the visitor's browser, without any server. That is why it uses
 * "*": any agent site may ask the panel to score reactions to its own copy.
 */
class BridgeActions {
  static CALLERS = ["*"];

  /**
   * Register the shared read with the bridge's registry.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(BridgeActions.scoreAction());
  }

  /**
   * Describe the shared scorer.
   *
   * :return: The action definition.
   */
  static scoreAction() {
    return {
      name: "score_reactions",
      description: `Score persona reactions to ${LIMITS.minVariants}-${LIMITS.maxVariants} versions of short marketing copy with Semantic Similarity Rating, in the visitor's browser. Call it once, after every persona has answered, with each reaction exactly as written. Returns a directional ranking for comparing these versions with each other, the score per persona, and the method. The first call can take up to a minute while the model loads.`,
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      timeoutMs: 170000,
      inputSchema: inputSchema(),
      execute: (args) => score(args),
    };
  }
}

export const registerActions = BridgeActions.registerActions;
