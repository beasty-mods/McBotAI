'use strict';
/**
 * Maps free-form natural language ("Botie, go mine some stone") to one of
 * the existing command handlers in commands.js. This is deliberately
 * rule-based pattern matching, not routed through the small neural net —
 * a from-scratch model trained on sparse chat isn't reliable enough to
 * safely decide what action to take, so action-selection stays
 * deterministic while the neural net handles casual conversation.
 *
 * This is honestly a heuristic, not full language understanding: it
 * pattern-matches phrasing and scans for known Minecraft block/item names.
 * Odd phrasing may go unrecognized and fall through to a normal chat
 * reply instead of an action — that's expected, not a bug.
 */

const SHAPE_WORDS = ['wall', 'floor', 'platform', 'cube', 'box', 'pyramid', 'tower', 'house'];

// Common colloquial terms that don't map to any literal Minecraft block/item
// name (e.g. nobody's inventory has an item literally called "wood").
const SYNONYMS = {
  wood: 'oak_log', logs: 'oak_log', log: 'oak_log', timber: 'oak_log',
  ore: 'iron_ore', rock: 'stone', rocks: 'stone', sticks: 'stick',
  planks: 'oak_planks', wool: 'white_wool', coal: 'coal_ore',
  door: 'oak_door', gate: 'oak_fence_gate', trapdoor: 'oak_trapdoor',
  button: 'stone_button', fence: 'oak_fence', bed: 'red_bed'
};

let cachedNamesSet = null;
let cachedVersion = null;
function getNamesSet(bot) {
  if (cachedNamesSet && cachedVersion === bot.version) return cachedNamesSet;
  const mcData = require('minecraft-data')(bot.version);
  const set = new Set();
  for (const name in mcData.blocksByName) set.add(name);
  for (const name in mcData.itemsByName) set.add(name);
  cachedNamesSet = set;
  cachedVersion = bot.version;
  return set;
}

function extractNumbers(text) {
  const matches = text.match(/-?\d+/g);
  return matches ? matches.map(Number) : [];
}

// Scans for the longest known block/item name in the text, checking 3-word,
// then 2-word, then 1-word windows (so "oak log" matches "oak_log" before
// falling back to matching just "log").
function findKnownName(text, namesSet) {
  const words = text.toLowerCase().replace(/[^a-z0-9_ ]/g, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (SYNONYMS[w] && namesSet.has(SYNONYMS[w])) return SYNONYMS[w];
  }
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const candidate = words.slice(i, i + n).join('_');
      if (namesSet.has(candidate)) return candidate;
      if (candidate.endsWith('s') && namesSet.has(candidate.slice(0, -1))) return candidate.slice(0, -1);
    }
  }
  return null;
}

