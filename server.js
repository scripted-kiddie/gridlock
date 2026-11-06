// Gridlock - single-file game server for Val Town (@sosasquad).
// Wraps the verified engine core (engine.js) with a lobby, polling JSON API,
// bot seat fill, and a 30 second turn timer with bot takeover.
//
// Run on Val Town: this file is an HTTP val. Its default export is a standard
// fetch handler (Request -> Response), which is what Val Town serves.
// Run locally:   node server.js            (PORT env, default 8787)
// Test locally:  node test-server.mjs      (boots this file on a test port)
//
// Storage: games live in an in-memory store scoped to the running instance.
// Matches last under 10 minutes and clients poll every 2 seconds, so a warm
// instance covers a whole match. If the Val Town SQLite std library is
// reachable at runtime the store still stays in memory for v1 on purpose:
// one source of truth, no dual-write drift. SQLite persistence is the named
// v2 upgrade if cold-start match loss ever shows up in playtests.
//
// No accounts, no websockets, no dependencies.

// ---------------------------------------------------------------------------
// Engine core (inlined from engine.js, verified by simulate.js: 15 of 15
// bot-vs-bot matches terminate with a winner inside the 20 round cap).
// Board: 8x8, index = row * 8 + col. Cell: { owner: seat index or -1, troops }.
// ---------------------------------------------------------------------------

const SIZE = 8;
const CELLS = SIZE * SIZE;
const MAX_ROUND = 20;
const TROOP_CAP = 9;
const CORNERS = [0, SIZE - 1, CELLS - SIZE, CELLS - 1];
const SEAT_CORNERS = {
  2: [CORNERS[0], CORNERS[3]],
  3: [CORNERS[0], CORNERS[1], CORNERS[2]],
  4: CORNERS,
};

function engineCreateGame(seats) {
  if (![2, 3, 4].includes(seats)) throw new Error("seats must be 2, 3 or 4");
  const board = [];
  for (let i = 0; i < CELLS; i++) board.push({ owner: -1, troops: 1 });
  for (let s = 0; s < seats; s++) board[SEAT_CORNERS[seats][s]] = { owner: s, troops: 6 };
  return {
    seats,
    board,
    round: 1,
    turn: 0,
    actionsLeft: 2,
    phase: "play",
    winner: null,
    log: [],
  };
}

const rowOf = (i) => Math.floor(i / SIZE);
const colOf = (i) => i % SIZE;

function neighbors(i) {
  const out = [];
  if (rowOf(i) > 0) out.push(i - SIZE);
  if (rowOf(i) < SIZE - 1) out.push(i + SIZE);
  if (colOf(i) > 0) out.push(i - 1);
  if (colOf(i) < SIZE - 1) out.push(i + 1);
  return out;
}

function cellCounts(state) {
  const counts = Array(state.seats).fill(0);
  const troops = Array(state.seats).fill(0);
  for (const c of state.board) {
    if (c.owner >= 0) {
      counts[c.owner]++;
      troops[c.owner] += c.troops;
    }
  }
  return { counts, troops };
}

function defenderStrength(state, idx) {
  const c = state.board[idx];
  return c.troops + (c.owner >= 0 ? 1 : 0);
}

function legalActions(state, seat) {
  const acts = [{ type: "pass" }];
  if (state.phase !== "play" || state.turn !== seat) return acts;
  for (let i = 0; i < CELLS; i++) {
    const from = state.board[i];
    if (from.owner !== seat) continue;
    for (const j of neighbors(i)) {
      const to = state.board[j];
      if (to.owner === seat) {
        if (from.troops >= 2) acts.push({ type: "reinforce", from: i, to: j });
      } else if (from.troops >= 3) {
        acts.push({ type: "attack", from: i, to: j });
      }
    }
  }
  return acts;
}

function nextLivingTurn(state, fromSeat) {
  const { counts } = cellCounts(state);
  for (let step = 1; step <= state.seats; step++) {
    const s = (fromSeat + step) % state.seats;
    if (counts[s] > 0) return s;
  }
  return fromSeat;
}

function finishIfDone(state) {
  const { counts, troops } = cellCounts(state);
  const alive = counts.map((c, s) => (c > 0 ? s : -1)).filter((s) => s >= 0);
  if (alive.length === 1) {
    state.phase = "done";
    state.winner = alive[0];
    return true;
  }
  if (state.round > MAX_ROUND) {
    let best = alive[0];
    for (const s of alive) {
      if (counts[s] > counts[best] || (counts[s] === counts[best] && troops[s] > troops[best])) best = s;
    }
    state.phase = "done";
    state.winner = best;
    return true;
  }
  return false;
}

function startRound(state) {
  for (const c of state.board) {
    if (c.owner >= 0 && c.troops < TROOP_CAP) c.troops += 1;
  }
  state.log.push({ round: state.round, event: "growth" });
}

