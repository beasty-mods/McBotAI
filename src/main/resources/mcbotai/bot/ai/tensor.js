'use strict';
/**
 * Minimal reverse-mode autograd engine over 2D matrices ("Tensor" = a
 * [rows, cols] matrix of numbers). This is the actual math substrate the
 * transformer is built on: every op below records how to push gradients
 * backward through it, so training is real backpropagation, not a stub.
 */

class Tensor {
  constructor(data, rows, cols, children = [], label = '') {
    this.data = data instanceof Float64Array ? data : Float64Array.from(data);
    this.rows = rows;
    this.cols = cols;
    this.grad = new Float64Array(rows * cols);
    this._backward = () => {};
    this._prev = children;
    this.label = label;
  }

  static zeros(rows, cols) {
    return new Tensor(new Float64Array(rows * cols), rows, cols);
  }

  static fromArray2D(arr2d) {
    const rows = arr2d.length, cols = arr2d[0].length;
    const data = new Float64Array(rows * cols);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) data[i * cols + j] = arr2d[i][j];
    return new Tensor(data, rows, cols);
  }

  static randn(rows, cols, scale = 1) {
    const data = new Float64Array(rows * cols);
    for (let i = 0; i < data.length; i++) {
      // Box-Muller
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      data[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
    }
    return new Tensor(data, rows, cols);
  }

  get(r, c) { return this.data[r * this.cols + c]; }
  set(r, c, v) { this.data[r * this.cols + c] = v; }
  addGrad(r, c, v) { this.grad[r * this.cols + c] += v; }
  zeroGrad() { this.grad.fill(0); }
  toArray2D() {
    const out = [];
    for (let i = 0; i < this.rows; i++) {
      const row = [];
      for (let j = 0; j < this.cols; j++) row.push(this.get(i, j));
      out.push(row);
    }
    return out;
  }
}

// ---- Topological sort + backward pass over the recorded graph ----

// Propagates gradients backward starting from whatever is already in
// `rootTensor.grad` (caller must seed it first). Use this when the root
// isn't a plain scalar loss — e.g. per-position logits where the gradient
// was computed manually (as with fused softmax+cross-entropy).
function backwardFrom(rootTensor) {
  const topo = [];
  const visited = new Set();
  function build(t) {
    if (visited.has(t)) return;
    visited.add(t);
    for (const child of t._prev) build(child);
    topo.push(t);
  }
  build(rootTensor);
  for (let i = topo.length - 1; i >= 0; i--) topo[i]._backward();
}

// Convenience for the common case: a true scalar (1x1) loss tensor.
function backward(lossTensor) {
  lossTensor.grad.fill(1); // dLoss/dLoss = 1
  backwardFrom(lossTensor);
}

// ---- Ops ----

function matmul(A, B) {
  const { rows: n, cols: k } = A;
  const k2 = B.rows, m = B.cols;
  if (k !== k2) throw new Error(`matmul shape mismatch: [${n}x${k}] x [${k2}x${m}]`);
  const out = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const a = A.data[i * k + p];
      if (a === 0) continue;
      for (let j = 0; j < m; j++) {
        out[i * m + j] += a * B.data[p * m + j];
      }
    }
  }
  const result = new Tensor(out, n, m, [A, B], 'matmul');
  result._backward = () => {
    // dA = dOut @ B^T ; dB = A^T @ dOut
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const g = result.grad[i * m + j];
        if (g === 0) continue;
        for (let p = 0; p < k; p++) {
          A.grad[i * k + p] += g * B.data[p * m + j];
          B.grad[p * m + j] += g * A.data[i * k + p];
        }
      }
    }
  };
  return result;
}

function addBias(A, bias) {
  // bias: Tensor [1, cols], broadcast-added to every row of A
  const { rows: n, cols: m } = A;
  const out = new Float64Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out[i * m + j] = A.data[i * m + j] + bias.data[j];
  const result = new Tensor(out, n, m, [A, bias], 'addBias');
  result._backward = () => {
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const g = result.grad[i * m + j];
      A.grad[i * m + j] += g;
      bias.grad[j] += g;
    }
  };
  return result;
}

