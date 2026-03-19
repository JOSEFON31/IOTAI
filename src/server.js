/**
 * IOTAI Standalone Server
 *
 * For cloud deployment (Render, Railway, etc.)
 * Serves: Documentation site + API + DAG Visualizer
 * No P2P (cloud servers don't support it on free tiers)
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { DAG } from './core/dag.js';
import { Wallet } from './wallet/wallet.js';
import { Faucet } from './core/faucet.js';
import { Storage } from './core/storage.js';
import {
  hash,
  generateNonce,
  generateKeyPair,
  publicKeyToAddress,
  encodePublicKey,
} from './core/crypto.js';
import { verifyTransaction } from './core/transaction.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCS_DIR = resolve(__dirname, '../docs');
const PORT = parseInt(process.env.PORT || '8080', 10);

// ---- Initialize DAG ----
const dag = new DAG();
const faucet = new Faucet(dag);
const storage = new Storage({ dag, faucet, autoSaveInterval: 30000 });

// Try to load existing data, otherwise initialize fresh
const loaded = storage.load();
if (!loaded) {
  dag.initialize(1_000_000_000);
  console.log('[Init] Fresh DAG initialized with 1B IOTAI supply');
} else {
  console.log('[Init] Restored DAG from disk');
}

// Sessions: token -> { wallet, expiresAt }
const sessions = new Map();
const TOKEN_TTL = 60 * 60 * 1000;

// Demo agents for visualizer labels
const demoAgents = [
  { name: 'Alpha', wallet: new Wallet({ passphrase: 'agent-alpha-2024' }), color: '#6C5CE7' },
  { name: 'Beta', wallet: new Wallet({ passphrase: 'agent-beta-2024' }), color: '#00B894' },
  { name: 'Gamma', wallet: new Wallet({ passphrase: 'agent-gamma-2024' }), color: '#E17055' },
  { name: 'Delta', wallet: new Wallet({ passphrase: 'agent-delta-2024' }), color: '#0984E3' },
];

// Only seed demo data on fresh start
if (!loaded) {
  for (const a of demoAgents) {
    dag.balances.set(a.wallet.address, 50_000);
  }
  dag.balances.set('iotai_genesis', 1_000_000_000 - 200_000);

  const txIds = [dag.genesisId];
  function addDemoTx(si, ri, amount, meta) {
    const s = demoAgents[si], r = demoAgents[ri];
    const p1 = txIds[txIds.length - 1], p2 = txIds[Math.max(0, txIds.length - 2)];
    const tx = s.wallet.send(r.wallet.address, amount, [p1, p2], { from: s.name, to: r.name, purpose: meta });
    if (dag.addTransaction(tx).success) txIds.push(tx.id);
  }
  addDemoTx(0,1,100,'API call payment');
  addDemoTx(1,2,50,'GPU rental');
  addDemoTx(2,3,30,'Data analysis');
  addDemoTx(0,2,200,'Model training');
  addDemoTx(3,0,75,'Inference result');
  addDemoTx(1,3,120,'Storage fee');
  addDemoTx(2,0,45,'Callback payment');
  addDemoTx(0,3,90,'Agent subscription');
  addDemoTx(3,1,60,'Report generation');

  // Save initial state immediately
  storage.save();
  console.log('[Init] Demo data seeded and saved');
}

// Start auto-save
storage.start();

// ---- Visualizer HTML builder ----
function buildVisualizerHTML() {
  const agentAddresses = {};
  for (const a of demoAgents) agentAddresses[a.wallet.address] = { name: a.name, color: a.color };

  const nodes = [], edges = [];
  for (const [id, tx] of dag.transactions) {
    const sender = agentAddresses[tx.from];
    nodes.push({
      id: tx.id, short: tx.id.substring(0,10), type: tx.type,
      from: tx.from, to: tx.to, amount: tx.amount, timestamp: tx.timestamp,
      weight: tx.cumulativeWeight,
      senderName: sender?.name || (tx.type === 'genesis' ? 'Genesis' : 'Unknown'),
      color: sender?.color || '#FDCB6E', metadata: tx.metadata,
    });
    for (const pid of tx.parents) edges.push({ from: tx.id, to: pid });
  }

  const data = {
    nodes, edges, stats: dag.getStats(),
    agents: demoAgents.map(a => ({
      name: a.name, address: a.wallet.address,
      balance: dag.getBalance(a.wallet.address), color: a.color,
    })),
  };

  return getVisualizerTemplate().replace('__DATA__', JSON.stringify(data));
}

// ---- HTTP Server ----
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ---- Visualizer ----
    if (path === '/visualizer' || path === '/visualizer/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(buildVisualizerHTML());
      return;
    }

    // ---- API Routes ----
    if (path.startsWith('/api/')) {
      const body = await readBody(req);
      const result = await handleAPI(req, path, body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.data));
      return;
    }

    // ---- Static docs ----
    serveStatic(res, path);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ---- API Handler ----
async function handleAPI(req, path, body) {
  const method = req.method;

  // Public
  if (method === 'POST' && path === '/api/v1/wallet/create') {
    const w = body?.passphrase ? new Wallet({ passphrase: body.passphrase }) : new Wallet();
    const token = genToken();
    sessions.set(token, { wallet: w, expiresAt: Date.now() + TOKEN_TTL });
    return { status: 201, data: { address: w.address, publicKey: encodePublicKey(w.publicKey), token, expiresIn: TOKEN_TTL } };
  }
  if (method === 'POST' && path === '/api/v1/auth/token') {
    if (!body?.passphrase) return { status: 400, data: { error: 'passphrase required' } };
    const w = new Wallet({ passphrase: body.passphrase });
    const token = genToken();
    sessions.set(token, { wallet: w, expiresAt: Date.now() + TOKEN_TTL });
    return { status: 200, data: { address: w.address, token, expiresIn: TOKEN_TTL } };
  }
  if (method === 'GET' && path === '/api/v1/network/stats') {
    return { status: 200, data: { ...dag.getStats(), faucet: faucet.getStatus(), storage: storage.getStats() } };
  }
  if (method === 'GET' && path === '/api/v1/faucet/status') {
    return { status: 200, data: faucet.getStatus() };
  }
  if (method === 'POST' && path === '/api/v1/faucet/start') {
    try {
      return { status: 200, data: faucet.startVerification() };
    } catch (e) { return { status: 400, data: { error: e.message } }; }
  }
  if (method === 'POST' && path === '/api/v1/faucet/claim') {
    if (!body?.challengeId || !body?.faceEmbedding || !body?.address)
      return { status: 400, data: { error: 'Required: challengeId, faceEmbedding, address' } };
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const result = await faucet.claimTokens({ ...body, livenessPass: body.livenessPass ?? false, ip });
    return { status: result.success ? 200 : 400, data: result };
  }

  // Auth required
  const session = authenticate(req);
  if (!session) return { status: 401, data: { error: 'Invalid or expired token' } };

  if (method === 'POST' && path === '/api/v1/transfer') {
    if (!body?.to || !body?.amount) return { status: 400, data: { error: 'Required: to, amount' } };
    const tips = dag.selectTips();
    const tx = session.wallet.send(body.to, body.amount, tips, body.metadata || null);
    const v = verifyTransaction(tx);
    if (!v.valid) return { status: 400, data: { error: v.error } };
    const r = dag.addTransaction(tx);
    if (!r.success) return { status: 400, data: { error: r.error } };
    return { status: 200, data: { txId: tx.id, from: tx.from, to: tx.to, amount: tx.amount, status: 'confirmed' } };
  }
  if (method === 'POST' && path === '/api/v1/data') {
    if (!body?.metadata) return { status: 400, data: { error: 'Required: metadata' } };
    const tips = dag.selectTips();
    const tx = session.wallet.sendData(tips, body.metadata);
    dag.addTransaction(tx);
    return { status: 200, data: { txId: tx.id, metadata: tx.metadata } };
  }
  if (method === 'GET' && path === '/api/v1/balance') {
    return { status: 200, data: { address: session.wallet.address, balance: dag.getBalance(session.wallet.address), unit: 'IOTAI' } };
  }
  if (method === 'GET' && path === '/api/v1/history') {
    const h = dag.getHistory(session.wallet.address);
    return { status: 200, data: { address: session.wallet.address, transactions: h } };
  }
  if (method === 'GET' && path.startsWith('/api/v1/tx/')) {
    const txId = path.split('/api/v1/tx/')[1];
    const tx = dag.getTransaction(txId);
    return tx ? { status: 200, data: tx } : { status: 404, data: { error: 'Not found' } };
  }

  return { status: 404, data: { error: 'Not found' } };
}

// ---- Helpers ----
function authenticate(req) {
  const h = req.headers['authorization'];
  if (!h?.startsWith('Bearer ')) return null;
  const s = sessions.get(h.substring(7));
  if (!s || Date.now() > s.expiresAt) return null;
  return s;
}

function genToken() { return hash(generateNonce() + Date.now()); }

function readBody(req) {
  return new Promise(r => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } });
  });
}

function serveStatic(res, pathname) {
  const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
  let fp = pathname === '/' ? '/index.html' : pathname;
  fp = fp.replace(/\.\./g, '');
  try {
    const content = readFileSync(resolve(DOCS_DIR, '.' + fp));
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'text/plain' });
    res.end(content);
  } catch {
    try {
      const content = readFileSync(resolve(DOCS_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  }
}

function getVisualizerTemplate() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>IOTAI - DAG Visualizer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a1a;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden}
#header{position:fixed;top:0;left:0;right:0;z-index:100;background:linear-gradient(135deg,#0a0a1a,#1a1a3e);border-bottom:1px solid #333;padding:12px 24px;display:flex;align-items:center;gap:20px}
#header h1{font-size:22px;background:linear-gradient(90deg,#6C5CE7,#00B894);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-box{background:#1a1a3e;border:1px solid #333;border-radius:8px;padding:6px 14px;font-size:13px}
.stat-box span{color:#00B894;font-weight:bold}
#sidebar{position:fixed;right:0;top:56px;bottom:0;width:320px;z-index:90;background:#0d0d24;border-left:1px solid #333;padding:16px;overflow-y:auto}
#sidebar h3{color:#6C5CE7;margin-bottom:12px;font-size:15px}
.agent-card{background:#1a1a3e;border-radius:8px;padding:10px 14px;margin-bottom:8px;border-left:3px solid}
.agent-card .name{font-weight:bold;font-size:14px}
.agent-card .addr{font-size:10px;color:#888;font-family:monospace;margin-top:2px}
.agent-card .bal{font-size:13px;color:#00B894;margin-top:4px}
#tx-detail{background:#1a1a3e;border-radius:8px;padding:12px;margin-top:16px;display:none;font-size:12px}
#tx-detail h4{color:#FDCB6E;margin-bottom:8px}
#tx-detail .row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #222}
#tx-detail .label{color:#888}
#tx-detail .value{color:#e0e0e0;font-family:monospace;text-align:right;max-width:180px;overflow:hidden;text-overflow:ellipsis}
canvas{position:fixed;top:56px;left:0;right:320px;bottom:0}
#tooltip{position:fixed;display:none;background:#1a1a3eee;border:1px solid #6C5CE7;border-radius:6px;padding:8px 12px;font-size:12px;pointer-events:none;z-index:200;max-width:250px}
#legend{position:fixed;bottom:16px;left:16px;z-index:100;background:#1a1a3ecc;border-radius:8px;padding:10px 16px;font-size:12px;display:flex;gap:16px}
.legend-item{display:flex;align-items:center;gap:6px}
.legend-dot{width:10px;height:10px;border-radius:50%}
@media(max-width:768px){#sidebar{width:200px}canvas{right:200px}}
</style>
</head>
<body>
<div id="header">
<h1>IOTAI Tangle</h1>
<div class="stat-box">Transactions: <span id="s-tx">0</span></div>
<div class="stat-box">Tips: <span id="s-tips">0</span></div>
<div class="stat-box">Addresses: <span id="s-addr">0</span></div>
</div>
<canvas id="canvas"></canvas>
<div id="sidebar"><h3>AI Agents</h3><div id="agents-list"></div><div id="tx-detail"><h4>Transaction Details</h4><div id="tx-rows"></div></div></div>
<div id="tooltip"></div>
<div id="legend"></div>
<script>
const DATA=__DATA__;
const canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d');let W,H;
function resize(){W=window.innerWidth-320;H=window.innerHeight-56;canvas.width=W*devicePixelRatio;canvas.height=H*devicePixelRatio;canvas.style.width=W+'px';canvas.style.height=H+'px';ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0)}
resize();window.addEventListener('resize',()=>{resize();render()});
document.getElementById('s-tx').textContent=DATA.stats.totalTransactions;
document.getElementById('s-tips').textContent=DATA.stats.tipCount;
document.getElementById('s-addr').textContent=DATA.stats.uniqueAddresses;
const agentsList=document.getElementById('agents-list');
DATA.agents.forEach(a=>{agentsList.innerHTML+='<div class="agent-card" style="border-color:'+a.color+'"><div class="name" style="color:'+a.color+'">'+a.name+'</div><div class="addr">'+a.address.substring(0,30)+'...</div><div class="bal">'+a.balance.toLocaleString()+' IOTAI</div></div>'});
const legendEl=document.getElementById('legend');
legendEl.innerHTML='<div class="legend-item"><div class="legend-dot" style="background:#FDCB6E"></div>Genesis</div>';
DATA.agents.forEach(a=>{legendEl.innerHTML+='<div class="legend-item"><div class="legend-dot" style="background:'+a.color+'"></div>'+a.name+'</div>'});
const nodeMap={};DATA.nodes.forEach(n=>nodeMap[n.id]=n);
const depths={};
function getDepth(id){if(depths[id]!==undefined)return depths[id];const node=nodeMap[id];if(!node||node.type==='genesis'){depths[id]=0;return 0}const pe=DATA.edges.filter(e=>e.from===id);let m=0;pe.forEach(e=>{m=Math.max(m,getDepth(e.to)+1)});depths[id]=m;return m}
DATA.nodes.forEach(n=>getDepth(n.id));const maxDepth=Math.max(...Object.values(depths),1);
const byDepth={};DATA.nodes.forEach(n=>{const d=depths[n.id];if(!byDepth[d])byDepth[d]=[];byDepth[d].push(n)});
const positions={};const MX=100,MY=80;
Object.entries(byDepth).forEach(([d,nodes])=>{const di=parseInt(d);const x=MX+(di/maxDepth)*(W-MX*2);const tH=H-MY*2;nodes.forEach((n,i)=>{const y=MY+(nodes.length===1?tH/2:(i/(nodes.length-1))*tH);positions[n.id]={x,y}})});
let camX=0,camY=0,zoom=1,dragging=false,dragX=0,dragY=0;
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(0.2,Math.min(5,zoom*(e.deltaY>0?0.9:1.1)));render()});
canvas.addEventListener('mousedown',e=>{dragging=true;dragX=e.clientX;dragY=e.clientY;canvas.style.cursor='grabbing'});
canvas.addEventListener('mousemove',e=>{if(dragging){camX+=e.clientX-dragX;camY+=e.clientY-dragY;dragX=e.clientX;dragY=e.clientY;render()}const mx=(e.clientX-camX)/zoom,my=(e.clientY-56-camY)/zoom;let hovered=null;DATA.nodes.forEach(n=>{const p=positions[n.id];const r=18+Math.min(n.weight*1.5,20);if(Math.hypot(p.x-mx,p.y-my)<r)hovered=n});const tip=document.getElementById('tooltip');if(hovered){tip.style.display='block';tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY+14)+'px';tip.innerHTML='<div style="color:'+hovered.color+';font-weight:bold">'+hovered.senderName+'</div><div>'+(hovered.type==='genesis'?'Genesis Block':hovered.amount+' IOTAI')+'</div><div style="color:#888;font-size:11px">Weight: '+hovered.weight+'</div>';canvas.style.cursor='pointer'}else{tip.style.display='none';if(!dragging)canvas.style.cursor='grab'}});
canvas.addEventListener('mouseup',()=>{dragging=false;canvas.style.cursor='grab'});
canvas.addEventListener('click',e=>{const mx=(e.clientX-camX)/zoom,my=(e.clientY-56-camY)/zoom;let clicked=null;DATA.nodes.forEach(n=>{const p=positions[n.id];const r=18+Math.min(n.weight*1.5,20);if(Math.hypot(p.x-mx,p.y-my)<r)clicked=n});showDetail(clicked)});
function showDetail(n){const el=document.getElementById('tx-detail'),rows=document.getElementById('tx-rows');if(!n){el.style.display='none';return}el.style.display='block';let h='';[['ID',n.short+'...'],['Type',n.type],['From',n.senderName],['To',n.to.substring(0,20)+'...'],['Amount',n.amount+' IOTAI'],['Weight',n.weight],['Time',new Date(n.timestamp).toLocaleTimeString()]].forEach(([l,v])=>{h+='<div class="row"><span class="label">'+l+'</span><span class="value">'+v+'</span></div>'});if(n.metadata?.purpose)h+='<div class="row"><span class="label">Purpose</span><span class="value">'+n.metadata.purpose+'</span></div>';rows.innerHTML=h}
function render(){ctx.clearRect(0,0,W,H);ctx.save();ctx.translate(camX,camY);ctx.scale(zoom,zoom);
DATA.edges.forEach(e=>{const from=positions[e.from],to=positions[e.to];if(!from||!to)return;const fn=nodeMap[e.from];ctx.beginPath();ctx.strokeStyle=(fn?.color||'#444')+'44';ctx.lineWidth=1.5;const cx=(from.x+to.x)/2,cy=(from.y+to.y)/2-20;ctx.moveTo(from.x,from.y);ctx.quadraticCurveTo(cx,cy,to.x,to.y);ctx.stroke();const angle=Math.atan2(to.y-cy,to.x-cx);ctx.beginPath();ctx.fillStyle=(fn?.color||'#444')+'66';ctx.moveTo(to.x,to.y);ctx.lineTo(to.x-8*Math.cos(angle-0.4),to.y-8*Math.sin(angle-0.4));ctx.lineTo(to.x-8*Math.cos(angle+0.4),to.y-8*Math.sin(angle+0.4));ctx.fill()});
DATA.nodes.forEach(n=>{const p=positions[n.id];const r=18+Math.min(n.weight*1.5,20);const glow=ctx.createRadialGradient(p.x,p.y,r*0.5,p.x,p.y,r*2);glow.addColorStop(0,n.color+'33');glow.addColorStop(1,'transparent');ctx.fillStyle=glow;ctx.fillRect(p.x-r*2,p.y-r*2,r*4,r*4);ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fillStyle=n.color+'22';ctx.fill();ctx.strokeStyle=n.color;ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#fff';ctx.font='bold 11px monospace';ctx.textAlign='center';ctx.fillText(n.senderName,p.x,p.y-4);ctx.font='10px monospace';ctx.fillStyle=n.color;ctx.fillText(n.type==='genesis'?'GENESIS':n.amount+' IOTAI',p.x,p.y+10);ctx.fillStyle='#0a0a1a';ctx.beginPath();ctx.arc(p.x+r*0.7,p.y-r*0.7,9,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#888';ctx.lineWidth=1;ctx.stroke();ctx.fillStyle='#fff';ctx.font='bold 8px sans-serif';ctx.fillText(n.weight,p.x+r*0.7,p.y-r*0.7+3)});
ctx.restore()}
render();canvas.style.cursor='grab';
</script></body></html>`;
}

// ---- Start ----
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ██╗ ██████╗ ████████╗ █████╗ ██╗');
  console.log('  ██║██╔═══██╗╚══██╔══╝██╔══██╗██║');
  console.log('  ██║██║   ██║   ██║   ███████║██║');
  console.log('  ██║██║   ██║   ██║   ██╔══██║██║');
  console.log('  ██║╚██████╔╝   ██║   ██║  ██║██║');
  console.log('  ╚═╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝');
  console.log('');
  console.log(`  Server running on port ${PORT}`);
  console.log(`  Docs:       http://localhost:${PORT}/`);
  console.log(`  Visualizer: http://localhost:${PORT}/visualizer`);
  console.log(`  API:        http://localhost:${PORT}/api/v1/...`);
  console.log('');
});
