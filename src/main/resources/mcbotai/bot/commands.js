const { GoalNear } = require('mineflayer-pathfinder').goals;
const builder = require('./builder');
const survival = require('./survival');
const { ACTION_INDEX } = require('./ai/state');
const { announce, announceResult } = require('./announce');

function attachCommands(bot, config, policy) {

  function isMaster(username) {
    if (!config.masters || config.masters.length === 0) return true; // no whitelist = anyone
    return config.masters.includes(username);
  }

  function stopEverything() {
    bot.pathfinder.setGoal(null);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
    if (bot.brain._jumpInterval) { clearInterval(bot.brain._jumpInterval); bot.brain._jumpInterval = null; }
    try { bot.pvp.stop(); } catch (e) {}
    try { bot.collectBlock.cancelTask(); } catch (e) {}
    bot.brain.state = 'idle';
    bot.brain.followTarget = null;
    bot.brain.guardPos = null;
    bot.brain.previousState = null;
  }

  const handlers = {
    async help() {
      bot.chat('Just mention me and say what you want — "Botie come here", "Botie mine some stone", ' +
        '"Botie give me 5 wood", "Botie build a wall out of stone 10 4", "Botie sit on that boat". ' +
        'Exact commands also work: come, follow, stop, guard, unguard, goto x y z, ' +
        'mine <block> [count], attack, collect <item> <count>, give <item> [count], drop all, ' +
        'equip <item>, craft <item> [count], smelt <item> [count], farm <crop> [count], ' +
        'harvest [crop] [count], sleep, store [item], mount <target>, dismount, use <block>, ' +
        'status, inventory, build <shape> <block> <dims...>, ' +
        'chat <message>, ai status|policy|save, auto on|off, dashboard');
    },

    async come(username) {
      const player = bot.players[username];
      if (!player || !player.entity) { bot.chat("I can't see you."); return; }
      stopEverything();
      const p = player.entity.position;
      bot.brain.state = 'goto';
      announce(bot, 'come', { target: username });
      bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, 2));
      bot.pathfinder.once('goal_reached', () => {
        if (bot.brain.state === 'goto') bot.brain.state = 'idle';
      });
    },

    async follow(username) {
      stopEverything();
      const ok = bot._brainAPI.setFollowGoal(username);
      if (ok) announce(bot, 'follow', { target: username });
      else bot.chat("I can't see you.");
    },

    async stop() {
      stopEverything();
      announce(bot, 'stop', {});
    },

    async guard() {
      stopEverything();
      bot.brain.state = 'guarding';
      bot.brain.guardPos = bot.entity.position.clone();
      const p = bot.brain.guardPos;
      announce(bot, 'guard', { pos: `${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}` });
    },

    async unguard() {
      stopEverything();
      announce(bot, 'unguard', {});
    },

    async goto(username, args) {
      if (args.length < 3) { bot.chat('Usage: goto x y z'); return; }
      const [x, y, z] = args.map(Number);
      if ([x, y, z].some(Number.isNaN)) { bot.chat('Coordinates must be numbers.'); return; }
      stopEverything();
      bot.brain.state = 'goto';
      announce(bot, 'goto', { x, y, z });
      bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));
      bot.pathfinder.once('goal_reached', () => {
        if (bot.brain.state === 'goto') bot.brain.state = 'idle';
      });
    },

    async mine(username, args) {
      if (args.length < 1) { bot.chat('Usage: mine <blockName> [count]'); return; }
      const blockName = args[0].toLowerCase();
      const countSpecified = args[1] !== undefined;
      const count = countSpecified ? parseInt(args[1], 10) : 3; // "some" defaults to 3 when no count is given

      const mcData = require('minecraft-data')(bot.version);
      const blockType = mcData.blocksByName[blockName];
      if (!blockType) { bot.chat(`I don't know a block called "${blockName}".`); return; }

      const blocks = bot.findBlocks({ matching: blockType.id, maxDistance: 64, count });
      if (blocks.length === 0) { bot.chat(`No ${blockName} found nearby.`); return; }

      stopEverything();
      bot.brain.state = 'mining';
      announce(bot, 'mine', { block: blockName, count: Math.min(count, blocks.length), specified: countSpecified });
      const startFeatures = policy ? bot._brainAPI.getStateFeatures(bot.entity.position,
        { health: bot.health, food: bot.food, hasWeapon: !!bot._brainAPI.getBestWeapon(), hasFood: false }) : null;
      try {
        const targets = blocks.slice(0, count).map(pos => bot.blockAt(pos));
        await bot.collectBlock.collect(targets);
        if (policy && startFeatures) policy.trainReinforce(startFeatures, ACTION_INDEX.mine, 1.0);
      } catch (e) {
        bot.chat(`Mining stopped: ${e.message}`);
        if (policy && startFeatures) policy.trainReinforce(startFeatures, ACTION_INDEX.mine, -0.3);
      } finally {
        if (bot.brain.state === 'mining') bot.brain.state = 'idle';
      }
    },

    async attack() {
      const target = bot._brainAPI.findNearestHostile();
      if (!target) { bot.chat('No hostile mobs nearby.'); return; }
      try {
        bot.brain.previousState = bot.brain.state;
        bot.brain.state = 'fighting';
        const weapon = bot._brainAPI.getBestWeapon();
        if (weapon) await bot.equip(weapon, 'hand');
        announce(bot, 'attack', { target: target.name });
        await bot.pvp.attack(target);
      } catch (e) {
        bot.chat(`Attack failed: ${e.message}`);
      }
    },

    async collect(username, args) {
      if (args.length < 1) { bot.chat('Usage: collect <itemName> [count]'); return; }
      const itemName = args[0].toLowerCase();
      const countSpecified = args[1] !== undefined;
      const count = countSpecified ? parseInt(args[1], 10) : 3;

      const mcData = require('minecraft-data')(bot.version);
      const blockType = mcData.blocksByName[itemName];
      if (!blockType) { bot.chat(`I don't know how to collect "${itemName}".`); return; }
      const blocks = bot.findBlocks({ matching: blockType.id, maxDistance: 64, count });
      if (blocks.length === 0) { bot.chat(`No ${itemName} found nearby.`); return; }
      stopEverything();
      bot.brain.state = 'mining';
      announce(bot, 'collect', { item: itemName, count: Math.min(count, blocks.length), specified: countSpecified });
      try {
        const targets = blocks.map(pos => bot.blockAt(pos));
        await bot.collectBlock.collect(targets);
      } catch (e) {
        bot.chat(`Collect stopped: ${e.message}`);
      } finally {
        if (bot.brain.state === 'mining') bot.brain.state = 'idle';
      }
    },

    async give(username, args) {
      if (args.length < 1) { bot.chat('Usage: give <itemName> [count]'); return; }
      const itemName = args[0].toLowerCase();
      const countSpecified = args[1] !== undefined;
      const requested = countSpecified ? parseInt(args[1], 10) : null;

      const matching = bot.inventory.items().filter(i => i.name === itemName);
      const available = matching.reduce((sum, i) => sum + i.count, 0);
      if (available === 0) { bot.chat(`I don't have any ${itemName}.`); return; }

      const giveCount = requested !== null ? Math.min(requested, available) : Math.min(available, 5); // "some" defaults to up to 5

      const player = bot.players[username];
      if (player && player.entity && player.entity.position.distanceTo(bot.entity.position) > 4) {
        try {
          await bot.pathfinder.goto(new GoalNear(player.entity.position.x, player.entity.position.y, player.entity.position.z, 2));
        } catch (e) { /* best effort, toss from wherever we ended up */ }
      }
      if (player && player.entity) {
        try { await bot.lookAt(player.entity.position.offset(0, 1, 0)); } catch (e) {}
      }

      announce(bot, 'give', { item: itemName, count: giveCount, specified: countSpecified });
      const mcData = require('minecraft-data')(bot.version);
      const itemType = mcData.itemsByName[itemName];
      try {
        await bot.toss(itemType.id, null, giveCount);
      } catch (e) {
        bot.chat(`Couldn't give it to you: ${e.message}`);
      }
    },

    async drop(username, args) {
      if (args[0] === 'all') {
        for (const item of bot.inventory.items()) await bot.tossStack(item);
        announce(bot, 'dropAll', {});
      } else {
        bot.chat('Usage: drop all');
      }
    },

    async equip(username, args) {
      if (args.length < 1) { bot.chat('Usage: equip <itemName>'); return; }
      const name = args.join('_').toLowerCase();
      const item = bot.inventory.items().find(i => i.name.includes(name));
      if (!item) { bot.chat(`I don't have "${args.join(' ')}".`); return; }
      await bot.equip(item, 'hand');
      announce(bot, 'equip', { item: item.name });
    },

    async craft(username, args) {
      if (args.length < 1) { bot.chat('Usage: craft <item> [count]'); return; }
      const itemName = args[0].toLowerCase();
      const count = args[1] ? parseInt(args[1], 10) : 1;

      const mcData = require('minecraft-data')(bot.version);
      const itemType = mcData.itemsByName[itemName];
      if (!itemType) { bot.chat(`I don't know an item called "${itemName}".`); return; }

      // Try a tableless (2x2) recipe first, then look for a nearby crafting table.
      let recipes = bot.recipesFor(itemType.id, null, count, null);
      let tableBlock = null;
      if (recipes.length === 0 && mcData.blocksByName.crafting_table) {
        tableBlock = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 16 });
        if (tableBlock) recipes = bot.recipesFor(itemType.id, null, count, tableBlock);
      }

      if (recipes.length === 0) {
        const allRecipes = bot.recipesAll(itemType.id, null, tableBlock);
        if (allRecipes.length > 0) bot.chat(`I don't have the ingredients to craft ${itemName}.`);
        else bot.chat(`I don't know a recipe for ${itemName}${tableBlock ? '' : ' (might need a crafting table nearby)'}.`);
        return;
      }

      stopEverything();
      announce(bot, 'craft', { item: itemName, count, usingTable: !!tableBlock });
      try {
        if (tableBlock && bot.entity.position.distanceTo(tableBlock.position) > 3) {
          await bot.pathfinder.goto(new GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2));
        }
        await bot.craft(recipes[0], count, tableBlock);
      } catch (e) {
        bot.chat(`Craft failed: ${e.message}`);
      }
    },

    async smelt(username, args) {
      if (args.length < 1) { bot.chat('Usage: smelt <item> [count]'); return; }
      const itemName = args[0].toLowerCase();
      const count = args[1] ? parseInt(args[1], 10) : 1;
      stopEverything();
      announce(bot, 'smelt', { item: itemName, count });
      try {
        const smelted = await survival.smelt(bot, itemName, count);
        bot.chat(`Smelted ${smelted}x ${itemName}.`);
      } catch (e) {
        bot.chat(`Couldn't smelt: ${e.message}`);
      }
    },

    async farm(username, args) {
      if (args.length < 1) { bot.chat('Usage: farm <wheat|carrot|potato|beetroot> [count]'); return; }
      const cropName = args[0].toLowerCase();
      const count = args[1] ? parseInt(args[1], 10) : 3;
      stopEverything();
      announce(bot, 'tillAndPlant', { crop: cropName, count });
      try {
        const planted = await survival.tillAndPlant(bot, cropName, count);
        bot.chat(`Planted ${planted}x ${cropName}.`);
      } catch (e) {
        bot.chat(`Couldn't farm: ${e.message}`);
      }
    },

    async harvest(username, args) {
      const cropName = args[0] ? args[0].toLowerCase() : null;
      const count = args[1] ? parseInt(args[1], 10) : 8;
      stopEverything();
      announce(bot, 'harvest', { crop: cropName || 'any', count });
      try {
        const harvested = await survival.harvest(bot, cropName, count);
        bot.chat(`Harvested ${harvested} crop${harvested === 1 ? '' : 's'}.`);
      } catch (e) {
        bot.chat(`Couldn't harvest: ${e.message}`);
      }
    },

    async sleep() {
      stopEverything();
      announce(bot, 'sleep', {});
      try {
        await survival.sleepInNearestBed(bot);
        bot.chat('Goodnight.');
      } catch (e) {
        bot.chat(`Couldn't sleep: ${e.message}`);
      }
    },

    async store(username, args) {
      const itemName = args[0] ? args[0].toLowerCase() : null;
      stopEverything();
      announce(bot, 'store', { item: itemName || 'all' });
      try {
        const deposited = await survival.storeItemsInNearestChest(bot, itemName);
        bot.chat(`Stored ${deposited} item${deposited === 1 ? '' : 's'} in the chest.`);
      } catch (e) {
        bot.chat(`Couldn't store items: ${e.message}`);
      }
    },

    async mount(username, args) {
      const targetName = args.join('_').toLowerCase();
      const target = bot.nearestEntity(e =>
        e.position.distanceTo(bot.entity.position) < 16 &&
        (!targetName || (e.name && e.name.toLowerCase().includes(targetName)))
      );
      if (!target) { bot.chat(`I don't see ${targetName ? `a ${targetName}` : 'anything to sit on'} nearby.`); return; }
      stopEverything();
      announce(bot, 'mount', { target: target.name });
      try {
        if (bot.entity.position.distanceTo(target.position) > 3) {
          await bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
        }
        bot.mount(target);
      } catch (e) {
        bot.chat(`Couldn't mount: ${e.message}`);
      }
    },

    async dismount() {
      announce(bot, 'dismount', {});
      try { bot.dismount(); } catch (e) { bot.chat(`Couldn't dismount: ${e.message}`); }
    },

    async use(username, args) {
      // Generic "interact with the nearest matching block" — doors, levers,
      // buttons, and similar — via bot.activateBlock (a right-click).
      const targetName = args.join('_').toLowerCase();
      if (!targetName) { bot.chat('Usage: use <block near you>, e.g. "use door"'); return; }
      const mcData = require('minecraft-data')(bot.version);
      const matchingIds = Object.values(mcData.blocksByName)
        .filter(b => b.name.includes(targetName))
        .map(b => b.id);
      if (matchingIds.length === 0) { bot.chat(`I don't know a block called "${targetName}".`); return; }
      const block = bot.findBlock({ matching: matchingIds, maxDistance: 16 });
      if (!block) { bot.chat(`No ${targetName} nearby.`); return; }
      announce(bot, 'use', { block: block.name });
      try {
        if (bot.entity.position.distanceTo(block.position) > 3) {
          await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));
        }
        await bot.activateBlock(block);
      } catch (e) {
        bot.chat(`Couldn't use it: ${e.message}`);
      }
    },

    async status() {
      const pos = bot.entity.position;
      announceResult(bot, 'status', {},
        `HP=${bot.health.toFixed(1)}/20 Food=${bot.food}/20 ` +
        `Pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}) State=${bot.brain.state}`);
    },

    async inventory() {
      const items = bot.inventory.items();
      const summary = items.length === 0 ? 'empty' : items.map(i => `${i.name}x${i.count}`).join(',').slice(0, 220);
      announceResult(bot, 'inventory', {}, summary);
    },

    async build(username, args) {
      if (args.length < 2) {
        bot.chat('Usage: build <cube|wall|floor|pyramid|tower|house> <blockName> <dims...>');
        bot.chat('e.g. build wall stone 10 4  |  build house oak_planks 7 5 4  |  build tower cobblestone 12');
        return;
      }
      const shape = args[0].toLowerCase();
      const blockName = args[1].toLowerCase();
      const dims = args.slice(2).map(v => (isNaN(Number(v)) ? v : Number(v)));

      const shapeBlocks = builder.generateShape(shape, dims);
      if (!shapeBlocks) {
        bot.chat(`Unknown shape "${shape}". Try cube, wall, floor, pyramid, tower, or house.`);
        return;
      }
      if (shapeBlocks.length === 0) {
        bot.chat("That shape came out empty — check your dimensions.");
        return;
      }
      if (shapeBlocks.length > builder.MAX_BLOCKS) {
        bot.chat(`That's ${shapeBlocks.length} blocks — over my limit of ${builder.MAX_BLOCKS}. Try something smaller.`);
        return;
      }

      const have = bot.inventory.items().filter(i => i.name === blockName)
        .reduce((sum, i) => sum + i.count, 0);
      if (have === 0) {
        bot.chat(`I don't have any "${blockName}" to build with.`);
        return;
      }

      stopEverything();
      bot.brain.state = 'building';
      announce(bot, 'build', { shape, block: blockName, blocks: shapeBlocks.length });
      const startFeatures = policy ? bot._brainAPI.getStateFeatures(bot.entity.position,
        { health: bot.health, food: bot.food, hasWeapon: !!bot._brainAPI.getBestWeapon(), hasFood: false }) : null;
      let placedCount = 0;
      await builder.build(bot, shapeBlocks, blockName, (msg) => {
        bot.chat(msg);
        const m = /(\d+) placed/.exec(msg);
        if (m) placedCount = parseInt(m[1], 10);
      });
      if (policy && startFeatures) {
        const completion = placedCount / shapeBlocks.length;
        policy.trainReinforce(startFeatures, ACTION_INDEX.build, completion > 0.8 ? 1.0 : (completion > 0.3 ? 0.2 : -0.3));
      }
      if (bot.brain.state === 'building') bot.brain.state = 'idle';
    },
    async chat(username, args) {
      if (!bot.chatAI) { bot.chat("AI chat isn't loaded."); return; }
      if (args.length === 0) { bot.chat('Usage: chat <message>'); return; }
      const text = args.join(' ');
      const prompt = `${username}: ${text}\n${bot.username}:`;
      const reply = bot.chatAI.reply(prompt);
      bot.chatAI.ingest(`${username}: ${text}\n`);
      if (reply) {
        bot.chat(reply);
        bot.chatAI.ingest(`${bot.username}: ${reply}\n`);
      } else {
        bot.chat("(nothing came out — it's still very undertrained)");
      }
    },

    async ai(username, args) {
      if (!bot.chatAI) { bot.chat("AI chat isn't loaded."); return; }
      const sub = (args[0] || 'status').toLowerCase();
      if (sub === 'save') {
        const ok1 = bot.chatAI.save();
        const ok2 = policy ? policy.save() : true;
        announceResult(bot, 'ai', { save: true }, (ok1 && ok2) ? 'saved' : 'failed');
        return;
      }
      if (sub === 'policy') {
        if (!policy) { bot.chat("Policy net isn't loaded."); return; }
        const s = policy.status();
        const counts = Object.entries(s.actionCounts).map(([k, v]) => `${k}:${v}`).join(' ');
        announceResult(bot, 'ai', { policy: true },
          `imitation=${s.imitationSteps} reinforce=${s.reinforceSteps} ` +
          `avgReward=${s.avgRecentReward !== null ? s.avgRecentReward.toFixed(2) : 'n/a'} counts=[${counts}]`);
        return;
      }
      const s = bot.chatAI.status();
      announceResult(bot, 'ai', { status: true },
        `steps=${s.stepCount} lastLoss=${s.lastLoss ? s.lastLoss.toFixed(3) : 'n/a'} ` +
        `buffer=${s.bufferChars}chars params=${s.paramCount} vocab=${s.vocabSize}`);
    },

    async auto(username, args) {
      const mode = (args[0] || '').toLowerCase();
      if (mode !== 'on' && mode !== 'off') { bot.chat('Usage: auto on|off'); return; }
      bot.autopilotEnabled = mode === 'on';
      announce(bot, 'setAutopilot', { enabled: bot.autopilotEnabled });
    },

    async dashboard() {
      if (config.dashboardEnabled === false) { bot.chat("Dashboard is disabled in config."); return; }
      const port = config.dashboardPort || 3333;
      announceResult(bot, 'dashboard', {}, `http://localhost:${port}`);
    }
  };

  function dispatch(cmd, username, args) {
    if (handlers[cmd]) {
      return handlers[cmd](username, args).catch(err => {
        bot.chat(`Error: ${err.message}`);
        console.error(err);
      });
    }
    bot.chat(`Unknown command "${cmd}". Try ${config.commandPrefix}help`);
    return Promise.resolve();
  }

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    if (!message.startsWith(config.commandPrefix)) return;
    if (!isMaster(username)) { bot.chat("I don't take orders from you."); return; }

    const parts = message.slice(config.commandPrefix.length).trim().split(/\s+/);
    const cmd = parts.shift().toLowerCase();
    dispatch(cmd, username, parts);
  });

  return { handlers, dispatch, isMaster };
}

module.exports = { attachCommands };