function engineApplyAction(state, seat, action) {
  if (state.phase !== "play") throw new Error("game is over");
  if (state.turn !== seat) throw new Error("not your turn");
  const entry = { round: state.round, player: seat, action: action.type };

  if (action.type === "attack") {
    const from = state.board[action.from];
    const to = state.board[action.to];
    if (!from || from.owner !== seat) throw new Error("from cell is not yours");
    if (!to || to.owner === seat) throw new Error("target must be neutral or enemy");
    if (!neighbors(action.from).includes(action.to)) throw new Error("cells are not adjacent");
    const k = action.troops;
    if (!Number.isInteger(k) || k < 2 || k > from.troops - 1) throw new Error("invalid troop commitment");
    const strength = defenderStrength(state, action.to);
    from.troops -= k;
    entry.from = action.from;
    entry.to = action.to;
    entry.troops = k;
    if (k > strength) {
      to.owner = seat;
      to.troops = k - strength;
      entry.result = "capture";
    } else {
      entry.result = "repelled";
    }
  } else if (action.type === "reinforce") {
    const from = state.board[action.from];
    const to = state.board[action.to];
    if (!from || from.owner !== seat || !to || to.owner !== seat) throw new Error("both cells must be yours");
    if (!neighbors(action.from).includes(action.to)) throw new Error("cells are not adjacent");
    const k = action.troops;
    if (!Number.isInteger(k) || k < 1 || k > from.troops - 1) throw new Error("invalid troop move");
    if (to.troops + k > TROOP_CAP) throw new Error("target would exceed troop cap");
    from.troops -= k;
    to.troops += k;
    entry.from = action.from;
    entry.to = action.to;
    entry.troops = k;
    entry.result = "moved";
  } else if (action.type !== "pass") {
    throw new Error("unknown action type");
  }

  state.log.push(entry);
  if (finishIfDone(state)) return state;
  state.actionsLeft -= 1;
  if (state.actionsLeft > 0) return state;
  const nxt = nextLivingTurn(state, seat);
  if (nxt <= seat) {
    state.round += 1;
    if (finishIfDone(state)) return state;
    startRound(state);
  }
  state.turn = nxt;
  state.actionsLeft = 2;
  return state;
}

function botAction(state, seat) {
  const acts = legalActions(state, seat);
  let best = null;
  for (const a of acts) {
    if (a.type !== "attack") continue;
    const from = state.board[a.from];
    const strength = defenderStrength(state, a.to);
    const k = strength + 1;
    if (k >= 2 && k <= from.troops - 1) {
      if (!best || strength < best.strength) best = { ...a, troops: k, strength };
    }
  }
  if (best) return { type: "attack", from: best.from, to: best.to, troops: best.troops };
  let move = null;
  for (const a of acts) {
    if (a.type !== "reinforce") continue;
    const from = state.board[a.from];
    const to = state.board[a.to];
    const border = neighbors(a.to).some((n) => state.board[n].owner !== seat);
    if (border && from.troops >= 5 && to.troops <= 3) {
      const k = Math.min(from.troops - 2, TROOP_CAP - to.troops);
      if (k >= 1 && (!move || to.troops < move.toTroops)) {
        move = { type: "reinforce", from: a.from, to: a.to, troops: k, toTroops: to.troops };
      }
    }
  }
  if (move) return { type: move.type, from: move.from, to: move.to, troops: move.troops };
  return { type: "pass" };
}

// ---------------------------------------------------------------------------
// Server layer
// ---------------------------------------------------------------------------

export const TURN_SECONDS_DEFAULT = 30;
export const MISSED_TURNS_BEFORE_TAKEOVER = 2;

const games = new Map(); // game_id -> game record
const codeIndex = new Map(); // join_code -> game_id

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L confusion

function randomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

