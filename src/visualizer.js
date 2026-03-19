/**
 * IOTAI DAG Visualizer
 *
 * Generates an interactive HTML visualization of the Tangle.
 * Opens in the browser - shows nodes, connections, balances, and tx details.
 */

import { createServer } from 'http';
import { DAG } from './core/dag.js';
import { Wallet } from './wallet/wallet.js';

const PORT = parseInt(process.argv[2] || '3000', 10);

// Build a demo DAG with multiple branches
const dag = new DAG();
const genesis = dag.initialize(1_000_000_000);

const agents = [
  { name: 'Alpha', wallet: new Wallet({ passphrase: 'agent-alpha-2024' }), color: '#6C5CE7' },
  { name: 'Beta', wallet: new Wallet({ passphrase: 'agent-beta-2024' }), color: '#00B894' },
  { name: 'Gamma', wallet: new Wallet({ passphrase: 'agent-gamma-2024' }), color: '#E17055' },
  { name: 'Delta', wallet: new Wallet({ passphrase: 'agent-delta-2024' }), color: '#0984E3' },
];

// Fund agents
for (const a of agents) {
  dag.balances.set(a.wallet.address, 50_000);
}
dag.balances.set('iotai_genesis', 1_000_000_000 - 200_000);

// Create transactions with branching structure
const txIds = [genesis.id];

function addTx(senderIdx, receiverIdx, amount, meta) {
  const sender = agents[senderIdx];
  const receiver = agents[receiverIdx];
  // Pick two different parents when possible
  const p1 = txIds[Math.max(0, txIds.length - 1)];
  const p2 = txIds[Math.max(0, txIds.length - 2)];
  const tx = sender.wallet.send(receiver.wallet.address, amount, [p1, p2], {
    from: sender.name,
    to: receiver.name,
    purpose: meta,
  });
  const result = dag.addTransaction(tx);
  if (result.success) txIds.push(tx.id);
  return tx;
}

// Build a richer DAG with branches
addTx(0, 1, 100, 'API call payment');
addTx(1, 2, 50, 'GPU rental');
addTx(2, 3, 30, 'Data analysis');
addTx(0, 2, 200, 'Model training');
addTx(3, 0, 75, 'Inference result');
addTx(1, 3, 120, 'Storage fee');
addTx(2, 0, 45, 'Callback payment');
addTx(0, 3, 90, 'Agent subscription');
addTx(3, 1, 60, 'Report generation');
addTx(1, 0, 35, 'Notification fee');
addTx(2, 1, 80, 'Compute credits');
addTx(0, 1, 150, 'Bulk API access');
addTx(3, 2, 40, 'Cache service');
addTx(1, 2, 65, 'Priority queue');
addTx(0, 3, 110, 'Premium agent tier');

