// The Synthetic Panel page: the versions form, the saved sample run and the results panel.
// The page's buttons and the assistant's website_* tools (site-actions.js) call the same
// methods, so both follow one set of rules.
import { scoreDetailed, LIMITS, STIMULUS_TYPES } from "./scoring-service.mjs";

// The three personas of synthetic-panel's personas.example.yaml. The agents' prompts come
// from that file (scripts/persona-prompts.py); the tests check these names against it.
export const PERSONAS = {
  alex: { name: "Alex Chen", profile: "34, SaaS founder, Austin, Texas" },
  priya: { name: "Priya Nair", profile: "29, professional skills learner, Chicago, Illinois" },
  jordan: { name: "Jordan Ellis", profile: "46, local-services customer, Raleigh, North Carolina" },
};

export const STIMULUS_LABELS = {
  headline: "Headline",
  email_subject: "Email subject line",
  offer: "Offer",
  value_prop: "Value proposition",
  cta: "Call to action",
  price: "Price",
  other: "Other short message",
};

export const MAX_CONTEXT = 300;
export const SAMPLE_NOTE = "Saved reactions from synthetic-panel's own sample run of November 7, 2026: three headlines, the three personas, two reactions each, written by Claude, one per prompt in its own context. Only the scoring runs here, in your browser, with no key.";
const VERSION_FIELDS = ["version-1", "version-2", "version-3"];

/**
 * The page's state and its operations.
 */
export class Panel {
  /**
   * :param doc: The document (a stand-in in the Node tests).
   */
  constructor(doc) {
    this.doc = doc;
    this.state = { version: 0, stimulus_type: "headline", context: "", variants: [] };
    this.lastRun = null;
    // What loads the scoring model; undefined means the browser default (warmUp).
    this.load = undefined;
  }

