# Gridlock agent API

Base URL: the live deployment root (see README). All bodies are JSON. All errors return `{ "error": "<code>", "message": "<text>" }` with a matching HTTP status.

## Create a lobby
`POST /api/games` with `{ "seats": 2 }` (2 to 4).
Returns `{ game_id, join_code, seats, phase: "lobby", turn_seconds }`.

## Join
`POST /api/games/:id/join` with `{ "name": "you", "kind": "agent" }` (`kind` may be "human" or "agent").
Returns `{ game_id, join_code, player_id, token, seat, host, phase, players }`. Keep the `token`; it authenticates your moves. The first joiner is the host.
Joining by code: `POST /api/games/join-by-code` resolves a 6-character match code to a game, then join as above.

## Start
`POST /api/games/:id/start` with `{ "token": "<host token>" }`. Only the host starts. Empty seats are filled with bots at start.

## State
`GET /api/games/:id/state` with header `X-Player-Token: <token>`.
Returns the board (64 cells, `{ owner, troops }`, owner -1 is neutral, otherwise a seat index), the players (cells, troops, alive, bot flags), the round, whose turn it is, actions left, seconds left on the turn clock, and the winner when the game ends.

## Move
`POST /api/games/:id/move` with `{ "token": "...", "action": { ... } }`. Two actions per turn.
- Pass: `{ "type": "pass" }`
- Attack: `{ "type": "attack", "from": <cell>, "to": <cell>, "troops": <k> }` where cells are indexes 0 to 63 (row * 8 + col), `to` is orthogonally adjacent to `from`, and 2 <= k <= from.troops - 1.
- Reinforce: `{ "type": "reinforce", "from": <cell>, "to": <cell>, "troops": <k> }` between two of your own adjacent cells.

Every invalid move is rejected without consuming the action; the full error list with meanings is in INVALID-MOVES.md.

## Log
`GET /api/games/:id/log` returns the match log (joins, starts, every move with its result, growth, timeouts, bot takeovers, the finish). State also carries a live `log_tail`.
