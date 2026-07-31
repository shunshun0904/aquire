/* ==========================================================================
   ヘッドレス検証: CPU 同士でゲームを大量に回し、ルール不変条件を確認する。
     node test/sim.js [games]
   ========================================================================== */
'use strict';

global.window = global;
require('../js/rules.js');
require('../js/engine.js');
require('../js/ai.js');

var R = global.AQ.Rules;
var E = global.AQ.Engine;
var AI = global.AQ.AI;

var failures = [];
function check(cond, msg, ctx) {
  if (!cond) failures.push(msg + (ctx ? ' :: ' + ctx : ''));
  return cond;
}

/* --- 不変条件 -------------------------------------------------------- */
function invariants(s, where) {
  R.CHAIN_IDS.forEach(function (id) {
    var held = s.players.reduce(function (n, p) { return n + p.shares[id]; }, 0);
    check(held + s.bank[id] === R.SHARES_PER_CHAIN,
      '株の総数が25枚でない: ' + id + ' (bank=' + s.bank[id] + ' held=' + held + ')', where);
    check(s.bank[id] >= 0, '銀行の株がマイナス: ' + id, where);
  });

  s.players.forEach(function (p) {
    check(p.cash >= 0, p.name + ' の所持金がマイナス: ' + p.cash, where);
    check(p.tiles.length <= R.HAND_SIZE, p.name + ' の手札が6枚超', where);
    p.tiles.forEach(function (t) {
      check(s.board[t] === null, '手札のタイルが盤上にもある: ' + R.label(t), where);
    });
  });

  /* 盤面: 無所属タイル同士が隣接していないこと（初期配置の連結は許容） */
  var sz = E.sizes(s);
  R.CHAIN_IDS.forEach(function (id) {
    if (sz[id] === 0) return;
    check(sz[id] >= 2, 'チェーンが1マス以下: ' + id + ' size=' + sz[id], where);
  });

  /* 各チェーンは1つの連結成分であること */
  R.CHAIN_IDS.forEach(function (id) {
    if (sz[id] === 0) return;
    var tiles = E.tilesOf(s, id);
    var seen = {}, stack = [tiles[0]], n = 0;
    while (stack.length) {
      var t = stack.pop();
      if (seen[t]) continue;
      seen[t] = true; n++;
      R.neighbors[t].forEach(function (x) { if (!seen[x] && s.board[x] === id) stack.push(x); });
    }
    check(n === tiles.length, 'チェーンが分断されている: ' + id + ' (' + n + '/' + tiles.length + ')', where);
  });

  /* 盤上 + 手札 + 山札 + 箱に戻した死にタイル = 108 */
  var onBoard = s.board.filter(function (v) { return v !== null; }).length;
  var inHands = s.players.reduce(function (n, p) { return n + p.tiles.length; }, 0);
  check(onBoard + inHands + s.bag.length + s.discarded.length === R.CELLS,
    'タイル総数が108でない: ' + onBoard + '+' + inHands + '+' + s.bag.length +
    '+' + s.discarded.length, where);

  /* 同じタイルが二重に存在しない */
  var seenTile = {};
  var all = s.players.reduce(function (acc, p) { return acc.concat(p.tiles); }, [])
    .concat(s.bag, s.discarded);
  all.forEach(function (t) {
    check(!seenTile[t], 'タイルが重複: ' + R.label(t), where);
    check(s.board[t] === null, '盤上のタイルが手札/山札にもある: ' + R.label(t), where);
    seenTile[t] = true;
  });
}