// Build the JSON data for the frontend
function buildGraphData() {
  const nodes = [];
  const edges = [];
  const agentAddresses = {};
  for (const a of agents) {
    agentAddresses[a.wallet.address] = { name: a.name, color: a.color };
  }

  for (const [id, tx] of dag.transactions) {
    const sender = agentAddresses[tx.from];
    nodes.push({
      id: tx.id,
      short: tx.id.substring(0, 10),
      type: tx.type,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      timestamp: tx.timestamp,
      weight: tx.cumulativeWeight,
      senderName: sender?.name || (tx.type === 'genesis' ? 'Genesis' : 'Unknown'),
      color: sender?.color || '#FDCB6E',
      metadata: tx.metadata,
    });

    for (const parentId of tx.parents) {
      edges.push({ from: tx.id, to: parentId });
    }
  }

  return { nodes, edges, stats: dag.getStats(), agents: agents.map(a => ({
    name: a.name,
    address: a.wallet.address,
    balance: dag.getBalance(a.wallet.address),
    color: a.color,
  }))};
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>IOTAI - DAG Visualizer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a1a;
    color: #e0e0e0;
    font-family: 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
  }
  #header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 100%);
    border-bottom: 1px solid #333;
    padding: 12px 24px;
    display: flex; align-items: center; gap: 20px;
  }
  #header h1 {
    font-size: 22px;
    background: linear-gradient(90deg, #6C5CE7, #00B894);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .stat-box {
    background: #1a1a3e; border: 1px solid #333; border-radius: 8px;
    padding: 6px 14px; font-size: 13px;
  }
  .stat-box span { color: #00B894; font-weight: bold; }
  #sidebar {
    position: fixed; right: 0; top: 56px; bottom: 0; width: 320px; z-index: 90;
    background: #0d0d24; border-left: 1px solid #333;
    padding: 16px; overflow-y: auto;
  }
  #sidebar h3 { color: #6C5CE7; margin-bottom: 12px; font-size: 15px; }
  .agent-card {
    background: #1a1a3e; border-radius: 8px; padding: 10px 14px;
    margin-bottom: 8px; border-left: 3px solid;
  }
  .agent-card .name { font-weight: bold; font-size: 14px; }
  .agent-card .addr { font-size: 10px; color: #888; font-family: monospace; margin-top: 2px; }
  .agent-card .bal { font-size: 13px; color: #00B894; margin-top: 4px; }
  #tx-detail {
    background: #1a1a3e; border-radius: 8px; padding: 12px;
    margin-top: 16px; display: none; font-size: 12px;
  }
  #tx-detail h4 { color: #FDCB6E; margin-bottom: 8px; }
  #tx-detail .row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #222; }
  #tx-detail .label { color: #888; }
  #tx-detail .value { color: #e0e0e0; font-family: monospace; text-align: right; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  canvas {
    position: fixed; top: 56px; left: 0; right: 320px; bottom: 0;
  }
  #tooltip {
    position: fixed; display: none; background: #1a1a3eee;
    border: 1px solid #6C5CE7; border-radius: 6px;
    padding: 8px 12px; font-size: 12px; pointer-events: none; z-index: 200;
    max-width: 250px;
  }
  #legend {
    position: fixed; bottom: 16px; left: 16px; z-index: 100;
    background: #1a1a3ecc; border-radius: 8px; padding: 10px 16px;
    font-size: 12px; display: flex; gap: 16px;
  }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
</style>
</head>
<body>

<div id="header">
  <h1>IOTAI Tangle</h1>
  <div class="stat-box">Transactions: <span id="s-tx">0</span></div>
  <div class="stat-box">Tips: <span id="s-tips">0</span></div>
  <div class="stat-box">Addresses: <span id="s-addr">0</span></div>
  <div class="stat-box">Nonces: <span id="s-nonces">0</span></div>
</div>

<canvas id="canvas"></canvas>

<div id="sidebar">
  <h3>AI Agents</h3>
  <div id="agents-list"></div>
  <div id="tx-detail">
    <h4>Transaction Details</h4>
    <div id="tx-rows"></div>
  </div>
</div>

<div id="tooltip"></div>

<div id="legend"></div>

<script>
const DATA = __DATA__;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let W, H;

