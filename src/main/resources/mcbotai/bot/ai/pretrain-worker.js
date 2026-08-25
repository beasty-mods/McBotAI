'use strict';
/**
 * Runs in a worker_threads.Worker (spawned by index.js at startup), not on
 * the main thread — so even though this does real synchronous forward/
 * backward passes (the same CPU-heavy work pretrain.js does offline), it
 * never blocks the main thread's event loop, which is what actually
 * matters for keeping the bot responsive.
 *
 * This intentionally runs to completion and exits BEFORE the main thread
 * creates its own live ChatAI instance and starts connecting to
 * Minecraft — not because the worker itself would block anything (it
 * wouldn't, it's a separate thread), but to avoid a real race condition:
 * if the live bot's ChatAI were already running and autosaving to the
 * same ai_memory.json file while this worker is also writing to it
 * concurrently, whichever save happened to land last would silently
 * clobber the other's progress. Finishing this pass first, then having
 * the main thread's ChatAI load the result, sidesteps that entirely.
 */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { ChatAI } = require('./chatbrain');

function send(message) {
  if (parentPort) parentPort.postMessage(message);
}

async function run() {
  const { config, steps } = workerData;

  if (!config.pretrainFile || !fs.existsSync(config.pretrainFile)) {
    send({ type: 'done', trained: 0, reason: 'no pretrain file configured' });
    return;
  }
  if (!steps || steps <= 0) {
    send({ type: 'done', trained: 0, reason: 'pretrainOnStartupSteps is 0' });
    return;
  }

  let text = fs.readFileSync(config.pretrainFile, 'utf8');
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.length < 200) {
    send({ type: 'done', trained: 0, reason: 'training file too small' });
    return;
  }

  const ai = new ChatAI(config);
  const startStep = ai.stepCount;

  for (let i = 0; i < steps; i++) {
    ai.pretrainStep(text);
    if ((i + 1) % 100 === 0) {
      send({ type: 'progress', step: i + 1, total: steps, loss: ai.lastLoss });
    }
  }
  ai.save();

  send({ type: 'done', trained: ai.stepCount - startStep, finalLoss: ai.lastLoss, totalSteps: ai.stepCount });
}

run().catch(err => {
  send({ type: 'error', message: err.message });
});
