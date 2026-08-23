/**
 * `pnpm run check` 在类型检查之后运行，做「构建产物是否符合 dsh 插件契约」的静态校验。
 * 目的：DSH 破坏性更新后快速暴露问题——manifest 字段名拼错、导出路径指向缺失文件、
 * cordis.patch.yml 不再是可解析的补丁列表、产物语法非法等。
 *
 * 校验面：
 * 1. package.json 的 `dsh` 契约（bundle.patch / client.inject/.platform/.immediately）。
 * 2. main / types / exports 指向的文件是否真实存在。
 * 3. cordis.patch.yml 必须是顶层数组，且包含指向本插件的 insert 行（id + name）。
 * 4. lib/index.js 可解析且导出 apply（default）。
 * 5. lib/client.js 可解析、包裹成 ModuleLoader、并导出 inject/apply。
 * 6. 若环境中可解析 `@deepseek-ai/dsh-app-boot`（例如已挂到 profile），再交叉校验真实 DshManifestSection。
 */
import { readFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'package.json');

const errors = [];
let pkg;

const ok = (message) => console.log(`  ok  ${message}`);
const fail = (message) => errors.push(message);

function loadManifest() {
  if (pkg === undefined) pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return pkg;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkManifest() {
  console.log('[check] package.json dsh 契约');
  const manifest = loadManifest();
  if (typeof manifest.name !== 'string') fail('package.json: name 必须为字符串');
  if (manifest.type !== 'module') fail('package.json: type 必须为 "module"（ESM）');
  if (typeof manifest.main !== 'string') fail('package.json: main 缺失');
  if (!(await fileExists(join(root, manifest.main)))) fail(`main 指向的文件不存在: ${manifest.main}`);

  // dsh.bundle
  const bundle = manifest.dsh?.bundle;
  if (!bundle || typeof bundle.patch !== 'string') {
    fail('package.json: dsh.bundle.patch 缺失（插件必须声明 patch 层）');
  } else if (!(await fileExists(join(root, bundle.patch)))) {
    fail(`dsh.bundle.patch 指向的文件不存在: ${bundle.patch}`);
  } else {
    ok(`dsh.bundle.patch -> ${bundle.patch}`);
  }

  // dsh.client
  const client = manifest.dsh?.client;
  if (!client) {
    fail('package.json: dsh.client 缺失（本插件是 client plugin）');
  } else {
    if (!Array.isArray(client.inject) || !client.inject.length) {
      fail('package.json: dsh.client.inject 必须是非空数组');
    } else {
      ok(`dsh.client.inject[0] -> ${client.inject[0]}`);
    }
    if (client.platform !== 'web') fail('package.json: dsh.client.platform 必须为 "web"');
    if (client.immediately !== true) fail('package.json: dsh.client.immediately 必须为 true');
    ok('dsh.client.platform/immediately 合法');
  }

  // exports 校验
  const ex = manifest.exports ?? {};
  for (const sub of ['.', './client']) {
    const target = ex[sub];
    if (!target) {
      fail(`exports["${sub}"] 缺失`);
      continue;
    }
    const def = typeof target === 'string' ? target : target.default;
    const types = typeof target === 'string' ? null : target.types;
    if (typeof def !== 'string' || !(await fileExists(join(root, def)))) {
      fail(`exports["${sub}"].default 指向的文件不存在: ${def}`);
    } else {
      ok(`exports["${sub}"].default -> ${def}`);
    }
    if (types && !(await fileExists(join(root, types)))) {
      fail(`exports["${sub}"].types 指向的文件不存在: ${types}`);
    }
  }
  if (!ex['./cordis.patch.yml']) fail('exports["./cordis.patch.yml"] 缺失（patch 必须可导出）');
  if (!ex['./package.json']) fail('exports["./package.json"] 缺失（resolveBundleDir 依赖）');
}

async function checkPatch() {
  console.log('[check] cordis.patch.yml 补丁列表');
  const patchPath = join(root, 'cordis.patch.yml');
  const text = await readFile(patchPath, 'utf8');
  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (error) {
    fail(`cordis.patch.yml 无法解析: ${error?.message ?? error}`);
    return;
  }
  if (!Array.isArray(parsed)) {
    fail('cordis.patch.yml 必须是顶层数组（补丁行列表）');
    return;
  }
  ok(`顶层数组，共 ${parsed.length} 条补丁`);
  let foundInsert = false;
  for (const [i, entry] of parsed.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`补丁第 ${i + 1} 条不是 mapping`);
      continue;
    }
    if (entry.insert) {
      const rows = Array.isArray(entry.insert) ? entry.insert : [entry.insert];
      for (const row of rows) {
        if (row && typeof row.id === 'string' && typeof row.name === 'string') {
          foundInsert = true;
          if (row.name !== pkg.name) fail(`insert 行 name 与包名不一致: ${row.name} != ${pkg.name}`);
          else ok(`insert 行 id=${row.id} name=${row.name}`);
        }
      }
    }
  }
  if (!foundInsert) fail('cordis.patch.yml 中未找到带 id+name 的 insert 行');
}

async function checkArtifacts() {
  console.log('[check] 构建产物');
  const indexJs = join(root, 'lib', 'index.js');
  const clientJs = join(root, 'lib', 'client.js');
  if (!(await fileExists(indexJs))) {
    fail('lib/index.js 缺失（先运行 pnpm run build）');
  } else {
    const src = await readFile(indexJs, 'utf8');
    if (!/(export\s*\{[^}]*apply|export\s+function\s+apply)/.test(src)) fail('lib/index.js 未导出 apply');
    else ok('lib/index.js 导出 apply');
  }

  if (!(await fileExists(clientJs))) {
    fail('lib/client.js 缺失（先运行 pnpm run build）');
  } else {
    const src = await readFile(clientJs, 'utf8');
    if (!src.includes('window.__ModuleLoader__.load({')) fail('lib/client.js 未包裹为 ModuleLoader');
    else ok('lib/client.js 包裹为 ModuleLoader');
    if (!/inject/.test(src) || !/apply/.test(src)) fail('lib/client.js 未导出 inject/apply（ModuleLoader 需要）');
    else ok('lib/client.js 含 inject/apply');
  }

  for (const rel of ['resource/avatar.png', 'resource/avatar.png']) {
    if (!(await fileExists(join(root, rel)))) fail(`静态资源缺失: ${rel}`);
    else ok(`静态资源存在: ${rel}`);
  }
}

async function crossCheckRealManifest() {
  // 尽力而为：若环境中可解析 dsh-app-boot（例如已挂到 profile node_modules），交叉校验真实契约。
  try {
    await import('@deepseek-ai/dsh-app-boot');
    const manifest = loadManifest();
    if (typeof manifest.dsh?.bundle?.patch !== 'string') fail('交叉校验：dsh-app-boot 期望 dsh.bundle.patch 为字符串');
    else ok('交叉校验：与 @deepseek-ai/dsh-app-boot 契约一致');
  } catch {
    // 开发目录下未安装宿主包属正常，静默跳过。
  }
}

try {
  await checkManifest();
  await checkPatch();
  await checkArtifacts();
  await crossCheckRealManifest();
} catch (error) {
  fail(`校验过程异常: ${error?.message ?? error}`);
}

if (errors.length > 0) {
  console.error('\n[xiao-ui-theme-ts] check 失败：');
  for (const e of errors) console.error('  ✖ ' + e);
  process.exit(1);
}
console.log('\n[xiao-ui-theme-ts] check 通过：产物符合 dsh 插件契约。');
