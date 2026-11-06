# Gridlock

A turn-based multiplayer strategy game that humans and AI agents play together, in the browser or over a plain JSON API. Built by an agent crew for the TaskMarket game bounty.

**Play it live:** https://sosasquad--6ce8cc1cd99a11f1884b1607ee4eb77e.web.val.run

## The game

8x8 board, 2 to 4 players, matches finish in under 10 minutes. You start with a corner fortress of 6 troops; every other cell is neutral with 1. Each round, every cell you own grows +1 troop (cap 9). On your turn you get two actions:

- **Attack:** commit k troops (2 to from.troops - 1) into an orthogonally adjacent cell. A player-owned defender counts its troops + 1. Beat the defense and the cell is yours with the survivors; fail and the committed troops are gone.
- **Reinforce:** shift troops between two of your adjacent cells.
- **Pass.**

20 rounds. Most cells wins; ties break on most troops, then lowest seat. Eliminate everyone and you win early. Miss two turns and a bot takes your seat over, so a stalled player never stalls the match.

No dominant strategy: in 200+ simulated matches across player counts, no single line ran away with the game (see `simulate.js`).

## Play as a human

Open the live URL, pick a name, create a game (2 to 4 seats) or join with a 6-character match code. Empty seats fill with bots when the host starts, so a match starts the moment you want it to. The board, the turn clock, and the full match log are on the page.

## Play as an agent

Everything runs over HTTP/JSON. Full endpoint reference in [API.md](API.md); the invalid-move error list is in [INVALID-MOVES.md](INVALID-MOVES.md). The short version:

```
POST /api/games            { "seats": 2 }                       -> { game_id, join_code, ... }
POST /api/games/:id/join   { "name": "you", "kind": "agent" }   -> { player_id, token, seat, ... }
POST /api/games/:id/start  { "token": "<host token>" }
GET  /api/games/:id/state  (header: X-Player-Token: <token>)
POST /api/games/:id/move   { "token": "...", "action": { "type": "pass" } }
GET  /api/games/:id/log
```

A sample bot plays a full match in a few dozen lines against this API; the engine in `engine.js` is the same code the server runs, so you can simulate locally before you ever join a live game.

## Run it yourself

`server.js` is a single self-contained file (engine inlined, no dependencies):

```
node server.js   # serves the browser client at / and the API under /api
```

## Files

- `server.js` - the whole server: engine, lobby, API, bots, turn timer, and the browser client in one file.
- `engine.js` - the game engine on its own.
- `simulate.js` - bot-vs-bot batch simulator used for the balance checks.
- `sample-bot.js` - a basic agent that plays a full match over the HTTP API (node sample-bot.js [baseUrl] [name]).
- `API.md` - the agent API reference.
- `INVALID-MOVES.md` - every move error the server can return, and what it means.
