'use strict';
const { ACTION_INDEX, ALL_HOSTILE, getStateFeatures } = require('./ai/state');

const POLL_INTERVAL_MS = 1500;
const SAMPLE_RADIUS = 3;
const KILL_ATTRIBUTION_RADIUS = 6;
const KILL_ATTRIBUTION_WINDOW_MS = 3000;

/**
 * Watches every player listed in config.masters (not just the first one)
 * and, for each of them independently, checks what changed nearby: did a
 * block near them disappear (mined), appear (placed), did a hostile mob
 * die right next to them (fought), did they suddenly put a lot of distance
 * between themselves and a mob that was close a moment ago (fled). Each
 * time it infers one of these, it trains the policy network to associate
 * the surrounding situation with that action.
 *
 * This is necessarily heuristic — Mineflayer doesn't give us a player's
 * exact intent, only world-state changes we can infer from. It's an honest
 * best-effort imitation signal, not ground truth of what anyone did.
 */
function attachObserver(bot, config, policy) {
  const masterNames = config.masters && config.masters.length ? config.masters : [];
  if (masterNames.length === 0) {
    console.log('[observer] No masters configured in config.masters — skipping gameplay imitation.');
    return null;
  }

  const prevSnapshots = new Map(); // masterName -> snapshot
  const recentMobPositions = new Map(); // entity id -> {pos, ts} for kill/flee attribution

  function sampleBlocksAround(pos) {
    const samples = [];
    for (let dx = -SAMPLE_RADIUS; dx <= SAMPLE_RADIUS; dx++) {
      for (let dy = -1; dy <= 2; dy++) {
        for (let dz = -SAMPLE_RADIUS; dz <= SAMPLE_RADIUS; dz++) {
          const p = pos.offset(dx, dy, dz);
          const block = bot.blockAt(p);
          samples.push({ x: p.x, y: p.y, z: p.z, name: block ? block.name : 'unknown' });
        }
      }
    }
    return samples;
  }

  function isSolidName(name) {
    return name && name !== 'air' && name !== 'cave_air' && name !== 'void_air' && name !== 'unknown';
  }

  function trainOn(actionName, position, subject = {}) {
    if (!(actionName in ACTION_INDEX)) return;
    const features = getStateFeatures(bot, position, subject);
    policy.trainImitation(features, ACTION_INDEX[actionName]);
  }

  // Track hostile mob positions continuously so we can attribute deaths/flees to whichever master was nearby.
  bot.on('physicsTick', () => {
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e && e.type === 'mob' && e.name && ALL_HOSTILE.includes(e.name.toLowerCase())) {
        recentMobPositions.set(e.id, { pos: e.position.clone(), ts: Date.now() });
      }
    }
  });

  bot.on('entityDead', (entity) => {
    const record = recentMobPositions.get(entity.id);
    if (!record) return;
    if (Date.now() - record.ts > KILL_ATTRIBUTION_WINDOW_MS) return;
    for (const name of masterNames) {
      const player = bot.players[name];
      if (!player || !player.entity) continue;
      if (record.pos.distanceTo(player.entity.position) <= KILL_ATTRIBUTION_RADIUS) {
        trainOn('fight', record.pos);
        break; // credit the first nearby master only, avoid double-counting one kill
      }
    }
    recentMobPositions.delete(entity.id);
  });

  function pollMaster(masterName) {
    const player = bot.players[masterName];
    if (!player || !player.entity) { prevSnapshots.delete(masterName); return; }
    const pos = player.entity.position.clone();
    const prevSnapshot = prevSnapshots.get(masterName);
    const snapshot = { pos, blocks: sampleBlocksAround(pos), time: Date.now() };

    if (prevSnapshot && prevSnapshot.pos.distanceTo(pos) < 6) {
      const prevMap = new Map(prevSnapshot.blocks.map(b => [`${b.x},${b.y},${b.z}`, b.name]));
      let minedSomething = null, placedSomething = null;
      for (const b of snapshot.blocks) {
        const key = `${b.x},${b.y},${b.z}`;
        const prevName = prevMap.get(key);
        if (prevName === undefined) continue;
        if (isSolidName(prevName) && !isSolidName(b.name)) minedSomething = prevName;
        if (!isSolidName(prevName) && isSolidName(b.name)) placedSomething = b.name;
      }
      if (minedSomething) trainOn('mine', pos);
      if (placedSomething) trainOn('build', pos);

      for (const [id, record] of recentMobPositions) {
        if (Date.now() - record.ts > POLL_INTERVAL_MS * 2) continue; // stale
        if (record.pos.distanceTo(prevSnapshot.pos) < 6 && record.pos.distanceTo(pos) > 10) {
          trainOn('flee', prevSnapshot.pos);
          break;
        }
      }
    }

    prevSnapshots.set(masterName, snapshot);
  }

  const interval = setInterval(() => {
    for (const name of masterNames) pollMaster(name);
  }, POLL_INTERVAL_MS);

  return { stop: () => clearInterval(interval) };
}

module.exports = { attachObserver };
