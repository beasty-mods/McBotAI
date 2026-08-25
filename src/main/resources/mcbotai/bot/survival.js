'use strict';
const { GoalNear, GoalGetToBlock } = require('mineflayer-pathfinder').goals;
const { announce } = require('./announce');

// Crop item -> {seedName, blockName} — the item you plant vs the block name it grows into.
const CROPS = {
  wheat: { seed: 'wheat_seeds', block: 'wheat', matureAge: 7 },
  carrot: { seed: 'carrot', block: 'carrots', matureAge: 7 },
  potato: { seed: 'potato', block: 'potatoes', matureAge: 7 },
  beetroot: { seed: 'beetroot_seeds', block: 'beetroots', matureAge: 3 }
};
const HOE_PRIORITY = [/netherite_hoe/, /diamond_hoe/, /iron_hoe/, /stone_hoe/, /golden_hoe/, /wooden_hoe/];
const FUEL_PATTERNS = [/coal$/, /charcoal/, /_log$/, /_planks$/, /coal_block/];

function findBestTool(bot, patterns) {
  const items = bot.inventory.items();
  for (const pattern of patterns) {
    const found = items.find(i => pattern.test(i.name));
    if (found) return found;
  }
  return null;
}

async function smelt(bot, oreName, count = 1) {
  const mcData = require('minecraft-data')(bot.version);
  const oreType = mcData.itemsByName[oreName];
  if (!oreType) throw new Error(`Unknown item "${oreName}".`);

  const oreInInventory = bot.inventory.items().filter(i => i.name === oreName)
    .reduce((sum, i) => sum + i.count, 0);
  if (oreInInventory === 0) throw new Error(`No ${oreName} in inventory to smelt.`);

  const fuel = findBestTool(bot, FUEL_PATTERNS);
  if (!fuel) throw new Error(`No fuel (coal, charcoal, or logs/planks) to smelt with.`);

  const furnaceBlockType = mcData.blocksByName.furnace;
  let furnaceBlock = bot.findBlock({ matching: furnaceBlockType.id, maxDistance: 32 });
  if (!furnaceBlock) throw new Error(`No furnace found nearby — place one first.`);

  if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
    await bot.pathfinder.goto(new GoalGetToBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z));
  }

  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    const smeltCount = Math.min(count, oreInInventory);
    await furnace.putFuel(fuel.type, null, 1);
    await furnace.putInput(oreType.id, null, smeltCount);

    // Wait for smelting to complete (~10s per item on modern smelt speed, poll for output).
    const timeoutMs = smeltCount * 12000 + 5000;
    const start = Date.now();
    let collected = 0;
    while (Date.now() - start < timeoutMs && collected < smeltCount) {
      await new Promise(res => setTimeout(res, 2000));
      const output = furnace.outputItem();
      if (output && output.count > 0) {
        await furnace.takeOutput();
        collected += output.count;
      }
    }
    return collected;
  } finally {
    furnace.close();
  }
}

async function tillAndPlant(bot, cropName, count = 1) {
  const crop = CROPS[cropName];
  if (!crop) throw new Error(`I don't know how to farm "${cropName}". Try wheat, carrot, potato, or beetroot.`);

  const mcData = require('minecraft-data')(bot.version);
  const seedItem = bot.inventory.items().find(i => i.name === crop.seed);
  if (!seedItem) throw new Error(`No ${crop.seed} to plant.`);

  const hoe = findBestTool(bot, HOE_PRIORITY);
  if (!hoe) throw new Error(`No hoe to till soil with.`);

  const tillable = ['grass_block', 'dirt', 'coarse_dirt'].map(n => mcData.blocksByName[n]?.id).filter(Boolean);
  let planted = 0;

  for (let i = 0; i < count; i++) {
    const spot = bot.findBlock({ matching: tillable, maxDistance: 16 });
    if (!spot) break;
    const above = bot.blockAt(spot.position.offset(0, 1, 0));
    if (above && above.name !== 'air') continue; // something's already on top, skip this spot

    if (bot.entity.position.distanceTo(spot.position) > 3) {
      await bot.pathfinder.goto(new GoalNear(spot.position.x, spot.position.y, spot.position.z, 2));
    }
    await bot.equip(hoe, 'hand');
    await bot.activateBlock(spot);
    await new Promise(res => setTimeout(res, 250));

    const farmland = bot.blockAt(spot.position);
    const currentSeed = bot.inventory.items().find(i => i.name === crop.seed);
    if (!currentSeed) break; // ran out mid-loop
    await bot.equip(currentSeed, 'hand');
    await bot.activateBlock(farmland);
    planted++;
    await new Promise(res => setTimeout(res, 250));
  }
  return planted;
}

