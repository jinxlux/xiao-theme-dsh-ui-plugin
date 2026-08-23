/**
 * 把 tsc 产出的 CommonJS 客户端 `.build/client.js` 包裹成 DSH 客户端 ModuleLoader 加载形态。
 * 纯文件读写（无子进程），因此不会触发沙箱的 EPERM。
 * 产出 `lib/client.js`：`window.__ModuleLoader__.load({ id, factory: (require) => { <cjs>; return module.exports; } })`。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildClient = join(root, '.build', 'client.js');
const outDir = join(root, 'lib');

const clientCjs = await readFile(buildClient, 'utf8');
const wrapper = `window.__ModuleLoader__.load({
  id: 'xiao-ui-theme-ts',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
${clientCjs
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n')}
    return module.exports;
  },
});
`;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'client.js'), wrapper, 'utf8');
console.log('[xiao-ui-theme-ts] wrapped client -> lib/client.js (ModuleLoader)');
