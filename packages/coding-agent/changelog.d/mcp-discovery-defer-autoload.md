### Added

- `mcp.discoveryDeferAutoload` keeps conventionally autoloaded MCP tools (`gjc mcp add`, `.gjc/mcp.json`, `~/.gjc/agent/mcp.json`) out of the default tool selection when MCP discovery is on. The tools stay registered and become active through `search_tool_bm25`; servers listed in `mcp.discoveryDefaultServers` are still selected, so large MCP catalogs no longer occupy the context window up front.
