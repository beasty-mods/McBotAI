'use strict';
const { ChatAI } = require('./ai/chatbrain');
const { parseIntent, parseMultiIntent } = require('./nlu');

/**
 * Hooks the live-learning chat AI into the bot's chat stream. The bot only
 * ever acts or replies when its name is mentioned (or via an explicit
 * `!`-prefixed command, handled separately in commands.js). When mentioned:
 *   1. Try to parse the message as one or more chained action requests
 *      ("mine some stone", "mine some iron then build a wall") via nlu.js
 *      and dispatch them through the existing deterministic command
 *      handlers, one at a time — each step waits for the previous one to
 *      actually finish (mining/building/etc.) before starting the next.
 *   2. If nothing matched, fall back to a normal generated chat reply from
 *      the neural net.
 * Either way, everything said in chat (mentioned or not) still gets fed
 * into the chat model's live training, same as before.
 */
function attachChatAI(bot, config, commandsAPI) {
  const ai = new ChatAI(config);
  bot.chatAI = ai;

  bot.on('chat', (username, message) => {
    if (username === bot.username) return; // never learn from / react to itself
    if (message.startsWith(config.commandPrefix)) return; // exact "!" commands handled in commands.js

    const line = `${username}: ${message}\n`;
    ai.ingest(line);

    const mentioned = message.toLowerCase().includes(bot.username.toLowerCase());
    if (!mentioned) return;

    // Try to act on it first — commands aren't subject to the reply
    // cooldown, since back-to-back instructions shouldn't get throttled.
    if (commandsAPI) {
      const intents = parseMultiIntent(message, bot);
      if (intents.length > 0) {
        if (commandsAPI.isMaster(username)) {
          (async () => {
            for (const intent of intents) {
              await commandsAPI.dispatch(intent.cmd, username, intent.args);
            }
          })();
        } else if (ai.canReplyNow()) {
          bot.chat("I only take instructions from my master.");
          ai.lastReplyTs = Date.now();
        }
        return;
      }
    }

    if (!ai.canReplyNow()) return; // only throttle free-form chat replies
    const prompt = `${line}${bot.username}:`;
    const reply = ai.reply(prompt);
    if (reply) {
      bot.chat(reply);
      ai.ingest(`${bot.username}: ${reply}\n`);
    }
  });

  return ai;
}

module.exports = { attachChatAI };
