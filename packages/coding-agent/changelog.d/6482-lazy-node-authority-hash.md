### Fixed

- Plugin MCP startup no longer hashes every `node` on `PATH` when the module loads. Startup records each candidate's file identity, and the digest is computed on first use from a descriptor that must still be that startup file, so a replaced interpreter is rejected. Hard-linked `node` paths each keep their own startup authority.
