/**
 * 魈主题 —— Host 半：自管配置、魈式语气（多语言 / 自定义文本）、头像与磨砂背景静态路由、背景图上传。
 * 静态部署插件（dsh bundle），随 DSH 进程启动加载。
 * 配置存于 ~/.dsh/xiao-theme.json，经 HTTP 路由读写，改动即时生效（无需重启）。
 *
 * TypeScript 实现：逻辑与 xiao-ui-theme 保持一致，但界面经 `host.types` 强类型约束，编译期即可暴露接口笔误。
 */
import { readFile, writeFile, mkdir, unlink, rmdir, stat, readdir } from 'node:fs/promises';
import { createWriteStream, createReadStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, basename, extname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VoiceLanguage, XiaoConfig, ThemeSummary, ThemeListResponse, ThemeActivateResponse, ThemeExport, UploadEntry, UploadListResponse } from './config';
import type { HostCtx, WebRouteHandler } from './host.types';

/**
 * DSH 用户数据根目录。DSH 的解析优先级是「composition 里显式配置 > $DSH_HOME > ~/.dsh」
 * （见 @deepseek-ai/dsh-home-paths 的 resolveDshHome）；插件看不到宿主的显式配置，
 * 因此对齐用户级覆盖，并**逐条复刻它的处理顺序**，否则会和 DSH 解析到不同目录：
 *   1) $DSH_HOME 非空优先（空 / 全空白按未设置，避免解析到 cwd），否则 ~/.dsh；
 *   2) 展开前导 ~、~/、~\（只处理裸 ~ 与当前用户形式，~user 原样保留）；
 *   3) resolve() 规范化成绝对路径（相对值按 cwd 解析）。
 * 这里**不写死**任何机器路径——每台机器各自解析自己的家目录。
 */
const DSH_HOME: string = (() => {
  const fromEnv = (process.env.DSH_HOME ?? '').trim();
  const chosen = fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
  const expanded =
    chosen === '~'
      ? homedir()
      : chosen.startsWith('~/') || chosen.startsWith('~\\')
        ? join(homedir(), chosen.slice(2))
        : chosen;
  return resolve(expanded);
})();
/**
 * 插件私有数据（设置 / 上传）的落点，遵循 DSH 的单一数据根，但要向后兼容老位置：
 * - 新位置有数据 → 用新位置（$DSH_HOME 生效时优先，用户明确把 DSH 数据放到别处就该跟着走）；
 * - 否则老位置已有数据 → **继续用老位置**：老用户升级后设置与上传原地不动，不出现"全丢"的观感；
 * - 两者都没有（新用户，含一开始就设了 $DSH_HOME 的人）→ 用新位置，插件数据全部落在 DSH 数据根下
 *   （可备份、可随盘迁移，也不依赖家目录可写）。
 * ⚠️ 只在进程启动时判定一次：读与写必须是同一个目录，否则同一次运行里会出现"刚上传完列表却是空的"。
 */
const LEGACY_CONFIG_PATH = join(homedir(), '.dsh', 'xiao-theme.json');
const LEGACY_UPLOAD_DIR = join(homedir(), '.dsh', 'xiao-theme-uploads');
const ROOTED_CONFIG_PATH = join(DSH_HOME, 'xiao-theme.json');
const ROOTED_UPLOAD_DIR = join(DSH_HOME, 'xiao-theme-uploads');
const CONFIG_PATH =
  existsSync(ROOTED_CONFIG_PATH) || !existsSync(LEGACY_CONFIG_PATH) ? ROOTED_CONFIG_PATH : LEGACY_CONFIG_PATH;
const UPLOAD_DIR =
  existsSync(ROOTED_UPLOAD_DIR) || !existsSync(LEGACY_UPLOAD_DIR) ? ROOTED_UPLOAD_DIR : LEGACY_UPLOAD_DIR;
// 娱乐功能「角色空间」：本插件生成/维护的 DSH 用户级 agent preset。
// 这一处**必须**和 DSH 的解析结果一致（DSH 会去扫描这个根目录），所以跟随 $DSH_HOME。
const AGENT_PRESET_ROOT = join(DSH_HOME, '.agent-presets');
const ROLEPLAY_PRESET_ID = 'xiao-roleplay'; // 目录名，须匹配 [a-z0-9][a-z0-9-]*
const ROLEPLAY_PRESET_DIR = join(AGENT_PRESET_ROOT, ROLEPLAY_PRESET_ID);
const ROLEPLAY_PRESET_NAME = '角色空间（娱乐）'; // DSH 新会话选择器里显示的名字
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)); // 插件根目录（lib 的上一级）
const MAX_UPLOAD_AVATAR = 20 * 1024 * 1024; // 头像/图片保持原上限（<img>，无需大文件）
const MAX_UPLOAD_BG = 200 * 1024 * 1024; // 背景（含视频）放宽：流式落盘后内存不再是瓶颈
const UPLOAD_HEADER_BYTES = 16; // 流式时抓取的前 16 字节用于视频容器签名校验
const GIF_SCAN_MAX = 20 * 1024 * 1024; // 超过此大小的 GIF 不再逐字节扫描（视为动态），避免读取超大单帧 GIF 卡死

// Host 半保持自包含：运行时不依赖相对模块，以下默认值与范围常量以 `XiaoConfig` 类型约束（与 src/config.ts 保持一致）。
const HOST_DEFAULT_CONFIG: XiaoConfig = {
  enabled: true,
  voiceEnabled: true,
  // 相对插件根，随包分发；他人 clone / dsh add 后同样可读（跨机器不依赖本地绝对路径）。
  avatarPath: 'resource/avatar.png',
  voiceLanguage: 'en',
  voicePrompt: '',
  backgroundEnabled: true,
  backgroundImagePath: 'resource/avatar.png',
  backgroundDynamic: false,
  backgroundVideoAudio: false,
  backgroundBlur: 22,
  panelOpacity: 0.5,
  sidebarOpacity: 0.85,
  // 主题主色：默认魈的青玉绿。
  themeColor: '#2E8B72',
  mascotTitle: '靖妖傩舞',
  mascotSubtitle: '别挡路',
  // 角色空间：**默认关闭**（老用户升级不会凭空多出一个 agent preset，想用需自己打开）；
  // 空字符串 = 使用内置的英文默认角色（ROLEPLAY_PERSONA_DEFAULT）。
  roleplayEnabled: false,
  roleplayPersona: '',
};
const HOST_RANGES = {
  backgroundBlur: { min: 0, max: 60 },
  panelOpacity: { min: 0.3, max: 0.9 },
  sidebarOpacity: { min: 0, max: 1 },
} as const;
/** hex 主色合法性校验：#rgb / #rrggbb。 */
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 内置默认主题 id / 名称：不可删除，配置即默认设置。 */
const DEFAULT_THEME_ID = 'default';
const DEFAULT_THEME_NAME = '魈';