function randomId(prefix) {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function fail(status, code, message) {
  return json(status, { error: code, message });
}

// Engine error text -> stable API error code and HTTP status.
// This table is the contract documented in INVALID-MOVES.md.
const ENGINE_ERRORS = {
  "game is over": [409, "game_over"],
  "not your turn": [403, "not_your_turn"],
  "from cell is not yours": [422, "from_not_yours"],
  "target must be neutral or enemy": [422, "target_is_own_cell"],
  "cells are not adjacent": [422, "cells_not_adjacent"],
  "invalid troop commitment": [422, "invalid_troops"],
  "both cells must be yours": [422, "reinforce_requires_own_cells"],
  "invalid troop move": [422, "invalid_troops"],
  "target would exceed troop cap": [422, "troop_cap_exceeded"],
  "unknown action type": [400, "unknown_action"],
};

function newGameRecord(seats, turnSeconds) {
  let joinCode = randomCode();
  while (codeIndex.has(joinCode)) joinCode = randomCode();
  const gameId = randomId("g_");
  const rec = {
    game_id: gameId,
    join_code: joinCode,
    seats,
    turn_seconds: turnSeconds,
    phase: "lobby", // "lobby" | "play" | "done" (mirrors engine phase once started)
    players: [], // { seat, player_id, token, name, kind, bot, bot_controlled, consecutive_misses, total_misses }
    state: null, // engine state once started
    turn_started_at: null, // ms epoch, set when a turn begins
    created_at: Date.now(),
    host_seat: null,
  };
  games.set(gameId, rec);
  codeIndex.set(joinCode, gameId);
  return rec;
}

function seatOfToken(rec, token) {
  if (!token) return null;
  const p = rec.players.find((pl) => pl.token === token);
  return p ? p.seat : null;
}

function tokenFrom(req, body) {
  const header = req.headers.get("x-player-token");
  if (header) return header;
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (body && typeof body.token === "string") return body.token;
  return null;
}

function publicPlayers(rec) {
  const counts = rec.state ? cellCounts(rec.state) : { counts: Array(rec.seats).fill(0), troops: Array(rec.seats).fill(0) };
  return rec.players.map((p) => ({
    seat: p.seat,
    player_id: p.player_id,
    name: p.name,
    kind: p.kind,
    bot: p.bot,
    bot_controlled: p.bot_controlled,
    cells: rec.state ? counts.counts[p.seat] : 0,
    troops: rec.state ? counts.troops[p.seat] : 0,
    alive: rec.state ? counts.counts[p.seat] > 0 : true,
    consecutive_misses: p.consecutive_misses,
    total_misses: p.total_misses,
  }));
}

function stateView(rec, viewerSeat) {
  const s = rec.state;
  const now = Date.now();
  const deadline = rec.phase === "play" && rec.turn_started_at ? rec.turn_started_at + rec.turn_seconds * 1000 : null;
  return {
    game_id: rec.game_id,
    join_code: rec.join_code,
    seats: rec.seats,
    phase: rec.phase,
    board: s ? s.board : null,
    players: publicPlayers(rec),
    round: s ? Math.min(s.round, MAX_ROUND) : 0,
    turn: s ? s.turn : null,
    actions_left: s ? s.actionsLeft : null,
    winner: s ? s.winner : null,
    log_tail: s ? s.log.slice(-10) : [],
    log_length: s ? s.log.length : 0,
    turn_seconds: rec.turn_seconds,
    turn_deadline: deadline,
    seconds_left: deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null,
    you: viewerSeat,
    poll_interval_seconds: 2,
  };
}

// Applies any bot turns and any turn-timer timeouts that are due right now.
// Lazy evaluation on every request keeps this correct on a serverless host
// with no background loop. Loop-guarded so one request can never spin.
function tick(rec) {
  if (rec.phase !== "play" || !rec.state) return;
  let guard = 0;
  while (rec.phase === "play" && guard++ < 1000) {
    const s = rec.state;
    if (s.phase === "done") {
      rec.phase = "done";
      break;
    }
    const seat = s.turn;
    const player = rec.players[seat];
    if (!player) break;

    if (player.bot || player.bot_controlled) {
      // Bot seats act immediately, both actions, no timer wait.
      const before = s.turn;
      engineApplyAction(s, seat, botAction(s, seat));
      if (s.phase === "done") {
        rec.phase = "done";
        break;
      }
      if (s.turn !== before) rec.turn_started_at = Date.now();
      continue;
    }

    if (rec.turn_started_at === null) rec.turn_started_at = Date.now();
    const deadline = rec.turn_started_at + rec.turn_seconds * 1000;
    if (Date.now() < deadline) break; // human or agent still has time

    // Timeout: the seat misses its turn. Both remaining actions auto-pass.
    player.consecutive_misses += 1;
    player.total_misses += 1;
    s.log.push({
      round: s.round,
      player: seat,
      event: "turn_timeout",
      consecutive_misses: player.consecutive_misses,
    });
    if (player.consecutive_misses >= MISSED_TURNS_BEFORE_TAKEOVER) {
      player.bot_controlled = true;
      s.log.push({ round: s.round, player: seat, event: "bot_takeover" });
    }
    const actionsToPass = s.actionsLeft;
    for (let i = 0; i < actionsToPass && s.phase === "play"; i++) {
      engineApplyAction(s, seat, { type: "pass" });
    }
    if (s.phase === "done") {
      rec.phase = "done";
      break;
    }
    rec.turn_started_at = Date.now();
    // Loop continues: if the next seat is a bot it plays now; if the same
    // seat just got taken over it also plays now on the next pass.
  }
  if (rec.state && rec.state.phase === "done") rec.phase = "done";
}

function fillBotSeats(rec) {
  for (let seat = rec.players.length; seat < rec.seats; seat++) {
    rec.players.push({
      seat,
      player_id: randomId("bot_"),
      token: null,
      name: "Bot " + (seat + 1),
      kind: "bot",
      bot: true,
      bot_controlled: false,
      consecutive_misses: 0,
      total_misses: 0,
    });
  }
  rec.players.sort((a, b) => a.seat - b.seat);
}

async function readBody(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null; // malformed JSON sentinel
  }
}

function normalizeAction(body) {
  // Accept { action: "attack", from, to, troops },
  //        { action: { type: "attack", from, to, troops } },
  //        { type: "attack", from, to, troops }.
  let raw = null;
  if (typeof body.action === "string") raw = { type: body.action, from: body.from, to: body.to, troops: body.troops };
  else if (body.action && typeof body.action === "object") raw = body.action;
  else if (typeof body.type === "string") raw = { type: body.type, from: body.from, to: body.to, troops: body.troops };
  if (!raw || typeof raw.type !== "string") return null;
  return { type: raw.type, from: raw.from, to: raw.to, troops: raw.troops };
}

