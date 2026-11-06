// Gridlock - core game engine (pure logic, no I/O).
// Board: 8x8, index = row * 8 + col. Cell: { owner: seat index or -1 (neutral), troops }.
// Round: at round start every owned cell gains +1 troop (cap 9). Then each living
// player, in seat order, takes a turn of TWO actions: attack, reinforce, or pass.
// Attack: commit k troops (2 <= k <= from.troops - 1) into an orthogonally adjacent
// cell. Defender strength = target troops + 1 if target is player-owned, else target
// troops. k > strength captures: target becomes attacker's with k - strength troops.
// k <= strength fails: attacker loses the committed troops, defender unchanged.
// Reinforce: move troops from one of your cells to an adjacent own cell (leave >= 1).
// Win: last player holding cells, or after round 20 the most cells (tiebreak: most
// total troops, then lowest seat).

export const SIZE = 8;
export const CELLS = SIZE * SIZE;
export const MAX_ROUND = 20;
export const TROOP_CAP = 9;
const CORNERS = [0, SIZE - 1, CELLS - SIZE, CELLS - 1]; // TL, TR, BL, BR
// Seat placement by player count (playtest fix, Nov 4): 2P takes opposite
// corners (TL vs BR), not the two top corners. 3P keeps TL, TR, BL: on a
// square board one seat always sits between the other two, and seat 0 is
// that middle seat - named here as a known seat-order property, not a bug.
const SEAT_CORNERS = {
  2: [CORNERS[0], CORNERS[3]],
  3: [CORNERS[0], CORNERS[1], CORNERS[2]],
  4: CORNERS,
};

export function createGame(seats) {
  if (![2, 3, 4].includes(seats)) throw new Error("seats must be 2, 3 or 4");
  const board = [];
  for (let i = 0; i < CELLS; i++) board.push({ owner: -1, troops: 1 });
  for (let s = 0; s < seats; s++) board[SEAT_CORNERS[seats][s]] = { owner: s, troops: 6 };
  return {
    seats,
    board,
    round: 1,
    turn: 0, // seat index whose turn is due
    actionsLeft: 2, // each turn is 2 actions: expand AND strike, not either/or
    phase: "play", // "play" | "done"
    winner: null,
    log: [],
  };
}

const row = (i) => Math.floor(i / SIZE);
const col = (i) => i % SIZE;

export function neighbors(i) {
  const out = [];
  if (row(i) > 0) out.push(i - SIZE);
  if (row(i) < SIZE - 1) out.push(i + SIZE);
  if (col(i) > 0) out.push(i - 1);
  if (col(i) < SIZE - 1) out.push(i + 1);
  return out;
}

export function cellCounts(state) {
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

export function legalActions(state, seat) {
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

export function applyAction(state, seat, action) {
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
  if (state.actionsLeft > 0) return state; // same player acts again
  const nxt = nextLivingTurn(state, seat);
  if (nxt <= seat) {
    // wrapped around -> new round
    state.round += 1;
    if (finishIfDone(state)) return state;
    startRound(state);
  }
  state.turn = nxt;
  state.actionsLeft = 2;
  return state;
}

// Greedy bot: capture the weakest reachable target it can beat with the smallest
// sufficient commitment; otherwise shift troops toward its weakest border cell;
// otherwise pass. Deterministic; ties broken by lowest index (stable, testable).
export function botAction(state, seat) {
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
  // reinforce: strongest cell feeds the weakest adjacent own cell
  let move = null;
  for (const a of acts) {
    if (a.type !== "reinforce") continue;
    const from = state.board[a.from];
    const to = state.board[a.to];
    const border = neighbors(a.to).some((n) => state.board[n].owner !== seat);
    if (border && from.troops >= 5 && to.troops <= 3) {
      const k = Math.min(from.troops - 2, TROOP_CAP - to.troops);
      if (k >= 1 && (!move || to.troops < move.toTroops)) move = { type: "reinforce", from: a.from, to: a.to, troops: k, toTroops: to.troops };
    }
  }
  if (move) return { type: move.type, from: move.from, to: move.to, troops: move.troops };
  return { type: "pass" };
}
