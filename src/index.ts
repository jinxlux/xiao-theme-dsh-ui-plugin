/**
 * 魈主题 —— Host 半：自管配置、魈式语气（多语言 / 自定义文本）、头像与磨砂背景静态路由、背景图上传。
 * 静态部署插件（dsh bundle），随 DSH 进程启动加载。
 * 配置存于 ~/.dsh/xiao-theme.json，经 HTTP 路由读写，改动即时生效（无需重启）。
 *
 * TypeScript 实现：逻辑与 xiao-ui-theme 保持一致，但界面经 `host.types` 强类型约束，编译期即可暴露接口笔误。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VoiceLanguage, XiaoConfig, ThemeSummary, ThemeListResponse, ThemeActivateResponse, ThemeExport } from './config';
import type { HostCtx, WebRouteHandler } from './host.types';

const CONFIG_PATH = join(homedir(), '.dsh', 'xiao-theme.json');
const UPLOAD_DIR = join(homedir(), '.dsh', 'xiao-theme-uploads');
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)); // 插件根目录（lib 的上一级）
const MAX_UPLOAD = 20 * 1024 * 1024;

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
  backgroundBlur: 22,
  panelOpacity: 0.5,
  sidebarOpacity: 0.85,
  // 主题主色：默认魈的青玉绿。
  themeColor: '#2E8B72',
  mascotTitle: '靖妖傩舞',
  mascotSubtitle: '别挡路',
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

/** 读取原始二进制请求体（用于图片上传），限制大小。 */
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        reject(new Error('file too large (max 20MB)'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
  fileTooLarge: { zh: '文件过大（最大 20MB）', en: 'File too large (max 20MB)' },
} as const;

/** 抛出型错误：已知的转成对应语言文案（如文件过大），系统错误原样保留。 */
function requestError(req: IncomingMessage, error: unknown): string {
  const lang = langFromReq(req);
  const msg = error instanceof Error ? error.message : String(error);
  if (msg === 'file too large (max 20MB)') return HOST_ERR.fileTooLarge[lang];
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
  };
}

/** 解析上传扩展名：优先 header `x-xiao-ext`，其次 query `?ext=`，最后 `.png`。 */
function resolveUploadExt(req: IncomingMessage): string {
  let ext = '.png';
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const queryExt = (url.searchParams.get('ext') || '').toLowerCase();
    if (/^\.(png|jpe?g|webp|gif|svg)$/.test(queryExt)) ext = queryExt.replace('jpeg', 'jpg');
  } catch {
    /* 忽略非法 URL */
  }
  const headerExt = String(req.headers['x-xiao-ext'] || '').toLowerCase();
  if (/^\.(png|jpe?g|webp|gif|svg)$/.test(headerExt)) ext = headerExt.replace('jpeg', 'jpg');
  return ext;
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

/** 读取请求 query 参数（?name=xxx）。 */
function queryParam(req: IncomingMessage, name: string): string | null {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    return url.searchParams.get(name);
  } catch {
    return null;
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

  // 2) 配置路由 + 静态资源路由 + 上传路由
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
          handler: async (_req, res) => {
            const config = await readConfig();
            if (!config.enabled || config.backgroundEnabled === false) {
              res.writeHead(404);
              res.end();
              return;
            }
            const filePath = resolveAssetPath(config.backgroundImagePath);
            try {
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
                const ext = resolveUploadExt(request);
                const body = await readRawBody(request);
                if (body.length === 0) {
                  sendJson(response, 400, { error: HOST_ERR.emptyUpload[langFromReq(request)] });
                  return;
                }
                await mkdir(UPLOAD_DIR, { recursive: true });
                const filePath = join(UPLOAD_DIR, `bg-${Date.now()}${ext}`);
                await writeFile(filePath, body);
                // 自动检测：是否为动态 GIF（多帧动画）。GIF 动图 => dynamic=true；静态图/单帧 GIF => false。
                const dynamic = isAnimatedGif(body);
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

    // —— 主题管理 API：列出 / 新建 / 切换 / 重命名 / 删除 / 导出 / 导入 ——
    // 切换当前主题会改变当前配置，需同步重刷提示词（走系统提示注册表，不能被 /settings POST 覆盖才刷新）。
    const syncVoiceNow = async (): Promise<void> => {
      if (syncVoice !== null) {
        try {
          await syncVoice();
        } catch (error) {
          console.error('[xiao-theme] voice sync failed:', error);
        }
      }
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