  /**
   * Return a copy of the page state for the assistant.
   */
  getState() {
    return {
      version: this.state.version,
      stimulus_type: this.state.stimulus_type,
      context: this.state.context,
      variants: this.state.variants.map((v) => ({ ...v })),
      personas: Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, profile: p.profile })),
      limits: { min_versions: LIMITS.minVariants, max_versions: LIMITS.maxVariants, max_copy: LIMITS.maxCopy, max_context: MAX_CONTEXT },
      last_run: this.lastRun,
    };
  }

  /**
   * Replace the saved versions. Refuses bad input before changing anything.
   *
   * :param input: {stimulus_type, context, variants: [copy, ...]}.
   * :return: The new state, or {ok: false, reason, field}.
   */
  setVariants(input) {
    const type = input.stimulus_type ?? this.state.stimulus_type;
    if (!STIMULUS_TYPES.includes(type)) {
      return { ok: false, reason: `Unknown kind of copy "${String(type).slice(0, 30)}".`, field: "stimulus_type" };
    }
    const copies = (input.variants || []).map((c) => String(c).trim());
    const filled = copies.filter((c) => c.length > 0);
    if (filled.length < LIMITS.minVariants || filled.length > LIMITS.maxVariants) {
      return { ok: false, reason: `Give ${LIMITS.minVariants} or ${LIMITS.maxVariants} versions; there are ${filled.length}.`, field: "variants" };
    }
    const long = filled.findIndex((c) => c.length > LIMITS.maxCopy);
    if (long !== -1) {
      return { ok: false, reason: `Version ${long + 1} has ${filled[long].length} characters; the most is ${LIMITS.maxCopy}.`, field: "variants" };
    }
    if (new Set(filled).size !== filled.length) {
      return { ok: false, reason: "Two versions are the same. Give each version different copy.", field: "variants" };
    }
    const context = String(input.context ?? "").trim();
    if (context.length > MAX_CONTEXT) {
      return { ok: false, reason: `The background has ${context.length} characters; the most is ${MAX_CONTEXT}.`, field: "context" };
    }
    this.state = {
      version: this.state.version + 1,
      stimulus_type: type,
      context,
      variants: filled.map((copy, i) => ({ id: `v${i + 1}`, copy })),
    };
    this.fillForm();
    return { ok: true, ...this.getState() };
  }

  /**
   * Save what the visitor typed in the form.
   *
   * :return: The setVariants result.
   */
  saveFromForm() {
    const result = this.setVariants({
      stimulus_type: this.byId("stimulus-type").value,
      context: this.byId("context-input").value,
      variants: VERSION_FIELDS.map((id) => this.byId(id).value),
    });
    this.byId("form-status").textContent = result.ok
      ? `Saved ${result.variants.length} versions (save ${result.version}).`
      : result.reason;
    return result;
  }

  /**
   * Save the form, then put a request in the chat box for the visitor to send.
   */
  askPanel() {
    const result = this.saveFromForm();
    if (!result.ok) return result;
    const input = this.doc.querySelector("#ns-input");
    if (!input) {
      this.byId("form-status").textContent = "Saved. The assistant has not loaded, so the panel cannot run yet.";
      return result;
    }
    input.value = "Run the panel on the versions I saved on the page.";
    input.focus();
    this.byId("form-status").textContent = `Saved ${result.variants.length} versions. Press Send in the chat to run the panel on your AI key.`;
    return result;
  }

  /**
   * Score reactions, show the results on the page and return the result for the agent.
   *
   * :param args: Input matching the score_reactions schema.
   * :param source: Words for where the reactions came from.
   * :return: The compact result with shown_on_page, or {ok: false, reason}.
   */
  async score(args, source) {
    const status = this.byId("score-status");
    status.textContent = "Loading the scoring model…";
    const progress = (fraction, label) => {
      status.textContent = `${label}: ${Math.round(fraction * 100)}%`;
    };
    let detailed;
    try {
      detailed = await scoreDetailed(args, progress, this.load);
    } catch (error) {
      status.textContent = `Scoring failed: ${error.message}`;
      throw error;
    }
    if (!detailed.result.ok) {
      status.textContent = detailed.result.reason;
      return detailed.result;
    }
    status.textContent = "";
    this.render(detailed, source);
    this.lastRun = {
      source,
      verdict: detailed.result.verdict,
      ranking: detailed.result.ranking,
    };
    return { ...detailed.result, shown_on_page: true };
  }

  /**
   * Score synthetic-panel's saved sample run. Needs no key.
   */
  async scoreSample() {
    const button = this.byId("sample-button");
    button.disabled = true;
    try {
      const response = await fetch(new URL("../data/sample-input.json", import.meta.url));
      if (!response.ok) throw new Error(`Could not load the sample run (HTTP ${response.status}).`);
      return await this.score(await response.json(), SAMPLE_NOTE);
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Show a scored run in the results panel.
   *
   * :param detailed: scoreDetailed's {result, full, handoff}.
   * :param source: Where the reactions came from.
   */
  render(detailed, source) {
    const { result, full, handoff } = detailed;
    const ids = Object.keys(full.per_variant);
    // The panel's own runs use v1-v3; the sample run keeps its ids (plain, outcome, proof).
    const label = (id) => (/^v\d+$/.test(id) ? `Version ${id.slice(1)}` : id);
    const personaIds = handoff.personas;
    const personaName = (id) => PERSONAS[id]?.name ?? id;

    this.byId("results-source").textContent = source;
    this.byId("results-kind").textContent = `${STIMULUS_LABELS[handoff.stimulus_type] ?? handoff.stimulus_type}, ${ids.length} versions, ${personaIds.length} personas, ${full.n_samples} reaction${full.n_samples === 1 ? "" : "s"} each.`;
    const verdict = this.byId("results-verdict");
    verdict.textContent = result.verdict === "comparable"
      ? "Comparable: every reaction was usable, so the versions can be ranked against each other."
      : `Not comparable: ${result.issues.join("; ")}. Treat this ranking as unreliable.`;
    verdict.className = result.verdict === "comparable" ? "verdict ok" : "verdict warn";

    const ranking = this.byId("results-ranking");
    ranking.replaceChildren(...full.ranking.map((r) => {
      const v = full.per_variant[r.variant_id];
      return this.row([
        String(r.rank),
        label(r.variant_id),
        v.copy,
        r.score.toFixed(2),
        this.bar((r.score - 1) / 4, `${r.score.toFixed(2)} of 5`),
      ]);
    }));

    this.byId("results-persona-head").replaceChildren(this.row(["Version", ...personaIds.map(personaName)], "th"));
    this.byId("results-personas").replaceChildren(...ids.map((id) => this.row([
      label(id),
      ...personaIds.map((p) => {
        const s = full.per_variant[id].persona_scores[p];
        return s === undefined ? "–" : s.toFixed(2);
      }),
    ])));

    this.byId("results-dists").replaceChildren(...ids.map((id) => {
      const groups = personaIds.map((p) => full.per_persona_variant[`${id}:${p}`]).filter(Boolean);
      const dist = [0, 1, 2, 3, 4].map((k) => groups.reduce((s, g) => s + g.distribution[k], 0) / (groups.length || 1));
      const figure = this.el("div", "dist");
      figure.append(this.el("p", "dist-title", label(id)));
      dist.forEach((p, k) => {
        const line = this.el("div", "dist-row");
        line.append(this.el("span", "dist-k", String(k + 1)), this.bar(p / 0.5, `${(p * 100).toFixed(0)}%`), this.el("span", "dist-p", `${(p * 100).toFixed(0)}%`));
        figure.append(line);
      });
      return figure;
    }));

    this.byId("results-reactions").replaceChildren(...ids.map((id) => {
      const details = this.el("details", "reactions");
      details.append(this.el("summary", "", `${label(id)}: ${full.per_variant[id].copy}`));
      for (const rec of handoff.records.filter((r) => r.variant_id === id)) {
        const group = full.per_persona_variant[`${id}:${rec.persona_id}`];
        const sample = group ? group.sample_scores[rec.sample_index] : undefined;
        const item = this.el("div", "reaction");
        item.append(
          this.el("p", "reaction-who", `${personaName(rec.persona_id)}${full.n_samples > 1 ? `, reaction ${rec.sample_index + 1}` : ""}${sample === undefined ? ", not scored" : `: ${sample.toFixed(2)}`}`),
          this.el("p", "reaction-text", rec.reaction),
        );
        details.append(item);
      }
      return details;
    }));

    this.byId("results").hidden = false;
  }

  /**
   * Put the saved state into the form fields.
   */
  fillForm() {
    this.byId("stimulus-type").value = this.state.stimulus_type;
    this.byId("context-input").value = this.state.context;
    VERSION_FIELDS.forEach((id, i) => {
      this.byId(id).value = this.state.variants[i]?.copy ?? "";
    });
  }

  /**
   * Wire the page's own controls.
   */
  wire() {
    this.byId("save-versions").addEventListener("click", () => this.saveFromForm());
    this.byId("ask-panel").addEventListener("click", () => this.askPanel());
    this.byId("sample-button").addEventListener("click", () => {
      this.scoreSample().catch((error) => console.error("Sample scoring failed", error));
    });
  }

  byId(id) {
    const found = this.doc.getElementById(id);
    if (!found) throw new Error(`The page has no element #${id}.`);
    return found;
  }

  el(tag, className, text) {
    const node = this.doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  row(cells, cellTag = "td") {
    const tr = this.doc.createElement("tr");
    for (const cell of cells) {
      const td = this.doc.createElement(cellTag);
      if (typeof cell === "string") td.textContent = cell;
      else td.append(cell);
      tr.append(td);
    }
    return tr;
  }

  bar(fraction, title) {
    const outer = this.el("span", "bar");
    outer.setAttribute("title", title);
    outer.setAttribute("aria-hidden", "true");
    const inner = this.el("span", "bar-fill");
    inner.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    outer.append(inner);
    return outer;
  }
}

export const App = { page: new Panel(document) };

// Wire the buttons only in a browser. Node tests import this file with a stand-in document.
if (typeof window !== "undefined") {
  App.page.wire();
}
