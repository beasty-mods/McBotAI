'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./tensor');
const { AdamOptimizer } = require('./optimizer');
const { ACTIONS, FEATURE_DIM } = require('./state');

/**
 * A small feedforward policy network: state features -> action logits.
 * Two training modes feed the same weights:
 *   - trainImitation: supervised step nudging the network toward whatever
 *     action the master was observed taking in a given state.
 *   - trainReinforce: REINFORCE policy-gradient step nudging the network
 *     toward (or away from) an action the bot itself took, scaled by the
 *     reward that action turned out to earn.
 * This is a lightweight contextual-bandit-style learner, not deep RL with
 * a value function/replay buffer — appropriate for the tiny amount of
 * signal a single Minecraft session generates.
 */
class PolicyNet {
  constructor(memoryPath, opts = {}) {
    this.memoryPath = path.resolve(memoryPath);
    this.hidden = opts.hidden || 24;
    this.nActions = ACTIONS.length;
    this.imitationSteps = 0;
    this.reinforceSteps = 0;
    this.actionCounts = new Array(this.nActions).fill(0);
    this.rewardHistory = [];

    this._buildParams();
    this.optimizer = new AdamOptimizer(this.params, { lr: 0.02, clipNorm: 3.0 });
    this._load();
  }

  _buildParams() {
    const d = FEATURE_DIM, h = this.hidden, a = this.nActions;
    this.params = [];
    const p = (r, c, s) => { const t = T.Tensor.randn(r, c, s); this.params.push(t); return t; };
    const z = (r, c) => { const t = T.Tensor.zeros(r, c); this.params.push(t); return t; };
    this.W1 = p(d, h, 1 / Math.sqrt(d));
    this.b1 = z(1, h);
    this.W2 = p(h, a, 1 / Math.sqrt(h));
    this.b2 = z(1, a);
  }

  _forwardTensor(featuresArray) {
    const x = new T.Tensor(Float64Array.from(featuresArray), 1, FEATURE_DIM);
    const h1 = T.reluElem(T.addBias(T.matmul(x, this.W1), this.b1));
    const logits = T.addBias(T.matmul(h1, this.W2), this.b2); // [1, nActions]
    return logits;
  }

  _softmax1D(row) {
    let max = -Infinity;
    for (const v of row) max = Math.max(max, v);
    const exps = Array.from(row).map(v => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(v => v / (sum || 1e-12));
  }

  /** Choose an action: epsilon-random exploration, otherwise sampled from the softmax policy. */
  act(featuresArray, epsilon = 0.1) {
    const logits = this._forwardTensor(featuresArray);
    const probs = this._softmax1D(logits.data);
    let idx;
    if (Math.random() < epsilon) {
      idx = Math.floor(Math.random() * this.nActions);
    } else {
      let r = Math.random(), acc = 0;
      idx = probs.length - 1;
      for (let i = 0; i < probs.length; i++) { acc += probs[i]; if (r <= acc) { idx = i; break; } }
    }
    return { actionIdx: idx, actionName: ACTIONS[idx], probs };
  }

  trainImitation(featuresArray, actionIdx) {
    for (const p of this.params) p.zeroGrad();
    const logits = this._forwardTensor(featuresArray);
    const { loss, dLogits } = T.softmaxCrossEntropyRow(logits.data, actionIdx);
    for (let j = 0; j < this.nActions; j++) logits.grad[j] += dLogits[j];
    T.backwardFrom(logits);
    this.optimizer.step();
    this.imitationSteps++;
    this.actionCounts[actionIdx]++;
    return loss;
  }

  trainReinforce(featuresArray, actionIdx, reward) {
    for (const p of this.params) p.zeroGrad();
    const logits = this._forwardTensor(featuresArray);
    // Reuse the softmax+CE gradient (probs - onehot) and scale by reward —
    // this is exactly the REINFORCE gradient for a categorical policy.
    const { dLogits } = T.softmaxCrossEntropyRow(logits.data, actionIdx);
    for (let j = 0; j < this.nActions; j++) logits.grad[j] += dLogits[j] * reward;
    T.backwardFrom(logits);
    this.optimizer.step();
    this.reinforceSteps++;
    this.actionCounts[actionIdx]++;
    this.rewardHistory.push(reward);
    if (this.rewardHistory.length > 200) this.rewardHistory.shift();
  }

  avgRecentReward() {
    if (this.rewardHistory.length === 0) return null;
    return this.rewardHistory.reduce((a, b) => a + b, 0) / this.rewardHistory.length;
  }

  save() {
    const tmp = this.memoryPath + '.tmp';
    const payload = {
      savedAt: new Date().toISOString(),
      imitationSteps: this.imitationSteps,
      reinforceSteps: this.reinforceSteps,
      actionCounts: this.actionCounts,
      rewardHistory: this.rewardHistory,
      params: this.params.map(p => Array.from(p.data)),
      optimizer: this.optimizer.toJSON()
    };
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.memoryPath);
      return true;
    } catch (e) {
      console.log(`[policy] Save failed: ${e.message}`);
      return false;
    }
  }

  _load() {
    if (!fs.existsSync(this.memoryPath)) {
      console.log(`[policy] No policy memory at ${this.memoryPath} — starting fresh.`);
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
      if (raw.params.length !== this.params.length) throw new Error('param count mismatch');
      for (let i = 0; i < this.params.length; i++) this.params[i].data.set(Float64Array.from(raw.params[i]));
      this.optimizer.loadFromJSON(raw.optimizer);
      this.imitationSteps = raw.imitationSteps || 0;
      this.reinforceSteps = raw.reinforceSteps || 0;
      this.actionCounts = raw.actionCounts || this.actionCounts;
      this.rewardHistory = raw.rewardHistory || [];
      console.log(`[policy] Loaded policy memory (${this.imitationSteps} imitation + ${this.reinforceSteps} reinforce steps so far).`);
    } catch (e) {
      console.log(`[policy] Could not load policy memory (${e.message}) — starting fresh.`);
    }
  }

  status() {
    return {
      imitationSteps: this.imitationSteps,
      reinforceSteps: this.reinforceSteps,
      actionCounts: Object.fromEntries(ACTIONS.map((a, i) => [a, this.actionCounts[i]])),
      avgRecentReward: this.avgRecentReward(),
      paramCount: this.params.reduce((s, p) => s + p.data.length, 0)
    };
  }
}

module.exports = { PolicyNet };
