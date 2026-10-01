@AGENTS.md

## Codebase exploration

Prefer the codebase-memory (CBM) graph over manual `grep`/`find`/multi-file `Read` sweeps when exploring, to save tokens:

- For structural questions (where is X defined, who calls X, what does X call, impact of changing X, dead code, architecture), use the `codebase-memory` skill, or spawn the `codebase-memory` / `codebase-memory-scout` agent.
- Fall back to `Read`/`grep` when the target file is already known, the lookup is a single literal string, or the graph reports the file as partially indexed or stale. The source is ground truth.
- Before changing a shared function, type or util, check its callers via the graph.
- Do not `Read` large files (e.g. `src/services/api.ts`, ~4k lines) to find a function: `search_graph` for it, then `get_code_snippet`.
- The CBM project name is `Users-zaidbhimala-Desktop-grocey-app`. The CBM tools are deferred, so load them with `ToolSearch` first. If results look stale, run `index_status` / `index_repository`.
