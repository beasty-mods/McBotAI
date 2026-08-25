'use strict';
/**
 * Adam optimizer over a list of Tensor parameters (from tensor.js).
 * Includes global-norm gradient clipping, which matters a lot here since
 * we're training on tiny, noisy batches (single short chat lines) rather
 * than large shuffled datasets.
 */
class AdamOptimizer {
  constructor(params, opts = {}) {
    this.params = params;
    this.lr = opts.lr || 0.01;
    this.beta1 = opts.beta1 || 0.9;
    this.beta2 = opts.beta2 || 0.98;
    this.eps = opts.eps || 1e-9;
    this.clipNorm = opts.clipNorm || 3.0;
    this.t = 0;
    this.m = params.map(p => new Float64Array(p.data.length));
    this.v = params.map(p => new Float64Array(p.data.length));
  }

  _clipGradients() {
    let totalSq = 0;
    for (const p of this.params) for (const g of p.grad) totalSq += g * g;
    const norm = Math.sqrt(totalSq);
    if (norm > this.clipNorm && norm > 0) {
      const scale = this.clipNorm / norm;
      for (const p of this.params) for (let i = 0; i < p.grad.length; i++) p.grad[i] *= scale;
    }
    return norm;
  }

  step() {
    this._clipGradients();
    this.t++;
    const b1 = this.beta1, b2 = this.beta2;
    const b1t = 1 - Math.pow(b1, this.t);
    const b2t = 1 - Math.pow(b2, this.t);
    for (let pi = 0; pi < this.params.length; pi++) {
      const p = this.params[pi], m = this.m[pi], v = this.v[pi];
      for (let i = 0; i < p.data.length; i++) {
        const g = p.grad[i];
        m[i] = b1 * m[i] + (1 - b1) * g;
        v[i] = b2 * v[i] + (1 - b2) * g * g;
        const mHat = m[i] / b1t;
        const vHat = v[i] / b2t;
        p.data[i] -= this.lr * mHat / (Math.sqrt(vHat) + this.eps);
      }
    }
  }

  toJSON() {
    return { t: this.t, m: this.m.map(a => Array.from(a)), v: this.v.map(a => Array.from(a)) };
  }

  loadFromJSON(obj) {
    if (!obj) return;
    this.t = obj.t || 0;
    if (obj.m && obj.m.length === this.m.length) {
      for (let i = 0; i < this.m.length; i++) this.m[i].set(Float64Array.from(obj.m[i]));
    }
    if (obj.v && obj.v.length === this.v.length) {
      for (let i = 0; i < this.v.length; i++) this.v[i].set(Float64Array.from(obj.v[i]));
    }
  }
}

module.exports = { AdamOptimizer };
