'use strict';
const fs = require('fs');
const path = require('path');
const { MiniTransformer } = require('./model');
const { AdamOptimizer } = require('./optimizer');
const { trainBPE, BPETokenizer, BASE_CHARS } = require('./tokenizer');

const TOKENIZER_VOCAB_SIZE = 1000; // picked after testing 600/1000/1400 — good compression vs. training-data size tradeoff
const MODEL_CONFIG = { dModel: 32, nHeads: 2, nLayers: 2, dFF: 64, maxLen: 128 };
const MAX_BUFFER_CHARS = 6000;
const TRAIN_STRIDE_CHARS = 24; // train roughly every N new characters of chat
const SAVE_EVERY_STEPS = 15;
const REPLY_COOLDOWN_MS = 4000;
const AVG_CHARS_PER_TOKEN_OVERSELECT = 6; // generous upper bound used when sampling a text window to encode

function loadOrBuildTokenizer(config) {
  const tokenizerPath = path.resolve(config.tokenizerPath || './tokenizer.json');

  if (fs.existsSync(tokenizerPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(tokenizerPath, 'utf8'));
      console.log(`[ai] Loaded tokenizer from ${tokenizerPath} (${raw.vocab.length} tokens).`);
      return BPETokenizer.fromJSON(raw);
    } catch (e) {
      console.log(`[ai] Could not load tokenizer (${e.message}) — retraining a fresh one.`);
    }
  }

  if (config.pretrainFile) {
    const pretrainPath = path.isAbsolute(config.pretrainFile) ? config.pretrainFile : path.resolve(config.pretrainFile);
    if (fs.existsSync(pretrainPath)) {
      console.log(`[ai] No tokenizer found — training one from ${pretrainPath}...`);
      const corpus = fs.readFileSync(pretrainPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const { vocab, merges } = trainBPE(corpus, TOKENIZER_VOCAB_SIZE);
      const tokenizer = new BPETokenizer({ vocab, merges });
      try {
        fs.writeFileSync(tokenizerPath, JSON.stringify(tokenizer.toJSON()));
        console.log(`[ai] Trained and saved a ${tokenizer.vocabSize}-token tokenizer to ${tokenizerPath}.`);
      } catch (e) {
        console.log(`[ai] Trained a tokenizer but couldn't save it (${e.message}) — will retrain each run.`);
      }
      return tokenizer;
    }
  }

  console.log('[ai] No tokenizer file and no training corpus available — falling back to a minimal character-only tokenizer.');
  return new BPETokenizer({ vocab: BASE_CHARS.slice(), merges: [] });
}

class ChatAI {
  constructor(config) {
    this.memoryPath = path.resolve(config.aiMemoryPath || './ai_memory.json');
    this.tokenizer = loadOrBuildTokenizer(config);
    this.model = new MiniTransformer(this.tokenizer.vocabSize, MODEL_CONFIG);
    this.optimizer = new AdamOptimizer(this.model.params, { lr: 0.015, clipNorm: 3.0 });
    this.stepCount = 0;
    this.lastLoss = null;
    this.buffer = '';
    this.lastReplyTs = 0;
    this._charsSinceTrain = 0;
    this._dirty = false;

    this._load();
  }

