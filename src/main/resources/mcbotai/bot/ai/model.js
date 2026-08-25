'use strict';
const T = require('./tensor');

/**
 * A tiny decoder-only (GPT-style) transformer, character-level, trained
 * from scratch — no pretraining, no external weights. Small enough to
 * forward+backward in a few milliseconds per training step in plain JS.
 */

function sinusoidalPositionalEncoding(maxLen, dModel) {
  // Fixed (non-learned) positional encoding, as in the original
  // "Attention Is All You Need" paper.
  const pe = new Float64Array(maxLen * dModel);
  for (let pos = 0; pos < maxLen; pos++) {
    for (let i = 0; i < dModel; i++) {
      const angle = pos / Math.pow(10000, (2 * Math.floor(i / 2)) / dModel);
      pe[pos * dModel + i] = i % 2 === 0 ? Math.sin(angle) : Math.cos(angle);
    }
  }
  return pe;
}

function causalMask(T_len) {
  const mask = new Float64Array(T_len * T_len);
  for (let i = 0; i < T_len; i++)
    for (let j = 0; j < T_len; j++)
      mask[i * T_len + j] = j > i ? -1e9 : 0; // block attending to future positions
  return mask;
}

class MiniTransformer {
  constructor(vocabSize, opts = {}) {
    this.vocabSize = vocabSize;
    this.dModel = opts.dModel || 32;
    this.nHeads = opts.nHeads || 2;
    this.headDim = this.dModel / this.nHeads;
    this.nLayers = opts.nLayers || 2;
    this.dFF = opts.dFF || 64;
    this.maxLen = opts.maxLen || 64;
    if (this.dModel % this.nHeads !== 0) throw new Error('dModel must be divisible by nHeads');

    this.posEnc = sinusoidalPositionalEncoding(this.maxLen, this.dModel);
    this.params = [];
    this._buildParams();
  }

  _p(rows, cols, scale) {
    const t = T.Tensor.randn(rows, cols, scale);
    this.params.push(t);
    return t;
  }
  _zeros(rows, cols) {
    const t = T.Tensor.zeros(rows, cols);
    this.params.push(t);
    return t;
  }
  _ones(rows, cols) {
    const t = T.Tensor.zeros(rows, cols);
    t.data.fill(1);
    this.params.push(t);
    return t;
  }

  _buildParams() {
    const d = this.dModel, ff = this.dFF;
    const scale = 1 / Math.sqrt(d);

    this.tokEmbed = this._p(this.vocabSize, d, 0.1);

    this.layers = [];
    for (let l = 0; l < this.nLayers; l++) {
      this.layers.push({
        ln1g: this._ones(1, d), ln1b: this._zeros(1, d),
        Wq: this._p(d, d, scale), bq: this._zeros(1, d),
        Wk: this._p(d, d, scale), bk: this._zeros(1, d),
        Wv: this._p(d, d, scale), bv: this._zeros(1, d),
        Wo: this._p(d, d, scale), bo: this._zeros(1, d),
        ln2g: this._ones(1, d), ln2b: this._zeros(1, d),
        W1: this._p(d, ff, scale), b1: this._zeros(1, ff),
        W2: this._p(ff, d, 1 / Math.sqrt(ff)), b2: this._zeros(1, d)
      });
    }

    this.lnFg = this._ones(1, d);
    this.lnFb = this._zeros(1, d);
    this.Wout = this._p(d, this.vocabSize, scale);
    this.bout = this._zeros(1, this.vocabSize);
  }

  zeroGrad() { for (const p of this.params) p.zeroGrad(); }

  _attention(xNorm, layer, mask, Tlen) {
    const Q = T.addBias(T.matmul(xNorm, layer.Wq), layer.bq);
    const K = T.addBias(T.matmul(xNorm, layer.Wk), layer.bk);
    const V = T.addBias(T.matmul(xNorm, layer.Wv), layer.bv);

    const heads = [];
    const scaleFactor = 1 / Math.sqrt(this.headDim);
    for (let h = 0; h < this.nHeads; h++) {
      const start = h * this.headDim;
      const Qh = T.sliceCols(Q, start, this.headDim);
      const Kh = T.sliceCols(K, start, this.headDim);
      const Vh = T.sliceCols(V, start, this.headDim);
      let scores = T.scale(T.matmul(Qh, T.transpose(Kh)), scaleFactor); // [T,T]
      scores = T.addConst(scores, mask);
      const attn = T.softmaxRows(scores);
      const ctx = T.matmul(attn, Vh); // [T, headDim]
      heads.push(ctx);
    }
    const concat = T.concatCols(heads); // [T, dModel]
    return T.addBias(T.matmul(concat, layer.Wo), layer.bo);
  }