function addElem(A, B) {
  const out = new Float64Array(A.data.length);
  for (let i = 0; i < out.length; i++) out[i] = A.data[i] + B.data[i];
  const result = new Tensor(out, A.rows, A.cols, [A, B], 'addElem');
  result._backward = () => {
    for (let i = 0; i < out.length; i++) { A.grad[i] += result.grad[i]; B.grad[i] += result.grad[i]; }
  };
  return result;
}

function addConst(A, constData) {
  // constData: plain Float64Array/array, same shape as A, no gradient (e.g. causal mask)
  const out = new Float64Array(A.data.length);
  for (let i = 0; i < out.length; i++) out[i] = A.data[i] + constData[i];
  const result = new Tensor(out, A.rows, A.cols, [A], 'addConst');
  result._backward = () => { for (let i = 0; i < out.length; i++) A.grad[i] += result.grad[i]; };
  return result;
}

function scale(A, s) {
  const out = new Float64Array(A.data.length);
  for (let i = 0; i < out.length; i++) out[i] = A.data[i] * s;
  const result = new Tensor(out, A.rows, A.cols, [A], 'scale');
  result._backward = () => { for (let i = 0; i < out.length; i++) A.grad[i] += result.grad[i] * s; };
  return result;
}

function transpose(A) {
  const { rows: n, cols: m } = A;
  const out = new Float64Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out[j * n + i] = A.data[i * m + j];
  const result = new Tensor(out, m, n, [A], 'transpose');
  result._backward = () => {
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) A.grad[i * m + j] += result.grad[j * n + i];
  };
  return result;
}

function reluElem(A) {
  const out = new Float64Array(A.data.length);
  for (let i = 0; i < out.length; i++) out[i] = A.data[i] > 0 ? A.data[i] : 0;
  const result = new Tensor(out, A.rows, A.cols, [A], 'relu');
  result._backward = () => {
    for (let i = 0; i < out.length; i++) A.grad[i] += (A.data[i] > 0 ? 1 : 0) * result.grad[i];
  };
  return result;
}

function softmaxRows(A) {
  const { rows: n, cols: m } = A;
  const out = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    let max = -Infinity;
    for (let j = 0; j < m; j++) max = Math.max(max, A.data[i * m + j]);
    let sum = 0;
    for (let j = 0; j < m; j++) {
      const e = Math.exp(A.data[i * m + j] - max);
      out[i * m + j] = e;
      sum += e;
    }
    for (let j = 0; j < m; j++) out[i * m + j] /= (sum || 1e-12);
  }
  const result = new Tensor(out, n, m, [A], 'softmax');
  result._backward = () => {
    for (let i = 0; i < n; i++) {
      let dot = 0;
      for (let j = 0; j < m; j++) dot += result.grad[i * m + j] * out[i * m + j];
      for (let j = 0; j < m; j++) {
        A.grad[i * m + j] += out[i * m + j] * (result.grad[i * m + j] - dot);
      }
    }
  };
  return result;
}

function layerNormRows(A, gamma, beta, eps = 1e-5) {
  const { rows: n, cols: d } = A;
  const out = new Float64Array(n * d);
  const xhat = new Float64Array(n * d);
  const invstd = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let mean = 0;
    for (let j = 0; j < d; j++) mean += A.data[i * d + j];
    mean /= d;
    let vari = 0;
    for (let j = 0; j < d; j++) { const diff = A.data[i * d + j] - mean; vari += diff * diff; }
    vari /= d;
    const is = 1 / Math.sqrt(vari + eps);
    invstd[i] = is;
    for (let j = 0; j < d; j++) {
      const xh = (A.data[i * d + j] - mean) * is;
      xhat[i * d + j] = xh;
      out[i * d + j] = xh * gamma.data[j] + beta.data[j];
    }
  }
  const result = new Tensor(out, n, d, [A, gamma, beta], 'layerNorm');
  result._backward = () => {
    for (let i = 0; i < n; i++) {
      let sumDxhat = 0, sumDxhatXhat = 0;
      for (let j = 0; j < d; j++) {
        const dY = result.grad[i * d + j];
        gamma.grad[j] += dY * xhat[i * d + j];
        beta.grad[j] += dY;
        const dxhat = dY * gamma.data[j];
        sumDxhat += dxhat;
        sumDxhatXhat += dxhat * xhat[i * d + j];
      }
      const is = invstd[i];
      for (let j = 0; j < d; j++) {
        const dY = result.grad[i * d + j];
        const dxhat = dY * gamma.data[j];
        const dx = (d * dxhat - sumDxhat - xhat[i * d + j] * sumDxhatXhat) * is / d;
        A.grad[i * d + j] += dx;
      }
    }
  };
  return result;
}