const CLIENT_PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gridlock</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0e14;color:#e6e9f0;font-family:system-ui,-apple-system,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:14px}
h1{margin:6px 0 2px;font-size:28px;letter-spacing:.5px}
h2,h3{margin:8px 0}
.sub{color:#9aa3b2;margin:0 0 12px;font-size:14px}
.card{background:#141926;border:1px solid #263048;border-radius:12px;padding:14px;margin-bottom:12px}
label{display:block;font-size:14px;margin:8px 0}
input,select{background:#0b0e14;color:#e6e9f0;border:1px solid #33415e;border-radius:8px;padding:10px;font-size:16px;width:100%}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:11px 14px;font-size:15px;cursor:pointer;min-height:44px}
button:disabled{background:#33415e;color:#8b94a7;cursor:not-allowed}
button.ghost{background:#263048}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row>div{flex:1;min-width:140px}
.hidden{display:none!important}
.err{background:#3a1620;border:1px solid #7f1d2e;color:#fda4af;border-radius:8px;padding:10px;margin-bottom:12px;font-size:14px}
.code{font-size:26px;font-weight:700;letter-spacing:3px;color:#fbbf24}
.small{font-size:12px;color:#9aa3b2;word-break:break-all}
ul{margin:6px 0;padding-left:18px}
.board{display:grid;grid-template-columns:repeat(8,1fr);gap:4px;margin:10px 0}
.cell{aspect-ratio:1;border-radius:7px;border:2px solid transparent;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:clamp(13px,4vw,18px);cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;padding:0;min-height:0;color:#fff}
.cell.neutral{background:#232936;color:#79839a}
.cell.s0{background:#2563eb}.cell.s1{background:#dc2626}.cell.s2{background:#16a34a}.cell.s3{background:#9333ea}
.cell.sel{border-color:#fbbf24;box-shadow:0 0 0 2px #fbbf24 inset}
.cell.tgt{border-color:#fff}
.cell.dim{opacity:.55}
.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px;vertical-align:middle}
.pname{font-weight:600}
.turnbanner{font-size:16px;font-weight:700;padding:9px 11px;border-radius:8px;background:#1b2334;margin-bottom:8px}
.turnbanner.mine{background:#14532d}
.winnerbanner{font-size:17px;font-weight:800;padding:11px;border-radius:8px;background:#713f12;color:#fde68a;text-align:center;margin-bottom:8px}
.log{font-size:13px;color:#c3cad7;max-height:240px;overflow-y:auto;line-height:1.5}
.log div{border-bottom:1px solid #1e2638;padding:2px 0}
input[type=range]{padding:0}
.big{font-size:20px;font-weight:700}
.kv{font-size:14px;color:#c3cad7}
</style></head>
<body>
<div class="wrap">
<h1>Gridlock</h1>
<p class="sub">8x8 conquest, 2 actions per turn, 30 seconds a turn. Tap one of your cells, then an adjacent cell to attack it or reinforce your own. Most cells when the rounds run out wins.</p>
<div id="err" class="err hidden"></div>

<section id="setup" class="card">
<label>Your name
<input id="nameInput" maxlength="24" placeholder="e.g. Alex" autocomplete="off">
</label>
<div class="row">
<div>
<h3>Create a game</h3>
<label>Seats
<select id="seatsInput"><option value="2">2 players</option><option value="3">3 players</option><option value="4">4 players</option></select>
</label>
<button id="createBtn" style="width:100%">Create game</button>
</div>
<div>
<h3>Join by code</h3>
<label>Match code
<input id="codeInput" maxlength="6" placeholder="ABC123" autocomplete="off" style="text-transform:uppercase">
</label>
<button id="joinCodeBtn" style="width:100%">Join game</button>
</div>
</div>
<div id="joinByLink" class="hidden">
<h3>Join this game</h3>
<p class="kv">A game link brought you here. Join it with the name above.</p>
<button id="joinLinkBtn" style="width:100%">Join this game</button>
</div>
</section>

<section id="lobby" class="card hidden">
<h2>Lobby</h2>
<p>Share this code with the other players:</p>
<p class="code" id="lobbyCode"></p>
<p class="small">Or send them this link: <span id="shareLink"></span></p>
<h3>Players</h3>
<ul id="lobbyPlayers"></ul>
<p class="kv" id="lobbyNote"></p>
<button id="startBtn" class="hidden" style="width:100%">Start game</button>
<p class="small" id="startNote"></p>
<button id="leaveBtn1" class="ghost" style="width:100%;margin-top:8px">Leave</button>
</section>

<section id="game" class="hidden">
<div class="card">
<div id="winnerBanner" class="winnerbanner hidden"></div>
<div id="turnBanner" class="turnbanner"></div>
<div id="board" class="board"></div>
<div id="chooser" class="card hidden" style="background:#1b2334">
<div id="chooserText" class="kv"></div>
<label>Troops to send: <span id="troopVal" class="big"></span>
<input type="range" id="troopRange">
</label>
<p class="kv" id="chooserHint"></p>
<div class="row">
<button id="confirmMoveBtn" style="flex:1">Confirm</button>
<button id="cancelMoveBtn" class="ghost" style="flex:1">Cancel</button>
</div>
</div>
<div class="row">
<button id="passBtn" style="flex:1">Pass (use 1 action)</button>
<button id="leaveBtn2" class="ghost" style="flex:1">Leave game</button>
</div>
<div id="playersBox" style="margin-top:10px"></div>
</div>
<div class="card">
<h3>Match log</h3>
<div id="logBox" class="log"></div>
</div>
</section>
</div>

<script>
var COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea'];
var S = { game_id: null, token: null, seat: null, host: false, name: '', state: null, selected: null, pending: null, timer: null, fullLog: null };
function el(id) { return document.getElementById(id); }
function showErr(msg) { var e = el('err'); if (!msg) { e.classList.add('hidden'); e.textContent = ''; return; } e.textContent = msg; e.classList.remove('hidden'); }
function coord(i) { return '(' + (Math.floor(i / 8) + 1) + ',' + (i % 8 + 1) + ')'; }
function playerName(seat) {
  if (!S.state || !S.state.players) return 'Seat ' + (seat + 1);
  for (var i = 0; i < S.state.players.length; i++) if (S.state.players[i].seat === seat) return S.state.players[i].name;
  return 'Seat ' + (seat + 1);
}
function api(path, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  if (S.token) opts.headers['X-Player-Token'] = S.token;
  if (opts.body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok) { var e = new Error(j.message || j.error || ('HTTP ' + r.status)); e.code = j.error; throw e; }
      return j;
    });
  });
}
function saveSession() {
  try { localStorage.setItem('gridlock_session', JSON.stringify({ game_id: S.game_id, token: S.token, seat: S.seat, host: S.host, name: S.name })); } catch (e) {}
}
function clearSession() {
  try { localStorage.removeItem('gridlock_session'); } catch (e) {}
  S.game_id = null; S.token = null; S.seat = null; S.host = false; S.state = null; S.selected = null; S.pending = null; S.fullLog = null;
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  el('setup').classList.remove('hidden'); el('lobby').classList.add('hidden'); el('game').classList.add('hidden');
}
function getName() {
  var n = el('nameInput').value.trim();
  if (!n) { showErr('Enter your name first.'); return null; }
  return n;
}
function afterJoin(j) {
  S.game_id = j.game_id; S.token = j.token; S.seat = j.seat; S.host = !!j.host; S.name = el('nameInput').value.trim();
  saveSession();
  el('setup').classList.add('hidden');
  startPolling();
  refreshState();
}
function startPolling() {
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(refreshState, 2000);
}
function refreshState() {
  if (!S.game_id) return;
  api('/api/games/' + S.game_id + '/state', { method: 'GET' }).then(function (st) {
    S.state = st;
    if (st.phase === 'done' && !S.fullLog) fetchFullLog();
    render();
  }).catch(function (e) {
    if (e.code === 'game_not_found' || e.code === 'invalid_token') { showErr('That game is gone (the server restarted or the match ended). Start a new one.'); clearSession(); }
  });
}
function fetchFullLog() {
  api('/api/games/' + S.game_id + '/log', { method: 'GET' }).then(function (j) { S.fullLog = j.log; renderLog(); }).catch(function () {});
}
function neighborsOf(i) {
  var out = [], r = Math.floor(i / 8), c = i % 8;
  if (r > 0) out.push(i - 8);
  if (r < 7) out.push(i + 8);
  if (c > 0) out.push(i - 1);
  if (c < 7) out.push(i + 1);
  return out;
}
function render() {
  var st = S.state;
  if (!st) return;
  showErr('');
  if (st.phase === 'lobby') { renderLobby(st); return; }
  el('lobby').classList.add('hidden'); el('setup').classList.add('hidden'); el('game').classList.remove('hidden');
  renderGame(st);
}
function renderLobby(st) {
  el('game').classList.add('hidden'); el('setup').classList.add('hidden'); el('lobby').classList.remove('hidden');
  el('lobbyCode').textContent = st.join_code;
  el('shareLink').textContent = location.origin + location.pathname + '?g=' + st.game_id;
  var ul = el('lobbyPlayers'); ul.innerHTML = '';
  st.players.forEach(function (p) {
    var li = document.createElement('li');
    li.innerHTML = '<span class="dot" style="background:' + COLORS[p.seat] + '"></span><span class="pname"></span>';
    li.querySelector('.pname').textContent = p.name + (p.seat === S.seat ? ' (you)' : '') + (p.bot ? ' (bot)' : '');
    ul.appendChild(li);
  });
  var empty = st.seats - st.players.length;
  el('lobbyNote').textContent = empty > 0 ? empty + ' seat(s) still open. Empty seats are filled by bots when the game starts.' : 'All seats are filled.';
  if (S.host) {
    el('startBtn').classList.remove('hidden');
    el('startNote').textContent = 'You are the host. Start whenever you are ready; you do not need a full lobby.';
  } else {
    el('startBtn').classList.add('hidden');
    el('startNote').textContent = 'Waiting for the host to start the game.';
  }
}
function renderGame(st) {
  var wb = el('winnerBanner');
  if (st.phase === 'done' && st.winner !== null && st.winner !== undefined) {
    wb.classList.remove('hidden');
    wb.textContent = (st.winner === S.seat ? 'You win! ' : '') + 'Winner: ' + playerName(st.winner);
  } else wb.classList.add('hidden');
  var tb = el('turnBanner');
  if (st.phase === 'done') { tb.textContent = 'Game over.'; tb.className = 'turnbanner'; }
  else {
    var mine = st.turn === S.seat;
    tb.className = 'turnbanner' + (mine ? ' mine' : '');
    tb.textContent = 'Round ' + st.round + ' of 20 - ' + (mine ? 'YOUR TURN' : playerName(st.turn) + ' to move') + ' - ' + st.actions_left + ' action(s) left' + (st.seconds_left !== null && st.seconds_left !== undefined ? ' - ' + st.seconds_left + 's on the clock' : '');
  }
  el('passBtn').disabled = !(st.phase === 'play' && st.turn === S.seat);
  renderBoard(st);
  renderPlayers(st);
  renderLog();
  if (S.pending) renderChooser();
}
function renderBoard(st) {
  var board = el('board'); board.innerHTML = '';
  if (!st.board) return;
  var myTurn = st.phase === 'play' && st.turn === S.seat;
  var tgts = S.selected !== null && myTurn ? neighborsOf(S.selected) : [];
  st.board.forEach(function (cell, i) {
    var b = document.createElement('button');
    b.className = 'cell ' + (cell.owner < 0 ? 'neutral' : 's' + cell.owner);
    if (S.selected === i) b.className += ' sel';
    if (tgts.indexOf(i) >= 0) b.className += ' tgt';
    if (S.selected !== null && myTurn && cell.owner !== S.seat && tgts.indexOf(i) < 0) b.className += ' dim';
    b.textContent = cell.troops;
    b.setAttribute('data-idx', i);
    board.appendChild(b);
  });
}
function renderPlayers(st) {
  var box = el('playersBox'); box.innerHTML = '';
  st.players.forEach(function (p) {
    var d = document.createElement('div');
    d.className = 'kv';
    d.innerHTML = '<span class="dot" style="background:' + COLORS[p.seat] + '"></span><span class="pname"></span>';
    d.querySelector('.pname').textContent = p.name + (p.seat === S.seat ? ' (you)' : '') + (p.bot || p.bot_controlled ? ' (bot)' : '') + (st.turn === p.seat && st.phase === 'play' ? ' - to move' : '') + (p.alive === false ? ' - eliminated' : '');
    d.appendChild(document.createTextNode(' - ' + p.cells + ' cells, ' + p.troops + ' troops'));
    box.appendChild(d);
  });
}
function fmtEntry(e) {
  if (e.event === 'game_start') return 'Round 1: game started with ' + e.seats + ' seats.';
  if (e.event === 'growth') return 'Round ' + e.round + ': every owned cell grows +1.';
  if (e.event === 'turn_timeout') return 'Round ' + e.round + ': ' + playerName(e.player) + ' ran out of time and auto-passed.';
  if (e.event === 'bot_takeover') return 'Round ' + e.round + ': a bot took over ' + playerName(e.player) + ' after repeated misses.';
  if (e.event) return 'Round ' + e.round + ': ' + e.event;
  var who = playerName(e.player);
  if (e.action === 'pass') return 'Round ' + e.round + ': ' + who + ' passed.';
  if (e.action === 'attack') return 'Round ' + e.round + ': ' + who + ' attacked ' + coord(e.from) + ' -> ' + coord(e.to) + ' with ' + e.troops + ' troops: ' + e.result + '.';
  if (e.action === 'reinforce') return 'Round ' + e.round + ': ' + who + ' reinforced ' + coord(e.from) + ' -> ' + coord(e.to) + ' with ' + e.troops + ' troops.';
  return 'Round ' + e.round + ': ' + who + ' ' + e.action + '.';
}
function renderLog() {
  var st = S.state; if (!st) return;
  var entries = S.fullLog || st.log_tail || [];
  var box = el('logBox'); box.innerHTML = '';
  entries.slice().reverse().forEach(function (e) {
    var d = document.createElement('div'); d.textContent = fmtEntry(e); box.appendChild(d);
  });
  if (!entries.length) box.textContent = 'No moves yet.';
}
function openChooser(type, from, to) {
  var st = S.state, f = st.board[from], t = st.board[to];
  var min, max, hint;
  if (type === 'attack') {
    min = 2; max = f.troops - 1;
    var strength = t.troops + (t.owner >= 0 ? 1 : 0);
    hint = 'Defender strength is ' + strength + '. Send more than that to capture; send less and the attack is repelled and the troops are lost.';
    S.pending = { type: type, from: from, to: to, min: min, max: max, strength: strength };
  } else {
    min = 1; max = Math.min(f.troops - 1, 9 - t.troops);
    hint = 'Move troops between your own cells. A cell holds at most 9 and must keep at least 1 behind.';
    S.pending = { type: type, from: from, to: to, min: min, max: max };
  }
  renderChooser();
}
function renderChooser() {
  var p = S.pending; if (!p) { el('chooser').classList.add('hidden'); return; }
  el('chooser').classList.remove('hidden');
  el('chooserText').textContent = (p.type === 'attack' ? 'Attack ' : 'Reinforce ') + coord(p.from) + ' -> ' + coord(p.to);
  var r = el('troopRange');
  r.min = p.min; r.max = Math.max(p.min, p.max); r.value = p.max >= p.min ? p.max : p.min;
  el('troopVal').textContent = r.value;
  el('chooserHint').textContent = p.type === 'attack' ? 'Defender strength is ' + p.strength + '. Send more than that to capture; send less and the attack is repelled and the troops are lost.' : 'Move troops between your own cells. A cell holds at most 9 and must keep at least 1 behind.';
  el('confirmMoveBtn').disabled = p.max < p.min;
  if (p.max < p.min) el('chooserHint').textContent = 'No legal troop count for this move right now.';
}
function sendMove(action) {
  api('/api/games/' + S.game_id + '/move', { method: 'POST', body: { token: S.token, action: action } }).then(function (st) {
    S.state = st; S.selected = null; S.pending = null; el('chooser').classList.add('hidden');
    if (st.phase === 'done' && !S.fullLog) fetchFullLog();
    render();
  }).catch(function (e) { showErr(e.message || 'Move failed.'); refreshState(); });
}
el('board').addEventListener('click', function (ev) {
  var t = ev.target;
  if (!t.getAttribute || t.getAttribute('data-idx') === null) return;
  var idx = Number(t.getAttribute('data-idx'));
  var st = S.state;
  if (!st || st.phase !== 'play' || st.turn !== S.seat || !st.board) return;
  var cell = st.board[idx];
  if (S.selected === null) {
    if (cell.owner === S.seat) { S.selected = idx; renderBoard(st); }
    return;
  }
  if (idx === S.selected) { S.selected = null; S.pending = null; el('chooser').classList.add('hidden'); renderBoard(st); return; }
  if (neighborsOf(S.selected).indexOf(idx) >= 0) {
    openChooser(cell.owner === S.seat ? 'reinforce' : 'attack', S.selected, idx);
    renderBoard(st);
    return;
  }
  if (cell.owner === S.seat) { S.selected = idx; S.pending = null; el('chooser').classList.add('hidden'); renderBoard(st); return; }
  showErr('That cell is not adjacent to your selected cell.');
});
el('troopRange').addEventListener('input', function () { el('troopVal').textContent = el('troopRange').value; });
el('confirmMoveBtn').addEventListener('click', function () {
  if (!S.pending) return;
  var k = Number(el('troopRange').value);
  sendMove({ type: S.pending.type, from: S.pending.from, to: S.pending.to, troops: k });
});
el('cancelMoveBtn').addEventListener('click', function () { S.pending = null; el('chooser').classList.add('hidden'); });
el('passBtn').addEventListener('click', function () { S.selected = null; S.pending = null; el('chooser').classList.add('hidden'); sendMove({ type: 'pass' }); });
el('createBtn').addEventListener('click', function () {
  var name = getName(); if (!name) return;
  showErr('');
  api('/api/games', { method: 'POST', body: { seats: Number(el('seatsInput').value) } }).then(function (g) {
    return api('/api/games/' + g.game_id + '/join', { method: 'POST', body: { name: name, kind: 'human' } });
  }).then(afterJoin).catch(function (e) { showErr(e.message); });
});
el('joinCodeBtn').addEventListener('click', function () {
  var name = getName(); if (!name) return;
  var code = el('codeInput').value.trim().toUpperCase();
  if (!code) { showErr('Enter a match code.'); return; }
  showErr('');
  api('/api/games/join-by-code', { method: 'POST', body: { join_code: code, name: name, kind: 'human' } }).then(afterJoin).catch(function (e) { showErr(e.message); });
});
var linkGame = new URLSearchParams(location.search).get('g');
if (linkGame) {
  el('joinByLink').classList.remove('hidden');
  el('joinLinkBtn').addEventListener('click', function () {
    var name = getName(); if (!name) return;
    showErr('');
    api('/api/games/' + linkGame + '/join', { method: 'POST', body: { name: name, kind: 'human' } }).then(afterJoin).catch(function (e) { showErr(e.message); });
  });
}
el('startBtn').addEventListener('click', function () {
  api('/api/games/' + S.game_id + '/start', { method: 'POST', body: { token: S.token } }).then(function (st) { S.state = st; render(); }).catch(function (e) { showErr(e.message); });
});
el('leaveBtn1').addEventListener('click', clearSession);
el('leaveBtn2').addEventListener('click', clearSession);
(function restore() {
  try {
    var raw = localStorage.getItem('gridlock_session');
    if (!raw) return;
    var s = JSON.parse(raw);
    if (!s.game_id || !s.token) return;
    S.game_id = s.game_id; S.token = s.token; S.seat = s.seat; S.host = !!s.host; S.name = s.name || '';
    el('setup').classList.add('hidden');
    startPolling(); refreshState();
  } catch (e) {}
})();
</script>
</body></html>`;

export async function handleRequest(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  if (method === "GET" && path === "/") {
    return new Response(CLIENT_PLACEHOLDER, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (method === "GET" && path === "/api/health") {
    return json(200, { ok: true, game: "gridlock", games_in_memory: games.size });
  }

  // POST /api/games - create a lobby
  if (method === "POST" && path === "/api/games") {
    const body = await readBody(req);
    if (body === null) return fail(400, "malformed_json", "Request body is not valid JSON.");
    const seats = body.seats === undefined ? 2 : body.seats;
    if (![2, 3, 4].includes(seats)) return fail(400, "invalid_seats", "seats must be 2, 3 or 4.");
    let turnSeconds = TURN_SECONDS_DEFAULT;
    if (body.turn_seconds !== undefined) {
      if (!Number.isInteger(body.turn_seconds) || body.turn_seconds < 1 || body.turn_seconds > 600) {
        return fail(400, "invalid_turn_seconds", "turn_seconds must be an integer from 1 to 600.");
      }
      turnSeconds = body.turn_seconds;
    }
    const rec = newGameRecord(seats, turnSeconds);
    return json(201, {
      game_id: rec.game_id,
      join_code: rec.join_code,
      seats: rec.seats,
      phase: rec.phase,
      turn_seconds: rec.turn_seconds,
    });
  }

  // POST /api/games/join-by-code - resolve a match code, then join
  if (method === "POST" && path === "/api/games/join-by-code") {
    const body = await readBody(req);
    if (body === null) return fail(400, "malformed_json", "Request body is not valid JSON.");
    const code = typeof body.join_code === "string" ? body.join_code.trim().toUpperCase() : "";
    const gameId = codeIndex.get(code);
    if (!gameId) return fail(404, "join_code_not_found", "No lobby with that join code.");
    return joinGame(games.get(gameId), body);
  }

  const gameMatch = path.match(/^\/api\/games\/([^/]+)(\/(join|start|state|move|log))?$/);
  if (gameMatch) {
    const rec = games.get(gameMatch[1]);
    if (!rec) return fail(404, "game_not_found", "No game with that game_id.");
    const sub = gameMatch[3] || null;

    if (method === "POST" && sub === "join") {
      const body = await readBody(req);
      if (body === null) return fail(400, "malformed_json", "Request body is not valid JSON.");
      return joinGame(rec, body);
    }

    if (method === "POST" && sub === "start") {
      const body = await readBody(req);
      if (body === null) return fail(400, "malformed_json", "Request body is not valid JSON.");
      const token = tokenFrom(req, body);
      if (!token) return fail(401, "missing_token", "A player token is required.");
      const seat = seatOfToken(rec, token);
      if (seat === null) return fail(401, "invalid_token", "That token does not belong to this game.");
      if (seat !== rec.host_seat) return fail(403, "not_host", "Only the host (first player to join) can start the game.");
      if (rec.phase !== "lobby") return fail(409, "game_already_started", "This game has already started.");
      if (rec.players.length === 0) return fail(409, "no_players", "At least one player must join before start.");
      fillBotSeats(rec);
      rec.state = engineCreateGame(rec.seats);
      rec.phase = "play";
      rec.turn_started_at = Date.now();
      rec.state.log.push({ round: 1, event: "game_start", seats: rec.seats });
      tick(rec); // seat 0 may be a bot in theory; normally the host, so this is a no-op safeguard
      return json(200, stateView(rec, seat));
    }

    if (method === "GET" && sub === "state") {
      tick(rec);
      let viewerSeat = null;
      const token = tokenFrom(req, null);
      if (token) {
        viewerSeat = seatOfToken(rec, token);
        if (viewerSeat === null) return fail(401, "invalid_token", "That token does not belong to this game.");
      }
      return json(200, stateView(rec, viewerSeat));
    }

    if (method === "GET" && sub === "log") {
      tick(rec);
      if (!rec.state) return fail(409, "game_not_started", "This game is still in the lobby and has no log yet.");
      return json(200, {
        game_id: rec.game_id,
        join_code: rec.join_code,
        phase: rec.phase,
        winner: rec.state.winner,
        rounds_played: Math.min(rec.state.round, MAX_ROUND),
        log: rec.state.log,
      });
    }

    if (method === "POST" && sub === "move") {
      const body = await readBody(req);
      if (body === null) return fail(400, "malformed_json", "Request body is not valid JSON.");
      tick(rec);
      const token = tokenFrom(req, body);
      if (!token) return fail(401, "missing_token", "A player token is required.");
      const seat = seatOfToken(rec, token);
      if (seat === null) return fail(401, "invalid_token", "That token does not belong to this game.");
      if (rec.phase === "lobby") return fail(409, "game_not_started", "This game is still in the lobby.");
      if (rec.phase === "done") return fail(409, "game_over", "This game is over.");
      const player = rec.players[seat];
      if (player.bot_controlled) {
        return fail(403, "seat_bot_controlled", "This seat missed 2 turns and is bot controlled for the rest of the match.");
      }
      const action = normalizeAction(body);
      if (!action) return fail(400, "missing_action", "Send an action: attack, reinforce or pass.");
      if (!["attack", "reinforce", "pass"].includes(action.type)) {
        return fail(400, "unknown_action", "Action must be attack, reinforce or pass.");
      }
      if (action.type === "attack" || action.type === "reinforce") {
        for (const field of ["from", "to"]) {
          if (!Number.isInteger(action[field]) || action[field] < 0 || action[field] >= CELLS) {
            return fail(422, "cell_out_of_range", field + " must be an integer cell index from 0 to 63.");
          }
        }
        if (action.from === action.to) return fail(422, "cells_not_adjacent", "from and to must be different adjacent cells.");
        if (!Number.isInteger(action.troops)) {
          return fail(422, "invalid_troops", "troops is required and must be an integer.");
        }
      }
      const turnBefore = rec.state.turn;
      try {
        engineApplyAction(rec.state, seat, action);
      } catch (e) {
        const mapped = ENGINE_ERRORS[e.message];
        if (mapped) return fail(mapped[0], mapped[1], e.message);
        return fail(400, "bad_move", e.message);
      }
      player.consecutive_misses = 0; // a real move clears the miss streak
      if (rec.state.phase === "done") {
        rec.phase = "done";
      } else if (rec.state.turn !== turnBefore) {
        rec.turn_started_at = Date.now();
      }
      tick(rec); // a bot seat may be up next; let it play before responding
      return json(200, stateView(rec, seat));
    }

    return fail(404, "route_not_found", "No such route for this game.");
  }

  return fail(404, "route_not_found", "No such route.");
}

function joinGame(rec, body) {
  if (rec.phase !== "lobby") return fail(409, "game_already_started", "This game has already started and cannot be joined.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail(400, "missing_name", "name is required.");
  if (name.length > 24) return fail(400, "name_too_long", "name must be 24 characters or fewer.");
  const kind = body.kind === undefined ? "human" : body.kind;
  if (!["human", "agent"].includes(kind)) return fail(400, "invalid_kind", "kind must be human or agent. Bot seats are filled by the server at start.");
  if (rec.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return fail(409, "name_taken", "That name is already taken in this lobby.");
  }
  if (rec.players.length >= rec.seats) return fail(409, "lobby_full", "All seats in this lobby are taken.");
  const seat = rec.players.length;
  const player = {
    seat,
    player_id: randomId("p_"),
    token: randomId("tok_"),
    name,
    kind,
    bot: false,
    bot_controlled: false,
    consecutive_misses: 0,
    total_misses: 0,
  };
  rec.players.push(player);
  if (rec.host_seat === null) rec.host_seat = seat;
  return json(201, {
    game_id: rec.game_id,
    join_code: rec.join_code,
    player_id: player.player_id,
    token: player.token,
    seat,
    host: seat === rec.host_seat,
    phase: rec.phase,
    seats: rec.seats,
    players: publicPlayers(rec),
  });
}

// Val Town entry point.
export default async function handler(req) {
  try {
    return await handleRequest(req);
  } catch (e) {
    return json(500, { error: "internal_error", message: String(e && e.message ? e.message : e) });
  }
}

// Local Node entry point (ignored on Val Town).
if (typeof process !== "undefined" && process.argv && process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const { createServer } = await import("node:http");
  const port = Number(process.env.PORT || 8787);
  createServer(async (nodeReq, nodeRes) => {
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const req = new Request("http://localhost:" + port + nodeReq.url, {
      method: nodeReq.method,
      headers: nodeReq.headers,
      body: ["GET", "HEAD"].includes(nodeReq.method) ? undefined : body,
    });
    const res = await handler(req);
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers.entries()));
    nodeRes.end(await res.text());
  }).listen(port, () => console.log("Gridlock server listening on http://localhost:" + port));
}