  /**
   * Forward pass over a sequence of token indices.
   * Returns the final-layer hidden states [T, dModel] AND per-position
   * logits [T, vocabSize] (pre-softmax), plus the causal mask used.
   */
  forward(tokenIndices) {
    const Tlen = tokenIndices.length;
    if (Tlen > this.maxLen) throw new Error('sequence longer than maxLen');
    const mask = causalMask(Tlen);

    const tok = T.embedLookup(this.tokEmbed, tokenIndices);
    const posSlice = this.posEnc.slice(0, Tlen * this.dModel);
    let x = T.addConst(tok, posSlice);

    for (const layer of this.layers) {
      const xn1 = T.layerNormRows(x, layer.ln1g, layer.ln1b);
      const attnOut = this._attention(xn1, layer, mask, Tlen);
      x = T.addElem(x, attnOut);

      const xn2 = T.layerNormRows(x, layer.ln2g, layer.ln2b);
      const h1 = T.reluElem(T.addBias(T.matmul(xn2, layer.W1), layer.b1));
      const ffOut = T.addBias(T.matmul(h1, layer.W2), layer.b2);
      x = T.addElem(x, ffOut);
    }

    const xf = T.layerNormRows(x, this.lnFg, this.lnFb);
    const logits = T.addBias(T.matmul(xf, this.Wout), this.bout); // [T, vocabSize]
    return logits;
  }

  /**
   * Trains on one sequence: predicts token[i+1] from tokens[0..i] for every
   * position, computes average cross-entropy loss, and backpropagates.
   * Returns the scalar loss (does NOT apply the optimizer step itself).
   */
  lossAndBackward(tokenIndices) {
    if (tokenIndices.length < 2) return null;
    this.zeroGrad();
    const inputIdx = tokenIndices.slice(0, -1);
    const targetIdx = tokenIndices.slice(1);
    const logits = this.forward(inputIdx); // [T, V]
    const Tlen = inputIdx.length, V = this.vocabSize;

    let totalLoss = 0;
    for (let t = 0; t < Tlen; t++) {
      const row = logits.data.slice(t * V, (t + 1) * V);
      const { loss, dLogits } = T.softmaxCrossEntropyRow(row, targetIdx[t]);
      totalLoss += loss;
      for (let j = 0; j < V; j++) logits.grad[t * V + j] += dLogits[j] / Tlen;
    }
    T.backwardFrom(logits); // gradients already seeded on logits.grad above
    return totalLoss / Tlen;
  }

  /** Greedy/temperature sampling continuation of a prompt (token indices). */
  generate(promptIdx, maxNewTokens, temperature = 0.8, topK = 8, repetitionPenalty = 1.3) {
    let seq = promptIdx.slice(-this.maxLen);
    const out = [];
    for (let step = 0; step < maxNewTokens; step++) {
      const windowed = seq.slice(-this.maxLen);
      const logits = this.forward(windowed);
      const lastRow = Array.from(logits.data.slice((windowed.length - 1) * this.vocabSize, windowed.length * this.vocabSize));

      // Repetition penalty: discourage repeating characters seen recently.
      // Without this, a model this small tends to fall into "the the the"
      // style loops — penalizing recently-used tokens (standard technique:
      // shrink positive logits, grow negative ones, toward zero) pushes
      // sampling toward more varied output.
      if (repetitionPenalty && repetitionPenalty !== 1) {
        const recentTokens = new Set(seq.slice(-24));
        for (const tokenId of recentTokens) {
          if (tokenId < 0 || tokenId >= lastRow.length) continue;
          lastRow[tokenId] = lastRow[tokenId] > 0 ? lastRow[tokenId] / repetitionPenalty : lastRow[tokenId] * repetitionPenalty;
        }
      }

      // temperature + top-k sampling
      const scaled = lastRow.map(v => v / temperature);
      const indices = scaled.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, topK);
      const maxV = indices[0][0];
      const exps = indices.map(([v]) => Math.exp(v - maxV));
      const sum = exps.reduce((a, b) => a + b, 0);
      let r = Math.random() * sum;
      let chosen = indices[0][1];
      for (let i = 0; i < indices.length; i++) {
        r -= exps[i];
        if (r <= 0) { chosen = indices[i][1]; break; }
      }
      out.push(chosen);
      seq = [...seq, chosen];
    }
    return out;
  }

  // ---- Persistence ----
  toJSON() {
    return {
      vocabSize: this.vocabSize, dModel: this.dModel, nHeads: this.nHeads,
      nLayers: this.nLayers, dFF: this.dFF, maxLen: this.maxLen,
      params: this.params.map(p => Array.from(p.data))
    };
  }

  loadFromJSON(obj) {
    if (obj.vocabSize !== this.vocabSize || obj.dModel !== this.dModel ||
        obj.nHeads !== this.nHeads || obj.nLayers !== this.nLayers ||
        obj.dFF !== this.dFF) {
      throw new Error('Saved model architecture does not match current config — delete the memory file to start fresh.');
    }
    if (obj.params.length !== this.params.length) {
      throw new Error('Saved parameter count mismatch — delete the memory file to start fresh.');
    }
    for (let i = 0; i < this.params.length; i++) {
      this.params[i].data.set(Float64Array.from(obj.params[i]));
    }
  }

  paramCount() {
    return this.params.reduce((sum, p) => sum + p.data.length, 0);
  }
}

module.exports = { MiniTransformer };
