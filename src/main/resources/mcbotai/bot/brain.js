const { GoalNear, GoalFollow } = require('mineflayer-pathfinder').goals;
const { HOSTILE_MOBS, AVOID_MELEE_MOBS, ACTION_INDEX, getStateFeatures } = require('./ai/state');
const { announce } = require('./announce');

/**
 * The "brain": a state machine plus autonomous survival/combat behaviors
 * that run continuously in the background, regardless of what command the
 * player last gave.
 *
 * States: idle | following | guarding | mining | goto | building | fleeing | fighting
 */

const SWORD_PRIORITY = [/netherite_sword/i, /diamond_sword/i, /iron_sword/i, /stone_sword/i, /golden_sword/i, /wooden_sword/i];
const AXE_PRIORITY = [/netherite_axe/i, /diamond_axe/i, /iron_axe/i, /stone_axe/i, /golden_axe/i, /wooden_axe/i];
const WEAPON_PRIORITY = [...SWORD_PRIORITY, /sword/i, ...AXE_PRIORITY, /axe/i, /trident/i];

function attachBrain(bot, config, policy) {
  bot.brain = {
    state: 'idle',
    followTarget: null,
    guardPos: null,
    previousState: null,
    lastHealth: bot.health
  };

  const recentSwings = new Map(); // entityId -> timestamp
  const DETECT_RADIUS = 10;
  const CREEPER_SAFE_DISTANCE = 6;
  const ATTACKER_MATCH_RADIUS = 4;
  const ATTACKER_MATCH_WINDOW_MS = 800;

  function say(msg) { bot.chat(msg); }
  function setState(state) { bot.brain.state = state; }

  function isHostile(entity) {
    if (!entity || entity.type !== 'mob' || !entity.name) return false;
    const n = entity.name.toLowerCase();
    return HOSTILE_MOBS.includes(n) || AVOID_MELEE_MOBS.includes(n);
  }

  function findNearestHostile(radius = DETECT_RADIUS) {
    return bot.nearestEntity(e =>
      isHostile(e) && e.position.distanceTo(bot.entity.position) < radius
    );
  }

  function findNearestByPredicate(predicate, radius) {
    return bot.nearestEntity(e => predicate(e) && e.position.distanceTo(bot.entity.position) < radius);
  }

  function getBestWeapon() {
    const items = bot.inventory.items();
    for (const pattern of WEAPON_PRIORITY) {
      const found = items.find(i => pattern.test(i.name));
      if (found) return found;
    }
    return null;
  }

  function getBestSword() {
    const items = bot.inventory.items();
    for (const pattern of SWORD_PRIORITY) {
      const found = items.find(i => pattern.test(i.name));
      if (found) return found;
    }
    return null;
  }

  function getBestAxe() {
    const items = bot.inventory.items();
    for (const pattern of AXE_PRIORITY) {
      const found = items.find(i => pattern.test(i.name));
      if (found) return found;
    }
    return null;
  }

  // Alternates axe (heavier hit) and sword (faster follow-up) when the bot
  // is carrying both — a common PvP tactic. Falls back to whichever one it
  // actually has if it's only carrying a sword or only an axe.
  function pickCombatWeapon(hitCount) {
    const axe = getBestAxe();
    const sword = getBestSword();
    if (axe && sword) return (hitCount % 2 === 0) ? axe : sword;
    return axe || sword || getBestWeapon();
  }

  // ---- Movement helper: set the bot following a player, with a live goal ----
  function setFollowGoal(username) {
    const player = bot.players[username];
    if (!player || !player.entity) return false;
    bot.brain.followTarget = username;
    setState('following');
    // dynamic=true lets pathfinder re-route as the target moves, without us
    // having to recreate the goal every tick (recreating it every tick was
    // the bug causing follow to stall/jitter).
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);
    return true;
  }

  // ---- Eating ----
  async function tryEat(force = false) {
    if (!force && bot.food >= config.lowFoodThreshold) return;
    if (bot.brain._eating) return;

    const foodItem = bot.inventory.items().find(item =>
      /bread|apple|carrot|potato|beef|pork|chicken|mutton|rabbit|cod|salmon|stew|melon|berries/i.test(item.name)
      && !/rotten|poisonous|spider_eye/i.test(item.name)
    );
    if (!foodItem) return;

    try {
      bot.brain._eating = true;
      await bot.equip(foodItem, 'hand');
      await bot.consume();
    } catch (e) {
      // ignore eat failures (not hungry enough, interrupted, etc.)
    } finally {
      bot.brain._eating = false;
    }
  }

  // ---- Sprint-jumping while fleeing (bunny-hop for extra speed) ----
  function startJumpLoop() {
    if (bot.brain._jumpInterval) return;
    bot.brain._jumpInterval = setInterval(() => {
      if (bot.entity.onGround) {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 150);
      }
    }, 450);
  }
  function stopJumpLoop() {
    if (bot.brain._jumpInterval) { clearInterval(bot.brain._jumpInterval); bot.brain._jumpInterval = null; }
    try { bot.setControlState('jump', false); } catch (e) {}
  }

  // ---- Fleeing ----
  function retreatFrom(fromPos, source) {
    const firstEntry = bot.brain.state !== 'fleeing';
    if (firstEntry) {
      bot.brain.previousState = bot.brain.state;
      bot.brain._fleeRecord = policy ? {
        features: getStateFeatures(bot, bot.entity.position, {
          health: bot.health, food: bot.food, hasWeapon: !!getBestWeapon(), hasFood: false
        })
      } : null;
    }
    setState('fleeing');
    try { bot.pvp.stop(); } catch (e) {}
    bot.setControlState('sprint', true);
    startJumpLoop(); // bunny-hop while sprinting for extra speed
    tryEat(true); // eat now to top up hunger so sprinting doesn't stall

    const dx = bot.entity.position.x - fromPos.x;
    const dz = bot.entity.position.z - fromPos.z;
    const len = Math.hypot(dx, dz) || 1;
    const targetX = bot.entity.position.x + (dx / len) * 12;
    const targetZ = bot.entity.position.z + (dz / len) * 12;
    try {
      bot.pathfinder.setGoal(new GoalNear(targetX, bot.entity.position.y, targetZ, 2));
    } catch (e) {}

    if (firstEntry) announce(bot, 'retreatFrom', { source });
  }

  function endFlee() {
    bot.setControlState('sprint', false);
    stopJumpLoop();
    if (policy && bot.brain._fleeRecord && bot.brain._fleeRecord.features) {
      policy.trainReinforce(bot.brain._fleeRecord.features, ACTION_INDEX.flee, 0.6); // survived — reinforce the retreat
    }
    bot.brain._fleeRecord = null;
    announce(bot, 'endFlee', {});
    resumeState();
  }

  // ---- Fighting ----
  async function startFight(mob) {
    if (bot.brain.state !== 'fighting') {
      bot.brain.previousState = bot.brain.state;
    }
    setState('fighting');
    bot.brain._fightRecord = {
      targetId: mob.id,
      features: policy ? getStateFeatures(bot, bot.entity.position, {
        health: bot.health, food: bot.food, hasWeapon: !!getBestWeapon(), hasFood: false
      }) : null,
      startHealth: bot.health
    };
    bot.brain._hitCount = 0;
    const weapon = pickCombatWeapon(0); // opening hit: axe if available (heavier), for the "critical" first strike
    try {
      if (weapon && (!bot.heldItem || bot.heldItem.type !== weapon.type)) {
        await bot.equip(weapon, 'hand');
      }
      announce(bot, 'startFight', { target: mob.name });
      await bot.pvp.attack(mob);
    } catch (e) {
      // target may have died/despawned already
    }
  }

  // Fires right after each swing lands — use it to line up the weapon for
  // the *next* swing, alternating axe/sword mid-fight.
  bot.on('attackedTarget', async () => {
    if (bot.brain.state !== 'fighting') return;
    bot.brain._hitCount = (bot.brain._hitCount || 0) + 1;
    const nextWeapon = pickCombatWeapon(bot.brain._hitCount);
    if (nextWeapon && (!bot.heldItem || bot.heldItem.type !== nextWeapon.type)) {
      try { await bot.equip(nextWeapon, 'hand'); } catch (e) { /* fight may have just ended */ }
    }
  });

  function settleFightReward(outcome) {
    if (!policy || !bot.brain._fightRecord || !bot.brain._fightRecord.features) return;
    const rec = bot.brain._fightRecord;
    const healthDelta = bot.health - rec.startHealth;
    let reward;
    if (outcome === 'won') reward = 1 + Math.min(0, healthDelta) * 0.1; // full credit, small penalty if it cost health
    else if (outcome === 'fled') reward = -0.4;
    else reward = -0.2; // target just wandered off / lost track
    policy.trainReinforce(rec.features, ACTION_INDEX.fight, reward);
    bot.brain._fightRecord = null;
  }

  function resumeState() {
    const prev = bot.brain.previousState || 'idle';
    bot.brain.previousState = null;
    if (prev === 'following' && bot.brain.followTarget) {
      setFollowGoal(bot.brain.followTarget);
    } else {
      setState(prev === 'fighting' || prev === 'fleeing' ? 'idle' : prev);
    }
  }

  bot.on('stoppedAttacking', () => {
    const rec = bot.brain._fightRecord;
    if (rec) {
      if (bot.brain.state === 'fleeing') {
        settleFightReward('fled'); // low-HP flee interrupted the fight
      } else {
        const targetStillExists = !!bot.entities[rec.targetId];
        settleFightReward(targetStillExists ? 'disengaged' : 'won');
      }
    }
    if (bot.brain.state === 'fighting') resumeState();
  });

  // ---- Threat scanning: runs continuously, drives fight-or-flight ----
  function threatTick() {
    if (bot.brain.state === 'fleeing' || bot.brain.state === 'fighting') return;

    const creeper = findNearestByPredicate(
      e => e.type === 'mob' && e.name === 'creeper', CREEPER_SAFE_DISTANCE
    );
    if (creeper) {
      retreatFrom(creeper.position, 'creeper');
      return;
    }

    // In guard mode, only engage threats near the guard post.
    const searchRadius = bot.brain.state === 'guarding' ? config.guardRange : DETECT_RADIUS;
    const originPos = bot.brain.state === 'guarding' && bot.brain.guardPos
      ? bot.brain.guardPos : bot.entity.position;

    const hostile = bot.nearestEntity(e =>
      isHostile(e) && e.name !== 'creeper' &&
      e.position.distanceTo(originPos) < searchRadius &&
      e.position.distanceTo(bot.entity.position) < DETECT_RADIUS
    );
    if (!hostile) return;

    const weapon = getBestWeapon();
    if (weapon) {
      startFight(hostile);
    } else {
      retreatFrom(hostile.position, `unarmed_vs_${hostile.name}`);
    }
  }

  // ---- Attacker detection (for "hit by someone" reaction) ----
  bot.on('entitySwingArm', (entity) => {
    recentSwings.set(entity.id, Date.now());
  });

  function findRecentAttacker() {
    const now = Date.now();
    let best = null;
    let bestDist = Infinity;
    for (const [id, ts] of recentSwings) {
      if (now - ts > ATTACKER_MATCH_WINDOW_MS) continue;
      const entity = bot.entities[id];
      if (!entity || entity === bot.entity) continue;
      const dist = entity.position.distanceTo(bot.entity.position);
      if (dist < ATTACKER_MATCH_RADIUS && dist < bestDist) {
        best = entity;
        bestDist = dist;
      }
    }
    return best;
  }

  bot.on('health', () => {
    const dropped = bot.health < bot.brain.lastHealth;
    bot.brain.lastHealth = bot.health;

    if (dropped) {
      const attacker = findRecentAttacker();
      if (attacker && (attacker.type === 'player' || isHostile(attacker))) {
        if (attacker.name === 'creeper') {
          retreatFrom(attacker.position, 'creeper_hit');
        } else {
          // Neutral to everyone — players and mobs get the same treatment:
          // fight back if armed, retreat if not. No special-casing for
          // players, including the bot's own master — getting hit is
          // getting hit, regardless of who's on the other end.
          const weapon = getBestWeapon();
          if (weapon) {
            startFight(attacker);
          } else {
            const label = attacker.type === 'player' ? `player:${attacker.username || 'unknown'}` : attacker.name;
            retreatFrom(attacker.position, `unarmed_vs_${label}`);
          }
        }
      }
    }

    // Low-HP safety net: bail out of whatever we're doing, regardless of cause.
    if (bot.health <= config.fleeHealthThreshold && bot.brain.state !== 'fleeing') {
      const hostile = findNearestHostile();
      retreatFrom(hostile ? hostile.position : bot.entity.position, 'low_health');
    } else if (bot.health > config.fleeHealthThreshold + 4 && bot.brain.state === 'fleeing') {
      endFlee();
    }
  });

  // ---- Death: harsh penalty on whatever action was active, since dying is the worst outcome ----
  bot.on('death', () => {
    if (!policy) return;
    if (bot.brain._fightRecord && bot.brain._fightRecord.features) {
      policy.trainReinforce(bot.brain._fightRecord.features, ACTION_INDEX.fight, -2);
      bot.brain._fightRecord = null;
    }
    if (bot.brain._fleeRecord && bot.brain._fleeRecord.features) {
      policy.trainReinforce(bot.brain._fleeRecord.features, ACTION_INDEX.flee, -1); // fled but still died — flee itself may not have been the issue, lighter penalty
      bot.brain._fleeRecord = null;
    }
    announce(bot, 'onDeath', {});
  });

  // ---- Guard: return to post when nothing to fight ----
  function guardTick() {
    if (bot.brain.state !== 'guarding' || !bot.brain.guardPos) return;
    if (bot.pvp.target) return; // busy fighting, handled elsewhere
    const dist = bot.entity.position.distanceTo(bot.brain.guardPos);
    if (dist > 3) {
      bot.pathfinder.setGoal(new GoalNear(
        bot.brain.guardPos.x, bot.brain.guardPos.y, bot.brain.guardPos.z, 2
      ));
    }
  }

  bot.on('physicsTick', () => {
    tryEat();
    threatTick();
    if (bot.brain.state === 'guarding') guardTick();
  });

  bot._brainAPI = {
    setState, say, findNearestHostile, setFollowGoal, getBestWeapon, isHostile,
    getStateFeatures: (pos, subject) => getStateFeatures(bot, pos, subject)
  };
}

module.exports = { attachBrain };