/** 主题持久化条目：一份完整配置 + 元信息。 */
interface ThemeEntry {
  name: string;
  builtin: boolean;
  /** 已规范化的配置（写回前经 normalizeConfig）。 */
  config: XiaoConfig;
}

/** 主题管理持久化形态（~/.dsh/xiao-theme.json）。 */
interface ThemeStore {
  activeThemeId: string;
  themes: Record<string, ThemeEntry>;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

/** 把任意配置对象规范化为合法 XiaoConfig（逐字段校验 + 兜底；含旧字段迁移 backgroundOpacity/… -> panelOpacity）。 */
function normalizeConfig(parsed: Record<string, unknown>): XiaoConfig {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  return {
    enabled: parsed.enabled !== false,
    voiceEnabled: parsed.voiceEnabled !== false,
    avatarPath:
      typeof parsed.avatarPath === 'string' && parsed.avatarPath.length > 0
        ? parsed.avatarPath
        : HOST_DEFAULT_CONFIG.avatarPath,
    voiceLanguage:
      parsed.voiceLanguage === 'zh'
        ? 'zh'
        : parsed.voiceLanguage === 'en'
          ? 'en'
          : HOST_DEFAULT_CONFIG.voiceLanguage,
    voicePrompt: typeof parsed.voicePrompt === 'string' ? parsed.voicePrompt : HOST_DEFAULT_CONFIG.voicePrompt,
    backgroundEnabled: parsed.backgroundEnabled !== false,
    backgroundImagePath:
      typeof parsed.backgroundImagePath === 'string' && parsed.backgroundImagePath.length > 0
        ? parsed.backgroundImagePath
        : HOST_DEFAULT_CONFIG.backgroundImagePath,
    backgroundDynamic: parsed.backgroundDynamic === true,
    backgroundVideoAudio: parsed.backgroundVideoAudio === true,
    backgroundBlur: clamp(
      parsed.backgroundBlur,
      HOST_RANGES.backgroundBlur.min,
      HOST_RANGES.backgroundBlur.max,
      HOST_DEFAULT_CONFIG.backgroundBlur,
    ),
    // panelOpacity：新字段优先；旧配置迁移（backgroundOpacity/backgroundDarkOpacity -> 取非 0.5 的那个，
    // 都没有或同为 0.5 则回默认）。封顶 0.9，保证背景图恒可见。
    panelOpacity: clamp(
      typeof parsed.panelOpacity === 'number'
        ? parsed.panelOpacity
        : typeof parsed.backgroundOpacity === 'number' && parsed.backgroundOpacity !== 0.5
          ? parsed.backgroundOpacity
          : typeof parsed.backgroundDarkOpacity === 'number' && parsed.backgroundDarkOpacity !== 0.5
            ? parsed.backgroundDarkOpacity
            : HOST_DEFAULT_CONFIG.panelOpacity,
      HOST_RANGES.panelOpacity.min,
      HOST_RANGES.panelOpacity.max,
      HOST_DEFAULT_CONFIG.panelOpacity,
    ),
    sidebarOpacity: clamp(
      typeof parsed.sidebarOpacity === 'number'
        ? parsed.sidebarOpacity
        : HOST_DEFAULT_CONFIG.sidebarOpacity,
      HOST_RANGES.sidebarOpacity.min,
      HOST_RANGES.sidebarOpacity.max,
      HOST_DEFAULT_CONFIG.sidebarOpacity,
    ),
    themeColor:
      typeof parsed.themeColor === 'string' && HEX_COLOR_RE.test(parsed.themeColor.trim())
        ? parsed.themeColor.trim()
        : HOST_DEFAULT_CONFIG.themeColor,
    mascotTitle:
      typeof parsed.mascotTitle === 'string' && parsed.mascotTitle.trim().length > 0
        ? parsed.mascotTitle
        : HOST_DEFAULT_CONFIG.mascotTitle,
    mascotSubtitle:
      typeof parsed.mascotSubtitle === 'string'
        ? parsed.mascotSubtitle
        : HOST_DEFAULT_CONFIG.mascotSubtitle,
    // 默认关闭：**缺失即 false**（旧配置没有这个字段 → 不安装预设），只有显式 true 才开启。
    roleplayEnabled: parsed.roleplayEnabled === true,
    roleplayPersona:
      typeof parsed.roleplayPersona === 'string' ? parsed.roleplayPersona : HOST_DEFAULT_CONFIG.roleplayPersona,
  };
}

/** 判断对象是否已是主题管理存储形态。 */
function isThemeStoreShape(value: unknown): value is ThemeStore {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.activeThemeId === 'string' &&
    o.themes !== null &&
    typeof o.themes === 'object' &&
    !Array.isArray(o.themes)
  );
}

/** 规整存储：确保 default 主题存在、activeThemeId 指向有效主题、各主题 config 规范化。 */
function coerceThemeStore(value: ThemeStore): ThemeStore {
  if (!value.themes[DEFAULT_THEME_ID]) {
    value.themes[DEFAULT_THEME_ID] = { name: DEFAULT_THEME_NAME, builtin: true, config: { ...HOST_DEFAULT_CONFIG } };
  }
  const def = value.themes[DEFAULT_THEME_ID]!;
  def.builtin = true;
  if (typeof def.name !== 'string' || def.name.trim().length === 0) def.name = DEFAULT_THEME_NAME;
  for (const key of Object.keys(value.themes)) {
    const entry = value.themes[key];
    if (entry && entry.config && typeof entry.config === 'object') {
      entry.config = normalizeConfig(entry.config as unknown as Record<string, unknown>);
    } else {
      value.themes[key] = {
        name: key === DEFAULT_THEME_ID ? DEFAULT_THEME_NAME : (entry && entry.name) || key,
        builtin: key === DEFAULT_THEME_ID,
        config: { ...HOST_DEFAULT_CONFIG },
      };
    }
  }
  if (!value.themes[value.activeThemeId]) value.activeThemeId = DEFAULT_THEME_ID;
  return value;
}

/** 读取主题存储：新格式直接规整；旧裸 XiaoConfig 自动迁移为默认主题。 */
async function readThemeStore(): Promise<ThemeStore> {
  let value: unknown;
  try {
    const text = await readFile(CONFIG_PATH, 'utf8');
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (isThemeStoreShape(value)) return coerceThemeStore(value);
  // 旧版单配置迁移：成为「魈」默认主题的配置。
  const raw =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    activeThemeId: DEFAULT_THEME_ID,
    themes: {
      [DEFAULT_THEME_ID]: { name: DEFAULT_THEME_NAME, builtin: true, config: normalizeConfig(raw) },
    },
  };
}

/** 原子写回主题存储（确保目录存在）。 */
async function writeThemeStore(store: ThemeStore): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/** 读取「当前主题」的配置（文件缺失或损坏时回落默认值）。 */
async function readConfig(): Promise<XiaoConfig> {
  const store = await readThemeStore();
  const entry = store.themes[store.activeThemeId]!;
  return normalizeConfig(entry.config as unknown as Record<string, unknown>);
}

