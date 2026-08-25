'use strict';
const { announce } = require('./announce');

/**
 * Two things live here, both aimed at "learning more about the world":
 *
 * 1. Look-around scanning: when idle and safe, the bot periodically turns
 *    to look around (several yaw/pitch angles) instead of just standing
 *    still, and while doing so records any resource blocks or mobs it
 *    notices into a small rolling memory.
 * 2. Visited-cell tracking: a coarse grid of which areas it's already been
 *    to, so idle wandering/autopilot exploration is biased toward
 *    unexplored territory instead of pure random walk.
 *
 * This intentionally stays outside the neural policy network (ai/policy.js)
 * — adding features to that model would change its input dimensions and
 * invalidate any already-saved ai_policy_memory.json. This is a classic,
 * simple heuristic memory layered on top instead.
 */

const CELL_SIZE = 16;
const SCAN_INTERVAL_MS = 18000;
const MAX_MEMORY_ENTRIES = 25;
const RESOURCE_PATTERNS = [/_log$/, /_ore$/, /ancient_debris/];

function cellKey(pos) {
  return `${Math.floor(pos.x / CELL_SIZE)},${Math.floor(pos.z / CELL_SIZE)}`;
}

function attachWorldMemory(bot, config) {
  bot.worldMemory = {
    visitedCells: new Set(),
    knownResources: [], // [{name, pos, ts}]
    knownMobSightings: []
  };

  function rememberVisit() {
    bot.worldMemory.visitedCells.add(cellKey(bot.entity.position));
  }

  function scanSurroundings() {
    try {
      const mcData = require('minecraft-data')(bot.version);
      const ids = [];
      for (const pattern of RESOURCE_PATTERNS) {
        for (const name in mcData.blocksByName) if (pattern.test(name)) ids.push(mcData.blocksByName[name].id);
      }
      const found = bot.findBlocks({ matching: ids, maxDistance: 24, count: 5 });
      for (const pos of found) {
        const block = bot.blockAt(pos);
        if (!block) continue;
        bot.worldMemory.knownResources.push({ name: block.name, pos: pos.clone(), ts: Date.now() });
      }
      if (bot.worldMemory.knownResources.length > MAX_MEMORY_ENTRIES) {
        bot.worldMemory.knownResources = bot.worldMemory.knownResources.slice(-MAX_MEMORY_ENTRIES);
      }

      const mobs = Object.values(bot.entities).filter(e =>
        e.type === 'mob' && e.position.distanceTo(bot.entity.position) < 24
      );
      for (const m of mobs) {
        bot.worldMemory.knownMobSightings.push({ name: m.name, pos: m.position.clone(), ts: Date.now() });
      }
      if (bot.worldMemory.knownMobSightings.length > MAX_MEMORY_ENTRIES) {
        bot.worldMemory.knownMobSightings = bot.worldMemory.knownMobSightings.slice(-MAX_MEMORY_ENTRIES);
      }
    } catch (e) { /* best effort */ }
  }

  async function lookAroundSequence() {
    if (bot.brain.state !== 'idle') return;
    announce(bot, 'lookAround', {});
    const startYaw = bot.entity.yaw;
    const angles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    for (const offset of angles) {
      if (bot.brain.state !== 'idle') break; // bail if something more important came up mid-scan
      try {
        await bot.look(startYaw + offset, (Math.random() - 0.3) * 0.6, false);
      } catch (e) { break; }
      await new Promise(res => setTimeout(res, 350));
    }
    scanSurroundings();
    rememberVisit();
  }

  const interval = setInterval(lookAroundSequence, SCAN_INTERVAL_MS);

  // Suggests an unexplored-ish direction for wandering, falling back to
  // pure random if everything nearby has already been visited.
  function suggestExploreDirection() {
    const candidates = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const dist = 10;
      const x = bot.entity.position.x + Math.cos(angle) * dist;
      const z = bot.entity.position.z + Math.sin(angle) * dist;
      const key = cellKey({ x, z });
      candidates.push({ x, z, visited: bot.worldMemory.visitedCells.has(key) });
    }
    const unvisited = candidates.filter(c => !c.visited);
    const pool = unvisited.length > 0 ? unvisited : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  return { stop: () => clearInterval(interval), scanSurroundings, suggestExploreDirection };
}

module.exports = { attachWorldMemory };
