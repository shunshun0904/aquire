/* ==========================================================================
   CPU の強さ比較。席順をローテーションして先手/後手の有利を打ち消す。
     node test/bench.js [games] [agentA,agentB,agentC,agentD]
   agent: v2 / v1 / random
   ========================================================================== */
'use strict';

global.window = global;
require('../js/rules.js');
require('../js/engine.js');
require('../js/ai.js');
require('./ai_v1.js');

var R = global.AQ.Rules;
var E = global.AQ.Engine;
var V2 = global.AQ.AI;
var V1 = global.AQ.AI_V1;

/* --- ランダムプレイヤー ---------------------------------------------- */
var RANDOM = {
  PERSONA: V2.PERSONA,
  chooseTile: function (s, p) {
    var l = E.playableTiles(s, p);
    return l.length ? l[(s.rand() * l.length) | 0] : null;
  },
  chooseFoundChain: function (s, p, o) { return o[(s.rand() * o.length) | 0]; },
  chooseSurvivor: function (s, p, info, c) { return c[(s.rand() * c.length) | 0]; },
  disposal: function (s, p) {
    return { sell: p.shares[s.pending.dispose.defunct], trade: 0 };
  },
  buyCart: function (s, p) {
    var cart = {}, n = 0, cash = p.cash;
    var opts = E.buyOptions(s);
    while (n < 3 && opts.length) {
      var o = opts[(s.rand() * opts.length) | 0];
      if (o.price > cash || (cart[o.id] || 0) >= o.left) break;
      cart[o.id] = (cart[o.id] || 0) + 1; cash -= o.price; n++;
    }
    return cart;
  },
  shouldDeclareEnd: function () { return false; }
};

var AGENTS = { v2: V2, v1: V1, random: RANDOM };

function playGame(seed, agents) {
  var s = E.newGame({
    seed: seed,
    players: agents.map(function (a, i) {
      return { name: a.tag + i, personality: a.personality };
    })
  });
  var guard = 0;
  while (s.phase !== 'gameover') {
    if (++guard > 30000) throw new Error('無限ループ seed=' + seed);
    s.fx.length = 0;
    var p = E.actor(s);
    var A = agents[p.idx].impl;
    switch (s.phase) {
      case 'place': {
        var t = A.chooseTile(s, p);
        if (t === null) { E.buy(s, {}); break; }
        E.placeTile(s, t);
        break;
      }
      case 'found':
        E.chooseFoundChain(s, A.chooseFoundChain(s, p, s.pending.found.options));
        break;
      case 'survivor': {
        var m = s.pending.merge;
        E.chooseSurvivor(s, A.chooseSurvivor(s, p,
          { chains: m.chains, sizes: m.sizes, lones: m.lones }, m.candidates));
        break;
      }
      case 'dispose':
        E.submitDisposal(s, A.disposal(s, p));
        break;
      case 'buy':
        if (A.shouldDeclareEnd(s, p)) E.declareEnd(s);
        E.buy(s, A.buyCart(s, p));
        break;
      default:
        throw new Error('unknown phase ' + s.phase);
    }
  }
  return s.results;
}

var N = parseInt(process.argv[2], 10) || 400;
var spec = (process.argv[3] || 'v2,v1,random,v2').split(',');
var personas = ['balanced', 'aggressive', 'cautious', 'tycoon'];

var tally = {};
spec.forEach(function (name, i) {
  var key = name + '#' + i;
  tally[key] = { name: name, wins: 0, cash: 0, games: 0 };
});
var keys = Object.keys(tally);

for (var g = 0; g < N; g++) {
  /* 席順を1つずつずらす */
  var seats = spec.map(function (_, i) { return (i + g) % spec.length; });
  var agents = seats.map(function (specIdx, seat) {
    return {
      impl: AGENTS[spec[specIdx]],
      tag: spec[specIdx],
      personality: personas[seat % personas.length],
      key: keys[specIdx]
    };
  });
  var res = playGame(20000 + g, agents);
  res.forEach(function (r) {
    var t = tally[agents[r.player].key];
    t.games++; t.cash += r.cash;
    if (r.rank === 1) t.wins++;
  });
}

console.log('=== CPU ベンチマーク ===');
console.log(N + ' ゲーム / ' + spec.length + '人戦 / 席順ローテーション');
console.log('期待勝率(互角なら) ' + (100 / spec.length).toFixed(1) + '%\n');
keys.forEach(function (k) {
  var t = tally[k];
  console.log('  ' + t.name.padEnd(8) +
    ' 勝率 ' + (t.wins / t.games * 100).toFixed(1).padStart(5) + '%' +
    '   平均資産 ' + R.formatMoney(Math.round(t.cash / t.games)).padStart(10));
});
