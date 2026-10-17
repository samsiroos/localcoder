'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const changeHistory = new Map();
const runningApps = new Map();
let browserSession;
let visibleBrowserSession;
const browserPages = new Map();
const previewServers = new Map();
const browserProfiles = {
  desktop: { width: 1440, height: 900, isMobile: false },
  tablet: { width: 768, height: 1024, isMobile: true },
  mobile: { width: 390, height: 844, isMobile: true }
};

function makeChange(filePath, before, after, kind) {
  const beforeLines = before ? before.split(/\r?\n/) : [];
  const afterLines = after ? after.split(/\r?\n/) : [];
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix++;
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const preview = [
    ...removed.slice(0, 80).map(line => `- ${line}`),
    ...added.slice(0, 80).map(line => `+ ${line}`)
  ];
  if (removed.length + added.length > 160) preview.push('… diff preview truncated; open the full diff to inspect everything');
  const change = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    path: filePath, kind, before, after,
    removed: removed.length, added: added.length,
    preview: preview.join('\n') || '(no textual difference)'
  };
  changeHistory.set(change.id, change);
  return change;
}

class SnapshotProvider {
  provideTextDocumentContent(uri) {
    const id = uri.path.split('/').filter(Boolean)[0];
    const change = changeHistory.get(id);
    if (!change) return 'Snapshot is no longer available.';
    return uri.scheme === 'localcoder-before' ? change.before : change.after;
  }
}

function snapshotUri(scheme, change) {
  return vscode.Uri.from({ scheme, path: `/${change.id}/${path.basename(change.path)}` });
}

const AGENT_PROMPT = `You are LocalCoder, an autonomous coding agent inside VS Code.
You may inspect and change the open workspace using tools. Be concise and preserve existing code.
For requests involving one or more workspace files, discover the concrete paths with list_files or search, read every existing target, and then write the complete updated content to each real path. Do not merely print proposed file content in chat. Preserve unrelated content and report only filesystem operations confirmed by tool results.
Before changing, renaming, or deleting an existing file, you MUST call read_file for that exact path during the current request.
write_file always replaces the whole file, so its content must contain the complete final file. The tools insert and append do not exist.
Paths shown in tool documentation are examples. Never use literal placeholders such as relative/path, path/to/file, or optional/relative/directory. Choose a concrete filename based on the user's request.
Before implementing a feature, inspect the relevant entry file and package/configuration files to determine whether the code runs in a browser, Node.js, or another runtime. Browser JavaScript cannot use Node.js modules such as fs. Do not claim that a browser can write an arbitrary local file; use a user-initiated download, browser storage, or an actual backend as appropriate.
When you need a tool, respond with ONLY one valid JSON object. Do not use Markdown fences and do not add explanation:
{"tool":"read_file","path":"relative/path"}
{"tool":"list_files","path":"relative/directory"}
{"tool":"search","query":"text","path":"optional/relative/directory"}
{"tool":"write_file","path":"relative/path","content":"complete new file content"}
{"tool":"delete_file","path":"relative/path"}
{"tool":"rename_file","path":"current/relative/path","newPath":"new/relative/path"}
{"tool":"start_app","runtime":"node|python|dotnet","entry":"relative/path","args":[]}
{"tool":"stop_app","processId":12345}
{"tool":"project_command","ecosystem":"dotnet|node|react|docker","action":"run|build|publish","path":"relative/project/directory","args":[]}
{"tool":"open_url","url":"https://example.com"}
{"tool":"open_local_file","path":"profile.html"}
{"tool":"browser_screenshot","url":"https://example.com","profile":"desktop|tablet|mobile","fullPage":true}
{"tool":"browser_inspect","url":"https://example.com","selector":"optional CSS selector"}
{"tool":"browser_action","url":"https://example.com","action":"click|fill|hover","selector":"CSS selector","value":"text for fill"}
{"tool":"browser_set_css","url":"https://example.com","selector":"CSS selector","css":"color: red; display: block"}
{"tool":"http_request","method":"GET|POST|PUT|PATCH|PUSH|DELETE","url":"https://api.example.com/items","headers":{"content-type":"application/json"},"body":"optional request body"}
{"tool":"download_file","url":"https://example.com/file.zip","path":"downloads/file.zip"}
For create/edit operations, prefer this delimiter format because code does not need JSON escaping:
<write_file path="relative/path">
complete file content
</write_file>
For reading, this XML form is also accepted: <read_file path="relative/path"/>
When the task is complete, answer normally with a brief summary. Never print the labels "Tool call:" or "Tool result:" and never invent tool results or claim a file changed unless a real tool result confirmed it.`;

