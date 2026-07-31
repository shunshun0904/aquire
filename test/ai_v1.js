/* ==========================================================================
   ACQUIRE - ルールベース CPU
   すべての判断は「重み付きスコア」で決める。学習も探索木もない。
   評価の柱:
     1. ボーナス（筆頭/第2位）を取れる位置にいるか
     2. 自分が持つ株の価値が上がるか / 他人の株を育てていないか
     3. 現金は手番あたり3株ぶんを目安に回す
   ========================================================================== */
(function (global) {
  'use strict';

  var AQ = global.AQ;
  var R = AQ.Rules;
  var E = AQ.Engine;
  var AI = {};

  /* 性格ごとの重み */
  var PERSONA = {
    balanced:   { buy: 1.00, risk: 1.00, hoard: 600,  merge: 1.00, label: 'バランス' },
    aggressive: { buy: 1.30, risk: 1.35, hoard: 0,    merge: 1.25, label: 'アグレッシブ' },
    cautious:   { buy: 0.80, risk: 0.70, hoard: 1600, merge: 0.85, label: 'キャッシュ重視' },
    tycoon:     { buy: 1.15, risk: 1.05, hoard: 300,  merge: 1.40, label: 'マージャー' }
  };
  AI.PERSONA = PERSONA;
  function persona(p) { return PERSONA[p.personality] || PERSONA.balanced; }

  function others(s, p) {
    return s.players.filter(function (x) { return x.idx !== p.idx; });
  }
  function maxOtherShares(s, p, chainId) {
    return others(s, p).reduce(function (m, x) { return Math.max(m, x.shares[chainId]); }, 0);
  }
  function totalOtherShares(s, p, chainId) {
    return others(s, p).reduce(function (m, x) { return m + x.shares[chainId]; }, 0);
  }
  function jitter(s) { return (s.rand() - 0.5) * 3; }

  /* ------------------------------------------------------------------ *
   * 最終的な資産の見込み（終了判断とリード判定に使う）
   * ------------------------------------------------------------------ */
  function projectedWorth(s, playerIdx) {
    var sz = E.sizes(s);
    var p = s.players[playerIdx];
    var total = p.cash;
    R.CHAIN_IDS.forEach(function (id) {
      if (sz[id] === 0) return;
      total += p.shares[id] * R.priceOf(id, sz[id]);
      E.bonusSplit(s, id, sz[id]).forEach(function (pay) {
        if (pay.player === playerIdx) total += pay.amount;
      });
    });
    return total;
  }
  AI.projectedWorth = projectedWorth;

  function isLeading(s, p) {
    var mine = projectedWorth(s, p.idx);
    return others(s, p).every(function (x) { return projectedWorth(s, x.idx) <= mine; });
  }

  /* ------------------------------------------------------------------ *
   * 合併の価値を見積もる（survivor を固定して評価）
   * ------------------------------------------------------------------ */
  function evaluateMerge(s, p, info, survivor) {
    var w = persona(p);
    var v = 0;
    var defunct = info.chains.filter(function (c) { return c !== survivor; });
    var totalTiles = 0;
    info.chains.forEach(function (c) { totalTiles += info.sizes[c]; });

    defunct.forEach(function (d) {
      var size = info.sizes[d];
      var price = R.priceOf(d, size);

      E.bonusSplit(s, d, size).forEach(function (pay) {
        if (pay.player === p.idx) v += pay.amount / 90;
        else v -= pay.amount / 210;
      });

      /* 手持ち株は売却か2:1交換で現金・株に変わる */
      v += (p.shares[d] * price) / 260;

      /* 逆に自分が育ててきたチェーンが消えるのは機会損失 */
      if (p.shares[d] >= 4 && size <= 6) v -= 6;
    });

    /* 存続チェーンの値上がり */
    var oldSize = info.sizes[survivor];
    var newSize = totalTiles + 1 + (info.lones ? info.lones.length : 0);
    var delta = R.priceOf(survivor, newSize) - R.priceOf(survivor, oldSize);
    v += (p.shares[survivor] * delta) / 45;
    v -= (totalOtherShares(s, p, survivor) * delta) / 150;

    /* 他人が支配するチェーンを安全圏に押し上げてしまう */
    if (oldSize < R.SAFE_SIZE && newSize >= R.SAFE_SIZE) {
      var mine = p.shares[survivor];
      if (mine > maxOtherShares(s, p, survivor)) v += 18;
      else if (mine === 0) v -= 14;
    }

    /* 終了トリガー */
    if (newSize >= R.END_SIZE) v += isLeading(s, p) ? 45 : -45;

    return v * w.merge;
  }

  /* ------------------------------------------------------------------ *
   * タイル1枚のスコア
   * ------------------------------------------------------------------ */
  function scoreTile(s, p, tile) {
    var a = E.analyze(s, tile);
    var w = persona(p);
    var sz = E.sizes(s);
    var v = 0;

    if (a.type === 'dead' || a.type === 'blocked') return -Infinity;

    if (a.type === 'single') {
      /* 誰の得にもならない安全牌。孤立度が高いほど無害 */
      var near = 0;
      R.neighbors[tile].forEach(function (n) {
        R.neighbors[n].forEach(function (nn) { if (s.board[nn]) near++; });
      });
      v = 6 - near * 0.8;
      /* 盤の端に寄せておくと後で自分が設立しやすい */
      var r = R.rowOf(tile), c = R.colOf(tile);
      if (r === 0 || r === R.ROWS - 1 || c === 0 || c === R.COLS - 1) v += 1.5;
      return v + jitter(s);
    }

    if (a.type === 'found') {
      v = 48 + a.lones.length * 5;
      /* 設立直後に買い増せる現金があるほど価値が高い */
      if (p.cash >= 3000) v += 16;
      else if (p.cash >= 1200) v += 8;
      else v -= 10;
      /* 手持ちの死に株が復活するなら大きい */
      var revive = a.options.reduce(function (m, id) { return Math.max(m, p.shares[id]); }, 0);
      v += revive * 6;
      /* 残りチェーンが少ないほど設立権は貴重 */
      if (a.options.length <= 2) v += 10;
      return v * w.risk + jitter(s);
    }

    if (a.type === 'grow') {
      var size = sz[a.chain];
      var add = 1 + a.lones.length;
      var newSize = size + add;
      var delta = R.priceOf(a.chain, newSize) - R.priceOf(a.chain, size);
      var mine = p.shares[a.chain];
      var oth = totalOtherShares(s, p, a.chain);
      var maxOth = maxOtherShares(s, p, a.chain);

      v = (mine * delta) / 38 - (oth * delta) / 130;
      if (mine > 0) v += 6;
      if (mine === 0 && oth > 0) v -= 5;
      if (mine === 0 && oth === 0) v += 2;

      if (size < R.SAFE_SIZE && newSize >= R.SAFE_SIZE) {
        if (mine > maxOth) v += 24;
        else if (mine === 0) v -= 16;
        else v -= 5;
      }
      if (newSize >= R.END_SIZE) v += isLeading(s, p) ? 45 : -45;
      return v + jitter(s);
    }

    if (a.type === 'merge') {
      /* 存続チェーンを選べる場合は自分に一番良い選択を想定する */
      var best = -Infinity;
      a.candidates.forEach(function (c) {
        best = Math.max(best, evaluateMerge(s, p, a, c));
      });
      return best + jitter(s);
    }

    return jitter(s);
  }
  AI.scoreTile = scoreTile;

  /* ------------------------------------------------------------------ *
   * 公開 API
   * ------------------------------------------------------------------ */
  AI.chooseTile = function (s, p) {
    var legal = E.playableTiles(s, p);
    if (!legal.length) return null;
    var best = legal[0], bestScore = -Infinity;
    legal.forEach(function (t) {
      var sc = scoreTile(s, p, t);
      if (sc > bestScore) { bestScore = sc; best = t; }
    });
    return best;
  };

  AI.chooseFoundChain = function (s, p, options) {
    var best = options[0], bestScore = -Infinity;
    options.forEach(function (id) {
      var tier = R.chain(id).tier;
      var sc = 0;
      /* すでに持っている株が生き返るのが最優先 */
      sc += p.shares[id] * 14;
      /* 相手の死に株を蘇らせるのは避ける */
      sc -= maxOtherShares(s, p, id) * 9;
      /* 買い増せる現金があるなら高ティアの方が儲かる */
      sc += (p.cash >= 3500 ? tier * 7 : -tier * 5);
      sc += (s.rand() - 0.5) * 2;
      if (sc > bestScore) { bestScore = sc; best = id; }
    });
    return best;
  };

  AI.chooseSurvivor = function (s, p, info, candidates) {
    var best = candidates[0], bestScore = -Infinity;
    candidates.forEach(function (c) {
      var sc = evaluateMerge(s, p, info, c);
      if (sc > bestScore) { bestScore = sc; best = c; }
    });
    return best;
  };

  /* 消滅チェーンの株をどうするか */
  AI.disposal = function (s, p) {
    var d = s.pending.dispose;
    var held = p.shares[d.defunct];
    var survivor = d.survivor;
    var w = persona(p);

    var trade = 0;
    if (s.bank[survivor] > 0 && held >= 2) {
      var myS = p.shares[survivor];
      var needed = Math.max(0, maxOtherShares(s, p, survivor) - myS + 1);
      var wantShares = Math.min(needed, s.bank[survivor]);
      if (wantShares > 0) {
        var t = Math.min(held, wantShares * 2, s.bank[survivor] * 2);
        t -= t % 2;
        if (t >= 2) trade = t;
      }
      /* 筆頭を狙えなくても、存続側の方が高値なら少しだけ乗り換える */
      if (trade === 0 && held >= 4 &&
          R.priceOf(survivor, E.sizeOf(s, survivor)) > d.price * 1.15) {
        trade = 2;
      }
    }

    var remain = held - trade;

    /* 小さいチェーンは再設立されやすいので種株を残す */
    var availableLater = E.availableChains(s).length + 1;
    var keep = 0;
    if (d.size <= 5 && availableLater > 0) keep = Math.min(2, remain);
    if (p.personality === 'cautious') keep = Math.min(remain, keep);
    if (p.cash < 1000) keep = 0; // 現金が無いなら売る
    keep = Math.round(keep * w.risk);
    keep = Math.max(0, Math.min(keep, remain));

    return { sell: remain - keep, trade: trade };
  };

  /* ------------------------------------------------------------------ *
   * 株の購入（1株ずつ貪欲に選ぶ）
   * ------------------------------------------------------------------ */
  function chainValue(s, p, opt, cart) {
    var w = persona(p);
    var mine = p.shares[opt.id] + (cart[opt.id] || 0);
    var maxOth = maxOtherShares(s, p, opt.id);
    var tier = R.chain(opt.id).tier;
    var v = 12;

    if (mine + 1 > maxOth) v += 40;
    else if (mine + 1 === maxOth) v += 22;
    else v += 6;

    if (mine === 0) v += 5;

    if (opt.size <= 4) v += 22;
    else if (opt.size <= 6) v += 15;
    else if (opt.size <= 10) v += 8;
    if (opt.size >= R.SAFE_SIZE) v += 12; // 確実にボーナスが出る

    v += tier * 4;
    v += (opt.left <= 6) ? 8 : 0;
    v -= (opt.price / 100) * 2.2;

    return v * w.buy + (s.rand() - 0.5) * 2;
  }

  AI.buyCart = function (s, p) {
    var w = persona(p);
    var cart = {};
    var budget = p.cash;
    var bought = 0;
    var endgame = E.canDeclareEnd(s) || s.bag.length < 6;
    var reserve = endgame ? 0 : w.hoard;

    for (var k = 0; k < R.MAX_BUY_PER_TURN; k++) {
      var opts = E.buyOptions(s).filter(function (o) {
        return o.left - (cart[o.id] || 0) > 0 && o.price <= budget;
      });
      if (!opts.length) break;

      var best = null, bestV = -Infinity;
      opts.forEach(function (o) {
        var v = chainValue(s, p, o, cart);
        /* 手元資金を割り込む買い物は価値が高い時だけ */
        if (budget - o.price < reserve) v -= 18;
        if (v > bestV) { bestV = v; best = o; }
      });

      if (!best || bestV < 10) break;
      cart[best.id] = (cart[best.id] || 0) + 1;
      budget -= best.price;
      bought++;
    }
    return cart;
  };

  AI.shouldDeclareEnd = function (s, p) {
    if (!E.canDeclareEnd(s)) return false;
    var mine = projectedWorth(s, p.idx);
    var best = 0;
    others(s, p).forEach(function (x) { best = Math.max(best, projectedWorth(s, x.idx)); });
    /* 勝っているなら即終了、僅差で負けているなら粘る */
    return mine > best * 1.02;
  };

  AQ.AI_V1 = AI;
})(window);
