'use strict';
/**
 * Instead of narrating actions in plain English ("Coming!", "Mining 5 oak
 * logs..."), the bot announces the actual function/action it's invoking,
 * e.g. `> come(target="Steve")`. Used by both commands.js (explicit
 * commands) and brain.js (autonomous behavior) so the style is consistent
 * everywhere.
 */
function announce(bot, fnName, args = {}) {
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  bot.chat(`> ${fnName}(${argStr})`);
}

// Variant for calls that return a value worth showing (status/inventory/etc).
function announceResult(bot, fnName, args, resultStr) {
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  bot.chat(`> ${fnName}(${argStr}) => ${resultStr}`);
}

module.exports = { announce, announceResult };
