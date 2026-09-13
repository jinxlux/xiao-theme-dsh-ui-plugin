/**
 * Client \u534a\u7eaf\u51fd\u6570\u5355\u6d4b\uff08\u914d\u8272\u5de5\u5177\uff09\u3002
 * \u901a\u8fc7\u4f2a window.__ModuleLoader__ \u8f7d\u5165\u6784\u5efa\u4ea7\u7269 lib/client.js\uff0c\u518d\u7528
 * \u58f3\u7684 require \u6267\u884c\u5176 CJS \u5de5\u5382\uff0c\u56e0\u6b64\u4e0d\u89e6\u78b0 DOM\u3002
 * \u9700\u5148\u6784\u5efa\uff1a\`pnpm run build\`\uff08\`pnpm test\` \u5df2\u5305\u542b\uff09\u3002
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
// \u6d4b\u8bd5\u53ea\u8c03\u7eaf\u51fd\u6570\uff0cReact \u53ea\u9700\u80fd\u88ab import\uff08\u7ec4\u4ef6\u4e0d\u4f1a\u6e32\u67d3\uff09\uff0c\u6545\u7528\u6700\u5c0f\u6869\u4fdd\u6301\u65e0\u4f9d\u8d56\u3002
const reactStub = {
  createElement: () => null,
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
await import('../lib/client.js');
assert.ok(captured && typeof captured.factory === 'function', 'lib/client.js \u5e94\u8c03\u7528 __ModuleLoader__.load');
const mod = captured.factory((spec) => (spec === 'react' ? reactStub : nodeRequire(spec)));

test('parseHex', () => {
  assert.deepEqual(mod.parseHex('#2E8B72'), [46, 139, 114]);
  assert.deepEqual(mod.parseHex('2e8b72'), [46, 139, 114]);
  assert.deepEqual(mod.parseHex('#abc'), [170, 187, 204]);
  assert.equal(mod.parseHex('#xyz'), null);
  assert.equal(mod.parseHex(''), null);
});

test('rgbToHsl', () => {
  const red = mod.rgbToHsl(255, 0, 0);
  assert.equal(Math.round(red[0]), 0);
  assert.equal(Math.round(red[1]), 100);
  assert.equal(Math.round(red[2]), 50);
  assert.equal(Math.round(mod.rgbToHsl(0, 255, 0)[0]), 120);
  const gray = mod.rgbToHsl(128, 128, 128);
  assert.equal(gray[0], 0);
  assert.equal(gray[1], 0);
});

test('hslToRgb', () => {
  assert.deepEqual(mod.hslToRgb(0, 100, 50), [255, 0, 0]);
  assert.deepEqual(mod.hslToRgb(120, 100, 50), [0, 255, 0]);
  assert.deepEqual(mod.hslToRgb(240, 100, 50), [0, 0, 255]);
  assert.deepEqual(mod.hslToRgb(0, 0, 50), [128, 128, 128]);
});

test('shiftLight / shiftSat', () => {
  assert.equal(mod.shiftLight('nope', 10), 'nope');
  assert.equal(mod.shiftLight('#000000', -50), '#000000');
  assert.equal(mod.shiftLight('#ffffff', 50), '#ffffff');
  const lighter = mod.shiftLight('#2E8B72', 20);
  const l0 = mod.rgbToHsl(...mod.parseHex('#2E8B72'))[2];
  const l1 = mod.rgbToHsl(...mod.parseHex(lighter))[2];
  assert.ok(l1 > l0, '\u8c03\u4eae\u540e\u660e\u5ea6\u5e94\u589e\u5927');
  assert.equal(mod.shiftSat('nope', 10), 'nope');
  const desat = mod.shiftSat('#2E8B72', -100);
  assert.equal(Math.round(mod.rgbToHsl(...mod.parseHex(desat))[1]), 0);
});

test('deriveSurfaces', () => {
  const d = mod.deriveSurfaces('#2E8B72');
  assert.equal(d.light.length, 3);
  assert.equal(d.dark.length, 3);
  for (const v of [...d.light, ...d.dark]) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255);
  assert.equal(mod.deriveSurfaces('nope').light.length, 3);
});

test('mascotText: factory defaults follow the UI language', () => {
  const doc = { documentElement: { lang: 'zh-CN' } };
  globalThis.document = doc;
  assert.equal(mod.mascotText('', 'title'), '靖妖傩舞');
  assert.equal(mod.mascotText('靖妖傩舞', 'title'), '靖妖傩舞');
  assert.equal(mod.mascotText('Bane of All Evil', 'title'), '靖妖傩舞');
  assert.equal(mod.mascotText('别挡路', 'subtitle'), '别挡路');
  assert.equal(mod.mascotText('自定义', 'title'), '自定义');
  doc.documentElement.lang = 'en';
  assert.equal(mod.mascotText('', 'title'), 'Bane of All Evil');
  assert.equal(mod.mascotText('靖妖傩舞', 'title'), 'Bane of All Evil');
  assert.equal(mod.mascotText('别挡路', 'subtitle'), 'Out of my way');
  assert.equal(mod.mascotText('custom', 'subtitle'), 'custom');
});

test('buildPalette', () => {
  const p = mod.buildPalette('#2E8B72');
  const keys = Object.keys(p);
  assert.ok(keys.length > 0);
  assert.ok(keys.includes('--dsw-alias-bg-base'));
  assert.ok(keys.includes('--dsw-alias-brand-primary'));
  for (const k of keys) {
    assert.equal(typeof p[k].light, 'string');
    assert.equal(typeof p[k].dark, 'string');
  }
});