/** 写回「当前主题」的配置（next 已经规范化）。 */
async function writeConfig(next: XiaoConfig): Promise<void> {
  const store = await readThemeStore();
  const entry = store.themes[store.activeThemeId];
  if (entry) entry.config = next;
  await writeThemeStore(store);
}

/** 读取并解析 JSON 请求体（空体返回空对象）。 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      try {
        resolve(raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * 把请求体流式写盘（不整块驻留内存），限制大小，并抓取文件头若干字节供容器校验。
 * 处理背压（写盘慢时暂停接收）、大小上限（超限中断）、错误与客户端中断（清理半成品文件）。
 * 成功 resolve { size, header }；失败 reject（调用方负责清理）。
 */
function streamUpload(
  req: IncomingMessage,
  filePath: string,
  maxBytes: number,
): Promise<{ size: number; header: Buffer }> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    let size = 0;
    let header = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onError);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.destroy();
      void unlink(filePath).catch(() => {});
      reject(err);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ size, header });
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (header.length < UPLOAD_HEADER_BYTES) {
        const need = UPLOAD_HEADER_BYTES - header.length;
        header = Buffer.concat([header, chunk.subarray(0, Math.min(need, chunk.length))]);
      }
      if (size > maxBytes) {
        req.destroy();
        fail(new Error('file too large (max ' + maxBytes + ')'));
        return;
      }
      if (!ws.write(chunk)) {
        req.pause();
        ws.once('drain', () => req.resume());
      }
    };
    const onEnd = (): void => {
      ws.end(succeed);
    };
    const onError = (err: Error): void => fail(err instanceof Error ? err : new Error('upload aborted'));
    const onClose = (): void => fail(new Error('upload aborted'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

/** 校验视频容器签名与扩展名是否匹配（防止把 .mkv 改名成 .mp4 等）。仅校验视频；图片保持宽松。 */
function videoFormatMatches(ext: string, header: Buffer): boolean {
  if (header.length < 12) return false;
  if (/^\.mp4$/i.test(ext)) return header.toString('latin1', 4, 8) === 'ftyp';
  if (/^\.mov$/i.test(ext) || /^\.m4v$/i.test(ext)) {
    return header.toString('latin1', 4, 8) === 'ftyp' || header.indexOf('moov') >= 0;
  }
  if (/^\.webm$/i.test(ext)) {
    return header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
  }
  return false;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(value));
}

/** 请求携带的 DSH 界面语言（x-xiao-lang 头）：zh / 其余按 en。 */
function langFromReq(req: IncomingMessage): 'zh' | 'en' {
  const h = String(req.headers['x-xiao-lang'] || '').toLowerCase();
  return h === 'zh' ? 'zh' : 'en';
}

/** Host 端已知用户可见错误的中英文文案。 */
const HOST_ERR = {
  themeNotFound: { zh: '未找到主题', en: 'Theme not found' },
  defaultNotDeletable: { zh: '默认主题不可删除', en: 'The default theme cannot be deleted' },
  configRequired: { zh: '导入数据缺少 config', en: 'Import data is missing config' },
  emptyUpload: { zh: '上传内容为空', en: 'Empty upload' },
  fileTooLarge: { zh: '文件过大', en: 'File too large' },
  unsupportedFormat: {
    zh: '不支持的文件格式（背景支持 png/jpg/webp/gif/svg/mp4/webm/mov/m4v；头像支持 png/jpg/webp/gif/svg）',
    en: 'Unsupported file format (bg: png/jpg/webp/gif/svg/mp4/webm/mov/m4v; avatar: png/jpg/webp/gif/svg)',
  },
  formatMismatch: { zh: '文件格式与扩展名不匹配', en: 'File format does not match its extension' },
  uploadAborted: { zh: '上传已中断', en: 'Upload aborted' },
} as const;

/** 抛出型错误：已知的转成对应语言文案（如文件过大），系统错误原样保留。 */
function requestError(req: IncomingMessage, error: unknown): string {
  const lang = langFromReq(req);
  const msg = error instanceof Error ? error.message : String(error);
  const sizeMatch = /file too large \(max (\d+)\)/.exec(msg);
  if (sizeMatch) {
    const mb = Math.max(1, Math.round(Number(sizeMatch[1]) / (1024 * 1024)));
    return lang === 'zh' ? `文件过大（最大 ${mb}MB）` : `File too large (max ${mb}MB)`;
  }
  if (msg === 'unsupported format') return HOST_ERR.unsupportedFormat[lang];
  if (msg === 'format mismatch') return HOST_ERR.formatMismatch[lang];
  if (msg === 'upload aborted') return HOST_ERR.uploadAborted[lang];
  return msg;
}

/**
 * 资源路径解析：绝对路径（Windows 盘符 / Unix 斜杠开头）原样使用；
 * 其余视为相对插件根的路径（如 resource/avatar.png）。
 */
function resolveAssetPath(pathValue: string): string {
  if (typeof pathValue !== 'string' || pathValue.length === 0) return HOST_DEFAULT_CONFIG.backgroundImagePath;
  if (/^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('/')) return pathValue;
  return join(PLUGIN_ROOT, pathValue.replace(/^[\\/]+/, '').replace(/\\/g, '/'));
}

function contentTypeFor(pathValue: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(pathValue);
  const ext = '.' + (match ? match[1]!.toLowerCase() : '');
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** 解析 HTTP Range 头（bytes=start-end / bytes=start- / bytes=-suffix）；非法或不可满足返回 null（按完整文件返回）。 */
function parseRange(range: string | undefined, size: number): { start: number; end: number } | null {
  if (!range || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  const startRaw = m[1]!;
  const endRaw = m[2]!;
  let start: number;
  let end: number;
  if (startRaw === '') {
    // 后缀范围 bytes=-N：最后 N 字节
    const n = Number(endRaw);
    if (!Number.isFinite(n) || n === 0) return null;
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  }
  if (start < 0 || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** 魈式语气提示文本（中文模板）。 */
const VOICE_ZH = [
  '【魈式语气】当前会话启用了“降魔大圣·魈”主题，请以魈的口吻说话——但仅限于语气，绝不改变任何实质内容！',
  '必须遵守：',
  '1. 语气拟魈：话少、冷淡、简洁，可以自称“我”；偶尔用“别挡路”“此地清净”“凡人”“除魔”“风”等意象；不拖泥带水，不用表情符号堆砌。',
  '2. 内容完全不变：回答的事实、准确性、步骤、代码、任务执行方式与正常时一模一样，不得因语气省略、含糊或降低专业性。',
  '3. 保持克制：语气痕迹自然穿插即可，不要每句都带，不要中二堆砌，不要影响可读性。',
  '4. 工具照常用：调用工具、执行命令、读写文件等行为与平时完全一致，语气不影响任何功能。',
].join('\n');

/** 魈式语气提示文本（英文模板）。 */
const VOICE_EN = [
  '[Theme] "Xiao the Vigilant Yaksha" (Genshin Impact) is enabled for this session. Speak in Xiao\'s tone — tone only, never change the substance of any answer.',
  'Must follow:',
  '1. Tone: terse, cold, concise; you may refer to yourself as "I"; occasionally weave in imagery like "out of my way", "this place is peaceful", "mortals", "demon-slaying", "the wind"; no rambling, no emoji pileups.',
  '2. Content stays identical: facts, accuracy, steps, code, and how tasks are executed remain exactly the same as usual; never omit, blur, or lower professionalism for the sake of tone.',
  '3. Stay restrained: let the tone appear naturally; don\'t force it into every sentence; don\'t overdo the flavor; keep output readable.',
  '4. Tools work as always: call tools, run commands, read/write files, etc. exactly as usual; the tone never affects any function.',
].join('\n');

/** 取实际注入的提示词：自定义文本优先，否则用所选语言的默认模板。 */
function voiceText(config: XiaoConfig): string {
  const custom = (config.voicePrompt || '').trim();
  if (custom.length > 0) return custom;
  return config.voiceLanguage === 'zh' ? VOICE_ZH : VOICE_EN;
}

// —— 娱乐功能「角色空间」：把角色 system prompt 同步为一个独立 agent preset ——

/**
 * 内置默认角色设定（英文，默认角色 = 魈）。config.roleplayPersona 为空时使用。
 * 只存在于 Host 半：Client 只需要「空 = 用默认」的语义与占位说明，避免两处长文本漂移。
 */
const ROLEPLAY_PERSONA_DEFAULT = [
  'You are Xiao, the Vigilant Yaksha — the only character in this session.',
  'This is an entertainment roleplay session, not a work assistant. Stay in character at all times.',
  '',
  '1. Voice: terse, cold, restrained. You may weave in imagery of wind, yakshas, demons and Liyue, but keep it readable — no rambling, no emoji spam.',
  '2. You have no tools: no file, command, network or task access. Never claim you ran, read, changed, verified or delivered anything.',
  '3. Never present invented content as verified fact. If asked about real code, data or events, answer in character and say plainly that it is in-character talk.',
  '4. Never impersonate a real person, and never claim real authority or credentials.',
  '5. Keep replies conversational and reasonably short; avoid walls of text.',
].join('\n');

/**
 * 把角色文本渲染成 YAML 字面块标量：逐行加固定缩进，行尾空白与控制字符剥掉。
 * 用显式缩进指示符（`|2-`）配合固定的 6 空格内容缩进，所以「首行缩进即块缩进」的自动探测
 * 不再生效：换行、冒号、引号、井号、前导空格都能原样保留，既不转义也不可能撑破 YAML。
 */
function yamlLiteralBlock(text: string, indent: string): string {
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return clean
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/[ \t]+$/, '');
      if (trimmed.length === 0) return '';
      // 前导 tab 转空格：YAML 块标量的缩进不接受 tab。
      return indent + trimmed.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, ' '));
    })
    .join('\n');
}