let activeApiUrl = '';
function apiUrls() {
  const configured = vscode.workspace.getConfiguration('localcoder').get('apiUrl', 'http://127.0.0.1:11436').replace(/\/$/, '');
  return [...new Set([activeApiUrl, configured, 'http://127.0.0.1:11436'].filter(Boolean))];
}
async function api(route, options = {}) {
  let lastError;
  const { timeoutMs, signal, ...fetchOptions } = options;
  const requestTimeout = timeoutMs ?? (route === '/api/chat' ? 300000 : 5000);
  for (const base of apiUrls()) {
    try {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout);
      const response = await fetch(base + route, { ...fetchOptions, headers: { 'content-type': 'application/json', ...(fetchOptions.headers || {}) }, signal: requestSignal });
      const text = await response.text(); let data;
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      activeApiUrl = base;
      return data;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error?.name === 'TimeoutError'
        ? new Error(`Local model request timed out after ${Math.round(requestTimeout / 1000)} seconds`)
        : error;
    }
  }
  throw lastError || new Error('LocalCoder API is unavailable');
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function findAppRoot(context) {
  const configured = vscode.workspace.getConfiguration('localcoder').get('appPath', '').trim();
  const candidates = [
    configured,
    path.resolve(context.extensionPath, '..'),
    ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath)
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(path.join(candidate, 'server', 'index.js'))) return candidate;
  throw new Error('Cannot find LocalCoder server. Set localcoder.appPath to the LocalCoder folder.');
}
async function ensureLocalCoder(context) {
  let status;
  try { status = await api('/api/status'); } catch { /* start the bundled service */ }
  if (!status) {
    const root = await findAppRoot(context);
    const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
      cwd: root, detached: true, windowsHide: true, stdio: 'ignore'
    });
    child.unref();
  }
  for (let i = 0; i < 45; i++) {
    try {
      status = await api('/api/status');
      if (status.ready) return status;
      if (!status.running) {
        try { await api('/api/model/load', { method: 'POST', body: '{}' }); }
        catch (error) { if (!String(error.message).includes('already running')) throw error; }
      }
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (status) return status;
  throw new Error('LocalCoder did not start. Check that Node.js is installed and localcoder.appPath is correct.');
}
function workspaceRoot() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a workspace folder first');
  return folder.uri.fsPath;
}
function safePath(relative = '.') {
  const root = workspaceRoot();
  const result = path.resolve(root, relative);
  const rel = path.relative(root, result);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the workspace');
  return result;
}
function safeSkillName(name) {
  const clean = String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!clean) throw new Error('Skill name is required');
  return clean;
}
function explicitOpenUrl(text) {
  if (!/\b(?:open|browse|visit|navigate)\b/i.test(text)) return '';
  const match = /https?:\/\/[^\s<>"'`]+/i.exec(text);
  return match ? match[0].replace(/[),.;!?]+$/, '') : '';
}
function requestedScreenshotProfile(text) {
  if (!/\b(?:screen\s*shot|capture)\b/i.test(text)) return '';
  if (/\bmobile\b/i.test(text)) return 'mobile';
  if (/\btablet\b/i.test(text)) return 'tablet';
  return 'desktop';
}
function requestedBackgroundColor(text) {
  const match = /\bbackground(?:\s+color)?(?:\s+to)?\s+(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)\b/i.exec(text);
  return match ? match[1] : '';
}
function isPlaceholderPath(value) {
  return /^(?:relative\/path|path\/to\/(?:file|directory)|optional\/relative\/directory)$/i.test(String(value || '').replace(/\\/g, '/'));
}
function inferredCreatePath(request, content) {
  const explicit = /(?:^|\s)([a-zA-Z0-9_.-]+\.(?:html?|css|jsx?|tsx?|json|md|txt|xml|ya?ml|py|cs|java|go|rs|php|sql))(?:\s|$)/i.exec(request);
  if (explicit) return explicit[1];
  if (/\bprofile\b/i.test(request) && /\bhtml?\b/i.test(request)) return 'profile.html';
  if (/\b(?:home\s?page|landing\s?page)\b/i.test(request) && /\bhtml?\b/i.test(request)) return 'index.html';
  if (/\bhtml?\b/i.test(request) || /^\s*<!doctype html/i.test(String(content || ''))) return 'index.html';
  return '';
}
function requestedLocalBrowserFile(text) {
  if (!/\bopen\b/i.test(text) || !/\b(?:local|internal)\s+browser\b/i.test(text)) return '';
  const match = /(?:^|\s)([a-zA-Z0-9_./\\-]+\.(?:html?|svg|xml|txt|json))(?:\s|$)/i.exec(text);
  return match ? match[1].replace(/\\/g, '/') : '';
}
function generatedFileContent(request, answer) {
  if (!/\b(?:create|make|add|generate|update|edit|modify|change|use|apply)\b/i.test(request)) return '';
  if (!inferredCreatePath(request, answer)) return '';
  const blocks = [...String(answer || '').matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)].map(match => match[1].replace(/\r?\n$/, ''));
  return blocks.sort((left, right) => right.length - left.length)[0] || '';
}
async function openMarkdown(file, initialContent) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!(await exists(file))) await fs.writeFile(file, initialContent, 'utf8');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: false });
}
async function markdownFiles(directory) {
  try { return (await fs.readdir(directory)).filter(name => name.toLowerCase().endsWith('.md')).sort(); }
  catch { return []; }
}
const SUPPORTED_TOOLS = ['read_file', 'list_files', 'search', 'write_file', 'delete_file', 'rename_file', 'start_app', 'stop_app', 'project_command', 'open_url', 'open_local_file', 'browser_screenshot', 'browser_inspect', 'browser_action', 'browser_set_css', 'http_request', 'download_file'];