  // Re-reads the memory file and applies it to the live model in place —
  // used after the background pretraining worker (see pretrain-worker.js)
  // finishes a session, so freshly-learned weights take effect immediately
  // without needing to restart the bot.
  reload() {
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.memoryPath)) {
      console.log(`[ai] No memory file at ${this.memoryPath} — starting with a fresh, untrained model.`);
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
      // If this file was saved under a different tokenizer/vocab (e.g. the
      // old character-level encoding), the architecture genuinely won't
      // match — loadFromJSON below throws clearly in that case, and we
      // treat it the same as "no memory file", starting fresh rather than
      // crashing. This is expected the first time you run the new
      // tokenizer version against an old save.
      this.model.loadFromJSON(raw.model);
      this.optimizer.loadFromJSON(raw.optimizer);
      this.stepCount = raw.stepCount || 0;
      console.log(`[ai] Loaded memory from ${this.memoryPath} (${this.stepCount} training steps so far).`);
    } catch (e) {
      console.log(`[ai] Could not load memory file (${e.message}) — starting fresh instead.`);
    }
  }

  save() {
    const tmpPath = this.memoryPath + '.tmp';
    const payload = {
      savedAt: new Date().toISOString(),
      stepCount: this.stepCount,
      model: this.model.toJSON(),
      optimizer: this.optimizer.toJSON()
    };
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload));
      fs.renameSync(tmpPath, this.memoryPath); // atomic on POSIX filesystems
      this._dirty = false;
      return true;
    } catch (e) {
      console.log(`[ai] Save failed: ${e.message}`);
      return false;
    }
  }

  // Samples a maxLen-token window from somewhere within `text`. Since
  // token count isn't the same as character count anymore (that's the
  // whole point of subword tokens), this over-selects a generous chunk of
  // characters, encodes it, then picks a random maxLen-token slice from
  // the result — rather than naively slicing characters and hoping the
  // token count works out.
  _sampleTokenWindow(text, maxLen) {
    const overselectChars = Math.min(text.length, maxLen * AVG_CHARS_PER_TOKEN_OVERSELECT);
    const maxStartChar = text.length - overselectChars;
    const startChar = maxStartChar > 0 ? Math.floor(Math.random() * (maxStartChar + 1)) : 0;
    const substring = text.slice(startChar, startChar + overselectChars);
    const allTokens = this.tokenizer.encode(substring);
    if (allTokens.length <= maxLen) return allTokens;
    const maxTokenStart = allTokens.length - maxLen;
    const tokenStart = Math.floor(Math.random() * (maxTokenStart + 1));
    return allTokens.slice(tokenStart, tokenStart + maxLen);
  }

  // ---- Offline pretraining on arbitrary text (used by pretrain.js) ----
  // Deliberately separate from _trainStep()/ingest(): this samples from
  // whatever text you pass in directly, not the live chat buffer, so a
  // one-time bulk pretraining pass doesn't disturb ongoing chat learning.
  pretrainStep(text) {
    const tokens = this._sampleTokenWindow(text, MODEL_CONFIG.maxLen);
    if (tokens.length < 2) return null;
    try {
      const loss = this.model.lossAndBackward(tokens);
      if (loss === null || Number.isNaN(loss)) return null;
      this.optimizer.step();
      this.stepCount++;
      this.lastLoss = loss;
      this._dirty = true;
      return loss;
    } catch (e) {
      return null;
    }
  }

  // ---- Live training from chat text ----
  ingest(line) {
    this.buffer += line;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER_CHARS);
    }
    this._charsSinceTrain += line.length;
    if (this._charsSinceTrain >= TRAIN_STRIDE_CHARS && this.buffer.length >= 8) {
      this._charsSinceTrain = 0;
      this._trainStep();
    }
  }

  _trainStep() {
    const tokens = this._sampleTokenWindow(this.buffer, MODEL_CONFIG.maxLen);
    if (tokens.length < 2) return;

    try {
      const loss = this.model.lossAndBackward(tokens);
      if (loss === null || Number.isNaN(loss)) return;
      this.optimizer.step();
      this.stepCount++;
      this.lastLoss = loss;
      this._dirty = true;
      if (this.stepCount % SAVE_EVERY_STEPS === 0) this.save();
    } catch (e) {
      console.log(`[ai] Training step failed: ${e.message}`);
    }
  }

  // ---- Generation ----
  canReplyNow() {
    return Date.now() - this.lastReplyTs >= REPLY_COOLDOWN_MS;
  }

  reply(promptText, maxNewChars = 50, temperature = 0.85) {
    this.lastReplyTs = Date.now();
    const promptTokens = this.tokenizer.encode(promptText).slice(-MODEL_CONFIG.maxLen);
    // maxNewChars is approximate now (subword tokens vary in length) but
    // kept as the parameter name since callers think in terms of reply
    // length, not token count — divide by a rough average token length
    // for a comparable-length ceiling.
    const maxNewTokens = Math.max(4, Math.round(maxNewChars / 2.5));
    const generated = this.model.generate(promptTokens, maxNewTokens, temperature, 8);
    let text = this.tokenizer.decode(generated);
    const newlineIdx = text.indexOf('\n');
    if (newlineIdx !== -1) text = text.slice(0, newlineIdx);
    return text.trim();
  }

  status() {
    return {
      stepCount: this.stepCount,
      lastLoss: this.lastLoss,
      bufferChars: this.buffer.length,
      vocabSize: this.tokenizer.vocabSize,
      paramCount: this.model.paramCount(),
      memoryPath: this.memoryPath
    };
  }
}

module.exports = { ChatAI };
