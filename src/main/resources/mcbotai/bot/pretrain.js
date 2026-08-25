'use strict';
/**
 * Offline bulk pretraining for the chat model, run from the terminal —
 * NOT part of the live bot process. Running thousands of training steps
 * synchronously inside the live bot would freeze it (Node is
 * single-threaded and each step is a real forward+backward pass), so this
 * has to happen as a separate one-time pass before you start the bot.
 *
 * Usage:
 *   node pretrain.js [textFile] [steps]
 *   npm run pretrain             (uses config.json's pretrainFile, 6000 steps)
 *
 * It loads (or creates) the same ai_memory.json the live bot uses, trains
 * on random windows sampled from the given text file, checkpoints
 * periodically, and saves at the end — so it's safe to Ctrl+C partway
 * through and resume later, and the live bot picks up right where this
 * left off next time you run `npm start`.
 */
const fs = require('fs');
const path = require('path');
const { ChatAI } = require('./ai/chatbrain');

const config = require('./config.json');

const filePath = path.resolve(process.argv[2] || config.pretrainFile || './training-data/data.txt');
const steps = parseInt(process.argv[3], 10) || 6000;
const SAVE_EVERY = 1000;
const LOG_EVERY = 200;

if (!fs.existsSync(filePath)) {
  console.error(`Training file not found: ${filePath}`);
  console.error(`Usage: node pretrain.js [textFile] [steps]`);
  process.exit(1);
}

let text = fs.readFileSync(filePath, 'utf8');
text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); // normalize line endings to what the tokenizer expects

console.log(`Loaded ${text.length} characters from ${filePath}`);
if (text.length < 200) {
  console.warn('Warning: this is a very small amount of text — pretraining will have limited effect.');
}

const ai = new ChatAI(config);
console.log(`Starting from step ${ai.stepCount} (loss ${ai.lastLoss !== null ? ai.lastLoss.toFixed(4) : 'n/a'}).`);
console.log(`Training for ${steps} more steps...\n`);

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
});

const startTime = Date.now();
for (let i = 0; i < steps; i++) {
  if (interrupted) {
    console.log('\nInterrupted — saving progress before exit...');
    break;
  }
  ai.pretrainStep(text);

  if ((i + 1) % LOG_EVERY === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`step ${ai.stepCount}  loss=${ai.lastLoss !== null ? ai.lastLoss.toFixed(4) : 'n/a'}  (${elapsed}s elapsed)`);
  }
  if ((i + 1) % SAVE_EVERY === 0) {
    ai.save();
    console.log('  (checkpoint saved)');
  }
}

ai.save();
console.log(`\nDone. Final loss: ${ai.lastLoss !== null ? ai.lastLoss.toFixed(4) : 'n/a'}`);
console.log(`Saved to ${ai.memoryPath} — the live bot will load this automatically next time you run it.`);
process.exit(0);
