'use strict';
const { GoalNear } = require('mineflayer-pathfinder').goals;

const DECIDE_INTERVAL_MS = 7000;

/**
 * When enabled (`!auto on`), and only while the bot is otherwise idle and
 * safe, this asks the learned policy what to do next and carries it out.
 *
 * Deliberately NOT wired to fight/flee — those stay fully deterministic in
 * brain.js because getting combat wrong is costly and safety shouldn't
 * depend on how well-trained a small policy net happens to be yet. The
 * policy still learns to predict fight/flee from observing the master (see
 * observer.js) and gets rewarded for the bot's own fight/flee outcomes
 * (see brain.js) — it's just not the thing steering the bot's hand during
 * combat. Autopilot only acts on the lower-stakes choices: mine, follow,
 * guard, wander (build is intentionally excluded too — it needs explicit
 * block/dimension choices a human should make).
 */
function attachAutopilot(bot, config, policy) {
  if (!policy) return null;
  bot.autopilotEnabled = false;

  async function tryMine() {
    try {
      const mcData = require('minecraft-data')(bot.version);
      const patterns = [/_log$/, /_ore$/];
      const ids = [];
      for (const pattern of patterns) {
        for (const name in mcData.blocksByName) if (pattern.test(name)) ids.push(mcData.blocksByName[name].id);
      }
      const blocks = bot.findBlocks({ matching: ids, maxDistance: 24, count: 1 });
      if (blocks.length === 0) return false;
      const target = bot.blockAt(blocks[0]);
      bot.brain.state = 'mining';
      await bot.collectBlock.collect(target);
      if (bot.brain.state === 'mining') bot.brain.state = 'idle';
      return true;
    } catch (e) {
      if (bot.brain.state === 'mining') bot.brain.state = 'idle';
      return false;
    }
  }

  function tryFollowMaster() {
    const masterName = config.masters && config.masters[0];
    if (!masterName) return false;
    const player = bot.players[masterName];
    if (!player || !player.entity) return false;
    if (player.entity.position.distanceTo(bot.entity.position) < 3) return false; // already close
    bot._brainAPI.setFollowGoal(masterName);
    // only follow briefly during autopilot, then reassess rather than following forever
    setTimeout(() => {
      if (bot.brain.state === 'following' && bot.autopilotEnabled) {
        bot.pathfinder.setGoal(null);
        bot.brain.state = 'idle';
      }
    }, 15000);
    return true;
  }

  function tryGuard() {
    bot.brain.state = 'guarding';
    bot.brain.guardPos = bot.entity.position.clone();
    setTimeout(() => {
      if (bot.brain.state === 'guarding' && bot.autopilotEnabled) {
        bot.brain.state = 'idle';
        bot.brain.guardPos = null;
      }
    }, 20000);
    return true;
  }

  function tryWander() {
    let x, z;
    if (bot.worldMemory && bot.worldMemory.suggestExploreDirection) {
      const suggestion = bot.worldMemory.suggestExploreDirection();
      x = suggestion.x;
      z = suggestion.z;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const dist = 5 + Math.random() * 6;
      x = bot.entity.position.x + Math.cos(angle) * dist;
      z = bot.entity.position.z + Math.sin(angle) * dist;
    }
    try {
      bot.pathfinder.setGoal(new GoalNear(x, bot.entity.position.y, z, 2));
      return true;
    } catch (e) { return false; }
  }

  async function decide() {
    if (!bot.autopilotEnabled) return;
    if (bot.brain.state !== 'idle') return; // never interrupt anything else, including safety behaviors

    const features = bot._brainAPI.getStateFeatures(bot.entity.position, {
      health: bot.health, food: bot.food,
      hasWeapon: !!bot._brainAPI.getBestWeapon(), hasFood: false
    });
    const { actionIdx, actionName } = policy.act(features, 0.15);

    switch (actionName) {
      case 'mine': await tryMine(); break;
      case 'follow': tryFollowMaster(); break;
      case 'guard': tryGuard(); break;
      case 'wander': tryWander(); break;
      // 'fight' / 'flee' / 'build' intentionally not dispatched here
      default: break;
    }
  }

  const interval = setInterval(decide, DECIDE_INTERVAL_MS);
  return { stop: () => clearInterval(interval) };
}

module.exports = { attachAutopilot };
