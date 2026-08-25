'use strict';
const { announce } = require('./announce');

/**
 * Periodically checks inventory for wearable armor/shield and equips the
 * best available piece into each slot. Runs on an interval rather than
 * reactively so it naturally picks up anything gained via mining, combat
 * drops, or being handed items — no need to hook every possible source.
 */
const SLOT_PATTERNS = [
  { slot: 'head', pattern: /_helmet$/ },
  { slot: 'torso', pattern: /_chestplate$/ },
  { slot: 'legs', pattern: /_leggings$/ },
  { slot: 'feet', pattern: /_boots$/ },
  { slot: 'off-hand', pattern: /^shield$/ }
];

// Higher = better. Anything not listed (e.g. turtle_helmet, leather) still
// works, it just sorts below the named tiers.
const MATERIAL_RANK = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, golden: 2, gold: 2, leather: 1 };

function materialRank(name) {
  for (const mat in MATERIAL_RANK) if (name.startsWith(mat)) return MATERIAL_RANK[mat];
  return 0;
}

function bestCandidateFor(items, pattern) {
  const candidates = items.filter(i => pattern.test(i.name));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => materialRank(b.name) - materialRank(a.name));
  return candidates[0];
}

// Confirmed from mineflayer's own simple_inventory.js plugin — these are
// fixed window slot indices, not something exposed as a lookup helper.
const DEST_SLOT_INDEX = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };

async function autoEquipGear(bot, { silent = false } = {}) {
  const items = bot.inventory.items();
  for (const { slot, pattern } of SLOT_PATTERNS) {
    const candidate = bestCandidateFor(items, pattern);
    if (!candidate) continue;
    try {
      const current = bot.inventory.slots[DEST_SLOT_INDEX[slot]];
      if (current && current.name === candidate.name) continue; // already wearing the best option
      await bot.equip(candidate, slot);
      if (!silent) announce(bot, 'autoEquipGear', { item: candidate.name, slot });
    } catch (e) {
      // slot might be unavailable, item might not actually be wearable in this version, etc. — skip quietly
    }
  }
}

function attachEquipment(bot, config) {
  // Try once shortly after spawn, then periodically (catches anything
  // gained since — mining, drops, being handed gear).
  setTimeout(() => autoEquipGear(bot, { silent: true }), 3000);
  const interval = setInterval(() => autoEquipGear(bot), 15000);
  return { stop: () => clearInterval(interval), autoEquipGear: () => autoEquipGear(bot) };
}

module.exports = { attachEquipment, autoEquipGear };
