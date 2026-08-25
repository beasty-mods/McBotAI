const Vec3 = require('vec3');
const { GoalNear } = require('mineflayer-pathfinder').goals;

const MAX_BLOCKS = 400; // safety cap so a typo doesn't ask for a 10,000-block build

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// Each shape function returns an array of {x, y, z} offsets relative to an
// origin corner. y=0 is the bottom layer.

function cubeShape(w, h, d, hollow) {
  const blocks = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        const onShell = x === 0 || x === w - 1 || y === 0 || y === h - 1 || z === 0 || z === d - 1;
        if (!hollow || onShell) blocks.push({ x, y, z });
      }
    }
  }
  return blocks;
}

function wallShape(length, height, thickness = 1) {
  return cubeShape(length, height, thickness, false);
}

function floorShape(w, d) {
  return cubeShape(w, 1, d, false);
}

function pyramidShape(base) {
  const blocks = [];
  for (let y = 0; y < base; y++) {
    const size = base - 2 * y;
    if (size <= 0) break;
    const offset = y; // shrink inward each layer
    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        const onEdge = x === 0 || x === size - 1 || z === 0 || z === size - 1;
        if (onEdge || size <= 2) blocks.push({ x: x + offset, y, z: z + offset });
      }
    }
  }
  return blocks;
}

function towerShape(height, size = 3) {
  return cubeShape(size, height, size, true);
}

function houseShape(w, d, h) {
  const blocks = [];
  // floor
  for (const b of floorShape(w, d)) blocks.push({ x: b.x, y: 0, z: b.z });
  // walls (hollow box), starting one block above the floor
  for (const b of cubeShape(w, h, d, true)) blocks.push({ x: b.x, y: b.y + 1, z: b.z });
  // flat roof
  for (const b of floorShape(w, d)) blocks.push({ x: b.x, y: h + 1, z: b.z });
  // doorway: carve a 1x2 opening in the middle of the front wall (z=0)
  const doorX = Math.floor(w / 2);
  return blocks.filter(b => !(b.z === 0 && b.x === doorX && (b.y === 1 || b.y === 2)));
}

function generateShape(shape, dims) {
  switch (shape) {
    case 'cube':
    case 'box': {
      const [w, h, d, hollowFlag] = dims;
      return cubeShape(w, h, d, hollowFlag === 'hollow' || dims[3] === 1);
    }
    case 'wall':
      return wallShape(dims[0], dims[1], dims[2] || 1);
    case 'floor':
    case 'platform':
      return floorShape(dims[0], dims[1]);
    case 'pyramid':
      return pyramidShape(dims[0]);
    case 'tower':
      return towerShape(dims[0], dims[1] || 3);
    case 'house':
      return houseShape(dims[0], dims[1], dims[2]);
    default:
      return null;
  }
}

function getForwardOrigin(bot, distance = 3) {
  const yaw = bot.entity.yaw;
  const dx = Math.round(-Math.sin(yaw) * distance);
  const dz = Math.round(Math.cos(yaw) * distance);
  return bot.entity.position.floored().offset(dx, 0, dz);
}

function isSolid(block) {
  return block && block.boundingBox === 'block';
}

async function build(bot, shapeBlocks, blockName, statusCb) {
  const origin = getForwardOrigin(bot);

  // Build bottom-up, and center-out within each layer, so reference blocks
  // (something solid to place against) reliably exist before we need them.
  const sorted = [...shapeBlocks].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return (Math.abs(a.x) + Math.abs(a.z)) - (Math.abs(b.x) + Math.abs(b.z));
  });

  let placed = 0, skipped = 0;

  for (const off of sorted) {
    if (bot.brain.state !== 'building') {
      statusCb(`Build interrupted (${placed} placed, ${skipped} skipped).`);
      return;
    }

    const targetPos = origin.offset(off.x, off.y, off.z);
    const existing = bot.blockAt(targetPos);
    if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
      continue; // already occupied
    }

    const item = bot.inventory.items().find(i => i.name === blockName);
    if (!item) {
      statusCb(`Out of ${blockName} — stopping (${placed} placed).`);
      return;
    }

    const neighborOffsets = [
      { x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }
    ];
    let refBlock = null, faceVector = null;
    for (const n of neighborOffsets) {
      const nb = bot.blockAt(targetPos.offset(n.x, n.y, n.z));
      if (isSolid(nb)) {
        refBlock = nb;
        faceVector = new Vec3(-n.x, -n.y, -n.z);
        break;
      }
    }
    if (!refBlock) { skipped++; continue; } // nothing to anchor to yet

    if (bot.entity.position.distanceTo(targetPos) > 4) {
      try {
        await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
      } catch (e) { /* best effort */ }
    }

    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(refBlock, faceVector);
      placed++;
    } catch (e) {
      skipped++;
    }
    await sleep(100);
  }

  statusCb(`Build finished: ${placed} placed, ${skipped} skipped.`);
}

module.exports = { generateShape, build, MAX_BLOCKS };
