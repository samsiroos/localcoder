'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');

const changeHistory = new Map();

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
When you need a tool, respond with ONLY one valid JSON object. Do not use Markdown fences and do not add explanation:
{"tool":"read_file","path":"relative/path"}
{"tool":"list_files","path":"relative/directory"}
{"tool":"search","query":"text","path":"optional/relative/directory"}
{"tool":"write_file","path":"relative/path","content":"complete new file content"}
{"tool":"delete_file","path":"relative/path"}
When the task is complete, answer normally with a brief summary. Never invent tool results.`;

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
function parseTool(text) {
  const raw = String(text).trim();
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
  const start = new RegExp(`["']${key}["']\\s*:\\s*(["'])`, 'i').exec(text);
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
  const tool = looseString(text, 'tool');
  if (!tool || !['read_file', 'list_files', 'search', 'write_file', 'delete_file'].includes(tool)) return null;
  const value = { tool };
  for (const key of ['path', 'query', 'content']) {
    const field = looseString(text, key);
    if (field !== undefined) value[key] = field;
  }
  if (tool === 'write_file' && (typeof value.path !== 'string' || typeof value.content !== 'string')) return null;
  return value;
}
function resemblesToolCall(text) {
  return /["']tool["']\s*:\s*["'](?:read_file|list_files|search|write_file|delete_file)["']/i.test(String(text));
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
async function runTool(call, onChange = () => {}) {
  const root = workspaceRoot();
  if (call.tool === 'read_file') return (await fs.readFile(safePath(call.path), 'utf8')).slice(0, 80000);
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
    const target = safePath(call.path);
    if (!(await approve(`LocalCoder wants to write ${call.path}`))) return 'User denied the edit';
    await fs.mkdir(path.dirname(target), { recursive: true });
    const uri = vscode.Uri.file(target); let old = ''; let existed = true;
    try { old = await fs.readFile(target, 'utf8'); } catch { existed = false; }
    const next = String(call.content || '');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
    onChange(makeChange(call.path, old, next, existed ? 'edited' : 'created'));
    return `Wrote ${call.path}`;
  }
  if (call.tool === 'delete_file') {
    const target = safePath(call.path);
    if (!(await approve(`LocalCoder wants to delete ${call.path}`))) return 'User denied deletion';
    const old = await fs.readFile(target, 'utf8');
    await vscode.workspace.fs.delete(vscode.Uri.file(target), { useTrash: true });
    onChange(makeChange(call.path, old, '', 'removed'));
    return `Moved ${call.path} to trash`;
  }
  return `Unknown tool: ${call.tool}`;
}

class ChatProvider {
  constructor(context) {
    this.context = context;
    this.storageKey = 'localcoder.conversation.v1';
    this.saveChain = Promise.resolve();
    const saved = context.workspaceState.get(this.storageKey, {});
    this.history = Array.isArray(saved.history) && saved.history.length ? saved.history : [{ role: 'system', content: AGENT_PROMPT }];
    this.events = Array.isArray(saved.events) ? saved.events : [];
    for (const event of this.events) if (event.type === 'change' && event.change?.id) changeHistory.set(event.change.id, event.change);
  }
  resolveWebviewView(view) {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = html(view.webview, mediaRoot);
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
        for (const event of this.events) if (event.type === 'change' && event.change?.id) changeHistory.delete(event.change.id);
        this.history = [{ role: 'system', content: AGENT_PROMPT }];
        this.events = [];
        await this.saveChain;
        await this.context.workspaceState.update(this.storageKey, undefined);
        this.post({ type: 'cleared' });
      }
      if (message.type === 'refresh') await this.refreshStatus(true);
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
    const projectFile = path.join(root, '.localcoder', 'project.md');
    if (await exists(projectFile)) contextParts.push(`## Project details\n${(await fs.readFile(projectFile, 'utf8')).slice(0, 30000)}`);
    const skillsDirectory = path.join(root, '.localcoder', 'skills');
    for (const file of await markdownFiles(skillsDirectory)) {
      const content = await fs.readFile(path.join(skillsDirectory, file), 'utf8');
      contextParts.push(`## Workspace skill: ${file.slice(0, -3)}\n${content}`);
      if (contextParts.join('\n').length > 50000) break;
    }
    if (contextParts.length) messages.splice(1, 0, { role: 'system', content: contextParts.join('\n\n').slice(0, 50000) });
    return messages;
  }
  async agent(text) {
    if (!text.trim()) return;
    if (this.currentController) return;
    this.currentController = new AbortController();
    this.history.push({ role: 'user', content: text });
    this.emit({ type: 'user', text }); this.post({ type: 'busy', value: true });
    const maxSteps = vscode.workspace.getConfiguration('localcoder').get('agent.maxSteps', 8);
    let malformedRetries = 0;
    try {
      for (let step = 0; step < maxSteps; step++) {
        const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: await this.messagesForRequest(), useRag: true }), signal: this.currentController.signal });
        const answer = result.choices?.[0]?.message?.content || '';
        this.history.push({ role: 'assistant', content: answer });
        const tool = parseTool(answer);
        if (!tool && resemblesToolCall(answer)) {
          if (malformedRetries >= 1) {
            this.emit({ type: 'error', text: 'The model returned an invalid tool call twice. Ask it to write a smaller file or clear the conversation and retry.' });
            return;
          }
          malformedRetries++;
          const correction = 'Your tool call was not valid JSON. Retry the same tool call as one JSON object only, without Markdown fences or explanation.';
          this.history.push({ role: 'user', content: correction });
          this.emit({ type: 'tool', text: 'Retrying malformed tool call' });
          this.persist();
          continue;
        }
        malformedRetries = 0;
        if (!tool) { this.emit({ type: 'assistant', text: answer, sources: result.localcoder?.sources || [] }); return; }
        this.emit({ type: 'tool', text: `${tool.tool}: ${tool.path || tool.query || ''}` });
        let output;
        try { output = await runTool(tool, change => this.emit({ type: 'change', change })); } catch (e) { output = `Tool error: ${e.message}`; }
        this.history.push({ role: 'user', content: `Tool result:\n${output}` });
        this.persist();
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

