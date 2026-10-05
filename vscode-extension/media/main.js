'use strict';

const vscode = acquireVsCodeApi();
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const state = document.getElementById('state');
const dot = document.getElementById('dot');

function add(className, text, copyable = false) {
  const element = document.createElement('div');
  element.className = `msg ${className}`;
  const content = document.createElement('div');
  content.textContent = text;
  element.appendChild(content);
  if (copyable) {
    const copy = document.createElement('button');
    copy.className = 'copy-message';
    copy.textContent = 'Copy';
    copy.title = 'Copy message to clipboard';
    copy.addEventListener('click', () => {
      vscode.postMessage({ type: 'copy', text });
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });
    element.appendChild(copy);
  }
  chat.appendChild(element);
  chat.scrollTop = chat.scrollHeight;
}

function addChange(change) {
  const card = document.createElement('section');
  card.className = 'change';
  const heading = document.createElement('div');
  heading.className = 'change-head';
  heading.textContent = change.kind === 'created' ? 'Created file' : change.kind === 'removed' ? 'Removed file' : 'Edited file';
  const file = document.createElement('span');
  file.className = 'change-path';
  file.textContent = change.path;
  heading.appendChild(file);

  const stats = document.createElement('div');
  stats.className = 'change-stats';
  const added = document.createElement('span');
  added.className = 'plus';
  added.textContent = `+${change.added}`;
  const removed = document.createElement('span');
  removed.className = 'minus';
  removed.textContent = ` −${change.removed}`;
  stats.append(added, removed);

  const preview = document.createElement('pre');
  preview.className = 'diff-preview';
  preview.textContent = change.preview;
  const open = document.createElement('button');
  open.textContent = 'Open full diff';
  open.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', id: change.id }));
  card.append(heading, stats, preview, open);
  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;
}

send.addEventListener('click', () => {
  if (!input.value.trim()) return;
  vscode.postMessage({ type: 'send', text: input.value });
  input.value = '';
});
input.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key === 'Enter') send.click();
});
document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
document.getElementById('skills').addEventListener('click', () => vscode.postMessage({ type: 'manageSkills' }));
stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

function renderMessage(message) {
  if (message.type === 'user') add('user', message.text, true);
  if (message.type === 'assistant') {
    const sources = message.sources?.length ? `\n\nSources: ${message.sources.map(source => source.source).join(', ')}` : '';
    add('assistant', message.text + sources, true);
  }
  if (message.type === 'tool') add('tool', `Tool: ${message.text}`);
  if (message.type === 'change') addChange(message.change);
  if (message.type === 'error') add('error', message.text);
  if (message.type === 'cleared') chat.innerHTML = '';
  if (message.type === 'busy') { send.disabled = message.value; stop.disabled = !message.value; }
  if (message.type === 'status') {
    const ready = message.value.ready;
    dot.className = `dot ${ready ? 'ok' : ''}`;
    state.textContent = message.value.starting
      ? 'Starting local model…'
      : ready
        ? 'Model ready'
        : (message.value.error || 'Model loading…');
  }
}

window.addEventListener('message', ({ data: message }) => {
  if (message.type === 'restore') {
    chat.innerHTML = '';
    for (const event of message.events || []) renderMessage(event);
    return;
  }
  renderMessage(message);
});

vscode.postMessage({ type: 'ready' });
