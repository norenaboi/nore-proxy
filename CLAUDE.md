# Claude Code Instructions

Read and follow [`AGENT.md`](AGENT.md) before working in this repository. It is the authoritative repository handbook; current source, types, tests, and `package.json` remain authoritative when documentation and implementation differ.

- Inspect `git status` before editing and preserve all existing modified, deleted, and untracked user work.
- Follow the host-based verification and live-service restrictions in `AGENT.md`. Do not use Docker for verification unless explicitly requested. Never commit, push, deploy, restart services, or modify live operational data without explicit authorization.
- Report skipped, unavailable, failing, and unrun checks accurately; `npm test` is the global health check, and no linting command currently exists.
