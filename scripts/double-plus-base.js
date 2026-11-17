var config = {
  baseBet: { label: 'Base bet (x)', value: currency.minAmount, type: 'number' },
  payout: { label: 'Cash out at', value: 2, type: 'number' },
  maxBet: { label: 'Max bet (reset to x above this, 0 = no cap)', value: 0, type: 'number' },
  stopProfit: { label: 'Stop when profit reaches (0 = never)', value: 0, type: 'number' },
  stopLoss: { label: 'Stop when loss reaches (0 = never)', value: 0, type: 'number' }
}

function main () {
  var x = config.baseBet.value;
  var payout = config.payout.value;
  var bet = x;
  var profit = 0;
  var streak = 0; // losses in a row
  var stopped = false;

  function round8 (n) { return parseFloat(n.toFixed(8)); }

  function stop (msg) {
    stopped = true;
    log.info(msg);
    if (typeof game.stop === 'function') game.stop();
  }

  log.info('Start: x = ' + x + ', cash out at ' + payout + 'x');

  game.onBet = function () {
    if (stopped) return;

    if (bet > currency.amount) {
      log.error('Next bet ' + bet + ' is more than the balance ' + currency.amount + '. Reset to x.');
      bet = x;
      streak = 0;
    }

    var amount = bet;
    // A bet sent too late is rejected ("Bet suspended. The game has started.").
    // Without a handler that error stops the script, so log it and retry the
    // same amount next round; a rejected bet is not a loss.
    function skipped (err) {
      log.info('Bet ' + amount + ' not placed (' + ((err && err.message) || err) + '). Retrying next round.');
    }
    var placed;
    try {
      placed = game.bet(amount, payout);
    } catch (err) {
      skipped(err);
      return;
    }
    placed.then(function (result) {
      if (result > 1) {
        profit = round8(profit + amount * (payout - 1));
        log.success('WIN ' + amount + ' at ' + payout + 'x after ' + streak + ' losses. Profit: ' + profit);
        streak = 0;
        bet = x;                          // win: reset to x
      } else {
        profit = round8(profit - amount);
        streak++;
        bet = round8(amount * 2 + x);     // lose: prev * 2 + x
        log.error('LOSE ' + amount + ' (' + streak + ' in a row). Next bet: ' + bet + '. Profit: ' + profit);
        if (config.maxBet.value > 0 && bet > config.maxBet.value) {
          log.error('Next bet is above the max bet ' + config.maxBet.value + '. Reset to x.');
          bet = x;
          streak = 0;
        }
      }

      if (config.stopProfit.value > 0 && profit >= config.stopProfit.value) stop('Profit target reached: ' + profit);
      else if (config.stopLoss.value > 0 && -profit >= config.stopLoss.value) stop('Stop loss reached: ' + profit);
    }, skipped);
  };
}
