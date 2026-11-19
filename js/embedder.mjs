// The sentence embedder the scorer uses: all-MiniLM-L6-v2, fp32, mean pooling, L2-normalized,
// cut at 256 tokens like sentence-transformers' max_seq_length for this model. The caller
// passes the transformers.js module, so the same settings run in Node (tests) and in the
// browser (page and bridge), and each environment loads the library its own way.

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
// sentence-transformers truncates this model at 256 tokens; its tokenizer file says 512,
// which is what transformers.js's feature-extraction pipeline would use.
export const MAX_TOKENS = 256;

/**
 * Mean-pool token vectors over the attention mask, then L2-normalize each row.
 *
 * :param hidden: Tensor [batch, tokens, dim] of token embeddings.
 * :param mask: Tensor [batch, tokens] of 0/1 (numbers or BigInts).
 * :return: One plain array per input row.
 */
export function meanPoolNormalize(hidden, mask) {
  const [batch, tokens, dim] = hidden.dims;
  const data = hidden.data;
  const out = [];
  for (let b = 0; b < batch; b++) {
    const row = new Float64Array(dim);
    let count = 0;
    for (let t = 0; t < tokens; t++) {
      if (Number(mask.data[b * tokens + t]) === 0) continue;
      count += 1;
      const base = (b * tokens + t) * dim;
      for (let d = 0; d < dim; d++) row[d] += data[base + d];
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) {
      row[d] /= Math.max(count, 1e-9);
      norm += row[d] * row[d];
    }
    norm = Math.max(Math.sqrt(norm), 1e-12);
    out.push(Array.from(row, (v) => v / norm));
  }
  return out;
}

/**
 * Load the model and return embed(texts) -> Promise<number[][]>.
 *
 * :param lib: The transformers.js module (its AutoTokenizer, AutoModel and env exports).
 * :param options.localModelPath: Folder (path or URL, ending in "/") holding MODEL_ID.
 * :param options.wasmPaths: Browser only. Where onnxruntime-web's .mjs and .wasm files are,
 *   so nothing loads from a CDN.
 * :param options.progress: Optional callback for download progress events.
 * :param options.dtype: "fp32" (onnx/model.onnx, the default) or "fp16" (onnx/model_fp16.onnx).
 */
export async function createEmbedder(lib, { localModelPath, wasmPaths, progress, dtype = "fp32" } = {}) {
  const { AutoTokenizer, AutoModel, env } = lib;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = localModelPath;
  if (wasmPaths && env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = wasmPaths;
  }
  const options = progress ? { progress_callback: progress } : {};
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, options);
  const model = await AutoModel.from_pretrained(MODEL_ID, { ...options, dtype });
  return async (texts) => {
    const inputs = batchInputs(lib.Tensor, texts.map((t) => encodeIds(tokenizer, t)));
    const outputs = await model(inputs);
    return meanPoolNormalize(outputs.last_hidden_state, inputs.attention_mask);
  };
}

/**
 * Token ids for one text, cut the way sentence-transformers cuts them: the first
 * MAX_TOKENS - 1 ids, then the closing [SEP]. transformers.js 4.3.2's own truncation keeps
 * MAX_TOKENS ids and drops [SEP], which moved scores on long reactions by up to 0.056
 * (measured 2026-11-19 against synthetic-panel's Python output).
 *
 * :param tokenizer: The model's transformers.js tokenizer.
 * :param text: One input text.
 * :return: Plain array of ids, starting with [CLS] and ending with [SEP].
 */
export function encodeIds(tokenizer, text) {
  const ids = Array.from(tokenizer(text, { add_special_tokens: true, padding: false, truncation: false, return_tensor: false }).input_ids, Number);
  if (ids.length <= MAX_TOKENS) return ids;
  return [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]];
}

/**
 * Pad id lists into one batch: input_ids, attention_mask and token_type_ids tensors.
 *
 * :param Tensor: The transformers.js Tensor class.
 * :param rows: Arrays of token ids.
 * :return: The model's input feed.
 */
export function batchInputs(Tensor, rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const ids = new BigInt64Array(rows.length * width);
  const mask = new BigInt64Array(rows.length * width);
  rows.forEach((row, b) => {
    row.forEach((id, t) => {
      ids[b * width + t] = BigInt(id);
      mask[b * width + t] = 1n;
    });
  });
  const dims = [rows.length, width];
  return {
    input_ids: new Tensor("int64", ids, dims),
    attention_mask: new Tensor("int64", mask, dims),
    token_type_ids: new Tensor("int64", new BigInt64Array(rows.length * width), dims),
  };
}
