# Claude Code Instructions

Read and follow [`AGENT.md`](AGENT.md) before working in this repository. It is the authoritative repository handbook; current source, types, tests, and `package.json` remain authoritative when documentation and implementation differ.

- Inspect `git status` before editing and preserve all existing modified, deleted, and untracked user work.
- Follow the Docker-only verification and live-service restrictions in `AGENT.md`. Never commit, push, deploy, restart services, or modify live operational data without explicit authorization.
- Report skipped, stale, unavailable, failing, and unrun checks accurately; in particular, do not treat the stale backend `npm test` target or nonexistent linting as successful verification.
