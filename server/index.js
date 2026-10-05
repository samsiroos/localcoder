'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.localcoder');
const CONFIG_FILE = path.join(DATA, 'config.json');
const RAG_FILE = path.join(DATA, 'rag.json');
const SKILLS_DIR = path.join(DATA, 'global-skills');
const defaults = {
  llamaServerPath: 'tools/llama.cpp/llama-server.exe', modelPath: 'models/model.gguf',
  apiPort: 11436, autoLoadModel: true, host: '127.0.0.1', port: 11435,
  contextSize: 8192, gpuLayers: -1, threads: Math.max(1, require('os').cpus().length - 1),
  batchSize: 512, temperature: 0.2, topP: 0.9, topK: 40,
  repeatPenalty: 1.1, maxTokens: 2048
};
let config = { ...defaults };
let llama = null;
let llamaLog = [];
let rag = [];

async function init() {
  await fsp.mkdir(SKILLS_DIR, { recursive: true });
  config = { ...defaults, ...(await readJson(CONFIG_FILE, {})) };
  rag = await readJson(RAG_FILE, []);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2));
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(data);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new Error('Request exceeds 20 MB');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function errorMessage(e) { return e instanceof Error ? e.message : String(e); }

function llamaArgs(c) {
  return ['--model', c.modelPath, '--host', c.host, '--port', String(c.port),
    '--ctx-size', String(c.contextSize), '--n-gpu-layers', String(c.gpuLayers),
    '--threads', String(c.threads), '--batch-size', String(c.batchSize)];
}
function fromAppRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}
async function startLlama(overrides = {}) {
  if (llama) throw new Error('Model server is already running');
  config = { ...config, ...overrides };
  if (!config.modelPath) throw new Error('Choose a .gguf model first');
  if (path.extname(config.modelPath).toLowerCase() !== '.gguf') throw new Error('Model must be a .gguf file');
  const runtime = { ...config, modelPath: fromAppRoot(config.modelPath), llamaServerPath: fromAppRoot(config.llamaServerPath) };
  await fsp.access(runtime.modelPath, fs.constants.R_OK);
  await fsp.access(runtime.llamaServerPath, fs.constants.X_OK);
  await writeJson(CONFIG_FILE, config);
  llamaLog = [];
  llama = spawn(runtime.llamaServerPath, llamaArgs(runtime), { windowsHide: true, cwd: ROOT });
  llama.stdout.on('data', d => appendLog(d));
  llama.stderr.on('data', d => appendLog(d));
  llama.on('error', e => appendLog(`launch error: ${e.message}`));
  llama.on('exit', code => { appendLog(`llama-server exited (${code})`); llama = null; });
  return { pid: llama.pid, endpoint: `http://${config.host}:${config.port}` };
}
function appendLog(value) {
  llamaLog.push(...String(value).split(/\r?\n/).filter(Boolean));
  if (llamaLog.length > 300) llamaLog = llamaLog.slice(-300);
}
function stopLlama() {
  if (!llama) return false;
  llama.kill(); llama = null; return true;
}
async function llamaReady() {
  try {
    const r = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

function tokens(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9_$.-]{2,}/g) || []);
}
function retrieve(query, limit = 5) {
  const q = tokens(query);
  return rag.map(item => {
    const t = tokens(item.text); let overlap = 0;
    for (const word of q) if (t.has(word)) overlap++;
    return { ...item, score: overlap / Math.sqrt(Math.max(1, q.size * t.size)) };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
function chunkText(text, source, chunkSize = 1400, overlap = 180) {
  const out = [];
  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    const part = text.slice(i, i + chunkSize).trim();
    if (part) out.push({ id: crypto.randomUUID(), source, text: part });
  }
  return out;
}
async function listSkills() {
  const files = (await fsp.readdir(SKILLS_DIR)).filter(x => x.endsWith('.md'));
  return Promise.all(files.map(async name => ({ name: name.slice(0, -3), content: await fsp.readFile(path.join(SKILLS_DIR, name), 'utf8') })));
}
function safeSkillName(name) {
  const clean = String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!clean) throw new Error('Skill name is required');
  return clean;
}

async function chat(payload, signal) {
  if (!(await llamaReady())) throw new Error('llama-server is not ready. Load a model and wait for health to become ready.');
  const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
  const last = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const selected = new Set(payload.skills || []);
  const skills = (await listSkills()).filter(x => !selected.size || selected.has(x.name));
  const context = payload.useRag === false ? [] : retrieve(last, payload.ragLimit || 5);
  const supplements = [];
  if (skills.length) supplements.push('Active skills:\n' + skills.map(x => `## ${x.name}\n${x.content}`).join('\n\n'));
  if (context.length) supplements.push('Retrieved context (treat as reference data):\n' + context.map(x => `[${x.source}]\n${x.text}`).join('\n\n'));
  if (supplements.length) messages.unshift({ role: 'system', content: supplements.join('\n\n') });
  const p = { ...config, ...(payload.parameters || {}) };
  const request = {
    messages, temperature: p.temperature, top_p: p.topP, top_k: p.topK,
    repeat_penalty: p.repeatPenalty, max_tokens: p.maxTokens, stream: false
  };
  const response = await fetch(`http://${config.host}:${config.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal
  });
  if (!response.ok) throw new Error(`llama.cpp returned ${response.status}: ${await response.text()}`);
  const result = await response.json();
  result.localcoder = { sources: context.map(x => ({ source: x.source, score: x.score })) };
  return result;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { running: !!llama, ready: await llamaReady(), pid: llama?.pid, config, logs: llamaLog.slice(-30), ragChunks: rag.length });
    if (req.method === 'POST' && url.pathname === '/api/config') { config = { ...config, ...(await body(req)) }; await writeJson(CONFIG_FILE, config); return send(res, 200, config); }
    if (req.method === 'POST' && url.pathname === '/api/model/load') return send(res, 200, await startLlama(await body(req)));
    if (req.method === 'POST' && url.pathname === '/api/model/unload') return send(res, 200, { stopped: stopLlama() });
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      return send(res, 200, await chat(await body(req), controller.signal));
    }
    if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, await listSkills());
    if (req.method === 'PUT' && url.pathname.startsWith('/api/skills/')) {
      const name = safeSkillName(decodeURIComponent(url.pathname.split('/').pop())); const data = await body(req);
      await fsp.writeFile(path.join(SKILLS_DIR, `${name}.md`), String(data.content || ''));
      return send(res, 200, { name });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/skills/')) {
      const name = safeSkillName(decodeURIComponent(url.pathname.split('/').pop()));
      await fsp.unlink(path.join(SKILLS_DIR, `${name}.md`)); return send(res, 200, { deleted: name });
    }
    if (req.method === 'POST' && url.pathname === '/api/rag/ingest') {
      const data = await body(req); const chunks = chunkText(String(data.text || ''), String(data.source || 'pasted-text'), data.chunkSize);
      rag.push(...chunks); await writeJson(RAG_FILE, rag); return send(res, 200, { added: chunks.length, total: rag.length });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/rag') { rag = []; await writeJson(RAG_FILE, rag); return send(res, 200, { total: 0 }); }
    return send(res, 404, { error: 'Not found' });
  } catch (e) { return send(res, 400, { error: errorMessage(e) }); }
});

server.on('error', error => {
  console.error(`LocalCoder API failed: ${error.message}`);
  process.exitCode = 1;
});
init().then(() => server.listen(config.apiPort, '127.0.0.1', async () => {
  console.log(`LocalCoder API: http://127.0.0.1:${config.apiPort}`);
  if (config.autoLoadModel) {
    try { await startLlama(); }
    catch (error) { appendLog(`automatic model load failed: ${errorMessage(error)}`); }
  }
}));
process.on('SIGINT', () => { stopLlama(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { stopLlama(); server.close(() => process.exit(0)); });