/* --- 1ゲーム実行 ----------------------------------------------------- */
function playGame(seed, playerCount) {
  var players = [];
  var personas = ['balanced', 'aggressive', 'cautious', 'tycoon'];
  for (var i = 0; i < playerCount; i++) {
    players.push({ name: 'P' + i, personality: personas[i % personas.length] });
  }

  var s = E.newGame({ players: players, seed: seed });
  var guard = 0;
  var stats = { merges: 0, founds: 0, turns: 0 };

  while (s.phase !== 'gameover') {
    if (++guard > 20000) { failures.push('seed ' + seed + ': ゲームが終わらない'); break; }
    s.fx.forEach(function (f) {
      if (f.t === 'merge-start') stats.merges++;
      if (f.t === 'found') stats.founds++;
    });
    s.fx.length = 0;

    var actor = E.actor(s);
    var where = 'seed=' + seed + ' phase=' + s.phase + ' actor=' + actor.name;

    switch (s.phase) {
      case 'place': {
        var t = AI.chooseTile(s, actor);
        if (t === null) { E.buy(s, {}); break; }
        check(E.isPlayable(s, t), '非合法なタイルを選んだ: ' + R.label(t), where);
        E.placeTile(s, t);
        stats.turns++;
        break;
      }
      case 'found':
        E.chooseFoundChain(s, AI.chooseFoundChain(s, actor, s.pending.found.options));
        break;
      case 'survivor': {
        var m = s.pending.merge;
        E.chooseSurvivor(s, AI.chooseSurvivor(s, actor,
          { chains: m.chains, sizes: m.sizes, lones: m.lones }, m.candidates));
        break;
      }
      case 'dispose': {
        var d = s.pending.dispose;
        var p = actor;
        var choice = AI.disposal(s, p);
        var held = p.shares[d.defunct];
        check(choice.sell >= 0 && choice.trade >= 0, 'AI が負の枚数を返した', where);
        check(choice.trade % 2 === 0, 'AI の交換枚数が奇数: ' + choice.trade, where);
        check(choice.sell + choice.trade <= held,
          'AI が保有数を超えて処分: ' + choice.sell + '+' + choice.trade + '>' + held, where);
        check(choice.trade / 2 <= s.bank[d.survivor],
          'AI が在庫を超えて交換: ' + choice.trade / 2 + '>' + s.bank[d.survivor], where);
        E.submitDisposal(s, choice);
        break;
      }
      case 'buy': {
        if (AI.shouldDeclareEnd(s, actor)) E.declareEnd(s);
        var cartObj = AI.buyCart(s, actor);
        var n = 0, cost = 0, sz = E.sizes(s);
        R.CHAIN_IDS.forEach(function (id) {
          var q = cartObj[id] || 0;
          n += q; cost += q * R.priceOf(id, sz[id]);
          check(q <= s.bank[id], 'AI が在庫超過で購入: ' + id, where);
          check(q === 0 || sz[id] > 0, 'AI が盤外チェーンを購入: ' + id, where);
        });
        check(n <= 3, 'AI が3株を超えて購入: ' + n, where);
        check(cost <= actor.cash, 'AI が所持金を超えて購入', where);
        E.buy(s, cartObj);
        break;
      }
      default:
        failures.push('未知のフェーズ: ' + s.phase);
        return stats;
    }
    invariants(s, where);
  }

  check(s.results && s.results.length === playerCount, 'seed ' + seed + ': 結果が生成されていない');
  if (s.results) {
    s.results.forEach(function (r) {
      check(r.cash >= 0, 'seed ' + seed + ': 最終所持金がマイナス');
    });
    for (var k = 1; k < s.results.length; k++) {
      check(s.results[k - 1].cash >= s.results[k].cash, 'seed ' + seed + ': 順位が金額順でない');
    }
  }
  /* 清算後、盤上に残っているチェーンの株は全て換金されて銀行に戻る。
     盤上にないチェーン（消滅したまま再設立されなかった）の株は紙切れなので手元に残る。 */
  var finalSizes = E.sizes(s);
  R.CHAIN_IDS.forEach(function (id) {
    if (finalSizes[id] === 0) return;
    check(s.bank[id] === R.SHARES_PER_CHAIN,
      '清算後に有効チェーンの株が残っている: ' + id + ' bank=' + s.bank[id]);
  });

  stats.winner = s.results ? s.results[0] : null;
  stats.turnCount = s.turnCount;
  stats.log = s.log.length;
  return stats;
}

/* --- 実行 ------------------------------------------------------------- */
var N = parseInt(process.argv[2], 10) || 200;
var t0 = Date.now();
var totals = { merges: 0, founds: 0, turns: 0, rounds: 0, cash: 0 };
var winByPersona = {};

for (var g = 0; g < N; g++) {
  var count = 2 + (g % 5); // 2〜6人
  var st = playGame(1000 + g, count);
  totals.merges += st.merges;
  totals.founds += st.founds;
  totals.turns += st.turns;
  totals.rounds += st.turnCount || 0;
  if (st.winner) totals.cash += st.winner.cash;
  if (failures.length > 40) break;
}

var dt = Date.now() - t0;
console.log('=== ACQUIRE エンジン検証 ===');
console.log(N + ' ゲーム / ' + dt + 'ms (' + (dt / N).toFixed(1) + 'ms per game)');
console.log('平均 ラウンド数 : ' + (totals.rounds / N).toFixed(1));
console.log('平均 配置回数   : ' + (totals.turns / N).toFixed(1));
console.log('平均 設立回数   : ' + (totals.founds / N).toFixed(2));
console.log('平均 合併回数   : ' + (totals.merges / N).toFixed(2));
console.log('平均 勝者資産   : ' + R.formatMoney(Math.round(totals.cash / N)));

if (failures.length) {
  console.log('\n❌ 失敗 ' + failures.length + ' 件:');
  failures.slice(0, 25).forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
} else {
  console.log('\n✅ すべての不変条件を満たしました');
}
