# LocalCoder

LocalCoder is a private coding assistant for local GGUF models. It runs `llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp), adds reusable Markdown skills and local RAG, and exposes a VS Code agent that can inspect and modify the current workspace.

## What works

- Load/unload any readable `.gguf` model through `llama-server`
- Configure context size, GPU layers, threads, batch size, temperature, top-p, top-k, repeat penalty, and output limit
- Store reusable skills as Markdown files
- Ingest text into a persistent local RAG index
- Chat from the VS Code Activity Bar
- Agent tools: read, list, search, create/edit, and move files to trash
- Workspace boundary enforcement and confirmation before writes/deletes

## Quick start

1. Install a recent llama.cpp release and locate `llama-server.exe` (Windows) or `llama-server` (macOS/Linux).
2. Keep `llama-server.exe` under `tools/llama.cpp` and a GGUF under `models`, or adjust their relative paths in `.localcoder/config.json`.
3. Start the control service:

   ```powershell
   npm run server
   ```

4. The configured model loads automatically. To trigger a manual load when auto-load is disabled:

   ```powershell
   Invoke-RestMethod -Method Post -ContentType application/json `
     -Uri http://127.0.0.1:11436/api/model/load `
     -Body '{}'
   ```

5. Open `vscode-extension` in VS Code and press `F5`, or package and install it:

   ```powershell
   npm run package:extension
   code --install-extension vscode-extension/localcoder-0.1.0.vsix
   ```

Open the LocalCoder icon in the Activity Bar and start chatting.

## Install on another Windows computer

Copy the complete `localcoder` folder to the other computer. The folder must include `server`, `tools`, `models`, `.localcoder`, and the current `LocalCoder-*.vsix`. Install Node.js 20 or newer and VS Code, then:

1. Run `install-extension.bat` once to install the VS Code extension.
2. Run `start-localcoder.bat` whenever you want the offline AI server.
3. Keep its console window open, open any project folder in VS Code, and select LocalCoder in the Activity Bar.
4. Run `stop-localcoder.bat` to unload the model and stop the local service.

The llama.cpp and GGUF paths are relative to the application directory, so the copied folder can live anywhere. Internet access is not required after the folder and Node.js are present.

## Project details and skills

Use the **Skills** button in LocalCoder chat or run **LocalCoder: Manage Skills and Project Details** from the Command Palette.

- Project details are stored in `<workspace>/.localcoder/project.md` and apply only to that workspace.
- Workspace skills are stored in `<workspace>/.localcoder/skills/*.md` and apply only to that workspace.
- Global skills are stored in the LocalCoder application under `.localcoder/global-skills/*.md` and apply to every project.

These are ordinary Markdown files and can be edited directly at any time. LocalCoder reads them again before every model request, so saved changes take effect on the next message.

When the extension opens, it discovers or starts the local service and the configured GGUF loads automatically. After the initial llama.cpp and model download, this path requires no internet connection. If the extension cannot locate the application folder, set `localcoder.appPath` to the folder containing `server`, `models`, and `tools` (for example `C:\\Project\\localcoder`).

## API examples

Update inference defaults:

```powershell
Invoke-RestMethod -Method Post -ContentType application/json `
  -Uri http://127.0.0.1:11436/api/config `
  -Body '{"temperature":0.15,"contextSize":16384,"gpuLayers":-1}'
```

Create a skill:

```powershell
Invoke-RestMethod -Method Put -ContentType application/json `
  -Uri http://127.0.0.1:11436/api/skills/typescript `
  -Body '{"content":"Prefer strict TypeScript. Add focused tests for changed behavior."}'
```

Add RAG content:

```powershell
Invoke-RestMethod -Method Post -ContentType application/json `
  -Uri http://127.0.0.1:11436/api/rag/ingest `
  -Body '{"source":"architecture.md","text":"Paste documentation here..."}'
```

The RAG implementation is intentionally dependency-free and uses lexical relevance. It is fast for code and documentation and can later be replaced with llama.cpp embeddings plus a vector database without changing the extension API.

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/status` | Runtime health, config, recent logs |
| `POST` | `/api/config` | Persist configuration |
| `POST` | `/api/model/load` | Start llama-server |
| `POST` | `/api/model/unload` | Stop llama-server |
| `POST` | `/api/chat` | Chat completion with skills/RAG |
| `GET/PUT/DELETE` | `/api/skills/:name` | Manage skills |
| `POST/DELETE` | `/api/rag/ingest`, `/api/rag` | Add or clear RAG data |

## Security

The service listens only on `127.0.0.1`. The extension resolves every requested path and rejects paths outside the first workspace folder. File writes and deletions require a modal confirmation unless `localcoder.agent.autoApproveEdits` is explicitly enabled. Deleted files use the operating-system trash where supported.
