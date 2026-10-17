# Git workflow

Use this skill whenever the user asks to inspect or change Git state, manage branches, stage or commit changes, sync with a remote, resolve conflicts, tag a version, or publish a GitHub release. Carry out the requested Git operation in the current repository when safe; do not stop at generic instructions if the request is actionable.

## Inspect before acting

- Confirm the repository root, current branch, upstream, and recent commits before mutating Git state.
- Inspect both `git status --short --branch` and relevant staged and unstaged diffs. Read untracked files that would be included.
- Preserve pre-existing staged, unstaged, and untracked changes. Never discard, overwrite, or include them accidentally.
- For commits, stage only files requested or necessary for the task; avoid `git add -A` or `git add .` when unrelated changes exist.
- Check the final staged diff for accidental secrets, credentials, private keys, local config, generated files, or unrelated content. Never commit secrets.

## Work requested

- Treat read-only requests (status, log, diff, show, branch/tag listing, and remote inspection) as inspections and report what the commands establish.
- For staging, commit, branch, tag, push, pull, fetch, merge, rebase, cherry-pick, and release requests, make the requested changes after inspecting relevant state. Explain the intended scope before risky or broad operations; ask for clarification if target branch, remote, commit set, conflict resolution, or release contents are ambiguous.
- Do not commit, push, publish a release, or modify remote state unless the user explicitly asks for that operation.
- Before pushing, confirm the target remote and branch, inspect the commits being pushed, and verify no unrelated or sensitive changes are included. Never use force push or rewrite published history unless the user explicitly requests it and the consequences are clear.
- Before creating a release, verify the version/tag, release notes, and exact artifacts; confirm whether the release is draft or published when not specified. Do not claim publication until GitHub confirms it.
- For GitHub requests, prefer available authenticated GitHub tools. Otherwise use the installed GitHub CLI or existing Git credential helper without printing, exposing, or persisting tokens. Never ask the user to paste a secret into chat.
- Treat `reset --hard`, `clean`, forced checkout, branch deletion, tag deletion, and history rewrites as destructive. Do not run them unless explicitly requested; preserve data and ask when intent or scope is uncertain.
- Never commit merely because a Git request involves generating a change. Follow the requested operation exactly.

## Commit and verification

- Write concise commit messages that describe the change. Include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` unless the user explicitly asks not to.
- Resolve conflicts only according to the user's stated intent and the surrounding project behavior; do not silently choose one side or drop changes.
- After each operation, verify the resulting status, commit/tag/remote reference, and release or asset where applicable.
- Report completed operations with the commit hash, branch, remote, tag, and release link as applicable. Distinguish local success from remote success, and state clearly if authentication or permissions blocked an operation.