function parseIntent(rawMessage, bot) {
  const text = rawMessage.toLowerCase();

  // Order matters — more specific phrases are checked before looser ones
  // that could otherwise swallow them (e.g. "unguard" before "guard").
  if (/\b(stop guard(ing)?|unguard|stand down)\b/.test(text)) return { cmd: 'unguard', args: [] };

  if (/\b(turn off|stop|disable) (auto|autopilot|autonomous)/.test(text)) return { cmd: 'auto', args: ['off'] };
  if (/\b(turn on|start|enable) (auto|autopilot|autonomous)\b|\bthink(ing)? for yourself\b|\bdecide (for yourself|on your own)\b/.test(text)) {
    return { cmd: 'auto', args: ['on'] };
  }

  if (/\bsave (your|the)? ?(memory|brain|progress)\b/.test(text)) return { cmd: 'ai', args: ['save'] };
  if (/\bpolicy status\b|\bhow (good|well) (are you|is your) (policy|decision)/.test(text)) return { cmd: 'ai', args: ['policy'] };
  if (/\bhow much (have you learned|training)\b|\bai status\b|\btraining status\b/.test(text)) return { cmd: 'ai', args: ['status'] };
  if (/\bdashboard\b|\bshow me your (stats|status)\b/.test(text)) return { cmd: 'dashboard', args: [] };

  // "give me X" = hand over something already in inventory — distinct from
  // "get me X" / "mine X" below, which mean go fetch it from the world.
  if (/\bgive me\b|\bhand me\b|\bcan i have\b|\bpass me\b|\blet me have\b/.test(text)) {
    const item = findKnownName(text, getNamesSet(bot));
    if (item) {
      const nums = extractNumbers(text);
      return { cmd: 'give', args: [item, ...(nums.length ? [String(nums[0])] : [])] };
    }
  }

  if (/\b(stop|wait|hold on|cancel|never ?mind|that'?s enough)\b/.test(text)) return { cmd: 'stop', args: [] };
  if (/\bcome (here|to me|over)\b|^come\b/.test(text)) return { cmd: 'come', args: [] };
  if (/\bfollow me\b|\bfollow\b/.test(text)) return { cmd: 'follow', args: [] };
  if (/\bguard (this|here)\b|\bprotect (this|here)\b|\bstay here\b|^guard\b/.test(text)) return { cmd: 'guard', args: [] };

  if (/\bgo to\b|\bwalk to\b|\bhead to\b|\bcoordinates?\b/.test(text)) {
    const nums = extractNumbers(text);
    if (nums.length >= 3) return { cmd: 'goto', args: nums.slice(0, 3).map(String) };
  }

  if (/\battack\b|\bkill\b|\bfight\b/.test(text)) return { cmd: 'attack', args: [] };
  if (/\bdrop (everything|all|your (stuff|items|inventory))\b/.test(text)) return { cmd: 'drop', args: ['all'] };

  if (/\bequip\b|\bhold (the|your|a)\b|\bwield\b|\bswitch to\b/.test(text)) {
    const item = findKnownName(text, getNamesSet(bot));
    if (item) return { cmd: 'equip', args: [item] };
  }

  if (/\bbuild\b|\bconstruct\b|\bmake (a|me a)\b/.test(text)) {
    const shape = SHAPE_WORDS.find(s => text.includes(s));
    if (shape) {
      const material = findKnownName(text.replace(shape, ' '), getNamesSet(bot));
      const nums = extractNumbers(text);
      if (material) return { cmd: 'build', args: [shape, material, ...nums.map(String)] };
    }
  }

  if (/\bcraft\b|\bmake (some|a|an)\b/.test(text)) {
    const item = findKnownName(text.replace(/\bmake\b/g, ''), getNamesSet(bot));
    if (item) {
      const nums = extractNumbers(text);
      return { cmd: 'craft', args: [item, ...(nums.length ? [String(nums[0])] : [])] };
    }
  }

  if (/\bmine\b|\bdig\b/.test(text)) {
    const block = findKnownName(text, getNamesSet(bot));
    const nums = extractNumbers(text);
    if (block) return { cmd: 'mine', args: [block, ...(nums.length ? [String(nums[0])] : [])] };
  }

  const CROP_NAMES = ['wheat', 'carrot', 'potato', 'beetroot'];

  if (/\bharvest\b|\bpick (the |up )?(crops?|wheat|carrots?|potatoes?|beetroots?)\b/.test(text)) {
    const crop = CROP_NAMES.find(c => text.includes(c));
    const nums = extractNumbers(text);
    return { cmd: 'harvest', args: crop ? [crop, ...(nums.length ? [String(nums[0])] : [])] : (nums.length ? ['', String(nums[0])] : []) };
  }

  if (/\b(plant|farm|till)\b/.test(text)) {
    const crop = CROP_NAMES.find(c => text.includes(c));
    if (crop) {
      const nums = extractNumbers(text);
      return { cmd: 'farm', args: [crop, ...(nums.length ? [String(nums[0])] : [])] };
    }
  }

  if (/\bsmelt\b|\bsmelting\b/.test(text)) {
    const item = findKnownName(text, getNamesSet(bot));
    const nums = extractNumbers(text);
    if (item) return { cmd: 'smelt', args: [item, ...(nums.length ? [String(nums[0])] : [])] };
  }

  if (/\bgo (to )?sleep\b|\bsleep\b/.test(text)) return { cmd: 'sleep', args: [] };

  if (/\bstore\b|\bput (this|these|it|that|your (stuff|items))\b.*\b(chest|away)\b|\bdeposit\b/.test(text)) {
    const item = findKnownName(text, getNamesSet(bot));
    return { cmd: 'store', args: item ? [item] : [] };
  }

  const MOUNTABLE = ['boat', 'minecart', 'horse', 'donkey', 'mule', 'pig', 'strider', 'llama'];

  if (/\bdismount\b|\bget off\b|\bstop riding\b|\bstand up\b/.test(text)) return { cmd: 'dismount', args: [] };

  if (/\bsit (on|in)\b|\bride\b|\bmount\b|\bget (in|on)\b/.test(text)) {
    const target = MOUNTABLE.find(m => text.includes(m));
    return { cmd: 'mount', args: target ? [target] : [] };
  }

  if (/\bopen\b|\bclose\b|\bpull\b|\bpress\b|\bflip\b|\buse\b/.test(text)) {
    const target = findKnownName(text, getNamesSet(bot));
    if (target) return { cmd: 'use', args: [target] };
  }

  if (/\bcollect\b|\bgather\b|\bget me\b/.test(text)) {
    const item = findKnownName(text, getNamesSet(bot));
    const nums = extractNumbers(text);
    if (item) return { cmd: 'collect', args: [item, ...(nums.length ? [String(nums[0])] : [])] };
  }

  if (/\bhow are you\b|\bstatus\b|\bhow('?s| is) your health\b|\bhow much health\b/.test(text)) return { cmd: 'status', args: [] };
  if (/\binventory\b|\bwhat do you have\b|\bwhat('?s| is) in your (bag|inventory)\b/.test(text)) return { cmd: 'inventory', args: [] };
  if (/\bhelp\b|\bwhat can you do\b|\bcommands\b/.test(text)) return { cmd: 'help', args: [] };

  return null;
}

// Splits a message on sequencing words ("then", "after that", "next") and
// parses each piece independently, so "mine some iron then build a wall"
// becomes two intents run one after another instead of one confused parse.
function parseMultiIntent(rawMessage, bot) {
  const segments = rawMessage
    .split(/\b(?:and then|after that|then|next)\b/i)
    .map(s => s.trim())
    .filter(Boolean);

  const intents = [];
  for (const seg of segments) {
    const intent = parseIntent(seg, bot);
    if (intent) intents.push(intent);
  }
  return intents;
}

module.exports = { parseIntent, parseMultiIntent };
