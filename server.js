/* 5-Card Pineapple — game server.
   Plain Node (18+), no dependencies. Serves the page from ./public and runs the tables:
   it shuffles, deals, keeps every hand private, reveals the turn and river, and scores the showdown.
   Clients talk JSON over POST and receive live state over Server-Sent Events.
   Tables live in memory and are dropped after six idle hours. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./public/engine.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_PLAYERS = 8;
const IDLE_TABLE_MS = 6 * 60 * 60 * 1000;
const RECENT_MS = 20 * 1000;        // a player seen this recently is dealt in even if their stream blipped
const HOST_AWAY_MS = 60 * 1000;     // after this long without the dealer, the next player may deal

const tables = new Map();

/* ---------- helpers ---------- */
const now = () => Date.now();
const rnd = (n) => crypto.randomInt(n);
function randomCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_ALPHABET[rnd(CODE_ALPHABET.length)]; return s; }
function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18); }
function cleanId(s) { return /^[A-Za-z0-9_-]{8,64}$/.test(String(s || '')) ? String(s) : null; }
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 16384) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

/* ---------- tables ---------- */
function createTable(hostId) {
  let code = randomCode();
  while (tables.has(code)) code = randomCode();
  const t = { code, hostId, status: 'lobby', createdAt: now(), updatedAt: now(), handNo: 0, street: 0, board: [], seats: [], results: null, wins: {}, players: new Map(), streams: new Set() };
  tables.set(code, t);
  return t;
}
function touch(t) { t.updatedAt = now(); }
function isPresent(p) { return p.streams > 0 || now() - p.lastSeen < RECENT_MS; }
function effectiveHostId(t) {
  const h = t.players.get(t.hostId);
  if (h && (h.streams > 0 || now() - h.lastSeen < HOST_AWAY_MS)) return t.hostId;
  const next = [...t.players.values()].filter(isPresent).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (next) { t.hostId = next.id; return next.id; }
  return t.hostId;
}
function visibleBoard(t) {
  if (t.status === 'lobby') return [];
  if (t.status === 'showdown') return t.board;
  return t.board.slice(0, 3 + t.street);
}
function viewFor(t, me) {
  effectiveHostId(t);
  const players = [...t.players.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(p => ({
    id: p.id, name: p.name, joinedAt: p.joinedAt, connected: p.streams > 0, present: isPresent(p),
    done: p.handNo === t.handNo ? p.done : 0, seated: t.seats.includes(p.id)
  }));
  const you = me ? { id: me.id, hand: me.handNo === t.handNo ? me.hand : [], mucked: me.handNo === t.handNo ? me.mucked : [], done: me.handNo === t.handNo ? me.done : 0, seated: t.seats.includes(me.id) } : null;
  return { code: t.code, hostId: t.hostId, status: t.status, handNo: t.handNo, street: t.street, board: visibleBoard(t), seats: t.seats, results: t.status === 'showdown' ? t.results : null, wins: t.wins, players, you, serverTime: now() };
}
function send(res, event, data) {
  res.write((event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n');
}
function broadcast(t) {
  touch(t);
  for (const s of t.streams) { try { send(s.res, 'state', viewFor(t, s.player)); } catch (e) { /* dropped on close */ } }
}

function deal(t) {
  const seatPlayers = [...t.players.values()].filter(isPresent).sort((a, b) => a.joinedAt - b.joinedAt);
  if (seatPlayers.length < 2) return 'Two players need to be at the table to deal.';
  const deck = E.shuffle(E.makeDeck(), rnd);
  t.handNo += 1;
  for (const p of seatPlayers) { p.hand = []; p.mucked = []; p.done = 0; p.handNo = t.handNo; }
  for (let k = 0; k < 5; k++) for (const p of seatPlayers) p.hand.push(deck.pop());
  for (const p of seatPlayers) E.sortHand(p.hand);
  t.board = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
  t.seats = seatPlayers.map(p => p.id);
  t.street = 0; t.status = 'playing'; t.results = null;
  return null;
}
function maybeAdvance(t) {
  if (t.status !== 'playing') return;
  const need = t.street + 1;
  const seated = t.seats.map(id => t.players.get(id)).filter(Boolean);
  if (seated.length < 2) { t.seats = seated.map(p => p.id); }
  if (seated.length < 1) { t.status = 'lobby'; return; }
  if (!seated.every(p => p.handNo === t.handNo && p.done >= need)) return;
  if (t.street < 2) { t.street += 1; return; }
  // showdown
  const rows = seated.map(p => {
    const h = E.bestHand(p.hand.concat(t.board));
    return { id: p.id, name: p.name, hole: p.hand, mucked: p.mucked, cat: h.cat, tb: h.tb, used: h.used };
  });
  const score = r => [r.cat].concat(r.tb);
  rows.sort((a, b) => E.cmpScore(score(b), score(a)));
  const winners = rows.filter(r => E.cmpScore(score(r), score(rows[0])) === 0).map(r => r.id);
  for (const w of winners) t.wins[w] = (t.wins[w] || 0) + 1 / winners.length;
  t.results = { rows, winners };
  t.status = 'showdown';
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'tables', CODE?, action?]
  if (parts[1] !== 'tables') return json(res, 404, { error: 'Not found.' });

  // POST /api/tables — open a new table
  if (parts.length === 2 && req.method === 'POST') {
    const body = await readBody(req);
    const id = cleanId(body.playerId), token = cleanId(body.token), name = cleanName(body.name);
    if (!id || !token) return json(res, 400, { error: 'Missing player identity.' });
    if (!name) return json(res, 400, { error: 'Type your name first so the table knows who you are.' });
    const t = createTable(id);
    t.players.set(id, { id, token, name, joinedAt: now(), hand: [], mucked: [], done: 0, handNo: 0, streams: 0, lastSeen: now() });
    return json(res, 200, { code: t.code });
  }

  const code = String(parts[2] || '').toUpperCase();
  const t = tables.get(code);
  const action = parts[3];

  // GET /api/tables/CODE/events?player=&token= — live state
  if (action === 'events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const id = cleanId(url.searchParams.get('player')), token = cleanId(url.searchParams.get('token'));
    const p = t && id ? t.players.get(id) : null;
    if (!t || !p || p.token !== token) { send(res, 'gone', { reason: !t ? 'That table is no longer open.' : 'Your seat at that table is gone.' }); return res.end(); }
    const stream = { res, player: p };
    t.streams.add(stream); p.streams += 1; p.lastSeen = now();
    const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(beat); t.streams.delete(stream); p.streams = Math.max(0, p.streams - 1); p.lastSeen = now(); broadcast(t); });
    broadcast(t);
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const body = await readBody(req);
  const id = cleanId(body.playerId), token = cleanId(body.token);
  if (!id || !token) return json(res, 400, { error: 'Missing player identity.' });

  // POST /api/tables/CODE/join
  if (action === 'join') {
    if (!t) return json(res, 404, { error: 'No open table has the code ' + code + '.' });
    const name = cleanName(body.name);
    if (!name) return json(res, 400, { error: 'Type your name first so the table knows who you are.' });
    let p = t.players.get(id);
    if (p && p.token !== token) return json(res, 403, { error: 'That seat belongs to someone else.' });
    if (!p) {
      if (t.players.size >= MAX_PLAYERS) return json(res, 409, { error: 'That table is full (' + MAX_PLAYERS + ' players).' });
      p = { id, token, name, joinedAt: now(), hand: [], mucked: [], done: 0, handNo: 0, streams: 0, lastSeen: now() };
      t.players.set(id, p);
    } else { p.name = name; p.lastSeen = now(); }
    broadcast(t);
    return json(res, 200, { ok: true });
  }

  if (!t) return json(res, 404, { error: 'That table is no longer open.' });
  const me = t.players.get(id);
  if (!me || me.token !== token) return json(res, 403, { error: 'You are not at this table.' });
  me.lastSeen = now();

  if (action === 'deal') {
    if (effectiveHostId(t) !== me.id) return json(res, 403, { error: 'Only the dealer can deal.' });
    const err = deal(t);
    if (err) return json(res, 409, { error: err });
    broadcast(t);
    return json(res, 200, { ok: true });
  }
  if (action === 'discard') {
    if (t.status !== 'playing' || !t.seats.includes(me.id) || me.handNo !== t.handNo) return json(res, 409, { error: 'You are not in this hand.' });
    if (me.done >= t.street + 1) return json(res, 409, { error: 'You have already thrown away a card this street.' });
    const idx = me.hand.findIndex(c => E.cardId(c) === String(body.cardId));
    if (idx < 0) return json(res, 400, { error: 'That card is not in your hand.' });
    me.mucked.push(me.hand.splice(idx, 1)[0]);
    me.done = 5 - me.hand.length;
    maybeAdvance(t);
    broadcast(t);
    return json(res, 200, { ok: true });
  }
  if (action === 'leave') {
    t.players.delete(me.id);
    for (const s of [...t.streams]) if (s.player === me) { try { send(s.res, 'gone', { reason: 'You left the table.' }); s.res.end(); } catch (e) {} t.streams.delete(s); }
    t.seats = t.seats.filter(x => x !== me.id);
    if (t.players.size === 0) { tables.delete(t.code); return json(res, 200, { ok: true }); }
    if (t.hostId === me.id) effectiveHostId(t);
    maybeAdvance(t);
    broadcast(t);
    return json(res, 200, { ok: true });
  }
  if (action === 'close') {
    if (effectiveHostId(t) !== me.id) return json(res, 403, { error: 'Only the dealer can close the table.' });
    for (const s of [...t.streams]) { try { send(s.res, 'gone', { reason: 'The dealer closed the table.' }); s.res.end(); } catch (e) {} }
    tables.delete(t.code);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Unknown action.' });
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden.' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found.' });
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (url.pathname === '/healthz') json(res, 200, { ok: true, tables: tables.size });
    else serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message === 'bad json' || e.message === 'too large' ? 'Bad request.' : 'Something went wrong on the server.' });
    else { try { res.end(); } catch (_) {} }
  }
});

setInterval(() => {
  const cutoff = now() - IDLE_TABLE_MS;
  for (const [code, t] of tables) if (t.updatedAt < cutoff && t.streams.size === 0) tables.delete(code);
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log('5-Card Pineapple is listening on port ' + PORT));