function parseTool(text) {
  const raw = String(text).trim();
  const simpleXml = /<(read_file|list_files|delete_file|rename_file|open_url|open_local_file|browser_screenshot|browser_inspect|browser_action|browser_set_css|download_file)\s+([^>]*)\s*\/?>/i.exec(raw);
  if (simpleXml) {
    const tool = simpleXml[1].toLowerCase();
    const attributes = {}; for (const match of simpleXml[2].matchAll(/(\w+)=(['"])(.*?)\2/g)) attributes[match[1]] = match[3];
    if (attributes.path || attributes.newPath || attributes.url) return { tool, ...(attributes.path ? { path: attributes.path } : {}), ...(attributes.newPath ? { newPath: attributes.newPath } : {}), ...(attributes.url ? { url: attributes.url } : {}) };
  }
  const searchXml = /<search\s+query=(['"])(.*?)\1(?:\s+path=(['"])(.*?)\3)?\s*\/?>/i.exec(raw);
  if (searchXml) return { tool: 'search', query: searchXml[2], ...(searchXml[4] ? { path: searchXml[4] } : {}) };
  const block = /<write_file\s+path=(['"])(.*?)\1\s*>([\s\S]*?)<\/write_file>/i.exec(raw);
  if (block) return { tool: 'write_file', path: block[2], content: block[3].replace(/^\r?\n|\r?\n$/g, '') };
  const candidates = [raw];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    for (const version of [candidate, repairJson(candidate)]) {
      try {
        const value = JSON.parse(version);
        if (value && typeof value === 'object' && typeof value.tool === 'string') return value;
      } catch { /* try the next representation */ }
    }
  }
  return parseLooseTool(raw);
}
function repairJson(text) {
  let result = ''; let inString = false; let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!inString) {
      if (char === '"') inString = true;
      result += char;
      continue;
    }
    if (escaped) { result += char; escaped = false; continue; }
    if (char === '\\') {
      const next = text[i + 1];
      if ('"\\/bfnrtu'.includes(next || '')) { result += char; escaped = true; }
      else result += '\\\\';
      continue;
    }
    if (char === '"') { inString = false; result += char; continue; }
    if (char === '\n') { result += '\\n'; continue; }
    if (char === '\r') { result += '\\r'; continue; }
    if (char === '\t') { result += '\\t'; continue; }
    result += char;
  }
  return result.replace(/,\s*([}\]])/g, '$1');
}
function looseString(text, key) {
  const start = new RegExp(`["']${key}["']\\s*:\\s*(["'\\x60])`, 'i').exec(text);
  if (!start) return undefined;
  const quote = start[1]; const offset = start.index + start[0].length;
  let value = ''; let escaped = false;
  for (let i = offset; i < text.length; i++) {
    const char = text[i];
    if (escaped) { value += `\\${char}`; escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === quote && /^\s*(?:,|})/.test(text.slice(i + 1))) {
      try { return JSON.parse(`"${repairJson(value).replace(/"/g, '\\"')}"`); }
      catch { return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
    }
    value += char;
  }
  return undefined;
}
function parseLooseTool(text) {
  const tool = looseString(text, 'tool') || /["']tool["']\s*:\s*["']([^"']+)["']/i.exec(text)?.[1];
  if (!tool || !SUPPORTED_TOOLS.includes(tool)) return null;
  const value = { tool };
  for (const key of ['path', 'query', 'content', 'newPath', 'url', 'method', 'action', 'runtime', 'entry', 'selector', 'value', 'css', 'ecosystem', 'body', 'profile', 'args']) {
    const field = looseString(text, key);
    if (field !== undefined) value[key] = field;
  }
  if (tool === 'write_file' && value.content === undefined) {
    const marker = /["']content["']\s*:\s*["'`]/i.exec(text);
    const finalBrace = text.lastIndexOf('}');
    const finalQuote = text.lastIndexOf('"', finalBrace);
    if (marker && finalQuote >= marker.index + marker[0].length) {
      value.content = decodeLooseString(text.slice(marker.index + marker[0].length, finalQuote));
    }
  }
  if (tool === 'write_file' && (typeof value.path !== 'string' || typeof value.content !== 'string')) return null;
  if (tool === 'rename_file' && (typeof value.path !== 'string' || typeof value.newPath !== 'string')) return null;
  return value;
}
function decodeLooseString(value) {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
function resemblesToolCall(text) {
  return /["']tool["']\s*:\s*["'][^"']+["']/i.test(String(text)) || /\bTool (?:call|result):/i.test(String(text)) || /<(?:read_file|list_files|search|write_file|delete_file)\b/i.test(String(text));
}
function fabricatedToolTranscript(text) {
  const value = String(text);
  return /\bTool (?:call|result):/i.test(value) || /["']tool["']\s*:\s*["'](?:insert|append|replace|edit_file)["']/i.test(value);
}
function fitChatMessages(messages, maxCharacters = 8000) {
  const systems = messages.filter(message => message.role === 'system');
  const primarySystem = String(systems[0]?.content || '').slice(0, 3500);
  const extraSystem = systems.slice(1).map(message => String(message.content || '')).join('\n\n').slice(0, 2500);
  const result = [{ role: 'system', content: primarySystem }];
  if (extraSystem) result.push({ role: 'system', content: extraSystem });
  let remaining = Math.max(1200, maxCharacters - primarySystem.length - extraSystem.length);
  const selected = [];
  const conversation = messages.filter(message => message.role !== 'system');
  for (let index = conversation.length - 1; index >= 0 && remaining > 0; index--) {
    const message = conversation[index];
    let content = String(message.content || '');
    // Tool requests can contain an entire file and consume the small local model's
    // context. Its verified result is retained in the following user message.
    if (message.role === 'assistant' && resemblesToolCall(content)) continue;
    if (content.length > Math.min(3000, remaining)) content = content.slice(0, Math.min(3000, remaining)) + '\n[truncated]';
    if (content.length > remaining && selected.length) break;
    selected.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return [...result, ...selected];
}
async function collectFiles(dir, root, result, limit = 500) {
  if (result.length >= limit) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (result.length >= limit) break;
    if (['.git', 'node_modules', 'dist', 'bin', 'obj'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectFiles(full, root, result, limit); else result.push(path.relative(root, full));
  }
}
async function approve(label) {
  if (vscode.workspace.getConfiguration('localcoder').get('agent.autoApproveEdits', false)) return true;
  return (await vscode.window.showWarningMessage(label, { modal: true }, 'Apply')) === 'Apply';
}
async function automatedPage(url, profile = 'desktop', visible = false) {
  const viewport = browserProfiles[profile] || browserProfiles.desktop;
  let activeBrowser = visible ? visibleBrowserSession : browserSession;
  if (!activeBrowser) {
    const candidates = process.platform === 'win32'
      ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
      : undefined;
    const executablePath = candidates?.find(candidate => require('fs').existsSync(candidate));
    activeBrowser = await chromium.launch({ headless: !visible, ...(executablePath ? { executablePath } : {}) });
    if (visible) visibleBrowserSession = activeBrowser; else browserSession = activeBrowser;
  }
  const key = `${visible ? 'visible' : 'headless'}:${profile}:${url}`;
  const existing = browserPages.get(key);
  if (existing && !existing.page.isClosed()) return { ...existing, viewport };
  const context = await activeBrowser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  browserPages.set(key, { page, context });
  return { page, context, viewport };
}
async function waitForPageReady(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all([...document.images].map(image => {
      if (image.complete) return image.decode?.().catch(() => {});
      return new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 10000);
      }).then(() => image.decode?.().catch(() => {}));
    }));
  });
  await page.waitForTimeout(500);
}
async function runCurl(args, maximumOutput = 100000) {
  return new Promise(resolve => {
    const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    let stdoutLength = 0; let stderrLength = 0;
    child.stdout.on('data', data => { if (stdoutLength < maximumOutput) { stdout.push(data); stdoutLength += data.length; } });
    child.stderr.on('data', data => { if (stderrLength < 20000) { stderr.push(data); stderrLength += data.length; } });
    child.once('error', error => resolve({ error }));
    child.once('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8').slice(0, maximumOutput), stderr: Buffer.concat(stderr).toString('utf8').slice(0, 20000) }));
  });
}
async function workspacePreviewUrl(root, relativePath) {
  let preview = previewServers.get(root);
  if (!preview) {
    const token = crypto.randomBytes(18).toString('hex');
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        const prefix = `/${token}/`;
        if (!requestUrl.pathname.startsWith(prefix)) { response.writeHead(404); response.end('Not found'); return; }
        const relative = decodeURIComponent(requestUrl.pathname.slice(prefix.length));
        let target = path.resolve(root, relative);
        const boundary = path.relative(root, target);
        if (boundary.startsWith('..') || path.isAbsolute(boundary)) { response.writeHead(403); response.end('Forbidden'); return; }
        let stat = await fs.stat(target);
        if (stat.isDirectory()) { target = path.join(target, 'index.html'); stat = await fs.stat(target); }
        if (!stat.isFile()) { response.writeHead(404); response.end('Not found'); return; }
        response.writeHead(200, { 'content-type': contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        fsSync.createReadStream(target).pipe(response);
      } catch { response.writeHead(404); response.end('Not found'); }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    preview = { server, token, port: server.address().port };
    previewServers.set(root, preview);
  }
  const encodedPath = relativePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  return `http://127.0.0.1:${preview.port}/${preview.token}/${encodedPath}`;
}
async function runTool(call, onChange = () => {}, readPaths = new Set()) {
  const root = workspaceRoot();
  if (call.tool === 'read_file') {
    const target = safePath(call.path);
    const content = (await fs.readFile(target, 'utf8')).slice(0, 80000);
    readPaths.add(path.relative(root, target).toLowerCase());
    return content;
  }
  if (call.tool === 'list_files') {
    const files = []; await collectFiles(safePath(call.path || '.'), root, files); return files.join('\n');
  }
  if (call.tool === 'search') {
    const files = []; await collectFiles(safePath(call.path || '.'), root, files);
    const hits = [];
    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(root, file), 'utf8');
        content.split(/\r?\n/).forEach((line, i) => { if (line.toLowerCase().includes(String(call.query).toLowerCase()) && hits.length < 200) hits.push(`${file}:${i + 1}: ${line.trim()}`); });
      } catch { /* binary/unreadable */ }
    }
    return hits.join('\n') || 'No matches';
  }
  if (call.tool === 'write_file') {
    if (isPlaceholderPath(call.path)) return `Tool error: Refused placeholder file path: ${call.path}`;
    const target = safePath(call.path);
    const uri = vscode.Uri.file(target); let old = ''; let existed = true;
    try { old = await fs.readFile(target, 'utf8'); } catch { existed = false; }
    const relativeTarget = path.relative(root, target).toLowerCase();
    if (existed && !readPaths.has(relativeTarget)) return `Tool error: Existing file ${call.path} must be read first. Call read_file for exactly ${call.path}, then retry with its complete updated content.`;
    const next = String(call.content || '');
    if (next.includes('\u0000')) return `Tool error: Refused to write binary content through the text-file tool: ${call.path}`;
    if (existed && old === next) return `No change: ${call.path} already contains exactly the requested content.`;
    if (existed && old.trim() && !next.trim()) return `Tool error: Refused to replace non-empty ${call.path} with empty content.`;
    if (!(await approve(`LocalCoder wants to write ${call.path}`))) return 'User denied the edit';
    await fs.mkdir(path.dirname(target), { recursive: true });
    await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
    onChange(makeChange(call.path, old, next, existed ? 'edited' : 'created'));
    return `Verified filesystem operation: ${existed ? 'Edited existing file' : 'Created new file'} ${call.path}`;
  }
  if (call.tool === 'delete_file') {
    if (isPlaceholderPath(call.path)) return `Tool error: Refused placeholder file path: ${call.path}`;
    const target = safePath(call.path);
    const relativeTarget = path.relative(root, target).toLowerCase();
    if (!readPaths.has(relativeTarget)) return `Tool error: Existing file ${call.path} must be read first. Call read_file for exactly ${call.path}, then retry deletion.`;
    if (!(await approve(`LocalCoder wants to delete ${call.path}`))) return 'User denied deletion';
    const old = await fs.readFile(target, 'utf8');
    await vscode.workspace.fs.delete(vscode.Uri.file(target), { useTrash: true });
    onChange(makeChange(call.path, old, '', 'removed'));
    return `Verified filesystem operation: Removed existing file ${call.path} (moved to trash)`;
  }
  if (call.tool === 'rename_file') {
    if (isPlaceholderPath(call.path) || isPlaceholderPath(call.newPath)) return `Tool error: Refused placeholder rename path: ${call.path} -> ${call.newPath}`;
    const source = safePath(call.path);
    const destination = safePath(call.newPath);
    const relativeSource = path.relative(root, source).toLowerCase();
    if (!readPaths.has(relativeSource)) return `Tool error: Existing file ${call.path} must be read first. Call read_file for exactly ${call.path}, then retry the rename.`;
    if (!(await exists(source))) return `Tool error: Source file does not exist: ${call.path}`;
    if (await exists(destination)) return `Tool error: Destination already exists: ${call.newPath}`;
    const old = await fs.readFile(source, 'utf8');
    if (!(await approve(`LocalCoder wants to rename ${call.path} to ${call.newPath}`))) return 'User denied the rename';
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await vscode.workspace.fs.rename(vscode.Uri.file(source), vscode.Uri.file(destination), { overwrite: false });
    onChange(makeChange(call.path, old, '', 'removed'));
    onChange(makeChange(call.newPath, '', old, 'created'));
    return `Verified filesystem operation: Renamed ${call.path} to ${call.newPath}`;
  }
  if (call.tool === 'start_app') {
    const executables = { node: 'node', python: 'python', dotnet: 'dotnet' };
    const runtime = String(call.runtime || '').toLowerCase();
    if (!executables[runtime]) return 'Tool error: runtime must be node, python, or dotnet.';
    const entry = safePath(call.entry);
    if (!(await exists(entry))) return `Tool error: Entry file does not exist: ${call.entry}`;
    const args = Array.isArray(call.args) ? call.args.map(value => String(value)) : [];
    const approved = vscode.workspace.getConfiguration('localcoder').get('agent.autoApproveRuns', false)
      || (await vscode.window.showWarningMessage(`LocalCoder wants to start: ${runtime} ${call.entry} ${args.join(' ')}`.trim(), { modal: true }, 'Start')) === 'Start';
    if (!approved) return 'User denied starting the application.';
    const runtimeArgs = runtime === 'dotnet' && /\.csproj$/i.test(entry) ? ['run', '--project', entry, '--', ...args] : [entry, ...args];
    const child = spawn(executables[runtime], runtimeArgs, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    const capture = data => { output.push(String(data)); if (output.join('').length > 12000) output.shift(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 750);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode !== null) return `Tool error: Application exited with code ${child.exitCode}.\n${output.join('').slice(-8000)}`;
    runningApps.set(child.pid, { child, runtime, entry: call.entry, output });
    child.once('exit', () => runningApps.delete(child.pid));
    return `Started ${runtime} application ${call.entry}. Process ID: ${child.pid}.\n${output.join('').slice(-4000)}`;
  }
  if (call.tool === 'project_command') {
    const ecosystem = String(call.ecosystem || '').toLowerCase();
    const action = String(call.action || '').toLowerCase();
    const projectDirectory = safePath(call.path || '.');
    const stat = await fs.stat(projectDirectory).catch(() => null);
    if (!stat?.isDirectory()) return `Tool error: Project directory does not exist: ${call.path || '.'}`;
    const extraArgs = Array.isArray(call.args) ? call.args.map(value => String(value)) : [];
    if (!['dotnet', 'node', 'react', 'docker'].includes(ecosystem) || !['run', 'build', 'publish'].includes(action)) return 'Tool error: ecosystem must be dotnet, node, react, or docker and action must be run, build, or publish.';
    if (ecosystem === 'docker' && action === 'publish' && !extraArgs.length) return 'Tool error: Docker publish requires an image tag in args, for example ["registry.example.com/team/app:1.0.0"].';
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let executable; let commandArgs;
    if (ecosystem === 'dotnet') [executable, commandArgs] = ['dotnet', [action, ...extraArgs]];
    if (ecosystem === 'node' || ecosystem === 'react') {
      const defaultScript = ecosystem === 'react' ? 'dev' : 'start';
      [executable, commandArgs] = action === 'run'
        ? [npm, ['run', extraArgs.shift() || defaultScript, ...extraArgs]]
        : action === 'build' ? [npm, ['run', 'build', ...extraArgs]] : [npm, ['publish', ...extraArgs]];
    }
    if (ecosystem === 'docker') {
      [executable, commandArgs] = action === 'run'
        ? ['docker', ['compose', 'up', ...extraArgs]]
        : action === 'build' ? ['docker', ['build', '.', ...extraArgs]] : ['docker', ['push', ...extraArgs]];
    }
    const displayPath = path.relative(root, projectDirectory) || '.';
    const displayCommand = `${executable} ${commandArgs.join(' ')}`.trim();
    const approved = vscode.workspace.getConfiguration('localcoder').get('agent.autoApproveRuns', false)
      || (await vscode.window.showWarningMessage(`LocalCoder wants to ${action} ${ecosystem} project ${displayPath}: ${displayCommand}`, { modal: true }, 'Run')) === 'Run';
    if (!approved) return `User denied project command: ${displayCommand}`;
    const child = spawn(executable, commandArgs, { cwd: projectDirectory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    const capture = data => { output.push(String(data)); if (output.join('').length > 40000) output.shift(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    if (action === 'run') {
      const started = await new Promise(resolve => {
        const timer = setTimeout(() => resolve({ running: true }), 1000);
        child.once('error', error => { clearTimeout(timer); resolve({ error }); });
        child.once('exit', code => { clearTimeout(timer); resolve({ code }); });
      });
      if (started.error) return `Tool error: Could not start ${displayCommand}: ${started.error.message}`;
      if (!started.running) return `Tool error: ${displayCommand} exited with code ${started.code}.\n${output.join('').slice(-8000)}`;
      runningApps.set(child.pid, { child, runtime: ecosystem, entry: displayPath, output });
      child.once('exit', () => runningApps.delete(child.pid));
      return `Started ${displayCommand}. Process ID: ${child.pid}.\n${output.join('').slice(-4000)}`;
    }
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', code => resolve({ code, output: output.join('').slice(-30000) }));
    });
    if (result.error) return `Tool error: Could not start ${displayCommand}: ${result.error.message}`;
    return `${displayCommand} exited with code ${result.code}.\n${result.output || '(no output)'}`;
  }
  if (call.tool === 'open_url') {
    let target;
    try { target = new URL(String(call.url || '')); }
    catch { return `Tool error: Invalid URL: ${call.url || '(empty)'}`; }
    if (!['http:', 'https:'].includes(target.protocol)) return 'Tool error: Only HTTP and HTTPS URLs can be opened.';
    const approved = (await vscode.window.showWarningMessage(`LocalCoder wants to open this address in VS Code's internal browser:\n${target.href}`, { modal: true }, 'Open')) === 'Open';
    if (!approved) return `User denied opening ${target.href}`;
    await vscode.commands.executeCommand('simpleBrowser.show', target.href);
    return `Opened ${target.href} in VS Code's internal browser.`;
  }
  if (call.tool === 'open_local_file') {
    if (isPlaceholderPath(call.path)) return `Tool error: Refused placeholder local file path: ${call.path}`;
    const target = safePath(call.path);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) return `Tool error: Workspace file does not exist: ${call.path}`;
    const relative = path.relative(root, target);
    const previewUrl = await workspacePreviewUrl(root, relative);
    await vscode.commands.executeCommand('simpleBrowser.show', previewUrl);
    return `Opened verified workspace file ${relative} in VS Code's internal browser at ${previewUrl}`;
  }
  if (['browser_screenshot', 'browser_inspect', 'browser_action', 'browser_set_css'].includes(call.tool)) {
    let target;
    try { target = new URL(String(call.url || '')); }
    catch { return `Tool error: Invalid URL: ${call.url || '(empty)'}`; }
    if (!['http:', 'https:'].includes(target.protocol)) return 'Tool error: Browser automation supports only HTTP and HTTPS URLs.';
    const profile = String(call.profile || 'desktop').toLowerCase();
    if (!browserProfiles[profile]) return 'Tool error: profile must be desktop, tablet, or mobile.';
    const mutating = call.tool === 'browser_action' || call.tool === 'browser_set_css';
    if (mutating) {
      const description = call.tool === 'browser_set_css'
        ? `change CSS for ${call.selector} on ${target.href}`
        : `${call.action} ${call.selector} on ${target.href}`;
      const approved = (await vscode.window.showWarningMessage(`LocalCoder wants to ${description}`, { modal: true }, 'Allow')) === 'Allow';
      if (!approved) return `User denied browser operation: ${description}`;
    }
    const { page, context, viewport } = await automatedPage(target.href, profile, call.visible === true);
    try {
      if (call.tool === 'browser_screenshot') {
        await waitForPageReady(page);
        const directory = safePath('.localcoder/screenshots');
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `${Date.now()}-${profile}.png`);
        await page.screenshot({ path: file, fullPage: call.fullPage !== false });
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
        return `Captured ${profile} screenshot at ${path.relative(root, file)} (${viewport.width}x${viewport.height}).`;
      }
      const selector = String(call.selector || 'body');
      if (call.tool === 'browser_inspect') {
        const elements = await page.locator(selector).evaluateAll(nodes => nodes.slice(0, 100).map((node, index) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return { index, tag: node.tagName.toLowerCase(), id: node.id || undefined, classes: [...node.classList].slice(0, 8), text: (node.innerText || node.textContent || '').trim().slice(0, 240), attributes: Object.fromEntries([...node.attributes].slice(0, 12).map(attribute => [attribute.name, attribute.value])), box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, css: { display: style.display, position: style.position, color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize } };
        }));
        return JSON.stringify(elements, null, 2);
      }
      if (call.tool === 'browser_set_css') {
        const count = await page.locator(selector).count();
        if (!count) return `Tool error: No elements matched ${selector}`;
        await page.locator(selector).evaluateAll((nodes, css) => nodes.forEach(node => { node.style.cssText += `;${css}`; }), String(call.css || ''));
        const computed = await page.locator(selector).first().evaluate(node => ({ backgroundColor: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
        return `Applied temporary CSS to ${count} element(s) matching ${selector}. Verified computed styles: ${JSON.stringify(computed)}. The change remains available for later inspection or screenshots in this session.`;
      }
      const action = String(call.action || '').toLowerCase();
      const locator = page.locator(selector).first();
      if (action === 'click') await locator.click();
      else if (action === 'fill') await locator.fill(String(call.value || ''));
      else if (action === 'hover') await locator.hover();
      else return 'Tool error: browser_action action must be click, fill, or hover.';
      return `Completed browser ${action} on ${selector}. Current URL: ${page.url()}`;
    } catch (error) { return `Tool error: Browser operation failed: ${error.message}`; }
  }
  if (call.tool === 'http_request') {
    let target;
    try { target = new URL(String(call.url || '')); }
    catch { return `Tool error: Invalid URL: ${call.url || '(empty)'}`; }
    if (!['http:', 'https:'].includes(target.protocol)) return 'Tool error: REST requests support only HTTP and HTTPS URLs.';
    const method = String(call.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'PUSH', 'DELETE'].includes(method)) return 'Tool error: method must be GET, POST, PUT, PATCH, PUSH, or DELETE.';
    if (method !== 'GET') {
      const approved = (await vscode.window.showWarningMessage(`LocalCoder wants to send ${method} ${target.href}`, { modal: true, detail: 'This request can change data on the remote service.' }, 'Send request')) === 'Send request';
      if (!approved) return `User denied ${method} request to ${target.href}`;
    }
    const args = ['--silent', '--show-error', '--location', '--include', '--max-time', '60', '--request', method];
    const headers = call.headers && typeof call.headers === 'object' && !Array.isArray(call.headers) ? call.headers : {};
    for (const [name, value] of Object.entries(headers)) args.push('--header', `${name}: ${String(value)}`);
    if (call.body !== undefined && call.body !== null) args.push('--data-binary', typeof call.body === 'string' ? call.body : JSON.stringify(call.body));
    args.push(target.href);
    const result = await runCurl(args);
    if (result.error) return `Tool error: Could not start curl: ${result.error.message}`;
    return `curl ${method} ${target.href} exited with code ${result.code}.\n${result.stdout}${result.stderr ? `\nStandard error:\n${result.stderr}` : ''}`;
  }
  if (call.tool === 'download_file') {
    let target;
    try { target = new URL(String(call.url || '')); }
    catch { return `Tool error: Invalid URL: ${call.url || '(empty)'}`; }
    if (!['http:', 'https:'].includes(target.protocol)) return 'Tool error: Downloads support only HTTP and HTTPS URLs.';
    if (isPlaceholderPath(call.path)) return `Tool error: Refused placeholder download path: ${call.path}`;
    const destination = safePath(call.path);
    const relativeDestination = path.relative(root, destination);
    const approved = (await vscode.window.showWarningMessage(`LocalCoder wants to download ${target.href}`, { modal: true, detail: `The file will be saved as ${relativeDestination}. An existing file will be replaced.` }, 'Download')) === 'Download';
    if (!approved) return `User denied downloading ${target.href}`;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.localcoder-download-${process.pid}-${Date.now()}.tmp`);
    const result = await runCurl(['--silent', '--show-error', '--location', '--fail', '--max-time', '300', '--output', temporary, target.href], 1000);
    if (result.error) return `Tool error: Could not start curl: ${result.error.message}`;
    if (result.code !== 0) {
      await fs.unlink(temporary).catch(() => {});
      return `Tool error: Download failed with curl exit code ${result.code}.\n${result.stderr}`;
    }
    await fs.copyFile(temporary, destination);
    await fs.unlink(temporary).catch(() => {});
    const stat = await fs.stat(destination);
    return `Downloaded ${target.href} to ${relativeDestination} (${stat.size} bytes).`;
  }
  if (call.tool === 'stop_app') {
    const processId = Number(call.processId);
    const running = runningApps.get(processId);
    if (!running) return `Tool error: Process ${call.processId} is not a running application started by LocalCoder in this VS Code session.`;
    const approved = vscode.workspace.getConfiguration('localcoder').get('agent.autoApproveRuns', false)
      || (await vscode.window.showWarningMessage(`LocalCoder wants to stop process ${processId} (${running.runtime} ${running.entry})`, { modal: true }, 'Stop')) === 'Stop';
    if (!approved) return 'User denied stopping the application.';
    running.child.kill();
    runningApps.delete(processId);
    return `Stopped process ${processId} (${running.runtime} ${running.entry}).`;
  }
  return `Unknown tool: ${call.tool}`;
}

class ChatProvider {
  constructor(context) {
    this.context = context;
    this.storageKey = 'localcoder.conversation.v1';
    this.saveChain = Promise.resolve();
    this.output = vscode.window.createOutputChannel('LocalCoder');
    context.subscriptions.push(this.output);
    const saved = context.workspaceState.get(this.storageKey, {});
    this.history = Array.isArray(saved.history) && saved.history.length ? saved.history : [{ role: 'system', content: AGENT_PROMPT }];
    this.events = Array.isArray(saved.events) ? saved.events : [];
    for (const event of this.events) if (event.type === 'change' && event.change?.id) changeHistory.set(event.change.id, event.change);
  }
  resolveWebviewView(view) {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = html(view.webview, mediaRoot, this.context.extension.packageJSON.version);
    view.webview.onDidReceiveMessage(message => this.receive(message));
  }
  post(value) { this.view?.webview.postMessage(value); }
  emit(event) {
    this.events.push(event);
    if (this.events.length > 200) this.events = this.events.slice(-200);
    this.post(event);
    this.persist();
  }
  persist() {
    if (this.history.length > 100) this.history = [this.history[0], ...this.history.slice(-99)];
    const snapshot = { history: this.history, events: this.events };
    this.saveChain = this.saveChain.then(() => this.context.workspaceState.update(this.storageKey, snapshot));
    return this.saveChain;
  }
  async refreshStatus(autoStart = false) {
    this.post({ type: 'status', value: { starting: true } });
    try { this.post({ type: 'status', value: autoStart ? await ensureLocalCoder(this.context) : await api('/api/status') }); }
    catch (e) { this.post({ type: 'status', value: { ready: false, error: e.message } }); }
  }
  async receive(message) {
    try {
      if (message.type === 'ready') {
        this.post({ type: 'restore', events: this.events });
        await this.refreshStatus(true);
      }
      if (message.type === 'send') await this.agent(String(message.text || ''));
      if (message.type === 'stop') this.currentController?.abort();
      if (message.type === 'copy') await vscode.env.clipboard.writeText(String(message.text || ''));
      if (message.type === 'manageSkills') await this.manageSkills();
      if (message.type === 'clear') {
        const confirmation = await vscode.window.showWarningMessage(
          'Clear the saved LocalCoder conversation for this workspace?',
          { modal: true, detail: 'Messages, tool activity, and stored diff snapshots for this workspace will be removed.' },
          'Clear conversation'
        );
        if (confirmation !== 'Clear conversation') return;
        for (const event of this.events) if (event.type === 'change' && event.change?.id) changeHistory.delete(event.change.id);
        this.history = [{ role: 'system', content: AGENT_PROMPT }];
        this.events = [];
        await this.saveChain;
        await this.context.workspaceState.update(this.storageKey, undefined);
        this.post({ type: 'cleared' });
      }
      if (message.type === 'refresh') await this.refreshStatus(true);
      if (message.type === 'openHomepage') await vscode.commands.executeCommand('simpleBrowser.show', 'https://pwaapps.com');
      if (message.type === 'openDiff') await this.openDiff(String(message.id || ''));
    } catch (e) { this.emit({ type: 'error', text: e.message }); }
  }
  async openDiff(id) {
    const change = changeHistory.get(id);
    if (!change) throw new Error('This change snapshot is no longer available');
    await vscode.commands.executeCommand(
      'vscode.diff',
      snapshotUri('localcoder-before', change),
      snapshotUri('localcoder-after', change),
      `LocalCoder: ${change.path} (before ↔ after)`,
      { preview: true }
    );
  }
  async manageSkills(action) {
    const selected = action || await vscode.window.showQuickPick([
      { label: 'Edit project details', value: 'project' },
      { label: 'Add workspace skill', value: 'workspace-add' },
      { label: 'Edit workspace skill', value: 'workspace-edit' },
      { label: 'Add global skill', value: 'global-add' },
      { label: 'Edit global skill', value: 'global-edit' }
    ], { title: 'LocalCoder skills', placeHolder: 'Choose what to manage' });
    const value = typeof selected === 'string' ? selected : selected?.value;
    if (!value) return;
    const root = workspaceRoot();
    if (value === 'project') {
      return openMarkdown(path.join(root, '.localcoder', 'project.md'), '# Project details\n\nDescribe the architecture, commands, conventions, constraints, and goals for this workspace.\n');
    }
    const global = value.startsWith('global-');
    const directory = global
      ? path.join(await findAppRoot(this.context), '.localcoder', 'global-skills')
      : path.join(root, '.localcoder', 'skills');
    let name;
    if (value.endsWith('-add')) {
      const entered = await vscode.window.showInputBox({ title: `New ${global ? 'global' : 'workspace'} skill`, prompt: 'Skill name', placeHolder: 'testing-rules' });
      if (entered === undefined) return;
      name = safeSkillName(entered);
    } else {
      const files = await markdownFiles(directory);
      if (!files.length) throw new Error(`No ${global ? 'global' : 'workspace'} skills exist yet`);
      const picked = await vscode.window.showQuickPick(files, { title: `Edit ${global ? 'global' : 'workspace'} skill` });
      if (!picked) return;
      name = picked.slice(0, -3);
    }
    return openMarkdown(path.join(directory, `${name}.md`), `# ${name}\n\nDescribe the instructions LocalCoder should follow.\n`);
  }
  async messagesForRequest() {
    const messages = [...this.history];
    const root = workspaceRoot();
    const contextParts = [];
    const bundledSkillsDirectory = path.join(this.context.extensionPath, 'skills');
    for (const file of await markdownFiles(bundledSkillsDirectory)) {
      const content = await fs.readFile(path.join(bundledSkillsDirectory, file), 'utf8');
      contextParts.push(`## Built-in global skill: ${file.slice(0, -3)}\n${content}`);
    }
    try {
      const globalSkillsDirectory = path.join(await findAppRoot(this.context), '.localcoder', 'global-skills');
      for (const file of await markdownFiles(globalSkillsDirectory)) {
        const content = await fs.readFile(path.join(globalSkillsDirectory, file), 'utf8');
        contextParts.push(`## Global skill: ${file.slice(0, -3)}\n${content}`);
      }
    } catch { /* app root may be unavailable while only the extension is installed */ }
    const projectFile = path.join(root, '.localcoder', 'project.md');
    if (await exists(projectFile)) contextParts.push(`## Project details\n${(await fs.readFile(projectFile, 'utf8')).slice(0, 30000)}`);
    const skillsDirectory = path.join(root, '.localcoder', 'skills');
    for (const file of await markdownFiles(skillsDirectory)) {
      const content = await fs.readFile(path.join(skillsDirectory, file), 'utf8');
      contextParts.push(`## Workspace skill: ${file.slice(0, -3)}\n${content}`);
      if (contextParts.join('\n').length > 50000) break;
    }
    if (contextParts.length) messages.splice(1, 0, { role: 'system', content: contextParts.join('\n\n').slice(0, 50000) });
    return fitChatMessages(messages);
  }
  async agent(text) {
    if (!text.trim()) return;
    if (this.currentController) return;
    this.currentController = new AbortController();
    const agentStartedAt = Date.now();
    this.history.push({ role: 'user', content: text });
    this.emit({ type: 'user', text });
    this.post({ type: 'busy', value: true, startedAt: agentStartedAt });
    const maxSteps = vscode.workspace.getConfiguration('localcoder').get('agent.maxSteps', 8);
    let malformedRetries = 0;
    let lastToolSignature = '';
    let repeatedToolCount = 0;
    const readPaths = new Set();
    let successfulChanges = 0;
    const verifiedChanges = [];
    try {
      const localBrowserPath = requestedLocalBrowserFile(text);
      if (localBrowserPath) {
        this.post({ type: 'phase', text: `Opening ${localBrowserPath} in local browser` });
        this.emit({ type: 'tool', text: `open_local_file: ${localBrowserPath}` });
        const output = await runTool({ tool: 'open_local_file', path: localBrowserPath });
        this.history.push({ role: 'assistant', content: output });
        this.emit({ type: output.startsWith('Tool error:') ? 'error' : 'assistant', text: output, durationMs: Date.now() - agentStartedAt });
        this.persist();
        return;
      }
      const directUrl = explicitOpenUrl(text);
      if (directUrl) {
        this.post({ type: 'phase', text: 'Waiting for confirmation to open URL' });
        this.emit({ type: 'tool', text: `open_url: ${directUrl}` });
        const outputs = [await runTool({ tool: 'open_url', url: directUrl })];
        if (outputs[0].startsWith('Opened ')) {
          const profile = requestedScreenshotProfile(text);
          const backgroundColor = requestedBackgroundColor(text);
          if (backgroundColor) {
            this.post({ type: 'phase', text: 'Waiting for confirmation to apply local CSS' });
            this.emit({ type: 'tool', text: `browser_set_css: body background ${backgroundColor}` });
            outputs.push(await runTool({ tool: 'browser_set_css', url: directUrl, profile: profile || 'desktop', visible: !profile, selector: 'html, body', css: `background: ${backgroundColor} !important; background-color: ${backgroundColor} !important` }));
          }
          if (profile) {
            this.post({ type: 'phase', text: `Capturing ${profile} screenshot` });
            this.emit({ type: 'tool', text: `browser_screenshot: ${directUrl} (${profile})` });
            outputs.push(await runTool({ tool: 'browser_screenshot', url: directUrl, profile, fullPage: true }));
          }
        }
        const finalText = outputs[0].startsWith('User denied')
          ? `The web address was not opened because confirmation was declined.\n${directUrl}`
          : outputs.join('\n\n');
        this.history.push({ role: 'assistant', content: finalText });
        this.emit({ type: 'assistant', text: finalText, durationMs: Date.now() - agentStartedAt });
        this.persist();
        return;
      }
      for (let step = 0; step < maxSteps; step++) {
        this.post({ type: 'phase', text: step === 0 ? 'Local model is thinking' : 'Local model is continuing' });
        const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: await this.messagesForRequest(), useRag: true }), signal: this.currentController.signal });
        const answer = result.choices?.[0]?.message?.content || '';
        this.output.appendLine(`[${new Date().toISOString()}] model response\n${answer}\n`);
        this.history.push({ role: 'assistant', content: answer });
        const tool = parseTool(answer);
        if (!tool && resemblesToolCall(answer)) {
          if (malformedRetries >= 1) {
            this.emit({ type: 'error', text: 'The model returned an invalid tool call twice. See View → Output → LocalCoder for the raw response, then clear this conversation and retry.' });
            return;
          }
          malformedRetries++;
          const correction = fabricatedToolTranscript(answer)
            ? 'You invented a tool transcript or used unavailable tools. Do not write Tool call/Tool result text. insert and append do not exist. First call read_file for the existing file using one JSON object only. After its real result, use one write_file call containing the complete updated file.'
            : 'Your tool call could not be parsed. For a file write, retry using exactly <write_file path="relative/path"> followed by the complete raw file content and </write_file>. Do not use JSON or Markdown fences.';
          this.history.push({ role: 'user', content: correction });
          this.emit({ type: 'tool', text: 'Retrying malformed tool call' });
          this.persist();
          continue;
        }
        malformedRetries = 0;
        if (!tool) {
          const generatedContent = generatedFileContent(text, answer);
          const generatedPath = inferredCreatePath(text, generatedContent);
          if (generatedContent && generatedPath) {
            this.post({ type: 'phase', text: `Creating ${generatedPath}` });
            this.emit({ type: 'tool', text: `Recovered generated content and requested write_file: ${generatedPath}` });
            let output;
            try {
              const generatedTarget = safePath(generatedPath);
              if (await exists(generatedTarget)) {
                this.post({ type: 'phase', text: `Reading existing ${generatedPath} before update` });
                await runTool({ tool: 'read_file', path: generatedPath }, () => {}, readPaths);
                this.emit({ type: 'tool', text: `Verified existing file before update: ${generatedPath}` });
              }
              output = await runTool({ tool: 'write_file', path: generatedPath, content: generatedContent }, change => { successfulChanges++; verifiedChanges.push(change); this.emit({ type: 'change', change }); }, readPaths);
            }
            catch (error) { output = `Tool error: ${error.message}`; }
            this.history.push({ role: 'user', content: `Tool result:\n${output}` });
            const finalText = output.startsWith('Verified filesystem operation:')
              ? `${output}\n\nCreated ${generatedPath} from the generated content.`
              : output;
            this.history.push({ role: 'assistant', content: finalText });
            this.emit({ type: output.startsWith('Tool error:') ? 'error' : 'assistant', text: finalText, durationMs: Date.now() - agentStartedAt });
            this.persist();
            return;
          }
          if (fabricatedToolTranscript(answer) && successfulChanges === 0) {
            this.emit({ type: 'error', text: 'The model claimed a file operation that was not executed. No file was changed. Retry with a smaller request; LocalCoder will require read_file before editing.' });
            return;
          }
          const internalOnly = /^\s*(?:\[Previous tool call omitted after execution\]|Tool (?:call|result):?)\s*$/i.test(answer);
          const verifiedSummary = verifiedChanges.length
            ? `Verified changes:\n${verifiedChanges.map(change => `- ${change.kind[0].toUpperCase() + change.kind.slice(1)} ${change.path}`).join('\n')}`
            : '';
          const finalText = internalOnly || !answer.trim() ? verifiedSummary || 'Completed.' : verifiedSummary ? `${answer.trim()}\n\n${verifiedSummary}` : answer;
          this.history[this.history.length - 1] = { role: 'assistant', content: finalText };
          this.emit({ type: 'assistant', text: finalText, sources: result.localcoder?.sources || [], durationMs: Date.now() - agentStartedAt }); return;
        }
        if (tool.tool === 'write_file' && isPlaceholderPath(tool.path)) {
          const inferredPath = inferredCreatePath(text, tool.content);
          if (inferredPath) {
            tool.path = inferredPath;
            this.emit({ type: 'tool', text: `Replaced placeholder path with inferred file name: ${inferredPath}` });
          } else {
            this.history.push({ role: 'user', content: 'Tool error: You used the literal example path relative/path. Choose a specific filename from the user request, such as index.html or src/app.js, and retry write_file with the complete content.' });
            this.emit({ type: 'tool', text: 'Rejected placeholder path; asking model for a specific filename' });
            continue;
          }
        }
        if (!['read_file', 'list_files', 'search', 'write_file', 'delete_file', 'rename_file', 'start_app', 'stop_app', 'project_command', 'open_url', 'open_local_file', 'browser_screenshot', 'browser_inspect', 'browser_action', 'browser_set_css', 'http_request', 'download_file'].includes(tool.tool)) {
          this.history.push({ role: 'user', content: `Tool error: ${tool.tool} is unavailable. Use read_file first, then write_file with the complete file content.` });
          this.emit({ type: 'tool', text: `Rejected unsupported tool: ${tool.tool}` });
          continue;
        }
        this.history[this.history.length - 1] = { role: 'assistant', content: `Tool call: ${tool.tool} ${tool.path || tool.query || ''}`.trim() };
        if (tool.tool === 'write_file' && !isPlaceholderPath(tool.path)) {
          const writeTarget = safePath(tool.path);
          const relativeWriteTarget = path.relative(workspaceRoot(), writeTarget).toLowerCase();
          if (await exists(writeTarget) && !readPaths.has(relativeWriteTarget)) {
            this.post({ type: 'phase', text: `Reading existing ${tool.path} before update` });
            await runTool({ tool: 'read_file', path: tool.path }, () => {}, readPaths);
            this.emit({ type: 'tool', text: `Verified existing file before update: ${tool.path}` });
          }
        }
        const toolSignature = JSON.stringify(tool);
        if (toolSignature === lastToolSignature) {
          repeatedToolCount++;
          if (repeatedToolCount >= 2) {
            this.emit({ type: 'assistant', text: `The requested operation on ${tool.path || 'the workspace'} was already completed. LocalCoder stopped repeated duplicate tool calls.`, durationMs: Date.now() - agentStartedAt });
            return;
          }
          this.emit({ type: 'tool', text: `Skipped duplicate ${tool.tool}: ${tool.path || tool.query || ''}` });
          this.history.push({ role: 'user', content: 'That identical tool call already completed successfully. Do not call it again. Respond now with a brief final summary.' });
          this.persist();
          continue;
        }
        lastToolSignature = toolSignature;
        repeatedToolCount = 0;
        this.post({ type: 'phase', text: `Running tool: ${tool.tool}` });
        this.emit({ type: 'tool', text: `${tool.tool}: ${tool.path || tool.query || ''}` });
        let output;
        try { output = await runTool(tool, change => { successfulChanges++; verifiedChanges.push(change); this.emit({ type: 'change', change }); }, readPaths); } catch (e) { output = `Tool error: ${e.message}`; }
        this.history.push({ role: 'user', content: `Tool result:\n${output}` });
        this.persist();
        if (output.startsWith('No change:')) {
          this.emit({ type: 'assistant', text: output, durationMs: Date.now() - agentStartedAt });
          return;
        }
      }
      this.emit({ type: 'error', text: `Agent stopped after ${maxSteps} steps. Increase localcoder.agent.maxSteps to continue longer.` });
    } catch (error) {
      if (this.currentController?.signal.aborted) this.emit({ type: 'tool', text: 'Stopped by user' });
      else throw error;
    } finally {
      this.currentController = null;
      this.post({ type: 'busy', value: false });
    }
  }
}

function html(webview, mediaRoot, version) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource}"><style>
  body{padding:0;color:var(--vscode-foreground);font:13px var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}header{padding:10px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:8px;align-items:center}.header-spacer{flex:1}.header-button{margin:0;padding:5px 8px;min-width:30px;background:transparent;color:var(--vscode-foreground);font-size:16px;line-height:1}.header-button:hover{background:var(--vscode-toolbar-hoverBackground)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;flex:none}.dot.ok{background:#22c55e}#state{white-space:nowrap}.footer-status{display:inline-flex;align-items:center;gap:7px;margin-left:9px;color:var(--vscode-descriptionForeground);font-size:11px}.header-version{color:var(--vscode-descriptionForeground);font-size:12px;white-space:nowrap}#chat{flex:1;overflow:auto;padding:10px}.msg{margin:0 0 12px;padding:9px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}.user{background:var(--vscode-textBlockQuote-background)}.assistant{border:1px solid var(--vscode-panel-border)}.tool{opacity:.75;font-size:12px}.error{color:var(--vscode-errorForeground)}.change{margin:0 0 12px;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden}.change-head{padding:8px;background:var(--vscode-editor-inactiveSelectionBackground);font-weight:600}.change-path{display:block;margin-top:3px;font-family:var(--vscode-editor-font-family);font-weight:400;word-break:break-all}.change-stats{padding:6px 8px;font-size:12px}.plus{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}.minus{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)}.diff-preview{margin:0;padding:8px;max-height:220px;overflow:auto;background:var(--vscode-textCodeBlock-background);font:11px var(--vscode-editor-font-family);white-space:pre}.change button{margin:0 8px 8px}footer{padding:10px;border-top:1px solid var(--vscode-panel-border)}textarea{box-sizing:border-box;width:100%;min-height:72px;resize:vertical;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:8px}button{margin-top:7px;padding:5px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px}button:disabled{opacity:.5}.secondary{float:right;background:var(--vscode-button-secondaryBackground)}small{opacity:.7}
  </style></head><body><header><span class="header-version">v${version}</span><span class="header-spacer"></span><button id="refresh" class="header-button" title="Refresh model status" aria-label="Refresh model status">↻</button><button id="skills" class="header-button" title="Manage skills" aria-label="Manage skills">🧩</button><button id="homepage" class="header-button" title="Open pwaapps.com" aria-label="Open pwaapps.com">🌐</button></header><div id="activity" style="display:none;padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)"><span id="activityText">Local model is thinking</span><span id="activityTime" style="float:right;font-variant-numeric:tabular-nums">0.0s</span></div><main id="chat"></main><footer><textarea id="input" placeholder="Ask about code or request a change… (Shift+Enter for new line)"></textarea><button id="send">Send</button><button id="stop" disabled>Stop</button><span class="footer-status"><span id="dot" class="dot"></span><span id="state">Connecting…</span></span><button id="clear" class="secondary">Clear</button></footer><script src="${scriptUri}"></script></body></html>`;
}

function activate(context) {
  const provider = new ChatProvider(context);
  const snapshots = new SnapshotProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('localcoder-before', snapshots));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('localcoder-after', snapshots));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('localcoder.chat', provider));
  context.subscriptions.push(vscode.commands.registerCommand('localcoder.openChat', () => vscode.commands.executeCommand('workbench.view.extension.localcoder')));
  context.subscriptions.push(vscode.commands.registerCommand('localcoder.configure', () => vscode.commands.executeCommand('workbench.action.openSettings', 'localcoder')));
  context.subscriptions.push(vscode.commands.registerCommand('localcoder.manageSkills', () => provider.manageSkills()));
}
async function deactivate() {
  await browserSession?.close();
  await visibleBrowserSession?.close();
  for (const preview of previewServers.values()) preview.server.close();
}
module.exports = { activate, deactivate };
