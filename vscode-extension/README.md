# LocalCoder

<p align="center">
  <img src="media/Cute%20Robot%20Coding.png" alt="LocalCoder robot coding mascot" width="256">
</p>

<p align="center">
  A private, local-first coding agent for Visual Studio Code.<br>
  Created by <a href="https://pwaapps.com">pwaapps.com</a>.
</p>

LocalCoder runs GGUF coding models through llama.cpp and works directly with the currently open VS Code workspace. After the model and runtime are installed, normal coding assistance can remain on the local computer.

## Features

- Read, search, create, update, rename, and delete workspace files with safety checks.
- Require confirmation before file changes, application execution, browser actions, API mutations, and downloads.
- Run, build, and publish .NET, Node.js, React, and Docker projects.
- Preview workspace HTML files in VS Code's internal browser.
- Open websites, inspect DOM elements, apply temporary CSS, and capture desktop, tablet, or mobile screenshots.
- Test REST APIs using GET, POST, PUT, PATCH, PUSH, and DELETE.
- Download files into the open workspace.
- Apply reusable global and workspace-specific Markdown skills.

## Getting started

1. Start the LocalCoder service and load a configured GGUF model.
2. Open a project folder in VS Code.
3. Select the LocalCoder robot icon in the Activity Bar.
4. Enter a coding request, inspect confirmations and diffs, then approve the intended operations.

Example requests:

```text
Create a responsive profile page in profile.html.
Update profile.html to use Bootstrap styling.
Open profile.html in the local browser.
Build this .NET project and report any errors.
Capture mobile and desktop screenshots of https://pwaapps.com.
```

## Safety and privacy

- File tools are restricted to the open workspace.
- Existing files are read before updates, renames, or deletions.
- Deleted files use the operating-system trash when supported.
- External mutations and downloads require confirmation.
- Browser automation uses an isolated Edge or Chrome session and does not use the normal browser profile's cookies or passwords.

## Creator

LocalCoder is created by [PWA Apps](https://pwaapps.com).
