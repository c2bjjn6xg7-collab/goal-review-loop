# Security Policy

## Secrets

Do not commit API keys, provider tokens, `.env` files, private keys, local session
files, or generated `.agent/` runtime artifacts.

`goal-review-loop` is designed to call provider CLIs that are already authenticated on
the user's machine. Credentials should remain in those provider tools and should not be
copied into this repository.

Before publishing or accepting a contribution, run a local secret scan and review any
matches manually.

## Permission Modes

Provider permission modes such as Claude Code `bypassPermissions` or
`--dangerously-skip-permissions` should only be used inside trusted, isolated, git-backed
workspaces.

Never run high-permission provider commands in repositories containing production
secrets, private customer data, or files that cannot be safely reverted.

## Reporting Issues

If you find a security issue, please do not publish exploit details in a public issue.
Open a private report with the repository owner or contact the maintainer directly.