/** 生成的 agent.cordis.yml：persona 即完整 system prompt，且不挂任何工具（能力防火墙）。 */
function roleplayComposition(persona: string): string {
  return [
    '# Auto-generated by the xiao-ui-theme-ts plugin — do not hand-edit.',
    '#',
    '# The roleplay preset: the persona prefix IS the complete system prompt and no tools are',
    '# mounted, so a session composed from it can never read files or run commands. To change',
    '# the character, edit the role text in DSH Web -> Settings -> Xiao Theme -> Roleplay.',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    // |2-：显式缩进指示符（父级 4 空格 + 2 = 内容 6 空格），内容原样保留、结尾不留换行。
    '    prefix: |2-',
    yamlLiteralBlock(persona, '      '),
    '    complete: true',
    '    includeRuntimeContext: false',
    '',
  ].join('\n');
}

/** 生成的 preset.yml：DSH 新会话选择器里的显示名与说明。 */
function roleplayMetadata(): string {
  return [
    `name: '${ROLEPLAY_PRESET_NAME}'`,
    "description: '独立的角色扮演会话：完整角色设定，无文件/命令权限，不影响工作会话。Independent roleplay session: full character prompt, no file or command access.'",
    'order: 90',
    '',
  ].join('\n');
}

/** 内容不同才写文件：避免无谓改写 preset 的 mtime（DSH 以 mtime + size 判断是否需要重新挂载）。 */
async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  try {
    if ((await readFile(filePath, 'utf8')) === content) return false;
  } catch {
    /* 不存在 / 不可读：照常写入 */
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return true;
}

/**
 * 依据当前配置同步「角色空间」预设：
 * - 开：写入 / 更新 agent.cordis.yml + preset.yml（内容变化才重写）。
 * - 关：删除这两个文件，并尽量移除空目录（用 rmdir 而非递归删除，绝不误删用户放进该目录的东西）。
 * @returns 同步后是否处于「已安装」状态。
 */
async function syncRoleplayPreset(): Promise<boolean> {
  const config = await readConfig();
  // 生效条件 = 主题总开关开 + 角色开关显式 true；其余一律视为关闭并清掉预设
  // （缺失 / false / 总开关关闭都不会留下孤儿预设）。
  if (config.enabled === false || config.roleplayEnabled !== true) {
    await unlink(join(ROLEPLAY_PRESET_DIR, 'agent.cordis.yml')).catch(() => {});
    await unlink(join(ROLEPLAY_PRESET_DIR, 'preset.yml')).catch(() => {});
    await rmdir(ROLEPLAY_PRESET_DIR).catch(() => {});
    return false;
  }
  const custom = (config.roleplayPersona || '').trim();
  const persona = custom.length > 0 ? config.roleplayPersona : ROLEPLAY_PERSONA_DEFAULT;
  await writeIfChanged(join(ROLEPLAY_PRESET_DIR, 'agent.cordis.yml'), roleplayComposition(persona));
  await writeIfChanged(join(ROLEPLAY_PRESET_DIR, 'preset.yml'), roleplayMetadata());
  return true;
}

/** syncRoleplayPreset 的安全包装：失败只记日志，绝不影响配置读写与设置页。 */
async function syncRoleplaySafe(): Promise<boolean> {
  try {
    return await syncRoleplayPreset();
  } catch (error) {
    console.error('[xiao-theme] roleplay preset sync failed:', error);
    return false;
  }
}

/** 预设的两个文件是否都在（供设置页显示安装状态）。 */
async function roleplayInstalled(): Promise<boolean> {
  try {
    await stat(join(ROLEPLAY_PRESET_DIR, 'agent.cordis.yml'));
    await stat(join(ROLEPLAY_PRESET_DIR, 'preset.yml'));
    return true;
  } catch {
    return false;
  }
}