async function harvest(bot, cropName, count = 8) {
  const crop = CROPS[cropName] || null;
  const mcData = require('minecraft-data')(bot.version);

  const targetBlockNames = crop ? [crop.block] : Object.values(CROPS).map(c => c.block);
  const ids = targetBlockNames.map(n => mcData.blocksByName[n]?.id).filter(Boolean);

  let harvested = 0;
  for (let i = 0; i < count; i++) {
    const spots = bot.findBlocks({ matching: ids, maxDistance: 16, count: 20 });
    const matureSpot = spots.find(pos => {
      const block = bot.blockAt(pos);
      if (!block) return false;
      const props = block.getProperties ? block.getProperties() : {};
      const age = parseInt(props.age, 10);
      const matureAge = Object.values(CROPS).find(c => c.block === block.name)?.matureAge ?? 7;
      return !Number.isNaN(age) && age >= matureAge;
    });
    if (!matureSpot) break;

    if (bot.entity.position.distanceTo(matureSpot) > 3) {
      await bot.pathfinder.goto(new GoalNear(matureSpot.x, matureSpot.y, matureSpot.z, 2));
    }
    await bot.dig(bot.blockAt(matureSpot));
    harvested++;
    await new Promise(res => setTimeout(res, 150));
  }
  return harvested;
}

async function sleepInNearestBed(bot) {
  const mcData = require('minecraft-data')(bot.version);
  const bedIds = Object.values(mcData.blocksByName).filter(b => b.name.endsWith('_bed')).map(b => b.id);
  const bedBlock = bot.findBlock({ matching: bedIds, maxDistance: 16 });
  if (!bedBlock) throw new Error('No bed found nearby.');

  if (bot.entity.position.distanceTo(bedBlock.position) > 3) {
    await bot.pathfinder.goto(new GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1));
  }
  await bot.sleep(bedBlock);
}

async function storeItemsInNearestChest(bot, itemNameFilter) {
  const mcData = require('minecraft-data')(bot.version);
  const chestIds = ['chest', 'trapped_chest', 'barrel'].map(n => mcData.blocksByName[n]?.id).filter(Boolean);
  const chestBlock = bot.findBlock({ matching: chestIds, maxDistance: 16 });
  if (!chestBlock) throw new Error('No chest found nearby.');

  if (bot.entity.position.distanceTo(chestBlock.position) > 3) {
    await bot.pathfinder.goto(new GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2));
  }

  const chestWindow = await bot.openContainer(chestBlock);
  let deposited = 0;
  try {
    const itemsToStore = bot.inventory.items().filter(i => !itemNameFilter || i.name === itemNameFilter);
    for (const item of itemsToStore) {
      try {
        await bot.transfer({
          window: chestWindow,
          itemType: item.type,
          metadata: item.metadata,
          count: item.count,
          sourceStart: chestWindow.inventoryStart,
          sourceEnd: chestWindow.inventoryEnd,
          destStart: 0,
          destEnd: chestWindow.inventoryStart
        });
        deposited += item.count;
      } catch (e) { /* chest may be full — stop trying further items */ break; }
    }
  } finally {
    chestWindow.close();
  }
  return deposited;
}

module.exports = { smelt, tillAndPlant, harvest, sleepInNearestBed, storeItemsInNearestChest, CROPS };
