/* ==========================================================================
   ACQUIRE - ルールベース CPU
   学習も探索木も使わない。すべての選択肢を「期待ドル」に換算して比較する。

   換算の柱:
     1. 株は最終清算で「そのときの株価」に戻る → 値上がり分が利益
     2. 筆頭ボーナス = 株価 x10 / 第2位 = 株価 x5 → 地位の改善は株価の何倍にもなる
     3. 合併ボーナスは即金。自分が取れるなら大きく加点、他人に渡すなら減点
   これで「設立」「拡大」「合併」「捨て牌」を同じ物差しで比較できる。
   ========================================================================== */
(function (global) {
  'use strict';

  var AQ = global.AQ;
  var R = AQ.Rules;
  var E = AQ.Engine;
  var AI = {};

  /* 性格ごとの重み。
     rival は「相手の利益をどれだけ嫌うか」。0.7 前後が最も強い（実測）ので
     そこを中心に、性格づけとして前後に散らしてある。 */
  var PERSONA = {
    balanced:   { buy: 1.00, bonus: 1.00, rival: 0.70, hoard: 600,  label: 'バランス' },
    aggressive: { buy: 1.25, bonus: 1.20, rival: 0.50, hoard: 0,    label: 'アグレッシブ' },
    cautious:   { buy: 0.85, bonus: 0.90, rival: 0.85, hoard: 1600, label: 'キャッシュ重視' },
    tycoon:     { buy: 1.10, bonus: 1.35, rival: 0.65, hoard: 300,  label: 'マージャー' }
  };
  AI.PERSONA = PERSONA;
  function persona(p) { return PERSONA[p.personality] || PERSONA.balanced; }

  function others(s, p) {
    return s.players.filter(function (x) { return x.idx !== p.idx; });
  }
  function maxOtherShares(s, p, chainId) {
    return others(s, p).reduce(function (m, x) { return Math.max(m, x.shares[chainId]); }, 0);
  }
  function jitter(s, scale) { return (s.rand() - 0.5) * (scale || 60); }

  /* ------------------------------------------------------------------ *
   * このチェーンは今後どれくらい伸びそうか（残りタイル数からの粗い見積り）
   * ------------------------------------------------------------------ */
  function expectedGrowth(s, size) {
    if (size >= R.END_SIZE) return 0;
    var remaining = s.bag.length;
    var active = E.activeChains(s).length || 1;
    /* 残タイルのうち、このチェーンに付く分をざっくり見積もる */
    var g = Math.round(remaining / (active + 2));
    return Math.max(1, Math.min(16, g));
  }

  /* 現時点で清算したら p がそのチェーンから受け取るボーナス額 */
  function bonusFor(s, p, chainId, size) {
    var out = 0;
    E.bonusSplit(s, chainId, size).forEach(function (pay) {
      if (pay.player === p.idx) out += pay.amount;
    });
    return out;
  }

  /* p の持ち株を delta 変化させたときのボーナス差分（一時的に書き換えて計算） */
  function bonusDelta(s, p, chainId, size, delta) {
    var before = bonusFor(s, p, chainId, size);
    p.shares[chainId] += delta;
    var after = bonusFor(s, p, chainId, size);
    p.shares[chainId] -= delta;
    return after - before;
  }

  /* ------------------------------------------------------------------ *
   * チェーンが add マス伸びることの価値（全プレイヤー分をドルで合算）
   *   株価上昇 x 持ち株 + ボーナス倍率（筆頭 x10 / 第2位 x5）
   * ------------------------------------------------------------------ */
  function growthValue(s, p, chainId, size, add) {
    if (add <= 0) return 0;
    var w = persona(p);
    var per = R.priceOf(chainId, size + add) - R.priceOf(chainId, size);
    if (per === 0) {
      /* 段の途中でも「次の段に近づく」分は価値がある */
      per = 100 * add / bracketWidth(size);
    }
    var v = 0;
    s.players.forEach(function (x) {
      var gain = x.shares[chainId] * per;
      var st = E.standing(s, chainId, x.idx);
      if (st === 'majority') gain += per * 10;
      else if (st === 'minority') gain += per * 5;
      v += (x.idx === p.idx) ? gain : -gain * w.rival;
    });
    return v;
  }

  function bracketWidth(size) {
    if (size <= 5) return 1;
    if (size <= 10) return 5;
    if (size <= 40) return 10;
    return 20;
  }

  /* ------------------------------------------------------------------ *
   * 合併の価値（存続チェーンを固定して評価）
   * ------------------------------------------------------------------ */
  function evaluateMerge(s, p, info, survivor) {
    var w = persona(p);
    var v = 0;
    var defunct = info.chains.filter(function (c) { return c !== survivor; });
    var totalTiles = 0;
    info.chains.forEach(function (c) { totalTiles += info.sizes[c]; });
    var lones = info.lones ? info.lones.length : 0;

    defunct.forEach(function (d) {
      var size = info.sizes[d];
      var price = R.priceOf(d, size);

      /* 即金のボーナス。自分の取り分は満額、他人の取り分は割り引いて減点 */
      E.bonusSplit(s, d, size).forEach(function (pay) {
        if (pay.player === p.idx) v += pay.amount * w.bonus;
        else v -= pay.amount * w.rival;
      });

      /* 持ち株は売却／2:1交換に変えられる（現金化の自由度） */
      v += p.shares[d] * price * 0.15;

      /* 育てている最中の小チェーンを潰すのは将来価値の取りこぼし */
      if (p.shares[d] >= 3 && size <= 6) {
        v -= growthValue(s, p, d, size, expectedGrowth(s, size)) * 0.4;
      }
    });

    /* 存続チェーンが一気に伸びる */
    var oldSize = info.sizes[survivor];
    var newSize = totalTiles + 1 + lones;
    v += growthValue(s, p, survivor, oldSize, newSize - oldSize);

    /* 安全圏に入ると以後は絶対に吸収されない */
    if (oldSize < R.SAFE_SIZE && newSize >= R.SAFE_SIZE) {
      var mine = p.shares[survivor];
      var maxOth = maxOtherShares(s, p, survivor);
      if (mine > maxOth) v += R.priceOf(survivor, newSize) * 3;
      else if (mine === 0) v -= R.priceOf(survivor, newSize) * 2.5;
    }

    /* 41マスは終了トリガー */
    if (newSize >= R.END_SIZE) v += isLeading(s, p) ? 6000 : -6000;

    return v;
  }

  /* ------------------------------------------------------------------ *
   * 最終資産の見込み（= 今ゲームが終わったときの所持金）
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
   * 新チェーン設立の価値
   * ------------------------------------------------------------------ */
  function foundValue(s, p, options) {
    var best = 0;
    options.forEach(function (id) {
      var startPrice = R.priceOf(id, 2);
      var g = expectedGrowth(s, 2);
      var projPrice = R.priceOf(id, Math.min(R.END_SIZE, 2 + g));

      /* 無料でもらえる1株の将来価値 */
      var v = projPrice;
      /* 設立直後は最安値。買い増せるなら先行者として筆頭を取りやすい */
      if (p.cash >= startPrice * 3) v += projPrice * 1.6;
      else if (p.cash >= startPrice) v += projPrice * 0.5;
      /* 死に株だったものが復活する */
      v += p.shares[id] * projPrice * 0.8;
      /* 相手の死に株を蘇らせてしまう分は減点 */
      v -= maxOtherShares(s, p, id) * projPrice * 0.5;
      if (v > best) best = v;
    });
    return best;
  }

  /* ------------------------------------------------------------------ *
   * タイル1枚のスコア（単位はドル相当）
   * ------------------------------------------------------------------ */
  function scoreTile(s, p, tile) {
    var a = E.analyze(s, tile);
    var sz = E.sizes(s);

    if (a.type === 'dead' || a.type === 'blocked') return -Infinity;

    if (a.type === 'single') {
      /* 誰の得にもならない「捨て牌」。周囲が空いているほど無害 */
      var near = 0;
      R.neighbors[tile].forEach(function (n) {
        R.neighbors[n].forEach(function (nn) { if (s.board[nn]) near++; });
      });
      return 40 - near * 12 + jitter(s, 20);
    }

    if (a.type === 'found') {
      return foundValue(s, p, a.options) + jitter(s);
    }

    if (a.type === 'grow') {
      var size = sz[a.chain];
      var add = 1 + a.lones.length;
      var newSize = size + add;
      var v = growthValue(s, p, a.chain, size, add);

      /* 安全圏の分かれ目 */
      if (size < R.SAFE_SIZE && newSize >= R.SAFE_SIZE) {
        var mine = p.shares[a.chain];
        var maxOth = maxOtherShares(s, p, a.chain);
        if (mine > maxOth) v += R.priceOf(a.chain, newSize) * 3;
        else if (mine === 0) v -= R.priceOf(a.chain, newSize) * 2.5;
        else v -= R.priceOf(a.chain, newSize) * 0.8;
      }
      if (newSize >= R.END_SIZE) v += isLeading(s, p) ? 6000 : -6000;
      return v + jitter(s);
    }

    if (a.type === 'merge') {
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
    var g = expectedGrowth(s, 2);
    var best = options[0], bestScore = -Infinity;
    options.forEach(function (id) {
      var projPrice = R.priceOf(id, Math.min(R.END_SIZE, 2 + g));
      var startPrice = R.priceOf(id, 2);
      var sc = projPrice;
      sc += p.shares[id] * projPrice * 0.8;            // 手持ちの死に株が復活
      sc -= maxOtherShares(s, p, id) * projPrice * 0.5; // 相手の死に株も復活してしまう
      /* 買い増す余力があるなら高ティアの方が儲かる。無いなら安い方 */
      sc += (p.cash >= startPrice * 3) ? projPrice * 0.6 : -startPrice * 2;
      sc += (s.rand() - 0.5) * 50;
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

  /* ------------------------------------------------------------------ *
   * 消滅チェーンの株の処分
   *   売却 = 即金 / 交換 = 2株を存続1株に / 保持 = 再設立に賭ける
   * ------------------------------------------------------------------ */
  AI.disposal = function (s, p) {
    var d = s.pending.dispose;
    var held = p.shares[d.defunct];
    var survivor = d.survivor;
    var survSize = E.sizeOf(s, survivor);
    var survPrice = R.priceOf(survivor, survSize);
    var g = expectedGrowth(s, survSize);
    var survProj = R.priceOf(survivor, Math.min(R.END_SIZE, survSize + g));

    /* 交換: 2株 -> 1株。存続チェーンで地位が上がるなら価値が高い */
    var trade = 0;
    if (s.bank[survivor] > 0 && held >= 2) {
      var needed = Math.max(0, maxOtherShares(s, p, survivor) - p.shares[survivor] + 1);
      var wantShares = Math.min(needed, s.bank[survivor]);
      if (wantShares > 0) {
        /* 筆頭を取れるなら、そのために必要な分だけ交換する */
        var gainIfMajority = bonusDelta(s, p, survivor, survSize, wantShares);
        var costOfTrade = wantShares * 2 * d.price; // 売却していれば得られた現金
        if (gainIfMajority + wantShares * survProj > costOfTrade) {
          var t = Math.min(held, wantShares * 2, s.bank[survivor] * 2);
          trade = t - (t % 2);
        }
      }
      /* 地位が取れなくても、存続側の方が明らかに伸びるなら乗り換える */
      if (trade === 0 && held >= 4 && survProj > d.price * 2.2) {
        trade = Math.min(2, s.bank[survivor] * 2);
        trade -= trade % 2;
      }
    }

    var remain = held - trade;

    /* 保持: 再設立されれば価値が戻るが、されなければ紙切れ */
    var keep = 0;
    var canRefound = E.availableChains(s).length + 1 > 0 && s.bag.length > 12;
    if (canRefound && d.size <= 4 && remain >= 2) keep = 1;
    keep = Math.max(0, Math.min(keep, remain));

    return { sell: remain - keep, trade: trade };
  };

  /* ------------------------------------------------------------------ *
   * 株の購入（1株ずつ、期待ドルが最大の株を貪欲に選ぶ）
   * ------------------------------------------------------------------ */
  function buyValue(s, p, opt) {
    var w = persona(p);
    var g = expectedGrowth(s, opt.size);
    var projSize = Math.min(R.END_SIZE, opt.size + g);
    var projPrice = R.priceOf(opt.id, projSize);

    /* 1) 値上がり益（買値は清算で戻ってくる前提） */
    var v = (projPrice - opt.price);

    /* 2) ボーナス地位の改善。確実ではないので割り引く */
    v += bonusDelta(s, p, opt.id, projSize, 1) * 0.5 * w.bonus;

    /* 3) 残り株が少ないチェーンは押さえておく価値がある */
    if (opt.left <= 5) v += projPrice * 0.4;

    /* 4) 安全圏のチェーンは確実にボーナスが出るので堅い */
    if (opt.size >= R.SAFE_SIZE) v += projPrice * 0.2;

    return v * w.buy + (s.rand() - 0.5) * 80;
  }

  AI.buyCart = function (s, p) {
    var w = persona(p);
    var cart = {};
    var budget = p.cash;
    var endgame = E.canDeclareEnd(s) || s.bag.length < 8;
    var reserve = endgame ? 0 : w.hoard;

    /* 評価中だけ持ち株を仮に増やすので、必ず元に戻す */
    var applied = {};
    try {
      for (var k = 0; k < R.MAX_BUY_PER_TURN; k++) {
        var opts = E.buyOptions(s).filter(function (o) {
          return o.left - (cart[o.id] || 0) > 0 && o.price <= budget;
        });
        if (!opts.length) break;

        var best = null, bestV = -Infinity;
        opts.forEach(function (o) {
          var v = buyValue(s, p, o);
          if (budget - o.price < reserve) v -= o.price;
          if (v > bestV) { bestV = v; best = o; }
        });

        if (!best || bestV <= 0) break;
        cart[best.id] = (cart[best.id] || 0) + 1;
        applied[best.id] = (applied[best.id] || 0) + 1;
        p.shares[best.id]++;          // 次の1株の評価に反映させる
        budget -= best.price;
      }
    } finally {
      R.CHAIN_IDS.forEach(function (id) {
        if (applied[id]) p.shares[id] -= applied[id];
      });
    }
    return cart;
  };

  AI.shouldDeclareEnd = function (s, p) {
    if (!E.canDeclareEnd(s)) return false;
    var mine = projectedWorth(s, p.idx);
    var best = 0;
    others(s, p).forEach(function (x) { best = Math.max(best, projectedWorth(s, x.idx)); });
    /* 勝っているなら終わらせる。負けているなら粘る */
    return mine > best;
  };

  AQ.AI = AI;
})(window);
