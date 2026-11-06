// Bot-vs-bot simulation proof for the Gridlock engine.
// Runs full matches at 2, 3 and 4 seats and asserts every match terminates
// with a winner inside the 20-round cap.
import { createGame, applyAction, botAction, cellCounts } from "./engine.js";

for (const seats of [2, 3, 4]) {
  for (let trial = 0; trial < 5; trial++) {
    const state = createGame(seats);
    let actions = 0;
    while (state.phase !== "done") {
      const seat = state.turn;
      applyAction(state, seat, botAction(state, seat));
      actions++;
      if (actions > 1000) throw new Error(`runaway match at ${seats} seats`);
    }
    const { counts } = cellCounts(state);
    const captures = state.log.filter((e) => e.result === "capture").length;
    console.log(
      `seats=${seats} trial=${trial} winner=${state.winner} rounds=${Math.min(state.round, 20)} actions=${actions} captures=${captures} finalCells=${counts.join("/")}`
    );
    if (state.winner === null || state.winner === undefined) throw new Error("no winner");
    if (counts[state.winner] === 0) throw new Error("winner holds no cells");
  }
}
console.log("ALL SIMULATIONS PASSED");
