'use strict';
const http = require('http');

/**
 * A tiny local web dashboard so you can check on the bot without spamming
 * chat — HP, position, inventory, both neural nets' training stats, world
 * memory, autopilot state. Zero new dependencies: just Node's built-in
 * `http` module serving one self-contained HTML page that polls a JSON
 * endpoint every couple seconds.
 *
 * This is local-network-only by default (binds to the machine it runs on).
 * Nothing here is authenticated — anyone who can reach the port can view
 * (read-only) status. Don't expose this port to the open internet.
 */

function buildStatusPayload(bot, policy) {
  const pos = bot.entity ? bot.entity.position : null;
  const inventory = bot.inventory ? bot.inventory.items().map(i => ({ name: i.name, count: i.count })) : [];

  return {
    username: bot.username,
    connected: !!bot.entity,
    health: bot.health,
    food: bot.food,
    position: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
    brainState: bot.brain ? bot.brain.state : 'unknown',
    autopilotEnabled: !!bot.autopilotEnabled,
    inventory,
    chatAI: bot.chatAI ? bot.chatAI.status() : null,
    policy: policy ? policy.status() : null,
    worldMemory: bot.worldMemory ? {
      visitedCells: bot.worldMemory.visitedCells.size,
      knownResources: bot.worldMemory.knownResources.length,
      knownMobSightings: bot.worldMemory.knownMobSightings.length
    } : null,
    timestamp: new Date().toISOString()
  };
}

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Botie dashboard</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; background: #14151a; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .card { background: #1e1f26; border-radius: 10px; padding: 16px 18px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #9aa; margin: 0 0 10px; }
  .stat { display: flex; justify-content: space-between; padding: 3px 0; font-size: 14px; }
  .stat .k { color: #9aa; }
  .bar-bg { background: #333; border-radius: 6px; height: 8px; overflow: hidden; margin-top: 4px; }
  .bar-fill { background: #4caf7d; height: 100%; transition: width 0.3s ease; }
  .bar-fill.low { background: #d9534f; }
  .pill { display: inline-block; background: #2c2e3a; border-radius: 999px; padding: 2px 10px; font-size: 12px; margin: 2px 4px 2px 0; }
  .invlist { max-height: 220px; overflow-y: auto; }
  .offline { color: #d9534f; font-weight: 600; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
  .dot.on { background:#4caf7d; } .dot.off { background:#555; }
</style>
</head>
<body>
  <h1 id="title">Botie dashboard</h1>
  <div class="sub" id="lastUpdate">connecting…</div>
  <div class="grid" id="grid"></div>

<script>
function bar(value, max, low) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return '<div class="bar-bg"><div class="bar-fill' + (value <= low ? ' low' : '') + '" style="width:' + pct + '%"></div></div>';
}
function stat(k, v) { return '<div class="stat"><span class="k">' + k + '</span><span>' + v + '</span></div>'; }

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    document.getElementById('title').textContent = (s.username || 'Botie') + ' dashboard';
    if (!s.connected) {
      document.getElementById('lastUpdate').innerHTML = '<span class="offline">not connected to a world (reconnecting…)</span>';
      document.getElementById('grid').innerHTML = '';
      return;
    }
    document.getElementById('lastUpdate').textContent = 'updated ' + new Date(s.timestamp).toLocaleTimeString();

    let html = '';

    html += '<div class="card"><h2>Vitals</h2>'
      + stat('Health', s.health != null ? s.health.toFixed(1) + ' / 20' : '—')
      + (s.health != null ? bar(s.health, 20, 6) : '')
      + stat('Food', s.food != null ? s.food + ' / 20' : '—')
      + (s.food != null ? bar(s.food, 20, 6) : '')
      + stat('Position', s.position ? s.position.x + ', ' + s.position.y + ', ' + s.position.z : '—')
      + stat('State', s.brainState)
      + stat('Autopilot', '<span class="dot ' + (s.autopilotEnabled ? 'on' : 'off') + '"></span>' + (s.autopilotEnabled ? 'on' : 'off'))
      + '</div>';

    html += '<div class="card"><h2>Inventory (' + s.inventory.length + ' stacks)</h2><div class="invlist">'
      + (s.inventory.length ? s.inventory.map(i => '<span class="pill">' + i.name + ' ×' + i.count + '</span>').join('') : '<span class="k">empty</span>')
      + '</div></div>';

    if (s.chatAI) {
      html += '<div class="card"><h2>Chat model</h2>'
        + stat('Training steps', s.chatAI.stepCount)
        + stat('Last loss', s.chatAI.lastLoss != null ? s.chatAI.lastLoss.toFixed(3) : 'n/a')
        + stat('Buffer', s.chatAI.bufferChars + ' chars')
        + stat('Params', s.chatAI.paramCount)
        + stat('Vocab', s.chatAI.vocabSize)
        + '</div>';
    }

    if (s.policy) {
      const counts = Object.entries(s.policy.actionCounts).map(([k,v]) => '<span class="pill">' + k + ': ' + v + '</span>').join('');
      html += '<div class="card"><h2>Policy network</h2>'
        + stat('Imitation steps', s.policy.imitationSteps)
        + stat('Reinforce steps', s.policy.reinforceSteps)
        + stat('Avg recent reward', s.policy.avgRecentReward != null ? s.policy.avgRecentReward.toFixed(2) : 'n/a')
        + stat('Params', s.policy.paramCount)
        + '<div style="margin-top:8px">' + counts + '</div>'
        + '</div>';
    }

    if (s.worldMemory) {
      html += '<div class="card"><h2>World memory</h2>'
        + stat('Visited areas', s.worldMemory.visitedCells)
        + stat('Known resources', s.worldMemory.knownResources)
        + stat('Known mob sightings', s.worldMemory.knownMobSightings)
        + '</div>';
    }

    document.getElementById('grid').innerHTML = html;
  } catch (e) {
    document.getElementById('lastUpdate').innerHTML = '<span class="offline">dashboard lost connection to the bot process</span>';
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

function attachDashboard(getBot, config, policy) {
  if (config.dashboardEnabled === false) return null;
  const port = config.dashboardPort || 3333;

  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      const bot = getBot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bot ? buildStatusPayload(bot, policy) : { connected: false, username: null }));
      return;
    }
    if (req.url === '/' || req.url === '') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.on('error', (e) => {
    console.log(`[dashboard] Could not start on port ${port}: ${e.message}`);
  });

  server.listen(port, () => {
    console.log(`[dashboard] Live status at http://localhost:${port}`);
  });

  return { stop: () => server.close() };
}

module.exports = { attachDashboard };