function html(webview, mediaRoot) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource}"><style>
  body{padding:0;color:var(--vscode-foreground);font:13px var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}header{padding:10px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:8px;align-items:center}.dot{width:8px;height:8px;border-radius:50%;background:#ef4444}.dot.ok{background:#22c55e}#chat{flex:1;overflow:auto;padding:10px}.msg{margin:0 0 12px;padding:9px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}.user{background:var(--vscode-textBlockQuote-background)}.assistant{border:1px solid var(--vscode-panel-border)}.tool{opacity:.75;font-size:12px}.error{color:var(--vscode-errorForeground)}.change{margin:0 0 12px;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden}.change-head{padding:8px;background:var(--vscode-editor-inactiveSelectionBackground);font-weight:600}.change-path{display:block;margin-top:3px;font-family:var(--vscode-editor-font-family);font-weight:400;word-break:break-all}.change-stats{padding:6px 8px;font-size:12px}.plus{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}.minus{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)}.diff-preview{margin:0;padding:8px;max-height:220px;overflow:auto;background:var(--vscode-textCodeBlock-background);font:11px var(--vscode-editor-font-family);white-space:pre}.change button{margin:0 8px 8px}footer{padding:10px;border-top:1px solid var(--vscode-panel-border)}textarea{box-sizing:border-box;width:100%;min-height:72px;resize:vertical;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:8px}button{margin-top:7px;padding:5px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px}button:disabled{opacity:.5}.secondary{float:right;background:var(--vscode-button-secondaryBackground)}small{opacity:.7}
  </style></head><body><header><span id="dot" class="dot"></span><span id="state">Connecting…</span><button id="skills" class="secondary">Skills</button><button id="refresh" class="secondary">Refresh</button></header><main id="chat"></main><footer><textarea id="input" placeholder="Ask about code or request a change… (Ctrl+Enter)"></textarea><button id="send">Send</button><button id="stop" disabled>Stop</button><button id="clear" class="secondary">Clear</button></footer><script src="${scriptUri}"></script></body></html>`;
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
function deactivate() {}
module.exports = { activate, deactivate };
