/* ==========================================================================
   ブラウザ動作確認。実際に Chromium で起動して、
   コンソールエラーが出ないこと・操作が通ることを確認する。
     node test/browser.js
   ========================================================================== */
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const SHOT_DIR = path.resolve(__dirname, '..', 'dist', 'shots');

/* この環境には Chromium が同梱済みなので、あればそれを使う */
function findChromium() {
  const base = '/opt/pw-browsers';
  if (!fs.existsSync(base)) return undefined;
  const dir = fs.readdirSync(base)
    .filter(d => d.startsWith('chromium-'))
    .sort()
    .pop();
  if (!dir) return undefined;
  const bin = path.join(base, dir, 'chrome-linux', 'chrome');
  return fs.existsSync(bin) ? bin : undefined;
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChromium() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  function fail(msg) { errors.push(msg); }

  function report(step) {
    if (errors.length) {
      console.log('❌ ' + step + ' でエラー:');
      errors.forEach(e => console.log('   ' + e));
      process.exitCode = 1;
      errors.length = 0;
      return false;
    }
    console.log('✅ ' + step);
    return true;
  }

  await page.goto(URL);
  await page.waitForSelector('#sStart');
  await page.screenshot({ path: path.join(SHOT_DIR, '1-start.png') });
  report('スタート画面の表示');

  /* --- 観戦モードで CPU 同士を走らせる ------------------------------- */
  await page.click('#sSpeed button[data-s="0.55"]');
  await page.click('#sMode button[data-w="1"]');
  await page.click('#sOpp button[data-n="3"]');
  await page.click('#sStart');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(SHOT_DIR, '2-watch.png') });

  const watchState = await page.evaluate(() => ({
    phase: window.AQ.state.phase,
    logs: window.AQ.state.log.length,
    onBoard: window.AQ.state.board.filter(v => v !== null).length,
    players: window.AQ.state.players.length
  }));
  console.log('   観戦: ' + JSON.stringify(watchState));
  if (watchState.onBoard < 6) {
    fail('盤面が進行していない');
  }
  report('CPU 同士の自動進行');

  /* --- 人間プレイ: タイル配置と株購入を実際に操作する ---------------- */
  await page.click('#btnNew');
  await page.waitForSelector('#sStart');
  await page.click('#sSpeed button[data-s="0.55"]');
  await page.click('#sMode button[data-w="0"]');
  await page.click('#sOpp button[data-n="2"]');
  await page.click('#sStart');

  /* 自分の手番が来るまで待つ */
  await page.waitForFunction(() => {
    const s = window.AQ.state;
    return s && s.phase === 'place' && s.players[s.current].isHuman && !window.AQ.ui.isBusy();
  }, null, { timeout: 30000 });
  await page.screenshot({ path: path.join(SHOT_DIR, '3-my-turn.png') });
  report('自分の手番まで進行');

  /* 配置可能なタイルをクリック → 配置ボタン */
  const tile = await page.evaluate(() => {
    const s = window.AQ.state;
    const p = s.players[s.current];
    const legal = p.tiles.filter(t => window.AQ.Engine.isPlayable(s, t));
    return legal.length ? legal[0] : null;
  });
  if (tile === null) {
    console.log('⚠️  配置可能なタイルが無い手番だったのでスキップ');
  } else {
    await page.click(`.tile[data-tile="${tile}"]`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOT_DIR, '4-selected.png') });
    await page.click(`.tile[data-tile="${tile}"]`); // 2回目のクリックで配置
    await page.waitForTimeout(2500);
    const placed = await page.evaluate(t => window.AQ.state.board[t] !== null, tile);
    if (!placed) fail('タイルが盤面に置かれていない');
    report('タイルの配置');
  }

  /* 設立 / 合併の選択が出ていたら先に処理する */
  for (let i = 0; i < 4; i++) {
    const phase = await page.evaluate(() => window.AQ.state.phase);
    if (phase === 'found' || phase === 'survivor') {
      await page.click('.chain-btn');
      await page.waitForTimeout(2500);
    } else if (phase === 'dispose') {
      await page.click('#dOk');
      await page.waitForTimeout(2000);
    } else break;
  }

  /* 購入フェーズ: 実際に株が買えるようになるまで手番を進め、支払いが起きるか見る */
  let bought = false;
  for (let turn = 0; turn < 8 && !bought; turn++) {
    await page.waitForFunction(() => {
      const s = window.AQ.state;
      return s.phase === 'gameover' ||
        (s.phase === 'buy' && s.players[s.current].isHuman && !window.AQ.ui.isBusy());
    }, null, { timeout: 40000 });
    if (await page.evaluate(() => window.AQ.state.phase === 'gameover')) break;

    if (turn === 0) await page.screenshot({ path: path.join(SHOT_DIR, '5-buy.png') });

    const plus = page.locator('.buy-item .stepper button:not([disabled])').last();
    const cashBefore = await page.evaluate(() =>
      window.AQ.state.players.find(p => p.isHuman).cash);

    if (await plus.count()) { await plus.click(); await page.waitForTimeout(150); }
    await page.click('.action-btns .btn-primary');
    await page.waitForTimeout(1200);

    const cashAfter = await page.evaluate(() =>
      window.AQ.state.players.find(p => p.isHuman).cash);
    if (cashAfter < cashBefore) {
      bought = true;
      console.log('   購入で所持金が減少: ' + cashBefore + ' -> ' + cashAfter);
    }

    /* 次の自分の手番: タイルを1枚置いて購入フェーズへ進める */
    if (!bought) {
      await page.waitForFunction(() => {
        const s = window.AQ.state;
        return s.phase === 'gameover' ||
          (s.phase === 'place' && s.players[s.current].isHuman && !window.AQ.ui.isBusy());
      }, null, { timeout: 40000 });
      if (await page.evaluate(() => window.AQ.state.phase === 'gameover')) break;
      const t2 = await page.evaluate(() => {
        const s = window.AQ.state;
        const p = s.players[s.current];
        const legal = p.tiles.filter(x => window.AQ.Engine.isPlayable(s, x));
        return legal.length ? legal[0] : null;
      });
      if (t2 === null) continue;
      await page.click(`.tile[data-tile="${t2}"]`);
      await page.click(`.tile[data-tile="${t2}"]`);
      await page.waitForTimeout(1500);
      for (let i = 0; i < 4; i++) {
        const ph = await page.evaluate(() => window.AQ.state.phase);
        if (ph === 'found' || ph === 'survivor') {
          await page.click('.chain-btn'); await page.waitForTimeout(1800);
        } else if (ph === 'dispose') {
          await page.click('#dOk'); await page.waitForTimeout(1500);
        } else break;
      }
    }
  }
  if (!bought) fail('株の購入が一度も成立しなかった');
  report('株の購入と手番終了');

  /* --- 観戦モードで1ゲームを最後まで走らせ、結果画面まで確認する ------ */
  await page.click('#btnNew');
  await page.waitForSelector('#sStart');
  await page.click('#sMode button[data-w="1"]');
  await page.click('#sOpp button[data-n="3"]');
  await page.click('#sStart');
  await page.evaluate(() => window.AQ.ui.setSpeed(0.02)); // 演出を極小にして高速消化
  await page.waitForFunction(() => window.AQ.state.phase === 'gameover',
    null, { timeout: 180000 });
  await page.waitForSelector('#rAgain', { timeout: 20000 });
  await page.evaluate(() => window.AQ.ui.setSpeed(1));
  await page.screenshot({ path: path.join(SHOT_DIR, '8-result.png') });
  const ranking = await page.evaluate(() => window.AQ.state.results.map(r => r.name + ':' + r.cash));
  console.log('   最終順位: ' + ranking.join(' / '));
  report('ゲーム終了まで通し実行 + 結果画面');
  await page.click('#rClose');

  /* --- ルール画面 ------------------------------------------------------ */
  await page.click('#btnRules');
  await page.waitForSelector('#ruClose');
  await page.screenshot({ path: path.join(SHOT_DIR, '6-rules.png') });
  await page.click('#ruClose');
  report('ルール画面');

  /* --- モバイル幅 ------------------------------------------------------ */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: path.join(SHOT_DIR, '7-mobile.png'), fullPage: false });
  if (overflow > 2) fail('モバイル幅で横スクロールが発生: ' + overflow + 'px');
  report('モバイル幅レイアウト (横はみ出し ' + overflow + 'px)');

  await browser.close();
  console.log('\nスクリーンショット: ' + SHOT_DIR);
})();
