// Registers this site's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
// Each action wraps a Panel method (js/panel.mjs), so the assistant and the page's own
// buttons follow one set of rules. The page module is imported by the URL index.html uses.
import { App } from "./js/panel.mjs";
import { inputSchema, LIMITS, STIMULUS_TYPES } from "./js/scoring-service.mjs";

// The same words as the bridge's score_reactions (bridge/bridge-actions.js), so one set of
// moderator instructions fits a visit to this page and a call from another agent site.
export const SCORE_DESCRIPTION = `Score persona reactions to ${LIMITS.minVariants}-${LIMITS.maxVariants} versions of short marketing copy with Semantic Similarity Rating, in the visitor's browser. Call it once, after every persona has answered, with each reaction exactly as written. Returns a directional ranking for comparing these versions with each other, the score per persona, and the method. The first call can take up to a minute while the model loads.`;

class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(SiteActions.readStateAction());
    actions.register(SiteActions.setVariantsAction());
    actions.register(SiteActions.scoreAction());
  }

  static readStateAction() {
    return {
      name: "get_panel_state",
      description: "Read the versions of copy the visitor saved on this page, their kind and background, the three personas, the limits and the last scored run. Call it when the visitor asks about the saved versions or to run the panel on them: the visitor can change them on the page at any time.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => App.page.getState(),
    };
  }

  static setVariantsAction() {
    return {
      name: "set_variants",
      description: `Replace the versions saved on this page with ${LIMITS.minVariants} or ${LIMITS.maxVariants} new ones, each exactly as the visitor wrote it. Use it only when the visitor asks to save or change the versions on the page; running the panel does not need it.`,
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["variants"],
        properties: {
          stimulus_type: { type: "string", enum: STIMULUS_TYPES, description: "What the copy is." },
          context: { type: "string", maxLength: 300, description: "Optional background, such as who the page is for." },
          variants: {
            type: "array",
            minItems: LIMITS.minVariants,
            maxItems: LIMITS.maxVariants,
            items: { type: "string", minLength: 1, maxLength: LIMITS.maxCopy },
          },
        },
      },
      execute: (args) => App.page.setVariants(args),
    };
  }

  static scoreAction() {
    return {
      name: "score_reactions",
      description: SCORE_DESCRIPTION,
      // It changes only the results panel, which the next run replaces.
      effect: "write",
      timeoutMs: 170000,
      inputSchema: inputSchema(),
      execute: (args) => App.page.score(args, "Reactions written by the panel's persona agents on the AI model you chose in the assistant's settings. The scoring ran in your browser."),
    };
  }
}

export const registerActions = SiteActions.registerActions;
