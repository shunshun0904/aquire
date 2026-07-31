/* ==========================================================================
   ACQUIRE - UI レイヤー
   エンジンが積んだ演出キュー(state.fx)を順番に再生し、DOM を更新する。
   ========================================================================== */
(function (global) {
  'use strict';

  var AQ = global.AQ;
  var R = AQ.Rules;
  var Engine = AQ.Engine;
  var AI = AQ.AI;

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    board: $('board'), boardGlow: $('boardGlow'), fxLayer: $('fxLayer'),
    hand: $('hand'), handOwner: $('handOwner'), handHint: $('handHint'),
    actionBar: $('actionBar'), players: $('players'), chains: $('chains'),
    log: $('log'), overlay: $('overlay'), toasts: $('toasts'),
    statusTurn: $('statusTurn'), statusPhase: $('statusPhase'), status: $('status'),
    confetti: $('confetti'),
    btnNew: $('btnNew'), btnRules: $('btnRules'), btnSound: $('btnSound')
  };

  /* ------------------------------------------------------------------ *
   * UI 状態
   * ------------------------------------------------------------------ */
  var state = null;
  var cells = [];
  var view = new Array(R.CELLS).fill(null); // 現在 DOM に描かれている盤面
  var selectedTile = null;
  var cart = {};
  var declareIntent = false;
  var busy = false;
  var prevCash = {};
  var prevShares = {};
  var lastLogCount = 0;
  var lastActorIdx = -1;
  var handSignature = '';
  var speed = 1;

  var TIMING = {
    aiThink: 520,
    place: 420,
    paintStep: 55,
    found: 900,
    merge: 1100,
    absorb: 800,
    bonus: 700,
    stock: 500,
    small: 260
  };
  function ms(n) { return n * speed; }
  function sleep(n) { return new Promise(function (r) { setTimeout(r, ms(n)); }); }

  var PLAYER_COLORS = ['#e9c46a', '#4ade80', '#60a5fa', '#f472b6', '#fb923c', '#a78bfa'];

  /* ------------------------------------------------------------------ *
   * サウンド（WebAudio の簡易シンセ）
   * ------------------------------------------------------------------ */
  var Sound = {
    ctx: null,
    enabled: true,
    ensure: function () {
      if (!this.ctx) {
        var C = global.AudioContext || global.webkitAudioContext;
        if (C) this.ctx = new C();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone: function (freq, dur, type, gain, delay) {
      if (!this.enabled) return;
      var ctx = this.ensure(); if (!ctx) return;
      var t0 = ctx.currentTime + (delay || 0);
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain || .07, t0 + .012);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + .02);
    },
    sweep: function (f1, f2, dur, gain) {
      if (!this.enabled) return;
      var ctx = this.ensure(); if (!ctx) return;
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f1, t0);
      osc.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
      g.gain.setValueAtTime(gain || .05, t0);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + .02);
    },
    place:  function () { this.tone(420, .09, 'triangle', .08); this.tone(620, .07, 'sine', .04, .03); },
    found:  function () { [523, 659, 784, 1047].forEach(function (f, i) { Sound.tone(f, .35, 'triangle', .06, i * .07); }); },
    merge:  function () { this.sweep(160, 900, .55, .06); this.tone(110, .5, 'sawtooth', .04); },
    coin:   function () { this.tone(988, .1, 'square', .05); this.tone(1319, .16, 'square', .04, .06); },
    stock:  function () { this.tone(660, .1, 'sine', .05); this.tone(880, .12, 'sine', .04, .05); },
    safe:   function () { [784, 988, 1175].forEach(function (f, i) { Sound.tone(f, .3, 'sine', .05, i * .06); }); },
    turn:   function () { this.tone(330, .12, 'sine', .04); },
    win:    function () { [523, 659, 784, 1047, 1319].forEach(function (f, i) { Sound.tone(f, .5, 'triangle', .07, i * .11); }); },
    error:  function () { this.tone(150, .18, 'square', .05); }
  };

  /* ------------------------------------------------------------------ *
   * 小さな演出ユーティリティ
   * ------------------------------------------------------------------ */
  function rectOf(node) { return node.getBoundingClientRect(); }

  function flyTile(fromRect, toRect, label) {
    var d = document.createElement('div');
    d.className = 'flying-tile';
    d.textContent = label;
    d.style.left = fromRect.left + 'px';
    d.style.top = fromRect.top + 'px';
    d.style.width = fromRect.width + 'px';
    d.style.height = fromRect.height + 'px';
    document.body.appendChild(d);
    var dx = toRect.left + toRect.width / 2 - (fromRect.left + fromRect.width / 2);
    var dy = toRect.top + toRect.height / 2 - (fromRect.top + fromRect.height / 2);
    var scale = toRect.width / Math.max(1, fromRect.width);
    requestAnimationFrame(function () {
      d.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ') rotate(8deg)';
      d.style.opacity = '0';
    });
    setTimeout(function () { d.remove(); }, ms(760));
  }

  function flyStock(fromRect, toRect, color, dark, delay) {
    setTimeout(function () {
      var d = document.createElement('div');
      d.className = 'flying-stock';
      d.style.setProperty('--c', color);
      d.style.setProperty('--cd', dark);
      d.style.left = (fromRect.left + fromRect.width / 2 - 17) + 'px';
      d.style.top = (fromRect.top + fromRect.height / 2 - 22) + 'px';
      document.body.appendChild(d);
      var dx = toRect.left + toRect.width / 2 - (fromRect.left + fromRect.width / 2);
      var dy = toRect.top + toRect.height / 2 - (fromRect.top + fromRect.height / 2);
      requestAnimationFrame(function () {
        d.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (Math.random() * 40 - 20) + 'deg) scale(.6)';
        d.style.opacity = '0';
      });
      setTimeout(function () { d.remove(); }, ms(900));
    }, ms(delay || 0));
  }

  function floatText(anchor, text, cls) {
    if (!anchor) return;
    var r = rectOf(anchor);
    var d = document.createElement('div');
    d.className = 'float-text ' + (cls || 'gain');
    d.textContent = text;
    d.style.left = (r.left + r.width / 2) + 'px';
    d.style.top = (r.top + r.height * .3) + 'px';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, ms(1450));
  }

  function ripple(cellIndex, color) {
    var cell = cells[cellIndex]; if (!cell) return;
    var br = rectOf(el.board);
    var cr = rectOf(cell);
    var d = document.createElement('div');
    d.className = 'ripple';
    d.style.setProperty('--rc', color);
    d.style.left = (cr.left - br.left + cr.width / 2) + 'px';
    d.style.top = (cr.top - br.top + cr.height / 2) + 'px';
    d.style.width = cr.width + 'px';
    d.style.height = cr.width + 'px';
    el.fxLayer.appendChild(d);
    setTimeout(function () { d.remove(); }, ms(1000));
  }

  function glowBoard(cellIndex, color) {
    var br = rectOf(el.board), cr = rectOf(cells[cellIndex]);
    el.boardGlow.style.setProperty('--gc', color);
    el.boardGlow.style.setProperty('--gx', ((cr.left - br.left + cr.width / 2) / br.width * 100) + '%');
    el.boardGlow.style.setProperty('--gy', ((cr.top - br.top + cr.height / 2) / br.height * 100) + '%');
    el.boardGlow.classList.add('on');
    setTimeout(function () { el.boardGlow.classList.remove('on'); }, ms(900));
  }

  function quake() {
    var shell = el.board.parentElement;
    shell.classList.remove('quake'); void shell.offsetWidth; shell.classList.add('quake');
    setTimeout(function () { shell.classList.remove('quake'); }, ms(600));
  }

  function toast(html, cls, chainColor) {
    var d = document.createElement('div');
    d.className = 'toast ' + (cls || '');
    d.innerHTML = html;
    if (chainColor) d.style.setProperty('--c', chainColor);
    el.toasts.appendChild(d);
    setTimeout(function () { d.remove(); }, ms(2600));
  }

  function animateNumber(node, from, to, duration) {
    var start = performance.now();
    var dur = ms(duration || 650);
    function frame(now) {
      var t = Math.min(1, (now - start) / dur);
      var e = 1 - Math.pow(1 - t, 3);
      node.textContent = R.formatMoney(Math.round(from + (to - from) * e));
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ *
   * 盤面の描画
   * ------------------------------------------------------------------ */
  function buildBoard() {
    el.board.innerHTML = '';
    cells = [];
    for (var i = 0; i < R.CELLS; i++) {
      var c = document.createElement('div');
      c.className = 'cell';
      c.setAttribute('role', 'gridcell');
      c.dataset.i = i;
      c.textContent = R.label(i);
      c.addEventListener('click', onCellClick);
      el.board.appendChild(c);
      cells.push(c);
    }
  }

  var ANIM_CLASSES = ['anim-pop', 'anim-paint', 'anim-absorb', 'anim-shine'];

  function paintCell(i, val, anim, delay) {
    var cell = cells[i];
    view[i] = val;
    ANIM_CLASSES.forEach(function (a) { cell.classList.remove(a); });
    cell.className = 'cell';
    cell.style.removeProperty('--c');
    cell.style.removeProperty('--cd');

    if (val === null || val === undefined) {
      cell.textContent = R.label(i);
    } else if (val === '.') {
      cell.classList.add('lone');
      cell.textContent = R.label(i);
    } else {
      var ch = R.chain(val);
      cell.classList.add('chained');
      cell.style.setProperty('--c', ch.color);
      cell.style.setProperty('--cd', ch.dark);
      cell.innerHTML = '<span class="tag">' + ch.abbr + '</span>';
      cell.title = ch.jp + ' ' + R.label(i);
    }

    if (anim) {
      cell.style.setProperty('--d', ms(delay || 0) + 'ms');
      void cell.offsetWidth;
      cell.classList.add(anim);
    }
  }

  /* 一群のタイルを、起点から近い順に順番に塗る */
  function paintGroup(tiles, val, origin, anim, stepMs) {
    var sorted = tiles.slice().sort(function (a, b) {
      return R.distance(a, origin) - R.distance(b, origin);
    });
    var step = stepMs != null ? stepMs : TIMING.paintStep;
    sorted.forEach(function (t, k) {
      paintCell(t, val, anim, k * step);
    });
    return sorted.length * step + 600;
  }

  function syncBoard() {
    for (var i = 0; i < R.CELLS; i++) {
      if (view[i] !== state.board[i]) paintCell(i, state.board[i]);
    }
  }

  function decorateBoard() {
    var sz = Engine.sizes(state);
    var human = Engine.actor(state);
    var playable = {};
    if (state.phase === 'place' && human.isHuman) {
      human.tiles.forEach(function (t) {
        if (Engine.isPlayable(state, t)) playable[t] = true;
      });
    }
    for (var i = 0; i < R.CELLS; i++) {
      var cell = cells[i];
      var v = state.board[i];
      cell.classList.toggle('safe-mark', !!(v && v !== '.' && sz[v] >= R.SAFE_SIZE));
      cell.classList.toggle('playable', !!playable[i]);
      cell.classList.toggle('target', selectedTile === i);
    }
  }

  /* ------------------------------------------------------------------ *
   * 手札
   * ------------------------------------------------------------------ */
  function kindOf(tile) {
    var a = Engine.analyze(state, tile);
    switch (a.type) {
      case 'found':   return { text: '設立', color: '#e9c46a' };
      case 'merge':   return { text: '合併', color: '#ff6fb5' };
      case 'grow':    return { text: R.chain(a.chain).jp, color: R.chain(a.chain).color };
      case 'dead':    return { text: '配置不可', color: '#94a3b8' };
      case 'blocked': return { text: '設立不可', color: '#94a3b8' };
      default:        return null;
    }
  }

  function renderHand() {
    var human = state.players.find(function (p) { return p.isHuman; });
    var owner = human || state.players[state.current];
    var isTurn = human ? (state.current === human.idx && state.phase === 'place') : false;

    el.handOwner.textContent = human ? 'あなたの手札' : (owner.name + ' の手札（観戦）');

    var sig = owner.idx + ':' + owner.tiles.join(',') + ':' + isTurn;
    var changed = sig !== handSignature;
    handSignature = sig;

    el.hand.innerHTML = '';
    el.hand.classList.toggle('locked', !isTurn);

    owner.tiles.forEach(function (t, i) {
      var b = document.createElement('button');
      b.className = 'tile';
      b.textContent = R.label(t);
      b.dataset.tile = t;
      if (changed) b.style.setProperty('--d', ms(i * 55) + 'ms');
      else b.style.animation = 'none';

      var a = Engine.analyze(state, t);
      if (a.type === 'dead') b.classList.add('dead');
      else if (a.type === 'blocked') b.classList.add('blocked');

      if (isTurn) {
        var k = kindOf(t);
        if (k) {
          var tag = document.createElement('span');
          tag.className = 'kind';
          tag.textContent = k.text;
          tag.style.setProperty('--kc', k.color);
          b.appendChild(tag);
        }
        b.disabled = (a.type === 'dead' || a.type === 'blocked');
        if (selectedTile === t) b.classList.add('selected');
        b.addEventListener('click', function () { onHandClick(t); });
      } else {
        b.disabled = true;
      }
      el.hand.appendChild(b);
    });

    if (!owner.tiles.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-faint);font-size:12px;padding:16px 4px;';
      empty.textContent = 'タイルはありません（山札切れ）';
      el.hand.appendChild(empty);
    }

    var actingIsHuman = human && Engine.actor(state).idx === human.idx;
    if (!human) el.handHint.textContent = 'CPU同士の対戦を観戦しています';
    else if (state.phase === 'gameover') el.handHint.textContent = 'ゲーム終了';
    else if (isTurn) el.handHint.textContent = selectedTile != null
      ? R.label(selectedTile) + ' を盤面に置きます'
      : 'タイルを選んで配置してください';
    else if (actingIsHuman) el.handHint.textContent = '下の操作パネルで ' +
      (PHASE_TEXT[state.phase] || '') + ' を行ってください';
    else el.handHint.textContent = '他のプレイヤーの手番です';
  }

  /* ------------------------------------------------------------------ *
   * プレイヤーパネル
   * ------------------------------------------------------------------ */
  function renderPlayers() {
    var actor = Engine.actor(state);
    var sz = Engine.sizes(state);

    state.players.forEach(function (p) {
      var card = el.players.querySelector('[data-p="' + p.idx + '"]');
      if (!card) {
        card = document.createElement('div');
        card.className = 'pcard';
        card.dataset.p = p.idx;
        card.innerHTML =
          '<div class="pcard-head">' +
            '<div class="pavatar"></div>' +
            '<div class="pname"></div>' +
            '<div class="pbadge"></div>' +
          '</div>' +
          '<div class="pcash-row"><div class="pcash"></div><div class="pworth"></div></div>' +
          '<div class="pshares"></div>';
        card.style.setProperty('--pc', PLAYER_COLORS[p.idx % PLAYER_COLORS.length]);
        el.players.appendChild(card);
      }

      card.querySelector('.pavatar').textContent = p.name.slice(0, 1);
      card.querySelector('.pname').textContent = p.name;
      card.querySelector('.pbadge').textContent = p.isHuman
        ? 'YOU'
        : (AI.PERSONA[p.personality] || AI.PERSONA.balanced).label;

      var cashNode = card.querySelector('.pcash');
      var before = prevCash[p.idx];
      if (before == null) cashNode.textContent = R.formatMoney(p.cash);
      else if (before !== p.cash) animateNumber(cashNode, before, p.cash);
      prevCash[p.idx] = p.cash;

      var worth = Engine.netWorth(state, p);
      card.querySelector('.pworth').textContent = '資産 ' + R.formatMoney(worth);

      card.classList.toggle('active', p.idx === state.current && state.phase !== 'gameover');
      card.classList.toggle('acting', p.idx === actor.idx && state.phase !== 'gameover');

      /* 株チップ */
      var box = card.querySelector('.pshares');
      var prev = prevShares[p.idx] || {};
      box.innerHTML = '';
      R.CHAIN_IDS.forEach(function (id) {
        var n = p.shares[id];
        if (n <= 0) return;
        var ch = R.chain(id);
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.setProperty('--c', ch.color);
        chip.innerHTML = ch.abbr + ' <span class="n">' + n + '</span>';
        if (sz[id] > 0 && Engine.standing(state, id, p.idx) === 'majority') chip.classList.add('crown');
        if ((prev[id] || 0) !== n) chip.classList.add('new');
        box.appendChild(chip);
      });
      prevShares[p.idx] = Object.assign({}, p.shares);
    });
  }

  function playerCardOf(idx) { return el.players.querySelector('[data-p="' + idx + '"]'); }

  /* ------------------------------------------------------------------ *
   * チェーン表
   * ------------------------------------------------------------------ */
  function renderChains() {
    var sz = Engine.sizes(state);
    el.chains.innerHTML = '';
    R.CHAINS.forEach(function (ch) {
      var size = sz[ch.id];
      var row = document.createElement('div');
      row.className = 'crow' + (size > 0 ? ' on' : ' inactive');
      row.dataset.c = ch.id;
      row.style.setProperty('--c', ch.color);
      row.style.setProperty('--cd', ch.dark);
      var safe = size >= R.SAFE_SIZE;
      row.innerHTML =
        '<div class="cdot"></div>' +
        '<div class="cname">' + ch.jp + '<small>' + ['安', '中', '高'][ch.tier] + '</small></div>' +
        '<div class="csize' + (safe ? ' csafe' : '') + '">' + (size || '—') + (safe ? '🔒' : '') + '</div>' +
        '<div class="cprice">' + (size ? R.formatMoney(R.priceOf(ch.id, size)) : '—') + '</div>' +
        '<div class="cleft">' + state.bank[ch.id] + '株</div>';
      el.chains.appendChild(row);
    });
  }

  function bumpChainRow(chainId) {
    var row = el.chains.querySelector('[data-c="' + chainId + '"]');
    if (!row) return;
    row.classList.remove('bump'); void row.offsetWidth; row.classList.add('bump');
  }

  /* ------------------------------------------------------------------ *
   * ログ
   * ------------------------------------------------------------------ */
  function renderLog() {
    for (var i = lastLogCount; i < state.log.length; i++) {
      var line = document.createElement('div');
      line.className = 'log-line ' + state.log[i].kind;
      line.textContent = state.log[i].text;
      el.log.appendChild(line);
    }
    if (state.log.length !== lastLogCount) {
      lastLogCount = state.log.length;
      el.log.scrollTop = el.log.scrollHeight;
    }
    while (el.log.children.length > 200) el.log.removeChild(el.log.firstChild);
  }

  /* ------------------------------------------------------------------ *
   * ステータス
   * ------------------------------------------------------------------ */
  var PHASE_TEXT = {
    place: 'タイルを配置',
    found: '設立するチェーンを選択',
    survivor: '存続するチェーンを選択',
    dispose: '消滅チェーンの株を処分',
    buy: '株の購入',
    gameover: 'ゲーム終了'
  };

  function renderStatus() {
    var actor = Engine.actor(state);
    if (state.phase === 'gameover') {
      el.statusTurn.textContent = 'ゲーム終了';
      el.statusPhase.textContent = state.results ? '優勝: ' + state.results[0].name : '';
    } else {
      var youTag = (actor.isHuman && actor.name !== 'あなた') ? '（あなた）' : '';
      el.statusTurn.textContent = actor.name + youTag + ' の手番';
      el.statusPhase.textContent = 'ラウンド ' + state.turnCount + ' ・ ' +
        (PHASE_TEXT[state.phase] || '') +
        ' ・ 山札 ' + state.bag.length + '枚';
    }
    if (actor.idx !== lastActorIdx) {
      lastActorIdx = actor.idx;
      el.status.classList.remove('flash'); void el.status.offsetWidth; el.status.classList.add('flash');
    }
  }

  /* ------------------------------------------------------------------ *
   * アクションバー（フェーズごとの操作 UI）
   * ------------------------------------------------------------------ */
  function card(title, sub) {
    var d = document.createElement('div');
    d.className = 'action-card';
    d.innerHTML = '<div class="action-head"><div class="action-title">' + title + '</div>' +
      '<div class="action-sub">' + (sub || '') + '</div></div>';
    return d;
  }

  var lastActionKey = '';

  /* 操作パネルが新しく出たときだけ、画面内までスクロールする */
  function revealActions() {
    var key = state.phase + ':' + Engine.actor(state).idx;
    if (key === lastActionKey) return;
    lastActionKey = key;
    var actor = Engine.actor(state);
    if (!actor.isHuman || state.phase === 'place' || state.phase === 'gameover') return;
    requestAnimationFrame(function () {
      var r = el.actionBar.getBoundingClientRect();
      if (r.bottom > global.innerHeight - 8) {
        el.actionBar.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }
    });
  }

  function renderActions() {
    el.actionBar.innerHTML = '';
    if (state.phase === 'gameover') { lastActionKey = ''; return; }

    var actor = Engine.actor(state);
    if (!actor.isHuman) {
      var wait = card(actor.name + ' が考えています…', PHASE_TEXT[state.phase] || '');
      el.actionBar.appendChild(wait);
      lastActionKey = state.phase + ':' + actor.idx;
      return;
    }

    if (state.phase === 'place') renderPlaceActions(actor);
    else if (state.phase === 'found') renderFoundActions(actor);
    else if (state.phase === 'survivor') renderSurvivorActions(actor);
    else if (state.phase === 'buy') renderBuyActions(actor);
    /* dispose はモーダルで扱う */
    revealActions();
  }

  function renderPlaceActions(p) {
    var legal = Engine.playableTiles(state, p);
    var c = card('タイルを配置してください', '配置可能: ' + legal.length + ' 枚');
    if (selectedTile != null) {
      var a = Engine.analyze(state, selectedTile);
      var desc = {
        single: 'どのチェーンにも属さないタイルとして置きます',
        found: '新しいホテルチェーンを設立します',
        grow: a.chain ? R.chain(a.chain).jp + ' を拡大します' : '',
        merge: '合併が発生します'
      }[a.type] || '';
      var foot = document.createElement('div');
      foot.className = 'action-foot';
      foot.innerHTML = '<div class="cart-summary">' + R.label(selectedTile) + ' — ' + desc + '</div>';
      var btns = document.createElement('div');
      btns.className = 'action-btns';
      var ok = document.createElement('button');
      ok.className = 'btn btn-primary';
      ok.textContent = R.label(selectedTile) + ' に配置';
      ok.addEventListener('click', function () { doPlace(selectedTile); });
      var cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = '選び直す';
      cancel.addEventListener('click', function () { selectedTile = null; render(); });
      btns.appendChild(cancel); btns.appendChild(ok);
      foot.appendChild(btns);
      c.appendChild(foot);
    }
    el.actionBar.appendChild(c);
  }

  function renderFoundActions(p) {
    var opts = state.pending.found.options;
    var c = card('設立するホテルチェーンを選択', '設立者は無料で1株を受け取ります');
    var box = document.createElement('div');
    box.className = 'chain-choice';
    opts.forEach(function (id, i) {
      var ch = R.chain(id);
      var b = document.createElement('button');
      b.className = 'chain-btn';
      b.style.setProperty('--c', ch.color);
      b.style.setProperty('--d', ms(i * 60) + 'ms');
      b.innerHTML = '<b>' + ch.jp + '</b><span>' + ['安価', '中価格', '高価格'][ch.tier] +
        ' ・ 手持ち ' + p.shares[id] + '株</span>';
      b.addEventListener('click', function () {
        Engine.chooseFoundChain(state, id);
        step();
      });
      box.appendChild(b);
    });
    c.appendChild(box);
    el.actionBar.appendChild(c);
  }

  function renderSurvivorActions(p) {
    var m = state.pending.merge;
    var c = card('存続するチェーンを選択', '同じ大きさのチェーンが合併します。選ばれなかった方は消滅します');
    var box = document.createElement('div');
    box.className = 'chain-choice';
    m.candidates.forEach(function (id, i) {
      var ch = R.chain(id);
      var b = document.createElement('button');
      b.className = 'chain-btn';
      b.style.setProperty('--c', ch.color);
      b.style.setProperty('--d', ms(i * 60) + 'ms');
      b.innerHTML = '<b>' + ch.jp + ' を存続</b><span>' + m.sizes[id] + 'マス ・ 手持ち ' +
        p.shares[id] + '株</span>';
      b.addEventListener('click', function () {
        Engine.chooseSurvivor(state, id);
        step();
      });
      box.appendChild(b);
    });
    c.appendChild(box);
    el.actionBar.appendChild(c);
  }

  function cartCount() {
    return R.CHAIN_IDS.reduce(function (n, id) { return n + (cart[id] || 0); }, 0);
  }
  function cartCost() {
    var sz = Engine.sizes(state);
    return R.CHAIN_IDS.reduce(function (n, id) {
      return n + (cart[id] || 0) * R.priceOf(id, sz[id]);
    }, 0);
  }

  function renderBuyActions(p) {
    var opts = Engine.buyOptions(state);
    var sub = state.pending && state.pending.noPlayable
      ? '置けるタイルがなかったため、購入のみ行います'
      : '1手番に最大3株まで購入できます';
    var c = card('株を購入（所持金 ' + R.formatMoney(p.cash) + '）', sub);

    if (!opts.length) {
      var none = document.createElement('div');
      none.className = 'cart-summary';
      none.textContent = '購入できるチェーンがありません。';
      c.appendChild(none);
    } else {
      var grid = document.createElement('div');
      grid.className = 'buy-grid';
      opts.forEach(function (o) {
        var ch = R.chain(o.id);
        var n = cart[o.id] || 0;
        var item = document.createElement('div');
        item.className = 'buy-item' + (n > 0 ? ' active' : '');
        item.style.setProperty('--c', ch.color);
        item.style.setProperty('--cd', ch.dark);
        item.innerHTML =
          '<div class="swatch">' + ch.abbr + '</div>' +
          '<div class="meta"><b>' + ch.jp + '</b><span>' + R.formatMoney(o.price) +
          ' ・ 残' + (o.left - n) + '株</span></div>';

        var st = document.createElement('div');
        st.className = 'stepper';
        var minus = document.createElement('button'); minus.textContent = '−';
        var qty = document.createElement('span'); qty.className = 'qty'; qty.textContent = n;
        var plus = document.createElement('button'); plus.textContent = '＋';

        minus.disabled = n === 0;
        plus.disabled = n >= o.left || cartCount() >= R.MAX_BUY_PER_TURN ||
          cartCost() + o.price > p.cash;

        minus.addEventListener('click', function () {
          cart[o.id] = Math.max(0, (cart[o.id] || 0) - 1);
          Sound.tone(300, .06, 'sine', .04);
          render();
        });
        plus.addEventListener('click', function () {
          cart[o.id] = (cart[o.id] || 0) + 1;
          Sound.stock();
          render();
        });
        st.appendChild(minus); st.appendChild(qty); st.appendChild(plus);
        item.appendChild(st);
        grid.appendChild(item);
      });
      c.appendChild(grid);
    }

    var foot = document.createElement('div');
    foot.className = 'action-foot';
    foot.innerHTML = '<div class="cart-summary">選択 ' + cartCount() + ' / 3 株 ・ 合計 <b>' +
      R.formatMoney(cartCost()) + '</b></div>';

    var btns = document.createElement('div');
    btns.className = 'action-btns';

    if (Engine.canDeclareEnd(state)) {
      var dec = document.createElement('button');
      dec.className = 'btn' + (declareIntent ? ' btn-primary' : '');
      dec.textContent = declareIntent ? '★ 終了を宣言する' : 'ゲーム終了を宣言';
      dec.title = '条件を満たしたのでゲームを終わらせられます';
      dec.addEventListener('click', function () { declareIntent = !declareIntent; render(); });
      btns.appendChild(dec);
    }

    var pass = document.createElement('button');
    pass.className = 'btn';
    pass.textContent = '購入しない';
    pass.addEventListener('click', function () { cart = {}; doBuy(); });
    btns.appendChild(pass);

    var buy = document.createElement('button');
    buy.className = 'btn btn-primary';
    buy.textContent = cartCount() ? '購入して手番終了' : '手番を終える';
    buy.addEventListener('click', doBuy);
    btns.appendChild(buy);

    foot.appendChild(btns);
    c.appendChild(foot);
    el.actionBar.appendChild(c);
  }

  /* ------------------------------------------------------------------ *
   * 株処分モーダル（人間用）
   * ------------------------------------------------------------------ */
  function showDisposeModal() {
    var d = state.pending.dispose;
    var p = Engine.actor(state);
    var lim = Engine.disposalLimits(state, p.idx);
    var ch = R.chain(d.defunct);
    var surv = R.chain(d.survivor);
    var sell = 0, trade = 0;

    var m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML =
      '<h2>' + ch.jp + ' の株を処分</h2>' +
      '<p class="sub">' + ch.jp + ' は ' + surv.jp + ' に吸収されました。' +
      '保有株を「売却」「2株→' + surv.jp + '1株に交換」「そのまま保持」から選べます。</p>' +
      '<div class="dispose-summary" style="--c:' + ch.color + '">' +
        '<div class="big">' + lim.held + '株</div>' +
        '<div><b>' + ch.jp + '</b><br><span style="font-size:12px;color:var(--text-dim)">' +
        '売却額 ' + R.formatMoney(d.price) + ' / 株（' + d.size + 'マス時点）</span></div>' +
      '</div>' +
      '<div class="dispose-row" data-row="sell">' +
        '<div class="rl"><b>売却</b><span>1株 ' + R.formatMoney(d.price) + ' で現金化</span></div>' +
        '<div class="range-wrap"><input type="range" id="dSell" min="0" max="' + lim.maxSell + '" value="0">' +
        '<b id="dSellN" style="width:34px;text-align:right">0</b></div>' +
      '</div>' +
      '<div class="dispose-row" data-row="trade">' +
        '<div class="rl"><b>交換</b><span>2株 → ' + surv.jp + ' 1株（銀行在庫 ' +
          state.bank[d.survivor] + '株）</span></div>' +
        '<div class="range-wrap"><input type="range" id="dTrade" min="0" max="' + lim.maxTrade +
        '" step="2" value="0"><b id="dTradeN" style="width:34px;text-align:right">0</b></div>' +
      '</div>' +
      '<div class="dispose-total" id="dTotal"></div>' +
      '<div class="modal-foot">' +
        '<button class="btn" id="dAllKeep">すべて保持</button>' +
        '<button class="btn" id="dAllSell">すべて売却</button>' +
        '<button class="btn btn-primary" id="dOk">決定</button>' +
      '</div>';

    openModal(m, true);

    var sSell = m.querySelector('#dSell'), sTrade = m.querySelector('#dTrade');

    function refresh() {
      sell = +sSell.value; trade = +sTrade.value;
      /* 合計が保有数を超えないように相互に制限する */
      if (sell + trade > lim.held) {
        if (document.activeElement === sSell) {
          trade = Math.max(0, lim.held - sell); trade -= trade % 2; sTrade.value = trade;
        } else {
          sell = Math.max(0, lim.held - trade); sSell.value = sell;
        }
      }
      m.querySelector('#dSellN').textContent = sell;
      m.querySelector('#dTradeN').textContent = trade;
      m.querySelector('[data-row="sell"]').classList.toggle('has', sell > 0);
      m.querySelector('[data-row="trade"]').classList.toggle('has', trade > 0);
      m.querySelector('#dTotal').innerHTML =
        '現金 <b>+' + R.formatMoney(sell * d.price) + '</b> ・ ' +
        surv.jp + ' <b>+' + (trade / 2) + '株</b> ・ 保持 ' + (lim.held - sell - trade) + '株';
    }
    sSell.addEventListener('input', refresh);
    sTrade.addEventListener('input', refresh);
    m.querySelector('#dAllSell').addEventListener('click', function () {
      sSell.value = lim.held - trade; refresh();
    });
    m.querySelector('#dAllKeep').addEventListener('click', function () {
      sSell.value = 0; sTrade.value = 0; refresh();
    });
    m.querySelector('#dOk').addEventListener('click', function () {
      closeModal();
      Engine.submitDisposal(state, { sell: sell, trade: trade });
      step();
    });
    refresh();
  }

  /* ------------------------------------------------------------------ *
   * モーダル基盤
   * ------------------------------------------------------------------ */
  function openModal(node, sticky) {
    el.overlay.innerHTML = '';
    el.overlay.appendChild(node);
    el.overlay.hidden = false;
    el.overlay.dataset.sticky = sticky ? '1' : '';
  }
  function closeModal() {
    el.overlay.hidden = true;
    el.overlay.innerHTML = '';
  }
  el.overlay.addEventListener('click', function (e) {
    if (e.target === el.overlay && el.overlay.dataset.sticky !== '1') closeModal();
  });

  /* ------------------------------------------------------------------ *
   * 演出キューの再生
   * ------------------------------------------------------------------ */
  /* g は再生開始時のゲーム。途中で「新しいゲーム」が始まったら中断する。 */
  async function playFx(g) {
    while (g.fx.length) {
      if (state !== g) { g.fx.length = 0; return; }
      var e = g.fx.shift();
      await playOne(e, g);
    }
    if (state === g) syncBoard();
  }

  async function playOne(e, g) {
    switch (e.t) {
      case 'setup': {
        for (var i = 0; i < e.tiles.length; i++) {
          paintCell(e.tiles[i].tile, '.', 'anim-pop', 0);
          Sound.place();
          await sleep(130);
        }
        await sleep(200);
        break;
      }

      case 'turn': {
        Sound.turn();
        renderPlayers();
        renderStatus();
        break;
      }

      case 'place': {
        var p = g.players[e.player];
        var target = cells[e.tile];
        var src = p.isHuman
          ? (el.hand.querySelector('[data-tile="' + e.tile + '"]') || el.hand)
          : playerCardOf(e.player);
        if (src) flyTile(rectOf(src), rectOf(target), R.label(e.tile));
        await sleep(300);
        paintCell(e.tile, '.', 'anim-pop', 0);
        Sound.place();
        ripple(e.tile, 'rgba(255,255,255,.7)');
        await sleep(TIMING.place);
        break;
      }

      case 'found': {
        var ch = R.chain(e.chain);
        Sound.found();
        quake();
        ripple(e.origin, ch.color);
        glowBoard(e.origin, ch.color);
        toast('<b>' + ch.jp + '</b> 設立！', 'chain big', ch.color);
        var dur = paintGroup(e.tiles, e.chain, e.origin, 'anim-paint', 70);
        bumpChainRow(e.chain);
        renderChains();
        await sleep(Math.max(TIMING.found, dur));
        break;
      }

      case 'founder-share': {
        var ch2 = R.chain(e.chain);
        var to = playerCardOf(e.player);
        var br = rectOf(el.board);
        flyStock({ left: br.left + br.width / 2, top: br.top + br.height / 2, width: 0, height: 0 },
          rectOf(to), ch2.color, ch2.dark, 0);
        floatText(to, '設立者ボーナス +1株', 'gold');
        Sound.stock();
        await sleep(TIMING.stock);
        renderPlayers();
        break;
      }

      case 'grow': {
        paintGroup(e.tiles, e.chain, e.origin, 'anim-pop', 60);
        Sound.place();
        bumpChainRow(e.chain);
        renderChains();
        await sleep(TIMING.small + e.tiles.length * 60);
        break;
      }

      case 'merge-start': {
        var sv = R.chain(e.survivor);
        Sound.merge();
        quake();
        glowBoard(e.tile, sv.color);
        ripple(e.tile, sv.color);
        toast('合併発生 — <b>' + sv.jp + '</b> が ' +
          e.defunct.map(function (d) { return R.chain(d).jp; }).join('・') + ' を吸収',
          'chain big', sv.color);
        paintGroup(e.joining, e.survivor, e.tile, 'anim-pop', 60);
        await sleep(TIMING.merge);
        break;
      }

      case 'bonus': {
        var chB = R.chain(e.chain);
        Sound.coin();
        e.payouts.forEach(function (pay, i) {
          var node = playerCardOf(pay.player);
          setTimeout(function () {
            floatText(node, (pay.kind === 'majority' ? '筆頭' : '第2位') + ' +' +
              R.formatMoney(pay.amount), 'gold');
            Sound.coin();
          }, ms(i * 220));
        });
        toast(chB.jp + ' 消滅 — ボーナス支払い', 'chain', chB.color);
        await sleep(TIMING.bonus + e.payouts.length * 200);
        renderPlayers();
        break;
      }

      case 'sell': {
        var chS = R.chain(e.chain);
        var node = playerCardOf(e.player);
        for (var k = 0; k < Math.min(e.count, 6); k++) {
          flyStock(rectOf(node), rectOf(el.chains), chS.color, chS.dark, k * 70);
        }
        floatText(node, '+' + R.formatMoney(e.amount), 'gain');
        Sound.coin();
        await sleep(TIMING.stock);
        renderPlayers(); renderChains();
        break;
      }

      case 'trade': {
        var chT = R.chain(e.to);
        var nodeT = playerCardOf(e.player);
        for (var k2 = 0; k2 < e.got; k2++) {
          flyStock(rectOf(el.chains), rectOf(nodeT), chT.color, chT.dark, k2 * 90);
        }
        floatText(nodeT, chT.jp + ' +' + e.got + '株', 'gold');
        Sound.stock();
        await sleep(TIMING.stock);
        renderPlayers(); renderChains();
        break;
      }

      case 'absorb': {
        var chA = R.chain(e.chain);
        Sound.sweep(600, 200, .4, .05);
        paintGroup(e.tiles, e.chain, e.origin, 'anim-absorb', 45);
        await sleep(TIMING.absorb + e.tiles.length * 45);
        renderChains();
        break;
      }

      case 'merge-end': {
        bumpChainRow(e.chain);
        renderChains();
        await sleep(TIMING.small);
        break;
      }

      case 'buy': {
        var chBuy = R.chain(e.chain);
        var nodeB = playerCardOf(e.player);
        for (var k3 = 0; k3 < e.count; k3++) {
          flyStock(rectOf(el.chains), rectOf(nodeB), chBuy.color, chBuy.dark, k3 * 110);
        }
        floatText(nodeB, '-' + R.formatMoney(e.cost), 'loss');
        Sound.stock();
        await sleep(TIMING.stock + e.count * 60);
        renderPlayers(); renderChains();
        break;
      }

      case 'safe': {
        var chSafe = R.chain(e.chain);
        Sound.safe();
        toast('<b>' + chSafe.jp + '</b> が安全圏に到達 🔒', 'chain', chSafe.color);
        await sleep(TIMING.small);
        break;
      }

      case 'discard': {
        toast('置けないタイル ' + e.tiles.length + ' 枚を交換', '');
        await sleep(TIMING.small);
        break;
      }

      case 'draw': {
        renderHand();
        await sleep(160);
        break;
      }

      case 'declare-end': {
        toast('<b>' + g.players[e.player].name + '</b> がゲーム終了を宣言！', 'big');
        await sleep(700);
        break;
      }

      case 'final-settle': {
        toast('最終清算', 'big');
        renderPlayers(); renderChains();
        await sleep(700);
        break;
      }

      case 'gameover': {
        Sound.win();
        confetti();
        await sleep(500);
        break;
      }

      default: break;
    }
    renderLog();
  }

  /* ------------------------------------------------------------------ *
   * メインループ
   * ------------------------------------------------------------------ */
  async function step() {
    if (busy) return;
    busy = true;
    selectedTile = null;
    var mine = state; // このループが担当するゲーム
    try {
      while (state === mine) {
        render();
        await playFx(mine);
        if (state !== mine) return;

        if (mine.phase === 'gameover') { render(); await showResults(); break; }

        var actor = Engine.actor(mine);
        if (actor.isHuman) {
          render();
          if (mine.phase === 'dispose') showDisposeModal();
          break;
        }

        render();
        await sleep(TIMING.aiThink);
        if (state !== mine) return;
        await runAI(actor);
      }
    } catch (err) {
      console.error(err);
      toast('エラー: ' + err.message, 'big');
    } finally {
      /* 新しいゲームに切り替わっていたら busy はそちらが管理する */
      if (state === mine) busy = false;
    }
    if (state === mine) render();
  }

  async function runAI(p) {
    switch (state.phase) {
      case 'place': {
        var mine = state;
        var t = AI.chooseTile(state, p);
        if (t == null) { Engine.buy(state, {}); break; }
        cells[t].classList.add('target');
        await sleep(340);
        if (state !== mine) return; // 新しいゲームが始まった
        cells[t].classList.remove('target');
        Engine.placeTile(state, t);
        break;
      }
      case 'found': {
        var id = AI.chooseFoundChain(state, p, state.pending.found.options);
        Engine.chooseFoundChain(state, id);
        break;
      }
      case 'survivor': {
        var m = state.pending.merge;
        var info = { chains: m.chains, sizes: m.sizes, lones: m.lones };
        Engine.chooseSurvivor(state, AI.chooseSurvivor(state, p, info, m.candidates));
        break;
      }
      case 'dispose': {
        Engine.submitDisposal(state, AI.disposal(state, p));
        break;
      }
      case 'buy': {
        if (AI.shouldDeclareEnd(state, p)) Engine.declareEnd(state);
        Engine.buy(state, AI.buyCart(state, p));
        break;
      }
      default: throw new Error('unknown phase ' + state.phase);
    }
  }

  /* ------------------------------------------------------------------ *
   * 人間の操作
   * ------------------------------------------------------------------ */
  function onHandClick(tile) {
    if (busy || state.phase !== 'place') return;
    var actor = Engine.actor(state);
    if (!actor.isHuman) return;
    if (selectedTile === tile) { doPlace(tile); return; }
    selectedTile = tile;
    Sound.tone(520, .05, 'sine', .04);
    render();
  }

  function onCellClick(ev) {
    if (busy || state.phase !== 'place') return;
    var actor = Engine.actor(state);
    if (!actor.isHuman) return;
    var i = +ev.currentTarget.dataset.i;
    if (actor.tiles.indexOf(i) === -1) return;
    if (!Engine.isPlayable(state, i)) { Sound.error(); return; }
    doPlace(i);
  }

  function doPlace(tile) {
    if (busy) return;
    try {
      Engine.placeTile(state, tile);
      selectedTile = null;
      step();
    } catch (err) {
      Sound.error();
      toast(err.message, '');
    }
  }

  function doBuy() {
    if (busy) return;
    try {
      if (declareIntent && Engine.canDeclareEnd(state)) Engine.declareEnd(state);
      declareIntent = false;
      var c = cart; cart = {};
      Engine.buy(state, c);
      step();
    } catch (err) {
      Sound.error();
      toast(err.message, '');
    }
  }

  /* ------------------------------------------------------------------ *
   * 全体描画
   * ------------------------------------------------------------------ */
  function render() {
    if (!state) return;
    renderStatus();
    syncBoard();
    decorateBoard();
    renderHand();
    renderPlayers();
    renderChains();
    renderLog();
    renderActions();
  }

  /* ------------------------------------------------------------------ *
   * 紙吹雪
   * ------------------------------------------------------------------ */
  function confetti() {
    var cv = el.confetti;
    cv.classList.add('on');
    var ctx = cv.getContext('2d');
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    function resize() {
      cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
      cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    var colors = R.CHAINS.map(function (c) { return c.color; }).concat(['#e9c46a', '#ffffff']);
    var parts = [];
    for (var i = 0; i < 160; i++) {
      parts.push({
        x: Math.random() * innerWidth,
        y: -20 - Math.random() * innerHeight * .6,
        w: 6 + Math.random() * 8,
        h: 8 + Math.random() * 12,
        vy: 1.8 + Math.random() * 3.4,
        vx: (Math.random() - .5) * 2.2,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - .5) * .28,
        c: colors[(Math.random() * colors.length) | 0]
      });
    }
    var start = performance.now();
    (function frame(now) {
      var t = now - start;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      parts.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        p.vx += Math.sin((t + p.y) / 320) * .035;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.globalAlpha = t > 4500 ? Math.max(0, 1 - (t - 4500) / 1500) : 1;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (t < 6000) requestAnimationFrame(frame);
      else { ctx.clearRect(0, 0, innerWidth, innerHeight); cv.classList.remove('on'); }
    })(start);
  }

  /* ------------------------------------------------------------------ *
   * 結果表示
   * ------------------------------------------------------------------ */
  async function showResults() {
    await sleep(400);
    var m = document.createElement('div');
    m.className = 'modal';
    var rows = state.results.map(function (r, i) {
      var medal = ['🥇', '🥈', '🥉'][r.rank - 1] || r.rank;
      return '<div class="result-row' + (r.rank === 1 ? ' first' : '') + '" style="--d:' + ms(i * 110) + 'ms">' +
        '<div class="result-rank">' + medal + '</div>' +
        '<div><div class="result-name">' + r.name + (r.isHuman ? '（あなた）' : '') + '</div>' +
        '<div class="result-detail">ボーナス ' + R.formatMoney(r.bonus) +
        ' ・ 株清算 ' + R.formatMoney(r.stock) + '</div></div>' +
        '<div class="result-cash">' + R.formatMoney(r.cash) + '</div></div>';
    }).join('');
    m.innerHTML =
      '<h2>🏆 最終結果</h2>' +
      '<p class="sub">全チェーンのボーナスと保有株を清算しました。</p>' +
      '<div class="result-list">' + rows + '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn" id="rClose">盤面を見る</button>' +
        '<button class="btn btn-primary" id="rAgain">もう一度プレイ</button>' +
      '</div>';
    openModal(m, false);
    m.querySelector('#rClose').addEventListener('click', closeModal);
    m.querySelector('#rAgain').addEventListener('click', function () { closeModal(); showStartModal(); });
  }

  /* ------------------------------------------------------------------ *
   * スタート画面
   * ------------------------------------------------------------------ */
  var CPU_NAMES = ['アイダ', 'ボリス', 'カルロ', 'ダイアナ', 'エルザ'];
  var CPU_PERSONAS = ['aggressive', 'cautious', 'tycoon', 'balanced', 'aggressive'];

  function showStartModal() {
    var opponents = 3, watch = false, name = 'あなた';

    var m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML =
      '<h2>ACQUIRE</h2>' +
      '<p class="sub">ホテルチェーンを設立し、株を買い、合併ボーナスで資産を増やす名作ボードゲーム。' +
      'ゲーム終了時にもっとも資産の多いプレイヤーが勝者です。</p>' +
      '<div class="field"><label>プレイヤー名</label>' +
        '<input type="text" id="sName" value="あなた" maxlength="10"></div>' +
      '<div class="field"><label>CPU の人数</label><div class="seg" id="sOpp">' +
        [1, 2, 3, 4, 5].map(function (n) {
          return '<button data-n="' + n + '"' + (n === 3 ? ' class="on"' : '') + '>' + n + '人</button>';
        }).join('') + '</div></div>' +
      '<div class="field"><label>モード</label><div class="seg" id="sMode">' +
        '<button data-w="0" class="on">自分でプレイ</button>' +
        '<button data-w="1">CPU 同士を観戦</button></div></div>' +
      '<div class="field"><label>演出スピード</label><div class="seg" id="sSpeed">' +
        '<button data-s="1.4">ゆっくり</button>' +
        '<button data-s="1" class="on">ふつう</button>' +
        '<button data-s="0.55">はやい</button></div></div>' +
      '<div class="modal-foot">' +
        (state ? '<button class="btn" id="sCancel">中断してもどる</button>' : '') +
        '<button class="btn" id="sRules">ルールを読む</button>' +
        '<button class="btn btn-primary" id="sStart">ゲーム開始</button>' +
      '</div>';
    openModal(m, true);
    if (state) {
      m.querySelector('#sCancel').addEventListener('click', function () {
        closeModal();
        step(); // 進行中のゲームを再開する
      });
    }

    function segHandler(container, fn) {
      container.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        Array.prototype.forEach.call(container.children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        fn(b);
        Sound.tone(600, .05, 'sine', .04);
      });
    }
    segHandler(m.querySelector('#sOpp'), function (b) { opponents = +b.dataset.n; });
    segHandler(m.querySelector('#sMode'), function (b) { watch = b.dataset.w === '1'; });
    segHandler(m.querySelector('#sSpeed'), function (b) { speed = +b.dataset.s; });

    m.querySelector('#sRules').addEventListener('click', function () { showRulesModal(showStartModal); });
    m.querySelector('#sStart').addEventListener('click', function () {
      Sound.ensure();
      name = (m.querySelector('#sName').value || 'あなた').trim().slice(0, 10);
      closeModal();
      startGame(name, opponents, watch);
    });
  }

  function startGame(name, opponents, watch) {
    var players = [];
    if (!watch) players.push({ name: name, isHuman: true });
    var count = watch ? Math.max(2, opponents + 1) : opponents;
    for (var i = 0; i < count; i++) {
      players.push({ name: CPU_NAMES[i % CPU_NAMES.length], personality: CPU_PERSONAS[i % CPU_PERSONAS.length] });
    }

    view = new Array(R.CELLS).fill(null);
    prevCash = {}; prevShares = {}; lastLogCount = 0; lastActorIdx = -1;
    handSignature = ''; selectedTile = null; cart = {}; declareIntent = false;
    el.players.innerHTML = ''; el.log.innerHTML = '';
    el.toasts.innerHTML = '';
    buildBoard();

    /* 進行中のループは state が入れ替わった時点で自分から抜ける */
    state = Engine.newGame({ players: players });
    busy = false;
    global.AQ.state = state; // デバッグ用
    render();
    step();
  }

  /* ------------------------------------------------------------------ *
   * ルール画面
   * ------------------------------------------------------------------ */
  function showRulesModal(onClose) {
    var priceRows = R.PRICE_ROWS.map(function (row) {
      var sample = row.label === '41+' ? 41 : parseInt(row.label, 10) || 6;
      return '<tr><td>' + row.label + '</td>' +
        [0, 1, 2].map(function (tier) {
          var id = R.CHAIN_IDS.filter(function (x) { return R.chain(x).tier === tier; })[0];
          return '<td>' + R.formatMoney(R.priceOf(id, sample)) + '</td>';
        }).join('') + '</tr>';
    }).join('');

    var m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML =
      '<h2>ルール</h2>' +
      '<div class="rules-body">' +
      '<h3>1手番の流れ</h3><ul>' +
        '<li>手札から1枚タイルを盤面に置く</li>' +
        '<li>設立・拡大・合併の処理を行う</li>' +
        '<li>盤上のチェーンの株を最大3株まで購入する</li>' +
        '<li>手札を6枚に補充して次の人へ</li>' +
      '</ul>' +
      '<h3>チェーンの設立</h3><ul>' +
        '<li>どのチェーンにも属さないタイルに隣接して置くと新チェーンを設立できる</li>' +
        '<li>設立者は無料で1株もらえる</li>' +
        '<li>7つ全てのチェーンが盤上にある間は設立できない（そのタイルは置けない）</li>' +
      '</ul>' +
      '<h3>合併</h3><ul>' +
        '<li>2つ以上のチェーンをつなぐタイルを置くと合併が発生する</li>' +
        '<li>大きい方が存続し、小さい方は消滅する（同数なら置いた人が選ぶ）</li>' +
        '<li>消滅チェーンの筆頭株主に株価×10、第2位株主に株価×5のボーナス</li>' +
        '<li>同数で並んだ場合はボーナスを分割（100ドル単位で切り上げ）</li>' +
        '<li>消滅チェーンの株は「売却」「2株→存続1株に交換」「保持」から選ぶ</li>' +
        '<li>11マス以上のチェーンは安全圏となり吸収されない。安全圏同士をつなぐタイルは永久に配置不可</li>' +
      '</ul>' +
      '<h3>ゲーム終了</h3><ul>' +
        '<li>41マス以上のチェーンができる、または盤上の全チェーンが安全圏になったとき、手番のプレイヤーは終了を宣言できる</li>' +
        '<li>全チェーンのボーナスを支払い、全株を時価で清算。最も所持金が多い人の勝ち</li>' +
      '</ul>' +
      '<h3>株価表（1株あたり）</h3>' +
      '<table class="price-table"><thead><tr><th>マス数</th><th>安価<br>ルクソール/タワー</th>' +
      '<th>中価格<br>アメリカン他</th><th>高価格<br>インペリアル他</th></tr></thead>' +
      '<tbody>' + priceRows + '</tbody></table>' +
      '<p style="margin-top:14px;font-size:11.5px;color:var(--text-faint)">' +
      '筆頭株主ボーナス = 株価 × 10 / 第2位株主ボーナス = 株価 × 5</p>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn btn-primary" id="ruClose">閉じる</button></div>';
    openModal(m, true);
    m.querySelector('#ruClose').addEventListener('click', function () {
      closeModal();
      if (onClose) onClose();
    });
  }

  /* ------------------------------------------------------------------ *
   * 起動
   * ------------------------------------------------------------------ */
  el.btnNew.addEventListener('click', function () { showStartModal(); });
  el.btnRules.addEventListener('click', function () { showRulesModal(null); });
  el.btnSound.addEventListener('click', function () {
    Sound.enabled = !Sound.enabled;
    el.btnSound.setAttribute('aria-pressed', String(Sound.enabled));
    if (Sound.enabled) { Sound.ensure(); Sound.tone(700, .1, 'sine', .05); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.overlay.hidden && el.overlay.dataset.sticky !== '1') closeModal();
  });
  global.addEventListener('resize', function () {
    if (el.confetti.classList.contains('on')) {
      el.confetti.width = innerWidth; el.confetti.height = innerHeight;
    }
  });

  /* 外から触れる最小限の口（デバッグ・自動テスト用） */
  global.AQ.ui = {
    setSpeed: function (v) { speed = v; },
    getSpeed: function () { return speed; },
    newGame: startGame,
    isBusy: function () { return busy; }
  };

  buildBoard();
  showStartModal();

})(window);
