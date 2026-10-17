# Web development and application runtime

- Inspect the existing HTML, CSS, JavaScript, package files, and project details before choosing an architecture.
- Keep HTML semantic and accessible: associate labels with inputs, use buttons for actions, and preserve keyboard navigation.
- Prefer responsive CSS using normal document flow, flexbox, or grid. Reuse existing variables and styles instead of duplicating rules.
- In browser JavaScript, use DOM APIs, fetch, localStorage, IndexedDB, Blob downloads, and browser-compatible libraries. Never import Node.js `fs`, `path`, Express, or SQLite packages into browser scripts.
- CSV in a browser should normally be created as a Blob and downloaded after a user action. Persistent SQLite requires an existing backend or an explicit browser/WASM SQLite dependency.
- Node.js server code may use Node APIs and installed dependencies. Inspect package.json before importing a package.
- Python and .NET code must follow the existing project structure and dependency files.
- Before starting an app, inspect its package/configuration files and identify the correct entry point. Use start_app only for node, python, or dotnet entry files in the workspace.
- Report the process ID after starting an application. Use stop_app only with a process ID returned by start_app.
- Never claim an app started or stopped unless the tool result confirms it.
- Use `open_local_file` to preview an existing workspace HTML file in VS Code's internal browser. It serves the workspace from a private localhost URL so relative CSS, JavaScript, and image paths work. Never claim a file opened unless the tool confirms it exists and opened.
