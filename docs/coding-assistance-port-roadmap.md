# Coding Assistance Port Roadmap

This document tracks coding-assistance capabilities identified in Hermes Agent, Vellum Assistant, and CAI that are useful for Letta Code.

## Implemented in this pass

### Hermes Agent workflow skills

Bundled skills adapted from `/home/dok/.hermes/skills/software-development`:

- `systematic-debugging` — root-cause-first debugging workflow.
- `test-driven-development` — strict RED/GREEN/REFACTOR cycle.
- `writing-plans` — implementation-plan methodology with small tasks and exact paths.
- `requesting-code-review` — pre-commit review pipeline with independent reviewer loop.
- `subagent-driven-development` — task-by-task implementation with reviewer subagents.
- `spike` — throwaway feasibility experiments.

### Vellum-inspired compaction hardening

Implemented in local compaction:

- Newline-aware tool-result truncation.
- Runtime injection stripping for compaction input.
- Tail-anchor preservation in summaries.
- Binary-search sliding-window cutoff selection instead of coarse percentage stepping.
- Conservative tool-bearing-message cutoff handling.

Recommended future Vellum ports:

- Provider-aware token estimation.
- Adaptive compaction cooldown.
- Stronger tool-call/tool-result pair modeling if local message storage changes.
- Accessibility-tree compaction for browser automation transcripts.

### CAI-inspired Bash guardrails

Implemented opt-in guardrails:

- `LETTA_BASH_GUARDRAILS=1` or `LETTA_GUARDRAILS=1` enables command preflight checks.
- Blocks obvious fork bombs, destructive root deletes, downloaded-script pipes, reverse-shell-like patterns, raw device overwrites, and dangerous base64-hidden payloads.
- Annotates web/external shell output as untrusted when appropriate.

Recommended future CAI ports:

- AI-assisted prompt-injection classification.
- More complete Unicode homograph normalization.
- Guardrail span tracing and configurable policy profiles.

### Hermes-inspired file-operation reliability

Implemented lightweight local tracking:

- Repeated unchanged `Read` calls return a read-loop warning after repeated reads.
- `Edit`/`Write` warn if a file changed after the agent last read it.

Recommended future Hermes ports:

- Full fuzzy patch matching and “did you mean?” patch suggestions.
- Lint-delta reporting after edits.
- Cross-process/per-conversation read tracking instead of process-local tracking.

## Deferred higher-effort ports

### Hermes Agent

- `ExecuteCode` sandboxed code execution tool with RPC stubs.
- Multi-backend terminal abstraction: Docker, SSH, Modal, Singularity, Daytona, Vercel.
- Advanced subagent heartbeat/stale detection and timeout diagnostics.
- V4A-style validated multi-file patch parser.

### Vellum Assistant

- SkillHost facet interface for code-bearing skills.
- Skill catalog install/versioning with atomic writes.
- Tool origin stamping and conflict resolution: core > skill > plugin > MCP.
- Local model capability/pricing catalog.
- Tool risk classification and cached assessments.
- Credential-scoped execution / CES-style architecture.

### CAI

- Council / multi-model consensus subagent.
- Handoff tool with context filtering.
- Session resume from JSONL with tool-call correlation.
- Span-based tracing using Node `AsyncLocalStorage`.
- Red-team / blue-team / web-pentester subagent templates.
- JS surface mapper and HTTP analysis tools.

## Porting principles

- Port patterns into Letta Code architecture; do not paste large Python modules into TypeScript.
- Keep dangerous behavior opt-in or permission-gated.
- Preserve Letta Code’s existing permission system and memory-first design.
- Add tests for runtime behavior changes.
