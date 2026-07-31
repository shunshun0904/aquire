/* ==========================================================================
   index.html の CSS / JS をインライン展開して、1枚の HTML にまとめる。
     node build.js
   出力: dist/acquire.html （どこに置いても、開くだけで遊べる）
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'dist');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

let html = read('index.html');

/* <link rel="stylesheet" href="..."> を <style> に置き換える */
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, href) => {
  return '<style>\n' + read(href).trim() + '\n</style>';
});

/* <script src="..."></script> を中身に置き換える */
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  return '<script>\n' + read(src).trim() + '\n</script>';
});

if (/<link rel="stylesheet"|<script src=/.test(html)) {
  console.error('❌ インライン化できていない外部参照が残っています');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'acquire.html');
fs.writeFileSync(outFile, html);

/* Artifact 用: <!doctype>/<html>/<head>/<body> を外した本文だけの版 */
const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
const headStyle = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, 'ACQUIRE'])[1];
if (bodyMatch) {
  const fragment =
    '<title>' + title + '</title>\n' +
    headStyle + '\n' +
    bodyMatch[1].trim() + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'acquire-artifact.html'), fragment);
}

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log('✅ dist/acquire.html を生成しました (' + kb + ' KB)');
console.log('✅ dist/acquire-artifact.html を生成しました');
