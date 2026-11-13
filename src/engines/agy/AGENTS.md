# Engine implementation guide

Use named exports and an index.ts barrel. Keep source files below 400 lines
and tests beside implementations. Preserve provider behavior and public types.
Static descriptors must not import handlers or runtime implementation.
Broker infrastructure moves preserve its existing protocol and security rules.

AGY reads an MCP tool's schema with `view_file` under
`$HOME/.gemini/antigravity-cli/mcp/<server>/` before calling it, and refuses
reads outside its workspace. Daimon's runtime home is outside the workspace, so
`piArgs.ts` adds only that schema directory with `--add-dir` whenever Daimon
tools are mounted.
