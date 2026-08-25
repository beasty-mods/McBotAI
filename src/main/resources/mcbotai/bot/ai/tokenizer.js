'use strict';
/**
 * A small from-scratch byte-pair-encoding (BPE) tokenizer — the same
 * family of algorithm real subword tokenizers (GPT-2's, etc.) use, just
 * trained on a much smaller corpus and vocabulary to match this project's
 * tiny model.
 *
 * Why subword instead of character-level: with character-level encoding,
 * the model's fixed context window (128 positions) held 128 characters —
 * a couple of short sentences. With subword tokens, common words and
 * fragments become single tokens, so the same 128-token window covers
 * meaningfully more actual conversation, and the model spends its
 * capacity learning word-level patterns instead of re-deriving spelling
 * from scratch every time.
 *
 * How it works: text is split on whitespace into words (whitespace itself
 * stays as its own single-character tokens, so merges never cross word
 * boundaries — this is standard practice and keeps decoding trivial:
 * concatenate the token strings back together). Training starts from
 * individual characters as the base vocabulary and repeatedly merges
 * whichever adjacent pair of symbols is most frequent across the corpus,
 * recording each merge in the order it was learned. Encoding new text
 * applies those same merges, in that same learned order, to get from
 * characters up to the largest known subword pieces.
 */

const WORD_SPLIT_RE = /(\s+)/; // keep whitespace as its own tokens when splitting

function splitIntoWords(text) {
  return text.split(WORD_SPLIT_RE).filter(s => s.length > 0);
}

function wordToSymbols(word) {
  return Array.from(word); // start as individual characters
}

function getPairCounts(wordFreqs) {
  const counts = new Map();
  for (const [symbols, freq] of wordFreqs.values()) {
    for (let i = 0; i < symbols.length - 1; i++) {
      const key = symbols[i] + '\u0000' + symbols[i + 1];
      counts.set(key, (counts.get(key) || 0) + freq);
    }
  }
  return counts;
}

function mergeSymbolsInWord(symbols, a, b) {
  const out = [];
  let i = 0;
  while (i < symbols.length) {
    if (i < symbols.length - 1 && symbols[i] === a && symbols[i + 1] === b) {
      out.push(a + b);
      i += 2;
    } else {
      out.push(symbols[i]);
      i += 1;
    }
  }
  return out;
}

// Always available as single-character tokens, regardless of what the
// training corpus happens to contain — this is what guarantees lossless
// round-trip encode/decode for any realistic chat input (Minecraft chat
// is printable ASCII), rather than leaning on a lossy fallback token.
const BASE_CHARS = [];
for (let c = 32; c <= 126; c++) BASE_CHARS.push(String.fromCharCode(c));
BASE_CHARS.push('\n');

/**
 * Trains BPE merges on a corpus. Returns { vocab, merges } where vocab is
 * an array of token strings (index = token id) and merges is the ordered
 * list of [left, right] pairs learned, in the order to apply them.
 */
function trainBPE(corpusText, targetVocabSize, opts = {}) {
  const minPairFreq = opts.minPairFreq || 2;

  const words = splitIntoWords(corpusText);

  // Count unique words and their frequency, each starting as a list of
  // single-character symbols — the standard BPE working representation.
  const wordFreqs = new Map(); // word string -> [symbols[], freq]
  for (const w of words) {
    if (wordFreqs.has(w)) {
      wordFreqs.get(w)[1]++;
    } else {
      wordFreqs.set(w, [wordToSymbols(w), 1]);
    }
  }

  // Base vocabulary is the full fixed character set (see BASE_CHARS above),
  // not just characters seen in this particular corpus — so any printable
  // ASCII character always has a real token, even one the corpus never
  // happened to use (e.g. a rare punctuation mark, or an uppercase letter
  // if the corpus was all lowercase).
  const vocabSet = new Set(BASE_CHARS);
  const merges = [];

  while (vocabSet.size < targetVocabSize) {
    const pairCounts = getPairCounts(wordFreqs);
    if (pairCounts.size === 0) break;

    let bestKey = null, bestCount = 0;
    for (const [key, count] of pairCounts) {
      if (count > bestCount) { bestCount = count; bestKey = key; }
    }
    if (bestCount < minPairFreq) break; // no more merges worth learning

    const [a, b] = bestKey.split('\u0000');
    const merged = a + b;
    merges.push([a, b]);
    vocabSet.add(merged);

    for (const entry of wordFreqs.values()) {
      entry[0] = mergeSymbolsInWord(entry[0], a, b);
    }
  }

  const vocab = Array.from(vocabSet).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return { vocab, merges };
}

class BPETokenizer {
  constructor({ vocab, merges }) {
    this.vocab = vocab;
    this.merges = merges;
    this.tokenToId = new Map(vocab.map((t, i) => [t, i]));
    this.mergeRank = new Map(merges.map(([a, b], i) => [a + '\u0000' + b, i]));
    // A space is always in the base vocabulary, so this is a real,
    // harmless substitution for the vanishingly rare case of a character
    // completely outside printable ASCII/newline — not a lossy sentinel
    // token that would corrupt decoded output.
    this.fallbackId = this.tokenToId.get(' ');
  }

  _encodeWord(word) {
    let symbols = wordToSymbols(word);
    if (symbols.length <= 1) return symbols;

    // Repeatedly apply the highest-priority (earliest-learned) applicable
    // merge until none apply — this is the standard BPE encoding loop,
    // mirroring how training itself proceeded merge-by-merge.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let bestRank = Infinity, bestIdx = -1;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.mergeRank.get(symbols[i] + '\u0000' + symbols[i + 1]);
        if (rank !== undefined && rank < bestRank) { bestRank = rank; bestIdx = i; }
      }
      if (bestIdx === -1) break;
      symbols = [
        ...symbols.slice(0, bestIdx),
        symbols[bestIdx] + symbols[bestIdx + 1],
        ...symbols.slice(bestIdx + 2)
      ];
    }
    return symbols;
  }

  encode(text) {
    const ids = [];
    for (const word of splitIntoWords(text)) {
      for (const piece of this._encodeWord(word)) {
        const id = this.tokenToId.get(piece);
        if (id !== undefined) {
          ids.push(id);
        } else {
          // Whole piece unknown (shouldn't happen once merges are
          // applied down to individual characters, but stay safe) —
          // fall back character by character.
          for (const ch of piece) {
            ids.push(this.tokenToId.has(ch) ? this.tokenToId.get(ch) : this.fallbackId);
          }
        }
      }
    }
    return ids;
  }

  decode(ids) {
    return ids.map(id => this.vocab[id] ?? '').join('');
  }

  get vocabSize() { return this.vocab.length; }

  toJSON() {
    return { vocab: this.vocab, merges: this.merges };
  }

  static fromJSON(obj) {
    return new BPETokenizer(obj);
  }
}

module.exports = { trainBPE, BPETokenizer, BASE_CHARS };
