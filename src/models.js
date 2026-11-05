const mongoose = require('mongoose');

// One document per finished round.
const roundSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  crash: Number,
  hash: String,
  startedAt: Date,
  endedAt: { type: Date, index: true },
  partial: Boolean, // collector joined mid-round, some bets may be missing
  playerCount: Number,
  betCount: Number,
  classicBets: Number,
  trenballBets: Number,
  winners: Number, // winning bets
  wageredUsd: Number,
  classicWageredUsd: Number,
  trenballWageredUsd: Number,
  payoutUsd: Number,
  playersProfitUsd: Number, // sum of player profit (negative = house won)
}, { versionKey: false });

// One document per player bet per round.
const betSchema = new mongoose.Schema({
  gameId: { type: String, index: true },
  betId: String,
  playerId: { type: String, index: true },
  name: String,
  kind: String, // 'classic' | 'trenball'
  slot: Number, // classic: bet panel 1 or 2
  side: String, // trenball: Red / Green / Moon / ...
  condition: { op: String, x: Number },
  payout: Number, // multiplier paid when won
  amount: Number,
  currency: String,
  usd: Number,
  autoCashout: Number,
  cashedAt: Number,
  won: Boolean,
  profitUsd: Number,
  crash: Number,
  at: Date,
}, { versionKey: false });
betSchema.index({ playerId: 1, at: -1 });

// Running totals per player across all rounds (updated with $inc at round end).
const playerSchema = new mongoose.Schema({
  _id: String,
  name: String,
  rounds: Number, // rounds played
  bets: Number, // bets placed (a round can have several)
  classicBets: Number,
  trenballBets: Number,
  wins: Number, // winning bets
  losses: Number,
  wageredUsd: Number,
  profitUsd: Number,
  biggestWinUsd: Number,
  biggestLossUsd: Number,
  bestMultiplier: Number,
  firstSeen: Date,
  lastSeen: Date,
}, { versionKey: false });
for (const f of ['profitUsd', 'wageredUsd', 'rounds', 'bets', 'wins', 'lastSeen', 'biggestWinUsd', 'biggestLossUsd', 'bestMultiplier']) {
  playerSchema.index({ [f]: -1 });
}
playerSchema.index({ name: 1 });

module.exports = {
  Round: mongoose.model('Round', roundSchema),
  Bet: mongoose.model('Bet', betSchema),
  Player: mongoose.model('Player', playerSchema),
};
