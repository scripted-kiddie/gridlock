# Gridlock - invalid move and error list

For Padraic's Muse (QA) and anyone building against the API.
Server: `server.js` (single file, Val Town). Every error response has the same shape:

```json
{ "error": "<stable_code>", "message": "<human readable explanation>" }
```

Clients and bots must branch on `error`, never on `message`. Messages can be reworded; codes are the contract.
All of the move cases below were exercised live against the local server in `test-server.mjs` on Nov 5, 2026 and returned exactly the status and code listed.

## Move endpoint: POST /api/games/:id/move

Checks run in this order: game exists, token, game phase, seat takeover, action shape, cell range, then engine rules.

| # | Illegal input | HTTP | error code |
|---|---|---|---|
| 1 | No token (no `token` field, no `X-Player-Token` header, no Bearer header) | 401 | `missing_token` |
| 2 | Token that does not belong to any player in this game | 401 | `invalid_token` |
| 3 | Move while the game is still in the lobby | 409 | `game_not_started` |
| 4 | Move after the game has ended | 409 | `game_over` |
| 5 | Move from a seat that was taken over by a bot after 2 missed turns | 403 | `seat_bot_controlled` |
| 6 | No action at all (missing `action` and `type`) | 400 | `missing_action` |
| 7 | Action type other than `attack`, `reinforce`, `pass` (for example `nuke`) | 400 | `unknown_action` |
| 8 | `from` or `to` missing, not an integer, or outside 0 to 63 (attack and reinforce) | 422 | `cell_out_of_range` |
| 9 | `from` and `to` are the same cell | 422 | `cells_not_adjacent` |
| 10 | It is not this player's turn | 403 | `not_your_turn` |
| 11 | Attack: `from` cell is neutral or belongs to another player | 422 | `from_not_yours` |
| 12 | Attack: `to` cell already belongs to the attacker | 422 | `target_is_own_cell` |
| 13 | Attack or reinforce: `from` and `to` are not orthogonally adjacent (diagonals count as not adjacent) | 422 | `cells_not_adjacent` |
| 14 | Attack: `troops` missing or not an integer | 422 | `invalid_troops` |
| 15 | Attack: `troops` under 2, or more than `from.troops - 1` (a cell must keep at least 1 troop) | 422 | `invalid_troops` |
| 16 | Reinforce: either cell is neutral or belongs to another player | 422 | `reinforce_requires_own_cells` |
| 17 | Reinforce: `troops` missing, not an integer, under 1, or more than `from.troops - 1` | 422 | `invalid_troops` |
| 18 | Reinforce: move would push the target cell past the troop cap of 9 | 422 | `troop_cap_exceeded` |
| 19 | Any move on a `game_id` that does not exist | 404 | `game_not_found` |
| 20 | Request body that is not valid JSON, on any POST | 400 | `malformed_json` |

Notes on legal-but-losing moves, so QA does not file them as errors:

- An attack that does not beat the defender strength (target troops, plus 1 if the target is player owned) is a **legal** move. It returns 200, the committed troops are lost, the defender is unchanged, and the log entry result is `repelled`. Only a commitment that beats the strength captures, with result `capture`.
- `pass` is always legal on your turn, takes one of your 2 actions, and ignores any `from`, `to`, or `troops` fields sent with it.
- A failed move (any row above) never consumes an action and never changes the board. Only a 200 move advances `actions_left`.
- Turn timer: if a seat sends no successful move inside its 30 second turn window, the server auto-passes both actions, logs a `turn_timeout` event, and counts a miss. After 2 consecutive missed turns the seat becomes bot controlled for the rest of the match (log event `bot_takeover`) and row 5 applies to its old token. A successful move resets the consecutive miss count to 0.

## Lobby and lifecycle errors (same shape, for completeness)

| Endpoint | Illegal input | HTTP | error code |
|---|---|---|---|
| POST /api/games | `seats` not 2, 3 or 4 | 400 | `invalid_seats` |
| POST /api/games | `turn_seconds` present but not an integer from 1 to 600 | 400 | `invalid_turn_seconds` |
| POST /api/games/:id/join | `name` missing or blank | 400 | `missing_name` |
| POST /api/games/:id/join | `name` longer than 24 characters | 400 | `name_too_long` |
| POST /api/games/:id/join | `kind` other than `human` or `agent` (bots are server filled, never joined) | 400 | `invalid_kind` |
| POST /api/games/:id/join | Name already taken in this lobby (case insensitive) | 409 | `name_taken` |
| POST /api/games/:id/join | Lobby already has all seats filled | 409 | `lobby_full` |
| POST /api/games/:id/join | Game already started | 409 | `game_already_started` |
| POST /api/games/join-by-code | Join code matches no lobby | 404 | `join_code_not_found` |
| POST /api/games/:id/start | No token | 401 | `missing_token` |
| POST /api/games/:id/start | Token from outside this game | 401 | `invalid_token` |
| POST /api/games/:id/start | Caller is not the host (host is the first player to join) | 403 | `not_host` |
| POST /api/games/:id/start | Game already started | 409 | `game_already_started` |
| GET /api/games/:id/state | Token supplied but not from this game | 401 | `invalid_token` |
| GET /api/games/:id/log | Game still in the lobby, no log exists yet | 409 | `game_not_started` |
| Any route | Unknown path | 404 | `route_not_found` |
| Any route | Unexpected server fault | 500 | `internal_error` |

State without a token is allowed on purpose (spectators and the replay view); it returns the same state with `you: null`.

- Bag Chasers Muse, Nov 5, 2026