/** 写配置的 JSON body 合并（restoreDefaults 一键恢复默认）。 */
async function nextConfigFromBody(current: XiaoConfig, body: Record<string, unknown>): Promise<XiaoConfig> {
  if (body.restoreDefaults === true) return { ...HOST_DEFAULT_CONFIG };
  const clampNum = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
  const pickLanguage = (value: unknown): VoiceLanguage | null =>
    value === 'zh' ? 'zh' : value === 'en' ? 'en' : null;
  return {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    voiceEnabled: typeof body.voiceEnabled === 'boolean' ? body.voiceEnabled : current.voiceEnabled,
    avatarPath:
      typeof body.avatarPath === 'string' && body.avatarPath.length > 0
        ? body.avatarPath
        : current.avatarPath,
    voiceLanguage: pickLanguage(body.voiceLanguage) ?? current.voiceLanguage,
    voicePrompt: typeof body.voicePrompt === 'string' ? body.voicePrompt : current.voicePrompt,
    backgroundEnabled:
      typeof body.backgroundEnabled === 'boolean' ? body.backgroundEnabled : current.backgroundEnabled,
    backgroundImagePath:
      typeof body.backgroundImagePath === 'string' && body.backgroundImagePath.length > 0
        ? body.backgroundImagePath
        : current.backgroundImagePath,
    backgroundDynamic:
      typeof body.backgroundDynamic === 'boolean'
        ? body.backgroundDynamic
        : current.backgroundDynamic,
    backgroundVideoAudio:
      typeof body.backgroundVideoAudio === 'boolean'
        ? body.backgroundVideoAudio
        : current.backgroundVideoAudio,
    backgroundBlur:
      clampNum(body.backgroundBlur, HOST_RANGES.backgroundBlur.min, HOST_RANGES.backgroundBlur.max) ??
      current.backgroundBlur,
    panelOpacity:
      clampNum(body.panelOpacity, HOST_RANGES.panelOpacity.min, HOST_RANGES.panelOpacity.max) ??
      current.panelOpacity,
    sidebarOpacity:
      clampNum(body.sidebarOpacity, HOST_RANGES.sidebarOpacity.min, HOST_RANGES.sidebarOpacity.max) ??
      current.sidebarOpacity,
    themeColor:
      typeof body.themeColor === 'string' && HEX_COLOR_RE.test(body.themeColor.trim())
        ? body.themeColor.trim()
        : current.themeColor,
    mascotTitle:
      typeof body.mascotTitle === 'string' && body.mascotTitle.trim().length > 0
        ? body.mascotTitle
        : current.mascotTitle,
    mascotSubtitle:
      typeof body.mascotSubtitle === 'string'
        ? body.mascotSubtitle
        : current.mascotSubtitle,
    roleplayEnabled:
      typeof body.roleplayEnabled === 'boolean' ? body.roleplayEnabled : current.roleplayEnabled,
    roleplayPersona:
      typeof body.roleplayPersona === 'string' ? body.roleplayPersona : current.roleplayPersona,
  };
}

/** 背景上传允许的视频扩展名（头像上传仅允许图片，<img> 无法渲染视频）。 */
function allowedUploadExt(allowVideo: boolean): RegExp {
  return allowVideo
    ? /^\.(png|jpe?g|webp|gif|svg|mp4|webm|mov|m4v)$/
    : /^\.(png|jpe?g|webp|gif|svg)$/;
}

/** 读取客户端声明的上传扩展名（优先 query `?ext=`，其次 header `x-xiao-ext`）；未给则返回空串。 */
function requestedUploadExt(req: IncomingMessage): string {
  const norm = (raw: string): string => {
    const v = raw.toLowerCase().trim();
    if (v === '') return '';
    return v.startsWith('.') ? v : '.' + v;
  };
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const q = norm(url.searchParams.get('ext') || '');
    if (q !== '') return q;
  } catch {
    /* 忽略非法 URL */
  }
  return norm(String(req.headers['x-xiao-ext'] || ''));
}

/**
 * 判断上传内容是否为「动图 GIF」（多帧动画）。
 * 仅识别 GIF87a/GIF89a，并统计图形控制扩展（GCE，0x21 0xF9 0x04）数量：
 * 动图必然 ≥2 个（每帧一个），静态/单帧 GIF 至多 1 个；非 GIF 直接 false。
 */
function isAnimatedGif(buf: Buffer): boolean {
  if (buf.length < 6) return false;
  if (buf.toString('latin1', 0, 3) !== 'GIF') return false;
  let gce = 0;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) gce++;
    if (gce >= 2) return true;
  }
  return false;
}

/** 是否为视频扩展名（mp4/webm/mov/m4v）：视频背景一律视为动态背景。 */
function isVideoExtension(ext: string): boolean {
  return /^\.(mp4|webm|mov|m4v)$/i.test(ext || '');
}