function resize() {
  W = window.innerWidth - 320;
  H = window.innerHeight - 56;
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
resize();
window.addEventListener('resize', () => { resize(); render(); });

// Stats
document.getElementById('s-tx').textContent = DATA.stats.totalTransactions;
document.getElementById('s-tips').textContent = DATA.stats.tipCount;
document.getElementById('s-addr').textContent = DATA.stats.uniqueAddresses;
document.getElementById('s-nonces').textContent = DATA.stats.usedNonces;

// Agents sidebar
const agentsList = document.getElementById('agents-list');
DATA.agents.forEach(a => {
  agentsList.innerHTML += '<div class="agent-card" style="border-color:' + a.color + '">' +
    '<div class="name" style="color:' + a.color + '">' + a.name + '</div>' +
    '<div class="addr">' + a.address.substring(0, 30) + '...</div>' +
    '<div class="bal">' + a.balance.toLocaleString() + ' IOTAI</div></div>';
});

// Legend
const legendEl = document.getElementById('legend');
legendEl.innerHTML = '<div class="legend-item"><div class="legend-dot" style="background:#FDCB6E"></div>Genesis</div>';
DATA.agents.forEach(a => {
  legendEl.innerHTML += '<div class="legend-item"><div class="legend-dot" style="background:' + a.color + '"></div>' + a.name + '</div>';
});

// Layout nodes in a DAG-like arrangement
const nodeMap = {};
DATA.nodes.forEach(n => nodeMap[n.id] = n);

// Assign depth (topological order)
const depths = {};
function getDepth(id) {
  if (depths[id] !== undefined) return depths[id];
  const node = nodeMap[id];
  if (!node || node.type === 'genesis') { depths[id] = 0; return 0; }
  const parentEdges = DATA.edges.filter(e => e.from === id);
  let maxParent = 0;
  parentEdges.forEach(e => { maxParent = Math.max(maxParent, getDepth(e.to) + 1); });
  depths[id] = maxParent;
  return maxParent;
}
DATA.nodes.forEach(n => getDepth(n.id));

const maxDepth = Math.max(...Object.values(depths), 1);

// Group by depth
const byDepth = {};
DATA.nodes.forEach(n => {
  const d = depths[n.id];
  if (!byDepth[d]) byDepth[d] = [];
  byDepth[d].push(n);
});

// Position nodes
const positions = {};
const MARGIN_X = 100;
const MARGIN_Y = 80;

Object.entries(byDepth).forEach(([d, nodes]) => {
  const di = parseInt(d);
  const x = MARGIN_X + (di / maxDepth) * (W - MARGIN_X * 2);
  const totalH = H - MARGIN_Y * 2;
  nodes.forEach((n, i) => {
    const y = MARGIN_Y + (nodes.length === 1 ? totalH / 2 : (i / (nodes.length - 1)) * totalH);
    positions[n.id] = { x, y };
  });
});

// Camera / pan & zoom
let camX = 0, camY = 0, zoom = 1;
let dragging = false, dragX = 0, dragY = 0;

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  zoom = Math.max(0.2, Math.min(5, zoom * factor));
  render();
});

