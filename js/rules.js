/* ==========================================================================
   ACQUIRE - ルールとデータ定義
   盤面の座標、ホテルチェーン、株価表など「変わらない事実」だけを置く層。
   ========================================================================== */
(function (global) {
  'use strict';

  var AQ = (global.AQ = global.AQ || {});

  var Rules = {};

  /* --- 盤面 ------------------------------------------------------------ */
  Rules.COLS = 12;
  Rules.ROWS = 9;
  Rules.CELLS = Rules.COLS * Rules.ROWS; // 108
  Rules.ROW_LETTERS = 'ABCDEFGHI';

  /* --- ゲーム定数 ------------------------------------------------------ */
  Rules.SAFE_SIZE = 11; // これ以上は吸収されない（安全）
  Rules.END_SIZE = 41; // これ以上のチェーンが出たら終了宣言可能
  Rules.SHARES_PER_CHAIN = 25;
  Rules.START_CASH = 6000;
  Rules.HAND_SIZE = 6;
  Rules.MAX_BUY_PER_TURN = 3;

  /* --- ホテルチェーン --------------------------------------------------
     tier 0: 安価 / tier 1: 中間 / tier 2: 高価
     ---------------------------------------------------------------------- */
  Rules.CHAINS = [
    { id: 'luxor',       name: 'Luxor',       jp: 'ルクソール',       abbr: 'LX', tier: 0, color: '#e0483a', dark: '#8f231a' },
    { id: 'tower',       name: 'Tower',       jp: 'タワー',           abbr: 'TW', tier: 0, color: '#efb019', dark: '#946a05' },
    { id: 'american',    name: 'American',    jp: 'アメリカン',       abbr: 'AM', tier: 1, color: '#3b7dd8', dark: '#1d4685' },
    { id: 'festival',    name: 'Festival',    jp: 'フェスティバル',   abbr: 'FS', tier: 1, color: '#2fa464', dark: '#155f37' },
    { id: 'worldwide',   name: 'Worldwide',   jp: 'ワールドワイド',   abbr: 'WW', tier: 1, color: '#8b5cd6', dark: '#4d2c85' },
    { id: 'imperial',    name: 'Imperial',    jp: 'インペリアル',     abbr: 'IM', tier: 2, color: '#ef8022', dark: '#984a08' },
    { id: 'continental', name: 'Continental', jp: 'コンチネンタル',   abbr: 'CT', tier: 2, color: '#17b6c4', dark: '#0a6b74' }
  ];

  Rules.CHAIN_IDS = Rules.CHAINS.map(function (c) { return c.id; });

  var CHAIN_MAP = {};
  Rules.CHAINS.forEach(function (c) { CHAIN_MAP[c.id] = c; });
  Rules.chain = function (id) { return CHAIN_MAP[id]; };

  /* --- 座標ヘルパ ------------------------------------------------------ */
  Rules.rowOf = function (i) { return Math.floor(i / Rules.COLS); };
  Rules.colOf = function (i) { return i % Rules.COLS; };
  Rules.index = function (row, col) { return row * Rules.COLS + col; };
  Rules.label = function (i) {
    return (Rules.colOf(i) + 1) + Rules.ROW_LETTERS[Rules.rowOf(i)];
  };
  Rules.distance = function (a, b) {
    return Math.abs(Rules.rowOf(a) - Rules.rowOf(b)) + Math.abs(Rules.colOf(a) - Rules.colOf(b));
  };

  /* 上下左右の隣接マス（事前計算） */
  Rules.neighbors = (function () {
    var all = [];
    for (var i = 0; i < Rules.CELLS; i++) {
      var r = Rules.rowOf(i), c = Rules.colOf(i), n = [];
      if (r > 0) n.push(i - Rules.COLS);
      if (r < Rules.ROWS - 1) n.push(i + Rules.COLS);
      if (c > 0) n.push(i - 1);
      if (c < Rules.COLS - 1) n.push(i + 1);
      all.push(n);
    }
    return all;
  })();

  /* --- 株価表 ----------------------------------------------------------
     基準段 = チェーンの大きさから決まる 0..8 の段。
     価格 = (段 + 2 + tier) * 100
     例) 2マス/tier0 = 200、41マス/tier2 = 1200
     ---------------------------------------------------------------------- */
  function priceStep(size) {
    if (size < 2) return -1;
    if (size <= 5) return size - 2;   // 2,3,4,5 -> 0,1,2,3
    if (size <= 10) return 4;
    if (size <= 20) return 5;
    if (size <= 30) return 6;
    if (size <= 40) return 7;
    return 8;
  }
  Rules.priceStep = priceStep;

  Rules.priceOf = function (chainId, size) {
    var step = priceStep(size);
    if (step < 0) return 0;
    return (step + 2 + CHAIN_MAP[chainId].tier) * 100;
  };

  Rules.majorityBonus = function (chainId, size) { return Rules.priceOf(chainId, size) * 10; };
  Rules.minorityBonus = function (chainId, size) { return Rules.priceOf(chainId, size) * 5; };

  /* ボーナス分割は100ドル単位で切り上げ */
  Rules.roundUp100 = function (n) { return Math.ceil(n / 100) * 100; };

  Rules.isSafe = function (size) { return size >= Rules.SAFE_SIZE; };

  /* 表示用: 価格表の行 */
  Rules.PRICE_ROWS = [
    { label: '2',      test: function (s) { return s === 2; } },
    { label: '3',      test: function (s) { return s === 3; } },
    { label: '4',      test: function (s) { return s === 4; } },
    { label: '5',      test: function (s) { return s === 5; } },
    { label: '6-10',   test: function (s) { return s >= 6 && s <= 10; } },
    { label: '11-20',  test: function (s) { return s >= 11 && s <= 20; } },
    { label: '21-30',  test: function (s) { return s >= 21 && s <= 30; } },
    { label: '31-40',  test: function (s) { return s >= 31 && s <= 40; } },
    { label: '41+',    test: function (s) { return s >= 41; } }
  ];

  Rules.formatMoney = function (n) {
    var sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US');
  };

  AQ.Rules = Rules;
})(window);