/** 读取请求 query 参数（?name=xxx）。 */
function queryParam(req: IncomingMessage, name: string): string | null {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

/** 上传文件名里的用途前缀：bg- / avatar-。 */
function uploadKindFromName(name: string): 'bg' | 'avatar' {
  if (/^avatar-/i.test(name)) return 'avatar';
  return 'bg';
}

/** 扫主题存储，统计每个上传 blob 被哪些主题引用（供 picker 展示 used-by / active）。 */
function uploadUsedBy(store: ThemeStore): Map<string, { themes: string[]; active: boolean }> {
  const map = new Map<string, { themes: string[]; active: boolean }>();
  for (const [id, entry] of Object.entries(store.themes)) {
    const isActive = id === store.activeThemeId;
    const push = (pathValue: string | undefined): void => {
      if (typeof pathValue !== 'string' || pathValue.length === 0) return;
      const abs = resolveAssetPath(pathValue);
      const rel = relative(UPLOAD_DIR, abs);
      // 只认真正落在上传目录内的引用（本地绝对路径 / 插件相对目录不在此列）。
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return;
      const name = basename(abs);
      const rec = map.get(name) || { themes: [], active: false };
      if (rec.themes.indexOf(entry.name) < 0) rec.themes.push(entry.name);
      if (isActive) rec.active = true;
      map.set(name, rec);
    };
    push(entry.config.backgroundImagePath);
    push(entry.config.avatarPath);
  }
  return map;
}

/** 从磁盘读取并判断是否为动图 GIF（读取失败按静态处理）。 */
async function isAnimatedGifFile(filePath: string): Promise<boolean> {
  try {
    const buf = await readFile(filePath);
    return isAnimatedGif(buf);
  } catch {
    return false;
  }
}

/** 列出上传目录内的资产（可选按用途过滤），按 mtime 倒序。目录不存在/无文件返回空数组。 */
async function listUploads(kindFilter?: 'bg' | 'avatar'): Promise<UploadEntry[]> {
  let names: string[] = [];
  try {
    const dirents = await readdir(UPLOAD_DIR, { withFileTypes: true });
    names = dirents.filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
  const store = await readThemeStore();
  const refs = uploadUsedBy(store);
  const entries: UploadEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // 跳过隐藏/元数据
    const kind = uploadKindFromName(name);
    if (kindFilter !== undefined && kind !== kindFilter) continue;
    const filePath = join(UPLOAD_DIR, name);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    const ext = extname(name).toLowerCase() || '';
    let isDynamic = false;
    if (isVideoExtension(ext)) {
      isDynamic = true;
    } else if (ext === '.gif') {
      // 超大 GIF 不再逐字节判断（视为动态），避免读超大单帧 GIF 卡死；否则按真实动画检测。
      isDynamic = st.size > GIF_SCAN_MAX ? true : await isAnimatedGifFile(filePath);
    }
    const ref = refs.get(name);
    entries.push({
      name,
      kind,
      path: filePath.replace(/\\/g, '/'),
      size: st.size,
      mtime: st.mtimeMs,
      ext,
      isDynamic,
      usedBy: ref ? ref.themes : [],
      active: ref ? ref.active : false,
    });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

/** 用系统文件管理器打开目录。成功返回 true（spawn 立即返回，不代表窗口一定已打开）。 */
function openFolder(dir: string): boolean {
  const cmd =
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(cmd, [dir], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 生成唯一主题 id（时间戳 + 随机段）。 */
function newThemeId(): string {
  return 'theme-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffffff).toString(36);
}

/** 主题摘要（列表用）。 */
function summarizeTheme(entry: ThemeEntry, id: string, activeThemeId: string): ThemeSummary {
  return { id, name: entry.name, builtin: entry.builtin === true, active: id === activeThemeId };
}

/** 主题列表响应。 */
function themeList(store: ThemeStore): ThemeListResponse {
  return {
    activeThemeId: store.activeThemeId,
    themes: Object.keys(store.themes).map((id) => summarizeTheme(store.themes[id]!, id, store.activeThemeId)),
  };
}

/** 切到默认主题的兜底名（导入/新建用）。 */
function fallbackThemeName(store: ThemeStore, prefix: string): string {
  return prefix + ' ' + (Object.keys(store.themes).length + 1);
}

export function apply(ctx: HostCtx): void {
  // 1) 魈式语气：随配置 enabled + voiceEnabled 开/关，提示词内容（语言/自定义）变化时重建。
  let syncVoice: (() => Promise<void>) | null = null;
  ctx.inject(['systemPrompt'], (sub) => {
    let voiceDispose: (() => void) | null = null;
    syncVoice = async () => {
      const config = await readConfig();
      if (voiceDispose !== null) {
        voiceDispose();
        voiceDispose = null;
      }
      if (config.enabled && config.voiceEnabled !== false) {
        voiceDispose = sub.systemPrompt.section({
          name: 'xiao-voice',
          order: 1,
          text: voiceText(config),
        });
      }
    };
    void syncVoice();
    sub.effect(
      () => () => {
        if (voiceDispose !== null) {
          voiceDispose();
          voiceDispose = null;
        }
      },
      'xiao-theme: voice cleanup',
    );
  });

  // 2) 角色空间（娱乐）：默认关闭；「主题总开关 + 角色开关」同时开启时才把角色 system prompt
  //    同步为一个独立的 DSH agent preset，否则清掉该预设（老配置缺失字段 = 关闭，不会留下孤儿预设）。
  //    与工作会话完全隔离——只有「新会话主动选择该预设」才会进入角色，工作会话不受影响。
  void syncRoleplaySafe();

  // 3) 配置路由 + 静态资源路由 + 上传路由
  ctx.inject(['webServer'], (httpCtx) => {
    // 配置 API：GET /xiao-theme/settings 读，POST /xiao-theme/settings 写（restoreDefaults=true 一键恢复默认）
    httpCtx.effect(
      () =>
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/xiao-theme/settings',
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              sendJson(res, 200, await readConfig());
              return;
            }
            if (req.method === 'POST') {
              try {
                const body = await readJsonBody(req);
                const current = await readConfig();
                const next = await nextConfigFromBody(current, body);
                await writeConfig(next);
                if (syncVoice !== null) {
                  try {
                    await syncVoice();
                  } catch (error) {
                    console.error('[xiao-theme] voice sync failed:', error);
                  }
                }
                // 角色文本 / 开关变化：同步 agent preset（内容变化才重写文件）。
                await syncRoleplaySafe();
                sendJson(res, 200, next);
              } catch (error) {
                sendJson(res, 400, { error: requestError(req, error) });
              }
              return;
            }
            res.writeHead(405);
            res.end();
          },
        }),
      'xiao-theme: settings route',
    );

    // 头像路由：路径取自配置，enabled=false 时 404
    httpCtx.effect(
      () =>
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/xiao-avatar.png',
          handler: async (_req, res) => {
            const config = await readConfig();
            if (!config.enabled) {
              res.writeHead(404);
              res.end();
              return;
            }
            try {
              // 用 resolveAssetPath：支持相对插件根（resource/avatar.png，跨机器可读）或绝对路径。
              const filePath = resolveAssetPath(config.avatarPath);
              const body = await readFile(filePath);
              res.writeHead(200, {
                'content-type': contentTypeFor(filePath),
                'cache-control': 'no-cache',
              });
              res.end(body);
            } catch {
              res.writeHead(404);
              res.end();
            }
          },
        }),
      'xiao-theme: avatar route',
    );

    // 磨砂背景图路由：路径取自配置（支持相对插件根），enabled 或背景关闭时 404
    httpCtx.effect(
      () =>
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/xiao-bg',
          handler: async (req, res) => {
            const config = await readConfig();
            if (!config.enabled || config.backgroundEnabled === false) {
              res.writeHead(404);
              res.end();
              return;
            }
            const filePath = resolveAssetPath(config.backgroundImagePath);
            try {
              const st = await stat(filePath);
              // 视频/大文件支持 Range：浏览器可先播头部再流式续传、可拖动进度；不带 Range 时仍回完整文件（200）。
              const range = parseRange(req.headers.range, st.size);
              if (range) {
                const { start, end } = range;
                res.writeHead(206, {
                  'content-type': contentTypeFor(filePath),
                  'content-length': end - start + 1,
                  'content-range': 'bytes ' + start + '-' + end + '/' + st.size,
                  'accept-ranges': 'bytes',
                  'cache-control': 'no-cache',
                });
                createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
              } else {
                res.writeHead(200, {
                  'content-type': contentTypeFor(filePath),
                  'content-length': st.size,
                  'accept-ranges': 'bytes',
                  'cache-control': 'no-cache',
                });
                createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
              }
            } catch {
              res.writeHead(404);
              res.end();
            }
          },
        }),
      'xiao-theme: background route',
    );

    // 背景图上传：POST /xiao-theme/upload?ext=.png，raw body 为图片字节
    // 保存到 ~/.dsh/xiao-theme-uploads/，返回 { imagePath }，再由客户端写入配置
    httpCtx.effect(
      () =>
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/xiao-theme/upload',
          handler: async (req, res) => {
            const doUpload: WebRouteHandler = async (request: IncomingMessage, response: ServerResponse) => {
              if (request.method !== 'POST') {
                response.writeHead(405);
                response.end();
                return;
              }
              try {
                // kind 参数区分上传用途：背景图默认前缀 bg-；头像请求带 kind=avatar 用 avatar- 前缀。
                const kind = queryParam(request, 'kind') === 'avatar' ? 'avatar' : 'bg';
                const lang = langFromReq(request);
                // 校验扩展名：未给则默认 .png（兼容）；显式给出但不属于允许集合 => 明确报「不支持的文件格式」。
                const allowVideo = kind === 'bg';
                const allowed = allowedUploadExt(allowVideo);
                const requested = requestedUploadExt(request);
                let ext: string;
                if (requested === '') {
                  ext = '.png';
                } else if (allowed.test(requested)) {
                  ext = requested.replace('jpeg', 'jpg');
                } else {
                  sendJson(response, 400, { error: HOST_ERR.unsupportedFormat[lang] });
                  return;
                }
                // 头像仅允许图片：若头像请求声明的扩展名是视频，按不支持处理（<img> 无法渲染视频）。
                if (!allowVideo && isVideoExtension(ext)) {
                  sendJson(response, 400, { error: HOST_ERR.unsupportedFormat[lang] });
                  return;
                }
                await mkdir(UPLOAD_DIR, { recursive: true });
                const filePath = join(UPLOAD_DIR, `${kind}-${Date.now()}${ext}`);
                // 流式落盘：内存恒定，按 kind 分档上限（头像 20MB / 背景 200MB，含视频）。
                const maxBytes = kind === 'avatar' ? MAX_UPLOAD_AVATAR : MAX_UPLOAD_BG;
                const { size, header } = await streamUpload(request, filePath, maxBytes);
                if (size === 0) {
                  await unlink(filePath).catch(() => {});
                  sendJson(response, 400, { error: HOST_ERR.emptyUpload[lang] });
                  return;
                }
                // 视频容器签名校验：扩展名是视频但头不匹配（如把 .mkv 改名成 .mp4）=> 报「格式不匹配」。
                if (kind === 'bg' && isVideoExtension(ext) && !videoFormatMatches(ext, header)) {
                  await unlink(filePath).catch(() => {});
                  sendJson(response, 400, { error: HOST_ERR.formatMismatch[lang] });
                  return;
                }
                // 自动检测动态背景：视频 => true；动画 GIF => isAnimatedGif（从磁盘读取，GIF 体积小）；静态图/单帧 GIF => false。
                let dynamic = false;
                if (kind === 'bg') {
                  if (isVideoExtension(ext)) {
                    dynamic = true;
                  } else if (/^\.gif$/i.test(ext)) {
                    const gifBuf = await readFile(filePath);
                    dynamic = isAnimatedGif(gifBuf);
                  }
                }
                sendJson(response, 200, { imagePath: filePath.replace(/\\/g, '/'), dynamic });
              } catch (error) {
                sendJson(response, 400, { error: requestError(request, error) });
              }
            };
            await doUpload(req, res);
          },
        }),
      'xiao-theme: upload route',
    );

    // —— 上传资产管理：列表 + 预览文件 + 打开文件夹（供客户端「选择器弹窗」）——
    // 列出上传目录内的资产（可选 ?kind=bg|avatar 过滤），供选择器展示与复用。
    httpCtx.effect(
      () =>
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/xiao-theme/uploads',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405);
              res.end();
              return;
            }
            const kindParam = queryParam(req, 'kind');
            const kindFilter = kindParam === 'avatar' ? 'avatar' : kindParam === 'bg' ? 'bg' : undefined;
            const payload: UploadListResponse = { uploads: await listUploads(kindFilter) };
            sendJson(res, 200, payload);
          },
        }),
      'xiao-theme: upload list route',
    );

    // 上传文件预览：按名字读取某个已上传 blob（不受 enabled / 背景开关限制），带 Range（视频拖动）。
    httpCtx.effect(
      () =>
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/xiao-theme/uploads-file',
          handler: async (req, res) => {
            const name = queryParam(req, 'name') || '';
            const safeBase = basename(name);
            // 只允许纯文件名（无路径分隔 / .. / 空），杜绝路径穿越：basename 归一化后与原名不同即带路径成分。
            if (safeBase === '' || safeBase === '.' || safeBase === '..' || safeBase !== name) {
              res.writeHead(400);
              res.end();
              return;
            }
            const filePath = join(UPLOAD_DIR, safeBase);
            try {
              const st = await stat(filePath);
              const range = parseRange(req.headers.range, st.size);
              if (range) {
                const { start, end } = range;
                res.writeHead(206, {
                  'content-type': contentTypeFor(filePath),
                  'content-length': end - start + 1,
                  'content-range': 'bytes ' + start + '-' + end + '/' + st.size,
                  'accept-ranges': 'bytes',
                  'cache-control': 'no-cache',
                });
                createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
              } else {
                res.writeHead(200, {
                  'content-type': contentTypeFor(filePath),
                  'content-length': st.size,
                  'accept-ranges': 'bytes',
                  'cache-control': 'no-cache',
                });
                createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
              }
            } catch {
              res.writeHead(404);
              res.end();
            }
          },
        }),
      'xiao-theme: upload file route',
    );

    // 用系统文件管理器打开上传目录（本机动作；失败时返回 ok=false + path 供用户手动前往）。
    httpCtx.effect(
      () =>
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/xiao-theme/open-uploads',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405);
              res.end();
              return;
            }
            try {
              await mkdir(UPLOAD_DIR, { recursive: true });
              const ok = openFolder(UPLOAD_DIR);
              sendJson(res, 200, { ok, path: UPLOAD_DIR.replace(/\\/g, '/') });
            } catch {
              sendJson(res, 200, { ok: false, path: UPLOAD_DIR.replace(/\\/g, '/') });
            }
          },
        }),
      'xiao-theme: open uploads folder route',
    );

    // —— 角色空间（娱乐）：状态 / 重新应用 / 打开预设目录 ——
    // 状态只读：告诉设置页 preset 是否已安装、装在哪，供用户去新会话里选择它。
    httpCtx.effect(
      () => {
        const disposers: Array<() => void> = [];
        disposers.push(
          httpCtx.webServer.register({
            kind: 'exact',
            path: '/xiao-theme/roleplay',
            handler: async (req, res) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405);
                res.end();
                return;
              }
              const config = await readConfig();
              sendJson(res, 200, {
                presetId: ROLEPLAY_PRESET_ID,
                presetName: ROLEPLAY_PRESET_NAME,
                masterEnabled: config.enabled !== false,
                enabled: config.enabled !== false && config.roleplayEnabled === true,
                installed: await roleplayInstalled(),
                path: ROLEPLAY_PRESET_DIR.replace(/\\/g, '/'),
              });
            },
          }),
          // 重新应用：把当前角色文本重写成预设文件（用户手改过文件 / 想强制刷新时用）。
          httpCtx.webServer.register({
            kind: 'exact',
            path: '/xiao-theme/roleplay-apply',
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                res.writeHead(405);
                res.end();
                return;
              }
              try {
                const installed = await syncRoleplayPreset();
                sendJson(res, 200, { ok: true, installed });
              } catch (error) {
                sendJson(res, 400, { ok: false, error: requestError(req, error) });
              }
            },
          }),
          // 用系统文件管理器打开预设目录（本机动作；失败时返回 path 供用户手动前往）。
          httpCtx.webServer.register({
            kind: 'exact',
            path: '/xiao-theme/roleplay-open-folder',
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                res.writeHead(405);
                res.end();
                return;
              }
              try {
                // 生效状态先按当前配置落盘一次，未生效时只建目录，保证打开的目录一定存在。
                const config = await readConfig();
                if (config.enabled !== false && config.roleplayEnabled === true) await syncRoleplayPreset();
                else await mkdir(ROLEPLAY_PRESET_DIR, { recursive: true });
                const ok = openFolder(ROLEPLAY_PRESET_DIR);
                sendJson(res, 200, { ok, path: ROLEPLAY_PRESET_DIR.replace(/\\/g, '/') });
              } catch {
                sendJson(res, 200, { ok: false, path: ROLEPLAY_PRESET_DIR.replace(/\\/g, '/') });
              }
            },
          }),
        );
        return () => {
          for (const d of disposers) d();
        };
      },
      'xiao-theme: roleplay routes',
    );

    // —— 主题管理 API：列出 / 新建 / 切换 / 重命名 / 删除 / 导出 / 导入 ——
    // 切换当前主题会改变当前配置，需同步重刷提示词（走系统提示注册表，不能被 /settings POST 覆盖才刷新）
    // 以及「角色空间」预设（角色文本按主题各存一份）。
    const syncVoiceNow = async (): Promise<void> => {
      if (syncVoice !== null) {
        try {
          await syncVoice();
        } catch (error) {
          console.error('[xiao-theme] voice sync failed:', error);
        }
      }
      await syncRoleplaySafe();
    };

    const themeListCreateHandler: WebRouteHandler = async (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, themeList(await readThemeStore()));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const body = await readJsonBody(req);
        const name =
          typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : null;
        const store = await readThemeStore();
        const current = store.themes[store.activeThemeId];
        const id = newThemeId();
        store.themes[id] = {
          name: name ?? fallbackThemeName(store, '主题'),
          builtin: false,
          config: current ? { ...current.config } : { ...HOST_DEFAULT_CONFIG },
        };
        store.activeThemeId = id;
        await writeThemeStore(store);
        await syncVoiceNow();
        sendJson(res, 200, summarizeTheme(store.themes[id]!, id, store.activeThemeId));
      } catch (error) {
        sendJson(res, 400, { error: requestError(req, error) });
      }
    };

    const themeActivateHandler: WebRouteHandler = async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const store = await readThemeStore();
        if (!store.themes[id]) {
          sendJson(res, 400, { error: HOST_ERR.themeNotFound[langFromReq(req)] });
          return;
        }
        store.activeThemeId = id;
        await writeThemeStore(store);
        await syncVoiceNow();
        const payload: ThemeActivateResponse = {
          activeThemeId: store.activeThemeId,
          config: normalizeConfig(store.themes[id]!.config as unknown as Record<string, unknown>),
        };
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: requestError(req, error) });
      }
    };

    const themeRenameHandler: WebRouteHandler = async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const name =
          typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : null;
        const store = await readThemeStore();
        const entry = store.themes[id];
        if (!entry) {
          sendJson(res, 400, { error: HOST_ERR.themeNotFound[langFromReq(req)] });
          return;
        }
        if (name) entry.name = name;
        await writeThemeStore(store);
        sendJson(res, 200, summarizeTheme(entry, id, store.activeThemeId));
      } catch (error) {
        sendJson(res, 400, { error: requestError(req, error) });
      }
    };

    const themeDeleteHandler: WebRouteHandler = async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const store = await readThemeStore();
        const entry = store.themes[id];
        if (!entry) {
          sendJson(res, 400, { error: HOST_ERR.themeNotFound[langFromReq(req)] });
          return;
        }
        if (entry.builtin === true) {
          sendJson(res, 400, { error: HOST_ERR.defaultNotDeletable[langFromReq(req)] });
          return;
        }
        delete store.themes[id];
        if (store.activeThemeId === id) store.activeThemeId = DEFAULT_THEME_ID;
        await writeThemeStore(store);
        await syncVoiceNow();
        sendJson(res, 200, { activeThemeId: store.activeThemeId });
      } catch (error) {
        sendJson(res, 400, { error: requestError(req, error) });
      }
    };

    const themeExportHandler: WebRouteHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const id = queryParam(req, 'id') || DEFAULT_THEME_ID;
        const store = await readThemeStore();
        const entry = store.themes[id];
        if (!entry) {
          sendJson(res, 400, { error: HOST_ERR.themeNotFound[langFromReq(req)] });
          return;
        }
        const payload: ThemeExport = {
          framework: 'xiao-theme-ts',
          version: 1,
          name: entry.name,
          config: normalizeConfig(entry.config as unknown as Record<string, unknown>),
        };
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: requestError(req, error) });
      }
    };

    const themeImportHandler: WebRouteHandler = async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const body = await readJsonBody(req);
        const configRaw = body.config;
        if (configRaw === null || typeof configRaw !== 'object' || Array.isArray(configRaw)) {
          sendJson(res, 400, { error: HOST_ERR.configRequired[langFromReq(req)] });
          return;
        }
        const store = await readThemeStore();
        const name =
          typeof body.name === 'string' && body.name.trim().length > 0
            ? body.name.trim()
            : fallbackThemeName(store, '导入主题');
        const id = newThemeId();
        store.themes[id] = {
          name,
          builtin: false,
          config: normalizeConfig(configRaw as Record<string, unknown>),
        };
        await writeThemeStore(store);
        sendJson(res, 200, summarizeTheme(store.themes[id]!, id, store.activeThemeId));
      } catch (error) {
        sendJson(res, 400, { error: requestError(req, error) });
      }
    };

    httpCtx.effect(
      () => {
        const disposers: Array<() => void> = [];
        disposers.push(
          httpCtx.webServer.register({ kind: 'exact', path: '/xiao-theme/themes', handler: themeListCreateHandler }),
          httpCtx.webServer.register({ kind: 'exact', path: '/xiao-theme/themes-activate', handler: themeActivateHandler }),
          httpCtx.webServer.register({ kind: 'exact', path: '/xiao-theme/themes-rename', handler: themeRenameHandler }),
          httpCtx.webServer.register({ kind: 'exact', path: '/xiao-theme/themes-delete', handler: themeDeleteHandler }),
          httpCtx.webServer.register({ kind: 'exact', path: '/xiao-theme/themes-export', handler: themeExportHandler }),
          httpCtx.webServer.register({ kind: 'exact', path: '/xiao-theme/themes-import', handler: themeImportHandler }),
        );
        return () => {
          for (const d of disposers) d();
        };
      },
      'xiao-theme: theme management routes',
    );
  });
}

export default { apply };
