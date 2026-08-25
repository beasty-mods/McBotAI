'use strict';

// Single source of truth for what counts as "hostile" — imported by brain.js
// too, so combat logic and the learned policy agree on the same mob list.
const AVOID_MELEE_MOBS = ['creeper'];
const HOSTILE_MOBS = [
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'evoker', 'vex', 'silverfish',
  'endermite', 'phantom', 'blaze', 'magma_cube', 'slime', 'guardian',
  'elder_guardian', 'shulker', 'ravager', 'zombified_piglin', 'piglin_brute',
  'enderman'
];
const ALL_HOSTILE = [...HOSTILE_MOBS, ...AVOID_MELEE_MOBS];

const RESOURCE_PATTERNS = [/_log$/, /_ore$/, /ancient_debris/, /_planks$/, /stone$/, /dirt$/, /sand$/];

const ACTIONS = ['mine', 'fight', 'flee', 'follow', 'guard', 'build', 'wander'];
const ACTION_INDEX = Object.fromEntries(ACTIONS.map((a, i) => [a, i]));

const FEATURE_DIM = 12;
const NEUTRAL = 0.5; // used when a feature can't be observed (e.g. another player's health)

/**
 * Builds a fixed-size numeric feature vector describing the situation
 * around `position`. `subject` optionally supplies known values (health,
 * food, hasWeapon, hasFood) for whoever the state is "about" — when
 * observing the master player we usually don't know these, so they default
 * to a neutral 0.5 rather than a misleading 0.
 */
function getStateFeatures(bot, position, subject = {}) {
  const f = new Float64Array(FEATURE_DIM);

  f[0] = subject.health !== undefined ? subject.health / 20 : NEUTRAL;
  f[1] = subject.food !== undefined ? subject.food / 20 : NEUTRAL;

  const hostiles = Object.values(bot.entities).filter(e =>
    e.type === 'mob' && e.name && ALL_HOSTILE.includes(e.name.toLowerCase()) &&
    e.position.distanceTo(position) < 16
  );
  f[2] = Math.min(hostiles.length, 5) / 5;
  let nearestDist = 16;
  for (const h of hostiles) nearestDist = Math.min(nearestDist, h.position.distanceTo(position));
  f[3] = nearestDist / 16;

  f[4] = subject.hasWeapon !== undefined ? (subject.hasWeapon ? 1 : 0) : NEUTRAL;
  f[5] = subject.hasFood !== undefined ? (subject.hasFood ? 1 : 0) : NEUTRAL;

  let resourceCount = 0;
  try {
    const mcData = require('minecraft-data')(bot.version);
    const ids = [];
    for (const pattern of RESOURCE_PATTERNS) {
      for (const name in mcData.blocksByName) {
        if (pattern.test(name)) ids.push(mcData.blocksByName[name].id);
      }
    }
    resourceCount = bot.findBlocks({ point: position, matching: ids, maxDistance: 8, count: 5 }).length;
  } catch (e) { /* best effort */ }
  f[6] = Math.min(resourceCount, 5) / 5;

  const timeOfDay = (bot.time && typeof bot.time.timeOfDay === 'number') ? bot.time.timeOfDay : 0;
  f[7] = timeOfDay / 24000;
  f[8] = (timeOfDay > 13000 && timeOfDay < 23000) ? 1 : 0; // rough "is night"
  f[9] = (bot.isRaining) ? 1 : 0;

  f[10] = Math.max(0, Math.min(1, (position.y + 64) / 192));

  let dangerTerrain = 0;
  try {
    const below = bot.blockAt(position.offset(0, -1, 0));
    if (below && /lava|water/.test(below.name)) dangerTerrain = 1;
  } catch (e) { /* best effort */ }
  f[11] = dangerTerrain;

  return f;
}

module.exports = { HOSTILE_MOBS, AVOID_MELEE_MOBS, ALL_HOSTILE, ACTIONS, ACTION_INDEX, FEATURE_DIM, getStateFeatures };
