const mineflayer = require('mineflayer');
const path = require('path');
const { Worker } = require('worker_threads');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { plugin: pvpPlugin } = require('mineflayer-pvp');
const { plugin: collectBlockPlugin } = require('mineflayer-collectblock');
const { attachBrain } = require('./brain');
const { attachCommands } = require('./commands');
const { attachChatAI } = require('./chatai-listener');
const { attachObserver } = require('./observer');
const { attachAutopilot } = require('./autopilot');
const { attachEquipment } = require('./equipment');
const { attachWorldMemory } = require('./worldmemory');
const { attachInteractions } = require('./interactions');
const { attachDashboard } = require('./dashboard');
const { PolicyNet } = require('./ai/policy');

/**
 * Runs a bounded background pretraining pass on ai/pretrain-worker.js
 * (a separate thread — see that file for why) and resolves once it's
 * done. Never rejects; any failure just gets logged and treated as a
 * no-op so it can never prevent the bot from actually starting.
 */
function runPretrainWorker(config, steps, log) {
  return new Promise((resolve) => {
    if (!steps || steps <= 0) { resolve(); return; }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const worker = new Worker(path.join(__dirname, 'ai', 'pretrain-worker.js'), {
        workerData: { config, steps }
      });
      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          log(`[pretrain] step ${msg.step}/${msg.total} loss=${msg.loss !== null && msg.loss !== undefined ? msg.loss.toFixed(4) : 'n/a'}`);
        } else if (msg.type === 'done') {
          if (msg.trained > 0) {
            log(`[pretrain] warmed up ${msg.trained} steps this session (total ${msg.totalSteps}, loss ${msg.finalLoss !== null ? msg.finalLoss.toFixed(4) : 'n/a'}).`);
          }
          finish();
        } else if (msg.type === 'error') {
          log(`[pretrain] failed: ${msg.message}`);
          finish();
        }
      });
      worker.on('error', (err) => { log(`[pretrain] worker error: ${err.message}`); finish(); });
      worker.on('exit', finish); // safety net in case no message arrived
    } catch (e) {
      log(`[pretrain] could not start: ${e.message}`);
      finish();
    }
  });
}

/**
 * Starts the bot. Exported as a function (rather than running as a
 * top-level side effect) so it can be called programmatically — e.g. from
 * the Electron launcher UI with values typed into a form — as well as from
 * the command line via `npm start` (see the require.main check at the
 * bottom of this file, which is the only place this runs automatically).
 *
 * `configOverrides` is shallow-merged over config.json, so callers only
 * need to supply the fields they want to change (host/port/version/etc).
 * Returns a handle with `.stop()` to cleanly shut everything down —
 * useful for a "Disconnect" button in a GUI, not needed for CLI use.
 */
function startBot(configOverrides = {}, options = {}) {
  const baseConfig = require('./config.json');
  const config = { ...baseConfig, ...configOverrides };
  const log = options.onLog || console.log;

  // Resolve relative memory/data-file paths against this file's own
  // location (not process.cwd()) — critical when this is required from
  // somewhere else, like an Electron app launched from an arbitrary
  // working directory, so it reliably finds/writes the same files every
  // time regardless of how the bot was started.
  for (const key of ['aiMemoryPath', 'aiPolicyMemoryPath', 'pretrainFile', 'tokenizerPath']) {
    if (config[key] && !path.isAbsolute(config[key])) {
      config[key] = path.join(__dirname, config[key]);
    }
  }

  const policy = new PolicyNet(config.aiPolicyMemoryPath || './ai_policy_memory.json');

  let currentBot = null;
  let cleanupFns = [];
  let stopped = false;
  let reconnectTimer = null;

  // Persistent singleton across reconnects, unlike the per-connection bot
  // object — reads whatever the current bot is at request time so it never
  // shows stale data from a disconnected session.
  const dashboardHandle = attachDashboard(() => currentBot, config, policy);

  function createBot() {
    if (stopped) return;

    // Tear down background intervals/listeners from the previous connection
    // (observer polling, autopilot decisions, look-around scanning, gear
    // checks) before starting a new one, so reconnects don't leak intervals
    // tied to a disconnected bot object.
    cleanupFns.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    cleanupFns = [];

    log(`Connecting to ${config.host}:${config.port} as ${config.username} (MC ${config.version})...`);

    const bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      version: config.version,
    });
    currentBot = bot;

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvpPlugin);
    bot.loadPlugin(collectBlockPlugin);

    bot.once('spawn', () => {
      log('Bot spawned in world.');
      const mcData = require('minecraft-data')(bot.version);
      const movements = new Movements(bot, mcData);
      movements.canDig = true;
      movements.allowParkour = true;
      bot.pathfinder.setMovements(movements);

      attachBrain(bot, config, policy);
      const commandsAPI = attachCommands(bot, config, policy);
      attachChatAI(bot, config, commandsAPI);
      attachInteractions(bot, config);

      const observerHandle = attachObserver(bot, config, policy);
      if (observerHandle) cleanupFns.push(observerHandle.stop);

      const autopilotHandle = attachAutopilot(bot, config, policy);
      if (autopilotHandle) cleanupFns.push(autopilotHandle.stop);

      const equipmentHandle = attachEquipment(bot, config);
      if (equipmentHandle) cleanupFns.push(equipmentHandle.stop);

      const worldMemoryHandle = attachWorldMemory(bot, config);
      if (worldMemoryHandle) cleanupFns.push(worldMemoryHandle.stop);

      // What actually gets said in Minecraft chat comes from its own
      // generated speech now, not a fixed string — consistent with how
      // the thank-you message works (see interactions.js). If nothing
      // usable generates yet (a very undertrained model may produce
      // nothing coherent), it just joins quietly rather than falling
      // back to canned text. The technical log line above is separate —
      // that's for you/the console, not something it "says".
      if (bot.chatAI) {
        const greeting = bot.chatAI.reply(`${bot.username}:`, 40, 0.85);
        if (greeting) bot.chat(greeting);
      }
    });

    bot.on('kicked', (reason) => {
      log(`Kicked: ${JSON.stringify(reason)}`);
    });

    bot.on('error', (err) => {
      log(`Error: ${err.message}`);
    });

    bot.on('end', (reason) => {
      if (stopped) return;
      log(`Disconnected (${reason}). Reconnecting in ${config.reconnectDelayMs / 1000}s...`);
      reconnectTimer = setTimeout(createBot, config.reconnectDelayMs);
    });

    return bot;
  }

  // Periodic autosave for the policy net (chat AI autosaves on its own schedule internally).
  const saveInterval = setInterval(() => { policy.save(); }, 60000);

  process.on('SIGINT', () => {
    log('\nSaving memory before exit...');
    policy.save();
    if (currentBot && currentBot.chatAI) currentBot.chatAI.save();
    process.exit(0);
  });

  const pretrainSteps = config.pretrainOnStartupSteps ?? 300;
  runPretrainWorker(config, pretrainSteps, log).then(() => {
    if (!stopped) createBot();
  });

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(saveInterval);
      cleanupFns.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
      if (dashboardHandle) dashboardHandle.stop();
      policy.save();
      if (currentBot) {
        if (currentBot.chatAI) currentBot.chatAI.save();
        try { currentBot.quit(); } catch (e) { /* ignore */ }
      }
    },
    getBot: () => currentBot
  };
}

module.exports = { startBot };

if (require.main === module) {
  startBot();
}
