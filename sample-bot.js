// Gridlock sample bot: plays one full match over the HTTP/JSON API.
// Usage: node sample-bot.js [baseUrl] [name]
// Strategy (deliberately basic): expand into the weakest adjacent neutral
// cell when a legal attack exists, reinforce a thin border cell otherwise,
// pass when nothing is legal. Two actions per turn, then the turn ends.
const BASE = process.argv[2] || 'https://sosasquad--6ce8cc1cd99a11f1884b1607ee4eb77e.web.val.run';
const NAME = process.argv[3] || 'sample-bot';

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Player-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const idx = (r, c) => r * 8 + c;
const row = (i) => Math.floor(i / 8);
const col = (i) => i % 8;
const adjacent = (a, b) => Math.abs(row(a) - row(b)) + Math.abs(col(a) - col(b)) === 1;

async function main() {
  // Join the first open lobby we can create-or-join: create our own and let
  // the host flow fill seats with server bots if nobody else shows up.
  const game = await call('POST', '/api/games', { seats: 2 });
  const me = await call('POST', `/api/games/${game.game_id}/join`, { name: NAME, kind: 'agent' });
  console.log(`joined ${game.game_id} as seat ${me.seat} (code ${game.join_code})`);
  if (me.host) {
    await new Promise((r) => setTimeout(r, 3000)); // small window for a second player
    await call('POST', `/api/games/${game.game_id}/start`, { token: me.token });
    console.log('started the match');
  }

  for (let guard = 0; guard < 600; guard++) {
    const s = await call('GET', `/api/games/${game.game_id}/state`, null, me.token);
    if (s.phase === 'ended' || s.winner !== undefined && s.winner !== null && s.phase !== 'play') {
      console.log('game over. winner:', JSON.stringify(s.winner));
      return;
    }
    if (s.phase !== 'play') { await new Promise((r) => setTimeout(r, 1500)); continue; }
    if (s.turn !== me.seat || s.actions_left <= 0) { await new Promise((r) => setTimeout(r, 800)); continue; }

    const mine = s.board.map((c, i) => ({ ...c, i })).filter((c) => c.owner === me.seat && c.troops >= 3);
    let acted = false;
    for (const cell of mine) {
      const targets = s.board.map((c, i) => ({ ...c, i }))
        .filter((t) => adjacent(cell.i, t.i) && t.owner !== me.seat)
        .sort((a, b) => (a.troops + (a.owner >= 0 ? 1 : 0)) - (b.troops + (b.owner >= 0 ? 1 : 0)));
      const t = targets[0];
      if (!t) continue;
      const defense = t.troops + (t.owner >= 0 ? 1 : 0);
      const k = Math.min(cell.troops - 1, defense + 1);
      if (k >= 2 && k > defense) {
        await call('POST', `/api/games/${game.game_id}/move`, { token: me.token, action: { type: 'attack', from: cell.i, to: t.i, troops: k } });
        console.log(`attack ${cell.i} -> ${t.i} with ${k}`);
        acted = true;
        break;
      }
    }
    if (!acted) {
      await call('POST', `/api/games/${game.game_id}/move`, { token: me.token, action: { type: 'pass' } });
      console.log('pass');
    }
  }
  console.log('guard exhausted; leaving the match to the turn timer and bots.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