function embedLookup(table, indices) {
  // table: Tensor [V, d]; indices: array of length T -> output Tensor [T, d]
  const d = table.cols;
  const T = indices.length;
  const out = new Float64Array(T * d);
  for (let t = 0; t < T; t++) {
    const row = indices[t];
    for (let j = 0; j < d; j++) out[t * d + j] = table.data[row * d + j];
  }
  const result = new Tensor(out, T, d, [table], 'embed');
  result._backward = () => {
    for (let t = 0; t < T; t++) {
      const row = indices[t];
      for (let j = 0; j < d; j++) table.grad[row * d + j] += result.grad[t * d + j];
    }
  };
  return result;
}

function sliceCols(A, start, len) {
  const { rows: n, cols: m } = A;
  const out = new Float64Array(n * len);
  for (let i = 0; i < n; i++) for (let j = 0; j < len; j++) out[i * len + j] = A.data[i * m + start + j];
  const result = new Tensor(out, n, len, [A], 'sliceCols');
  result._backward = () => {
    for (let i = 0; i < n; i++) for (let j = 0; j < len; j++) A.grad[i * m + start + j] += result.grad[i * len + j];
  };
  return result;
}

function concatCols(tensors) {
  const n = tensors[0].rows;
  const totalCols = tensors.reduce((s, t) => s + t.cols, 0);
  const out = new Float64Array(n * totalCols);
  let colOffset = 0;
  for (const t of tensors) {
    for (let i = 0; i < n; i++) for (let j = 0; j < t.cols; j++) out[i * totalCols + colOffset + j] = t.data[i * t.cols + j];
    colOffset += t.cols;
  }
  const result = new Tensor(out, n, totalCols, tensors, 'concatCols');
  result._backward = () => {
    let off = 0;
    for (const t of tensors) {
      for (let i = 0; i < n; i++) for (let j = 0; j < t.cols; j++) t.grad[i * t.cols + j] += result.grad[i * totalCols + off + j];
      off += t.cols;
    }
  };
  return result;
}

// Fused softmax + cross-entropy over a single row of logits (numerically stable).
// Returns { loss: number, dLogitsRow: Float64Array } — used inline by the model
// so we don't need to build a full softmax node for the output layer.
function softmaxCrossEntropyRow(logitsRow, targetIdx) {
  const m = logitsRow.length;
  let max = -Infinity;
  for (let j = 0; j < m; j++) max = Math.max(max, logitsRow[j]);
  let sum = 0;
  const probs = new Float64Array(m);
  for (let j = 0; j < m; j++) { const e = Math.exp(logitsRow[j] - max); probs[j] = e; sum += e; }
  for (let j = 0; j < m; j++) probs[j] /= (sum || 1e-12);
  const loss = -Math.log(Math.max(probs[targetIdx], 1e-12));
  const dLogits = new Float64Array(m);
  for (let j = 0; j < m; j++) dLogits[j] = probs[j] - (j === targetIdx ? 1 : 0);
  return { loss, probs, dLogits };
}

module.exports = {
  Tensor, backward, backwardFrom, matmul, addBias, addElem, addConst, scale, transpose,
  reluElem, softmaxRows, layerNormRows, embedLookup, sliceCols, concatCols,
  softmaxCrossEntropyRow
};
