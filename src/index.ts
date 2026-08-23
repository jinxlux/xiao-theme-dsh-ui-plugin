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
import type { VoiceLanguage, XiaoConfig } from './config';
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
  backgroundBlur: 22,
  backgroundOpacity: 0.5,
  backgroundDarkOpacity: 0.5,
};
const HOST_RANGES = {
  backgroundBlur: { min: 0, max: 60 },
  backgroundOpacity: { min: 0.3, max: 1 },
  backgroundDarkOpacity: { min: 0.3, max: 1 },
} as const;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** 读取配置；文件缺失或损坏时回落默认值（逐字段校验 + 补默认）。 */
async function readConfig(): Promise<XiaoConfig> {
  let parsed: Record<string, unknown> = {};
  try {
    const text = await readFile(CONFIG_PATH, 'utf8');
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
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
    backgroundBlur: clamp(
      parsed.backgroundBlur,
      HOST_RANGES.backgroundBlur.min,
      HOST_RANGES.backgroundBlur.max,
      HOST_DEFAULT_CONFIG.backgroundBlur,
    ),
    backgroundOpacity: clamp(
      parsed.backgroundOpacity,
      HOST_RANGES.backgroundOpacity.min,
      HOST_RANGES.backgroundOpacity.max,
      HOST_DEFAULT_CONFIG.backgroundOpacity,
    ),
    backgroundDarkOpacity: clamp(
      parsed.backgroundDarkOpacity,
      HOST_RANGES.backgroundDarkOpacity.min,
      HOST_RANGES.backgroundDarkOpacity.max,
      HOST_DEFAULT_CONFIG.backgroundDarkOpacity,
    ),
  };
}

/** 原子写回配置（确保目录存在）。 */
async function writeConfig(next: XiaoConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
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
    backgroundBlur:
      clampNum(body.backgroundBlur, HOST_RANGES.backgroundBlur.min, HOST_RANGES.backgroundBlur.max) ??
      current.backgroundBlur,
    backgroundOpacity:
      clampNum(body.backgroundOpacity, HOST_RANGES.backgroundOpacity.min, HOST_RANGES.backgroundOpacity.max) ??
      current.backgroundOpacity,
    backgroundDarkOpacity:
      clampNum(body.backgroundDarkOpacity, HOST_RANGES.backgroundDarkOpacity.min, HOST_RANGES.backgroundDarkOpacity.max) ??
      current.backgroundDarkOpacity,
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
                sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
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
                  sendJson(response, 400, { error: 'empty upload' });
                  return;
                }
                await mkdir(UPLOAD_DIR, { recursive: true });
                const filePath = join(UPLOAD_DIR, `bg-${Date.now()}${ext}`);
                await writeFile(filePath, body);
                sendJson(response, 200, { imagePath: filePath.replace(/\\/g, '/') });
              } catch (error) {
                sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
              }
            };
            await doUpload(req, res);
          },
        }),
      'xiao-theme: upload route',
    );
  });
}

export default { apply };
