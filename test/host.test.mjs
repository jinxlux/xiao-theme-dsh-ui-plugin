/**
 * Host \u534a\u7eaf\u51fd\u6570\u5355\u6d4b\uff08node:test\uff0c\u96f6\u7b2c\u4e09\u65b9\u4f9d\u8d56\uff09\u3002
 * \u9700\u5148\u6784\u5efa\uff1a\`pnpm run build\`\uff08\`pnpm test\` \u5df2\u5305\u542b\uff09\u3002
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, isAnimatedGif, videoFormatMatches, yamlLiteralBlock, normalizeConfig } from '../lib/index.js';

test('parseRange: \u5408\u6cd5\u533a\u95f4', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-99999', 1000), { start: 0, end: 999 });
});

test('parseRange: \u975e\u6cd5/\u4e0d\u53ef\u6ee1\u8db3\u8fd4\u56de null', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange('bytes=2000-', 1000), null);
  assert.equal(parseRange('bytes=5-2', 1000), null);
  assert.equal(parseRange('bytes=-0', 1000), null);
  assert.equal(parseRange('bytes=0-9', 0), null);
});

function gifWithGce(count) {
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
  for (let i = 0; i < count; i += 1) bytes.push(0x21, 0xf9, 0x04, 0x00);
  return Buffer.from(bytes);
}

test('isAnimatedGif: \u591a\u5e27\u5224\u5b9a', () => {
  assert.equal(isAnimatedGif(gifWithGce(2)), true);
  assert.equal(isAnimatedGif(gifWithGce(3)), true);
  assert.equal(isAnimatedGif(gifWithGce(1)), false);
  assert.equal(isAnimatedGif(gifWithGce(0)), false);
  assert.equal(isAnimatedGif(Buffer.from('not a gif at all')), false);
  assert.equal(isAnimatedGif(Buffer.alloc(3)), false);
});

function ftypHeader() {
  const b = Buffer.alloc(16);
  b.write('ftyp', 4, 'latin1');
  return b;
}
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);

test('videoFormatMatches: \u5bb9\u5668\u7b7e\u540d\u4e0e\u6269\u5c55\u540d', () => {
  assert.equal(videoFormatMatches('.mp4', ftypHeader()), true);
  assert.equal(videoFormatMatches('.mov', ftypHeader()), true);
  assert.equal(videoFormatMatches('.m4v', ftypHeader()), true);
  assert.equal(videoFormatMatches('.webm', EBML), true);
  assert.equal(videoFormatMatches('.mp4', EBML), false);
  assert.equal(videoFormatMatches('.webm', ftypHeader()), false);
  assert.equal(videoFormatMatches('.mp4', Buffer.alloc(8)), false);
});

test('yamlLiteralBlock: \u7f29\u8fdb/\u8f6c\u4e49/\u7a7a\u767d\u5904\u7406', () => {
  assert.equal(yamlLiteralBlock('a: 1\n\nb', '  '), '  a: 1\n\n  b');
  assert.equal(yamlLiteralBlock('x: "y" # z', '    '), '    x: "y" # z');
  assert.equal(yamlLiteralBlock('\tlead', '  '), '   lead');
  assert.equal(yamlLiteralBlock('mid\ttab', '  '), '  mid\ttab');
  assert.equal(yamlLiteralBlock('trail   ', '  '), '  trail');
  assert.equal(yamlLiteralBlock('a\r\nb', '  '), '  a\n  b');
});

test('normalizeConfig: \u9ed8\u8ba4\u503c\u4e0e\u8303\u56f4\u94b3\u5236', () => {
  const d = normalizeConfig({});
  assert.equal(d.enabled, true);
  assert.equal(d.avatarPath, 'resource/avatar.png');
  assert.equal(d.backgroundBlur, 22);
  assert.equal(d.panelOpacity, 0.5);
  assert.equal(d.sidebarOpacity, 0.85);
  assert.equal(d.themeColor, '#2E8B72');
  assert.equal(d.roleplayEnabled, false);
  assert.equal(d.roleplayNetwork, false);

  const c = normalizeConfig({ backgroundBlur: 999, panelOpacity: 5, sidebarOpacity: -3, themeColor: 'nope' });
  assert.equal(c.backgroundBlur, 60);
  assert.equal(c.panelOpacity, 0.9);
  assert.equal(c.sidebarOpacity, 0);
  assert.equal(c.themeColor, '#2E8B72');
});

test('normalizeConfig: \u65e7\u5b57\u6bb5\u8fc1\u79fb\u4e0e\u4f18\u5148\u7ea7', () => {
  assert.equal(normalizeConfig({ backgroundOpacity: 0.7 }).panelOpacity, 0.7);
  assert.equal(normalizeConfig({ backgroundDarkOpacity: 0.8 }).panelOpacity, 0.8);
  assert.equal(normalizeConfig({ backgroundOpacity: 0.5 }).panelOpacity, 0.5);
  assert.equal(normalizeConfig({ panelOpacity: 0.4, backgroundOpacity: 0.7 }).panelOpacity, 0.4);
});

test('normalizeConfig: roleplay \u5f00\u5173\u300c\u7f3a\u5931\u5373 false\u300d', () => {
  assert.equal(normalizeConfig({}).roleplayEnabled, false);
  assert.equal(normalizeConfig({ roleplayEnabled: 'yes' }).roleplayEnabled, false);
  assert.equal(normalizeConfig({ roleplayEnabled: true }).roleplayEnabled, true);
  assert.equal(normalizeConfig({ roleplayNetwork: 1 }).roleplayNetwork, false);
  assert.equal(normalizeConfig({ roleplayNetwork: true }).roleplayNetwork, true);
});

test('normalizeConfig: \u5409\u7965\u7269\u6587\u6848\u515c\u5e95', () => {
  assert.equal(normalizeConfig({ mascotTitle: '   ' }).mascotTitle, '\u9756\u5996\u50a9\u821e');
  assert.equal(normalizeConfig({ mascotTitle: 'X' }).mascotTitle, 'X');
  assert.equal(normalizeConfig({ mascotSubtitle: '' }).mascotSubtitle, '');
});
