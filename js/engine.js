/* ==========================================================================
   ACQUIRE - ゲームエンジン
   状態遷移とルール判定のみを担当する。DOM には一切触れない。
   UI 層は state.fx（演出キュー）を読んでアニメーションを再生する。
   ========================================================================== */
(function (global) {
  'use strict';

  var AQ = global.AQ;
  var R = AQ.Rules;
  var E = {};

  /* ------------------------------------------------------------------ *
   * 乱数（シード指定で再現可能）
   * ------------------------------------------------------------------ */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rand) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function zeroShares() {
    var o = {};
    R.CHAIN_IDS.forEach(function (id) { o[id] = 0; });
    return o;
  }

  /* ------------------------------------------------------------------ *
   * 盤面の読み取り
   *   board[i] === null  空き
   *   board[i] === '.'   無所属タイル
   *   board[i] === 'luxor' 等  チェーン所属
   * ------------------------------------------------------------------ */
  function sizes(s) {
    var o = zeroShares();
    for (var i = 0; i < R.CELLS; i++) {
      var v = s.board[i];
      if (v && v !== '.') o[v]++;
    }
    return o;
  }
  E.sizes = sizes;

  E.sizeOf = function (s, chainId) {
    var n = 0;
    for (var i = 0; i < R.CELLS; i++) if (s.board[i] === chainId) n++;
    return n;
  };

  E.activeChains = function (s) {
    var sz = sizes(s);
    return R.CHAIN_IDS.filter(function (id) { return sz[id] > 0; });
  };

  E.availableChains = function (s) {
    var sz = sizes(s);
    return R.CHAIN_IDS.filter(function (id) { return sz[id] === 0; });
  };

  E.tilesOf = function (s, chainId) {
    var out = [];
    for (var i = 0; i < R.CELLS; i++) if (s.board[i] === chainId) out.push(i);
    return out;
  };

  /* 無所属タイルの連結成分（初期配置で隣り合う場合があるため必要） */
  function loneCluster(s, seeds) {
    var seen = {}, out = [], stack = seeds.slice();
    while (stack.length) {
      var t = stack.pop();
      if (seen[t] || s.board[t] !== '.') continue;
      seen[t] = true; out.push(t);
      R.neighbors[t].forEach(function (n) {
        if (!seen[n] && s.board[n] === '.') stack.push(n);
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * タイルを置いた時に何が起きるかを判定する
   *   single  : 何も起きない（孤立タイル）
   *   found   : 新チェーン設立
   *   blocked : 設立したいが7チェーン全て盤上 → 今は置けない（一時的）
   *   grow    : 既存チェーンの拡張
   *   merge   : 合併
   *   dead    : 安全なチェーン同士をつなぐ → 永久に置けない
   * ------------------------------------------------------------------ */
  E.analyze = function (s, i) {
    var chains = [], loneSeeds = [];
    R.neighbors[i].forEach(function (j) {
      var v = s.board[j];
      if (v === null || v === undefined) return;
      if (v === '.') loneSeeds.push(j);
      else if (chains.indexOf(v) === -1) chains.push(v);
    });

    var lones = loneSeeds.length ? loneCluster(s, loneSeeds) : [];

    if (chains.length >= 2) {
      var sz = sizes(s);
      var info = {};
      chains.forEach(function (c) { info[c] = sz[c]; });
      var safeOnes = chains.filter(function (c) { return R.isSafe(sz[c]); });
      if (safeOnes.length >= 2) {
        return { type: 'dead', chains: chains, sizes: info };
      }
      var max = Math.max.apply(null, chains.map(function (c) { return sz[c]; }));
      var candidates = chains.filter(function (c) { return sz[c] === max; });
      return { type: 'merge', chains: chains, sizes: info, lones: lones, candidates: candidates };
    }

    if (chains.length === 1) {
      return { type: 'grow', chain: chains[0], lones: lones };
    }

    if (lones.length > 0) {
      var avail = E.availableChains(s);
      if (avail.length === 0) return { type: 'blocked', lones: lones };
      return { type: 'found', lones: lones, options: avail };
    }

    return { type: 'single' };
  };

  E.isPlayable = function (s, i) {
    if (s.board[i] !== null) return false;
    var a = E.analyze(s, i);
    return a.type !== 'dead' && a.type !== 'blocked';
  };

  E.isPermanentlyDead = function (s, i) {
    if (s.board[i] !== null) return false;
    return E.analyze(s, i).type === 'dead';
  };

  E.playableTiles = function (s, player) {
    return player.tiles.filter(function (t) { return E.isPlayable(s, t); });
  };

  /* ------------------------------------------------------------------ *
   * 演出キュー & ログ
   * ------------------------------------------------------------------ */
  function fx(s, event) { s.fx.push(event); }
  function log(s, text, kind) {
    s.log.push({ text: text, kind: kind || 'info', turn: s.turnCount });
    if (s.log.length > 400) s.log.shift();
  }
  E.log = log;

  /* ------------------------------------------------------------------ *
   * ゲーム生成
   * ------------------------------------------------------------------ */
  E.newGame = function (opts) {
    opts = opts || {};
    var seed = opts.seed != null ? opts.seed : (Math.random() * 1e9) | 0;
    var rand = mulberry32(seed);

    var players = (opts.players || []).map(function (p, i) {
      return {
        idx: i,
        name: p.name,
        isHuman: !!p.isHuman,
        personality: p.personality || 'balanced',
        cash: R.START_CASH,
        tiles: [],
        shares: zeroShares()
      };
    });

    var bag = [];
    for (var i = 0; i < R.CELLS; i++) bag.push(i);
    shuffle(bag, rand);

    var bank = {};
    R.CHAIN_IDS.forEach(function (id) { bank[id] = R.SHARES_PER_CHAIN; });

    var s = {
      seed: seed,
      rand: rand,
      players: players,
      board: new Array(R.CELLS).fill(null),
      bank: bank,
      bag: bag,
      current: 0,
      phase: 'place',
      pending: null,
      fx: [],
      log: [],
      turnCount: 1,
      endDeclared: false,
      results: null,
      boughtThisTurn: 0,
      discarded: [] // 永久に置けず箱に戻したタイル
    };

    /* 初期タイル: 各プレイヤーが1枚ずつ盤面に置く */
    var starters = [];
    players.forEach(function (p) {
      var t = s.bag.pop();
      s.board[t] = '.';
      starters.push({ tile: t, player: p.idx });
    });
    fx(s, { t: 'setup', tiles: starters });
    log(s, '初期タイルを配置しました', 'system');

    /* 手札を配る */
    players.forEach(function (p) {
      while (p.tiles.length < R.HAND_SIZE && s.bag.length) p.tiles.push(s.bag.pop());
      p.tiles.sort(function (a, b) { return a - b; });
    });

    /* 手番順は初期タイルが最も左上の人から（簡易ルール） */
    var first = starters.slice().sort(function (a, b) { return a.tile - b.tile; })[0];
    s.current = first.player;

    startTurn(s);
    return s;
  };

  /* ------------------------------------------------------------------ *
   * 手番の開始
   * ------------------------------------------------------------------ */
  function startTurn(s) {
    var p = s.players[s.current];
    s.boughtThisTurn = 0;
    s.pending = null;
    fx(s, { t: 'turn', player: p.idx });

    if (E.playableTiles(s, p).length === 0) {
      // 置けるタイルが無い場合は配置を飛ばして株購入へ
      s.phase = 'buy';
      s.pending = { noPlayable: true };
      log(s, p.name + ' は置けるタイルがありません', 'warn');
    } else {
      s.phase = 'place';
    }
  }
  E.startTurn = startTurn;

  /* 今アクションすべきプレイヤー（株処分フェーズだけは手番と異なる） */
  E.actor = function (s) {
    if (s.phase === 'dispose' && s.pending && s.pending.dispose) {
      return s.players[s.pending.dispose.order[s.pending.dispose.at]];
    }
    return s.players[s.current];
  };

  /* ------------------------------------------------------------------ *
   * タイル配置
   * ------------------------------------------------------------------ */
  E.placeTile = function (s, tile) {
    if (s.phase !== 'place') throw new Error('phase');
    var p = s.players[s.current];
    var handPos = p.tiles.indexOf(tile);
    if (handPos === -1) throw new Error('not in hand');
    if (!E.isPlayable(s, tile)) throw new Error('illegal tile');

    var a = E.analyze(s, tile);
    p.tiles.splice(handPos, 1);
    s.board[tile] = '.';
    fx(s, { t: 'place', tile: tile, player: p.idx });
    log(s, p.name + ' が ' + R.label(tile) + ' に配置', 'place');

    if (a.type === 'single') {
      toBuyPhase(s);
      return;
    }

    if (a.type === 'found') {
      s.pending = { found: { tile: tile, lones: a.lones, options: a.options } };
      if (a.options.length === 1) {
        E.chooseFoundChain(s, a.options[0]);
      } else {
        s.phase = 'found';
      }
      return;
    }

    if (a.type === 'grow') {
      var tiles = [tile].concat(a.lones);
      paint(s, a.chain, tiles);
      var newSize = E.sizeOf(s, a.chain);
      fx(s, { t: 'grow', chain: a.chain, tiles: tiles, origin: tile, size: newSize });
      log(s, R.chain(a.chain).jp + ' が ' + newSize + 'マスに拡大', 'grow');
      checkSafe(s, a.chain, newSize);
      toBuyPhase(s);
      return;
    }

    if (a.type === 'merge') {
      s.pending = {
        merge: {
          tile: tile,
          lones: a.lones,
          chains: a.chains,
          sizes: a.sizes,
          survivor: null,
          defunct: null,
          idx: 0,
          maker: p.idx
        }
      };
      if (a.candidates.length === 1) {
        E.chooseSurvivor(s, a.candidates[0]);
      } else {
        s.phase = 'survivor';
        s.pending.merge.candidates = a.candidates;
      }
      return;
    }

    throw new Error('unreachable placement type: ' + a.type);
  };

  function paint(s, chainId, tiles) {
    tiles.forEach(function (t) { s.board[t] = chainId; });
  }

  function checkSafe(s, chainId, size) {
    if (size >= R.SAFE_SIZE && !s._safeAnnounced) s._safeAnnounced = {};
    if (size >= R.SAFE_SIZE) {
      s._safeAnnounced = s._safeAnnounced || {};
      if (!s._safeAnnounced[chainId]) {
        s._safeAnnounced[chainId] = true;
        fx(s, { t: 'safe', chain: chainId });
        log(s, R.chain(chainId).jp + ' が安全圏（11マス）に到達', 'safe');
      }
    } else if (s._safeAnnounced) {
      delete s._safeAnnounced[chainId];
    }
  }

  /* ------------------------------------------------------------------ *
   * 新チェーン設立
   * ------------------------------------------------------------------ */
  E.chooseFoundChain = function (s, chainId) {
    var f = s.pending && s.pending.found;
    if (!f) throw new Error('no pending found');
    if (f.options.indexOf(chainId) === -1) throw new Error('unavailable chain');

    var p = s.players[s.current];
    var tiles = [f.tile].concat(f.lones);
    paint(s, chainId, tiles);
    var size = tiles.length;

    fx(s, { t: 'found', chain: chainId, tiles: tiles, origin: f.tile, player: p.idx, size: size });
    log(s, p.name + ' が ' + R.chain(chainId).jp + ' を設立（' + size + 'マス）', 'found');

    /* 設立者ボーナス: 無料で1株 */
    if (s.bank[chainId] > 0) {
      s.bank[chainId]--;
      p.shares[chainId]++;
      fx(s, { t: 'founder-share', chain: chainId, player: p.idx });
      log(s, p.name + ' は設立者ボーナスで ' + R.chain(chainId).jp + ' 1株を獲得', 'stock');
    }

    checkSafe(s, chainId, size);
    s.pending = null;
    toBuyPhase(s);
  };

  /* ------------------------------------------------------------------ *
   * 合併
   * ------------------------------------------------------------------ */
  E.chooseSurvivor = function (s, chainId) {
    var m = s.pending && s.pending.merge;
    if (!m) throw new Error('no pending merge');
    if (m.chains.indexOf(chainId) === -1) throw new Error('not a merging chain');

    m.survivor = chainId;
    m.defunct = m.chains.filter(function (c) { return c !== chainId; })
      .sort(function (a, b) { return m.sizes[b] - m.sizes[a]; });

    /* 置いたタイルと周囲の無所属タイルは即座に存続チェーンへ */
    var joining = [m.tile].concat(m.lones);
    paint(s, chainId, joining);

    fx(s, {
      t: 'merge-start',
      survivor: chainId,
      defunct: m.defunct.slice(),
      tile: m.tile,
      joining: joining
    });
    log(s,
      R.chain(chainId).jp + ' が ' +
      m.defunct.map(function (c) { return R.chain(c).jp; }).join('・') + ' を吸収合併',
      'merge');

    m.idx = 0;
    processDefunct(s);
  };

  /* 消滅チェーンを1つずつ処理する */
  function processDefunct(s) {
    var m = s.pending.merge;
    if (m.idx >= m.defunct.length) { finishMerge(s); return; }

    var d = m.defunct[m.idx];
    var size = m.sizes[d];

    /* ボーナス支払い */
    var payouts = E.bonusSplit(s, d, size);
    payouts.forEach(function (pay) {
      s.players[pay.player].cash += pay.amount;
      log(s, s.players[pay.player].name + ' が ' + R.chain(d).jp + ' の' +
        (pay.kind === 'majority' ? '筆頭株主' : '第2位株主') + 'ボーナス ' +
        R.formatMoney(pay.amount) + ' を獲得', 'money');
    });
    if (payouts.length) fx(s, { t: 'bonus', chain: d, size: size, payouts: payouts });

    /* 株の処分待ち行列（合併を起こしたプレイヤーから時計回り） */
    var order = [];
    for (var k = 0; k < s.players.length; k++) {
      var pi = (m.maker + k) % s.players.length;
      if (s.players[pi].shares[d] > 0) order.push(pi);
    }

    if (order.length === 0) {
      absorbDefunct(s, d);
      m.idx++;
      processDefunct(s);
      return;
    }

    s.phase = 'dispose';
    s.pending.dispose = {
      defunct: d,
      size: size,
      price: R.priceOf(d, size),
      survivor: m.survivor,
      order: order,
      at: 0
    };
  }

  /* 筆頭 / 第2位ボーナスの計算（同数は分割して100ドル単位切り上げ） */
  E.bonusSplit = function (s, chainId, size) {
    var maj = R.majorityBonus(chainId, size);
    var min = R.minorityBonus(chainId, size);
    var holders = s.players.filter(function (p) { return p.shares[chainId] > 0; });
    if (holders.length === 0) return [];

    var sorted = holders.slice().sort(function (a, b) { return b.shares[chainId] - a.shares[chainId]; });
    var top = sorted[0].shares[chainId];
    var tops = sorted.filter(function (p) { return p.shares[chainId] === top; });
    var out = [];

    if (tops.length > 1) {
      /* 筆頭が同数 → 筆頭+第2位を合算して山分け */
      var each = R.roundUp100((maj + min) / tops.length);
      tops.forEach(function (p) {
        out.push({ player: p.idx, amount: each, kind: 'majority', shares: p.shares[chainId] });
      });
      return out;
    }

    out.push({ player: tops[0].idx, amount: maj, kind: 'majority', shares: top });

    var rest = sorted.filter(function (p) { return p.idx !== tops[0].idx; });
    if (rest.length === 0) {
      /* 株主が1人だけなら第2位ボーナスも同じ人へ */
      out.push({ player: tops[0].idx, amount: min, kind: 'minority', shares: top });
      return out;
    }

    var second = rest[0].shares[chainId];
    var seconds = rest.filter(function (p) { return p.shares[chainId] === second; });
    var amt = R.roundUp100(min / seconds.length);
    seconds.forEach(function (p) {
      out.push({ player: p.idx, amount: amt, kind: 'minority', shares: second });
    });
    return out;
  };

  /* 消滅チェーン株の処分オプションの上限 */
  E.disposalLimits = function (s, playerIdx) {
    var d = s.pending.dispose;
    var held = s.players[playerIdx].shares[d.defunct];
    var maxTrade = Math.min(held - (held % 2), s.bank[d.survivor] * 2);
    return { held: held, price: d.price, maxSell: held, maxTrade: maxTrade };
  };

  E.submitDisposal = function (s, choice) {
    if (s.phase !== 'dispose') throw new Error('phase');
    var d = s.pending.dispose;
    var pi = d.order[d.at];
    var p = s.players[pi];
    var held = p.shares[d.defunct];

    var sell = Math.max(0, choice.sell | 0);
    var trade = Math.max(0, choice.trade | 0);
    if (trade % 2 !== 0) throw new Error('trade must be even');
    if (sell + trade > held) throw new Error('too many shares');
    if (trade / 2 > s.bank[d.survivor]) throw new Error('not enough survivor shares');

    if (sell > 0) {
      var gain = sell * d.price;
      p.cash += gain;
      p.shares[d.defunct] -= sell;
      s.bank[d.defunct] += sell;
      fx(s, { t: 'sell', player: pi, chain: d.defunct, count: sell, amount: gain });
      log(s, p.name + ' が ' + R.chain(d.defunct).jp + ' ' + sell + '株を売却（+' +
        R.formatMoney(gain) + '）', 'money');
    }
    if (trade > 0) {
      var got = trade / 2;
      p.shares[d.defunct] -= trade;
      s.bank[d.defunct] += trade;
      p.shares[d.survivor] += got;
      s.bank[d.survivor] -= got;
      fx(s, { t: 'trade', player: pi, from: d.defunct, to: d.survivor, count: trade, got: got });
      log(s, p.name + ' が ' + R.chain(d.defunct).jp + ' ' + trade + '株を ' +
        R.chain(d.survivor).jp + ' ' + got + '株に交換', 'stock');
    }
    var keep = held - sell - trade;
    if (keep > 0) {
      log(s, p.name + ' は ' + R.chain(d.defunct).jp + ' ' + keep + '株を保持', 'stock');
    }

    d.at++;
    if (d.at < d.order.length) return; // 次の株主へ

    /* この消滅チェーンの処分完了 → 盤面を吸収 */
    var m = s.pending.merge;
    absorbDefunct(s, d.defunct);
    s.pending.dispose = null;
    m.idx++;
    processDefunct(s);
  };

  function absorbDefunct(s, defunctId) {
    var m = s.pending.merge;
    var tiles = E.tilesOf(s, defunctId);
    paint(s, m.survivor, tiles);
    fx(s, {
      t: 'absorb',
      chain: m.survivor,
      from: defunctId,
      tiles: tiles,
      origin: m.tile
    });
    if (s._safeAnnounced) delete s._safeAnnounced[defunctId];
  }

  function finishMerge(s) {
    var m = s.pending.merge;
    var size = E.sizeOf(s, m.survivor);
    fx(s, { t: 'merge-end', chain: m.survivor, size: size });
    log(s, R.chain(m.survivor).jp + ' は ' + size + 'マスになりました', 'merge');
    checkSafe(s, m.survivor, size);
    s.pending = null;
    toBuyPhase(s);
  }

  /* ------------------------------------------------------------------ *
   * 株の購入
   * ------------------------------------------------------------------ */
  function toBuyPhase(s) {
    s.phase = 'buy';
    s.boughtThisTurn = 0;
  }

  E.buyOptions = function (s, player) {
    var sz = sizes(s);
    return R.CHAIN_IDS.filter(function (id) {
      return sz[id] > 0 && s.bank[id] > 0;
    }).map(function (id) {
      return { id: id, size: sz[id], price: R.priceOf(id, sz[id]), left: s.bank[id] };
    });
  };

  E.buy = function (s, cart) {
    if (s.phase !== 'buy') throw new Error('phase');
    var p = s.players[s.current];
    var sz = sizes(s);
    var total = 0, count = 0;

    R.CHAIN_IDS.forEach(function (id) {
      var n = (cart && cart[id]) | 0;
      if (n <= 0) return;
      if (sz[id] === 0) throw new Error('chain not on board: ' + id);
      if (n > s.bank[id]) throw new Error('not enough shares: ' + id);
      count += n;
      total += n * R.priceOf(id, sz[id]);
    });

    if (count > R.MAX_BUY_PER_TURN) throw new Error('max 3 shares');
    if (total > p.cash) throw new Error('not enough cash');

    R.CHAIN_IDS.forEach(function (id) {
      var n = (cart && cart[id]) | 0;
      if (n <= 0) return;
      var cost = n * R.priceOf(id, sz[id]);
      p.cash -= cost;
      p.shares[id] += n;
      s.bank[id] -= n;
      fx(s, { t: 'buy', player: p.idx, chain: id, count: n, cost: cost });
      log(s, p.name + ' が ' + R.chain(id).jp + ' ' + n + '株を購入（-' +
        R.formatMoney(cost) + '）', 'stock');
    });
    if (count === 0) log(s, p.name + ' は株を購入しませんでした', 'info');

    s.boughtThisTurn = count;
    endTurn(s);
  };

  /* ------------------------------------------------------------------ *
   * 終了条件
   * ------------------------------------------------------------------ */
  E.canDeclareEnd = function (s) {
    var sz = sizes(s);
    var active = R.CHAIN_IDS.filter(function (id) { return sz[id] > 0; });
    if (active.length === 0) return false;
    if (active.some(function (id) { return sz[id] >= R.END_SIZE; })) return true;
    return active.every(function (id) { return sz[id] >= R.SAFE_SIZE; });
  };

  E.declareEnd = function (s) {
    if (!E.canDeclareEnd(s)) throw new Error('cannot declare end');
    s.endDeclared = true;
    log(s, s.players[s.current].name + ' がゲーム終了を宣言しました', 'system');
    fx(s, { t: 'declare-end', player: s.current });
  };

  /* ------------------------------------------------------------------ *
   * 手番の終了 → 補充 → 次のプレイヤー
   * ------------------------------------------------------------------ */
  function endTurn(s) {
    var p = s.players[s.current];

    if (s.endDeclared) { finalize(s); return; }

    /* 永久に置けないタイルを捨てて引き直す */
    var dumped = p.tiles.filter(function (t) { return E.isPermanentlyDead(s, t); });
    if (dumped.length) {
      p.tiles = p.tiles.filter(function (t) { return !E.isPermanentlyDead(s, t); });
      s.discarded = s.discarded.concat(dumped); // 箱に戻す（山札には戻らない）
      log(s, p.name + ' が死にタイル ' + dumped.map(R.label).join('・') + ' を交換', 'info');
      fx(s, { t: 'discard', player: p.idx, tiles: dumped });
    }

    /* 手札を6枚まで補充 */
    var drawn = [];
    while (p.tiles.length < R.HAND_SIZE && s.bag.length > 0) {
      var t = s.bag.pop();
      p.tiles.push(t);
      drawn.push(t);
    }
    p.tiles.sort(function (a, b) { return a - b; });
    if (drawn.length) fx(s, { t: 'draw', player: p.idx, tiles: drawn });

    /* 全員が置けなくなったら終了 */
    s.current = (s.current + 1) % s.players.length;
    if (s.current === 0) s.turnCount++;

    var anyone = s.players.some(function (pl) {
      return E.playableTiles(s, pl).length > 0 || pl.tiles.length > 0;
    });
    if (!anyone && s.bag.length === 0) { finalize(s); return; }

    startTurn(s);
  }
  E.endTurn = endTurn;

  /* ------------------------------------------------------------------ *
   * 最終清算
   * ------------------------------------------------------------------ */
  function finalize(s) {
    var sz = sizes(s);
    var active = R.CHAIN_IDS.filter(function (id) { return sz[id] > 0; });
    var breakdown = s.players.map(function (p) {
      return { player: p.idx, bonus: 0, stock: 0, start: p.cash };
    });

    log(s, '=== 最終清算 ===', 'system');

    active.forEach(function (id) {
      E.bonusSplit(s, id, sz[id]).forEach(function (pay) {
        s.players[pay.player].cash += pay.amount;
        breakdown[pay.player].bonus += pay.amount;
        log(s, s.players[pay.player].name + ' : ' + R.chain(id).jp + ' ' +
          (pay.kind === 'majority' ? '筆頭' : '第2位') + 'ボーナス ' +
          R.formatMoney(pay.amount), 'money');
      });
    });

    active.forEach(function (id) {
      var price = R.priceOf(id, sz[id]);
      s.players.forEach(function (p) {
        var n = p.shares[id];
        if (n <= 0) return;
        var amount = n * price;
        p.cash += amount;
        p.shares[id] = 0;
        s.bank[id] += n;
        breakdown[p.idx].stock += amount;
        log(s, p.name + ' : ' + R.chain(id).jp + ' ' + n + '株を清算 ' +
          R.formatMoney(amount), 'money');
      });
    });

    fx(s, { t: 'final-settle', breakdown: breakdown });

    var ranking = s.players.slice().sort(function (a, b) { return b.cash - a.cash; })
      .map(function (p, i) {
        return {
          player: p.idx, name: p.name, cash: p.cash, rank: i + 1,
          bonus: breakdown[p.idx].bonus, stock: breakdown[p.idx].stock,
          isHuman: p.isHuman
        };
      });
    /* 同額は同順位 */
    for (var i = 1; i < ranking.length; i++) {
      if (ranking[i].cash === ranking[i - 1].cash) ranking[i].rank = ranking[i - 1].rank;
    }

    s.results = ranking;
    s.phase = 'gameover';
    fx(s, { t: 'gameover', ranking: ranking });
    log(s, '優勝: ' + ranking[0].name + '（' + R.formatMoney(ranking[0].cash) + '）', 'system');
  }
  E.finalize = finalize;

  /* ------------------------------------------------------------------ *
   * 評価ヘルパ（UI / AI 共用）
   * ------------------------------------------------------------------ */
  E.netWorth = function (s, player) {
    var sz = sizes(s);
    var total = player.cash;
    R.CHAIN_IDS.forEach(function (id) {
      if (sz[id] > 0 && player.shares[id] > 0) {
        total += player.shares[id] * R.priceOf(id, sz[id]);
      }
    });
    return total;
  };

  /* そのチェーンで自分が筆頭/第2位かを返す */
  E.standing = function (s, chainId, playerIdx) {
    var counts = s.players.map(function (p) { return p.shares[chainId]; });
    var mine = counts[playerIdx];
    if (mine === 0) return 'none';
    var better = counts.filter(function (c, i) { return i !== playerIdx && c > mine; }).length;
    if (better === 0) return 'majority';
    if (better === 1) return 'minority';
    return 'other';
  };

  AQ.Engine = E;
})(window);