canvas.addEventListener('mousedown', e => {
  dragging = true; dragX = e.clientX; dragY = e.clientY;
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('mousemove', e => {
  if (dragging) {
    camX += e.clientX - dragX;
    camY += e.clientY - dragY;
    dragX = e.clientX; dragY = e.clientY;
    render();
  }
  // Tooltip
  const mx = (e.clientX - camX) / zoom;
  const my = (e.clientY - 56 - camY) / zoom;
  let hovered = null;
  DATA.nodes.forEach(n => {
    const p = positions[n.id];
    const r = 18 + Math.min(n.weight * 1.5, 20);
    if (Math.hypot(p.x - mx, p.y - my) < r) hovered = n;
  });
  const tip = document.getElementById('tooltip');
  if (hovered) {
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
    tip.innerHTML = '<div style="color:' + hovered.color + ';font-weight:bold">' + hovered.senderName + '</div>' +
      '<div>' + (hovered.type === 'genesis' ? 'Genesis Block' : hovered.amount + ' IOTAI') + '</div>' +
      '<div style="color:#888;font-size:11px">Weight: ' + hovered.weight + '</div>' +
      '<div style="color:#888;font-size:11px">' + hovered.short + '...</div>';
    canvas.style.cursor = 'pointer';
  } else {
    tip.style.display = 'none';
    if (!dragging) canvas.style.cursor = 'grab';
  }
});

canvas.addEventListener('mouseup', () => { dragging = false; canvas.style.cursor = 'grab'; });

canvas.addEventListener('click', e => {
  const mx = (e.clientX - camX) / zoom;
  const my = (e.clientY - 56 - camY) / zoom;
  let clicked = null;
  DATA.nodes.forEach(n => {
    const p = positions[n.id];
    const r = 18 + Math.min(n.weight * 1.5, 20);
    if (Math.hypot(p.x - mx, p.y - my) < r) clicked = n;
  });
  showDetail(clicked);
});

function showDetail(n) {
  const el = document.getElementById('tx-detail');
  const rows = document.getElementById('tx-rows');
  if (!n) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  let html = '';
  const fields = [
    ['ID', n.short + '...'],
    ['Type', n.type],
    ['From', n.senderName + ' (' + n.from.substring(0, 16) + '...)'],
    ['To', n.to.substring(0, 24) + '...'],
    ['Amount', n.amount.toLocaleString() + ' IOTAI'],
    ['Weight', n.weight],
    ['Time', new Date(n.timestamp).toLocaleTimeString()],
  ];
  if (n.metadata?.purpose) fields.push(['Purpose', n.metadata.purpose]);
  fields.forEach(([l, v]) => {
    html += '<div class="row"><span class="label">' + l + '</span><span class="value">' + v + '</span></div>';
  });
  rows.innerHTML = html;
}

// Render
function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(camX, camY);
  ctx.scale(zoom, zoom);

  // Draw edges
  DATA.edges.forEach(e => {
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to) return;

    const fromNode = nodeMap[e.from];
    ctx.beginPath();
    ctx.strokeStyle = (fromNode?.color || '#444') + '44';
    ctx.lineWidth = 1.5;

    // Curved edges
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2 - 20;
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(cx, cy, to.x, to.y);
    ctx.stroke();

    // Arrow
    const angle = Math.atan2(to.y - cy, to.x - cx);
    const arrowLen = 8;
    ctx.beginPath();
    ctx.fillStyle = (fromNode?.color || '#444') + '66';
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - arrowLen * Math.cos(angle - 0.4), to.y - arrowLen * Math.sin(angle - 0.4));
    ctx.lineTo(to.x - arrowLen * Math.cos(angle + 0.4), to.y - arrowLen * Math.sin(angle + 0.4));
    ctx.fill();
  });

  // Draw nodes
  DATA.nodes.forEach(n => {
    const p = positions[n.id];
    const r = 18 + Math.min(n.weight * 1.5, 20);

    // Glow
    const glow = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, r * 2);
    glow.addColorStop(0, n.color + '33');
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.fillRect(p.x - r * 2, p.y - r * 2, r * 4, r * 4);

    // Circle
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.color + '22';
    ctx.fill();
    ctx.strokeStyle = n.color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(n.senderName, p.x, p.y - 4);

    if (n.type !== 'genesis') {
      ctx.font = '10px monospace';
      ctx.fillStyle = n.color;
      ctx.fillText(n.amount + ' IOTAI', p.x, p.y + 10);
    } else {
      ctx.font = '9px monospace';
      ctx.fillStyle = '#FDCB6E';
      ctx.fillText('GENESIS', p.x, p.y + 10);
    }

    // Weight badge
    ctx.fillStyle = '#0a0a1a';
    ctx.beginPath();
    ctx.arc(p.x + r * 0.7, p.y - r * 0.7, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 8px sans-serif';
    ctx.fillText(n.weight, p.x + r * 0.7, p.y - r * 0.7 + 3);
  });

  ctx.restore();
}

render();
canvas.style.cursor = 'grab';
</script>
</body>
</html>`;

// Start HTTP server
const server = createServer((req, res) => {
  const graphData = buildGraphData();
  const html = HTML.replace('__DATA__', JSON.stringify(graphData));
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`\n  IOTAI DAG Visualizer running at: http://localhost:${PORT}\n`);
  console.log(`  - Click on nodes to see transaction details`);
  console.log(`  - Scroll to zoom in/out`);
  console.log(`  - Drag to pan`);
  console.log(`  - Press Ctrl+C to stop\n`);
});
