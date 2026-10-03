# Distribution snippets with source tags

Install instructions for each channel, tagged so that installations from that channel can be counted. These are prepared snippets only: none of the external listings below has been edited. Rule: a channel gets a tag only once the instructions it actually distributes carry that tag. Untagged installations are reported as `unknown`, which is accurate, not a gap to paper over.

Tags are optional analytics and change nothing about how the server works. Background and privacy details are in [README.md](./README.md#analytics-and-privacy).

## Formats

Every snippet is one of three shapes with a different `<source>`:

**Command line**

```bash
npx -y @basedagents/mcp --source <source> --campaign <campaign>
```

**JSON config (Claude Desktop, Cursor, Cline, Windsurf, OpenClaw)**

```json
{
  "mcpServers": {
    "basedagents": {
      "command": "npx",
      "args": ["-y", "@basedagents/mcp"],
      "env": {
        "BASEDAGENTS_ACQUISITION_SOURCE": "<source>",
        "BASEDAGENTS_ACQUISITION_CAMPAIGN": "<campaign>"
      }
    }
  }
}
```

**Claude Code**

```bash
claude mcp add basedagents --env BASEDAGENTS_ACQUISITION_SOURCE=<source> -- npx -y @basedagents/mcp
```

The campaign is optional everywhere. Leave it out unless a specific promotion needs separating.

## Per channel

| Channel | `source` | Where the snippet goes | Status |
|---------|----------|------------------------|--------|
| basedagents.ai | `website` | `/mcp/setup` generates it per visit, with a setup id | Shipped in this change |
| Campaign links | any source + `campaign` | `https://basedagents.ai/mcp/setup?utm_source=<source>&utm_campaign=<campaign>` | Shipped in this change |
| GitHub repository README | `github` | Root `README.md` MCP section | Shipped in this change |
| npm | `npm` | — | Not separable: see note below |
| MCP Registry | `mcp_registry` | `packages/mcp/server.json` (published by `publish.yml`) | Manual: proposed below |
| PulseMCP | `pulsemcp` | PulseMCP listing install instructions | Manual |
| Glama | `glama` | Glama listing install instructions | Manual |
| Smithery | `smithery` | Smithery listing config | Manual |
| Hacker News / community posts | `hackernews` | Link to `/mcp/setup?utm_source=hackernews&utm_campaign=<post>` | Use the setup link |
| Partners | `partner` + `campaign` = partner slug | The partner's own docs | Per partner |

### GitHub vs npm

`packages/mcp/README.md` is published to npm unchanged, so a tag in it would show up on both GitHub and npm and could not tell them apart. Its snippets therefore stay untagged and count as `unknown`. The repository's root `README.md` is GitHub-only, so it carries `--source github`. npm can only be separated if the npm package gets its own README at publish time. That isn't done yet.

### MCP Registry (proposed, not applied)

The registry schema lets a package declare environment variables. Whether a given client pre-fills them from the registry entry varies by client, so treat this as best effort:

```json
"packages": [
  {
    "registryType": "npm",
    "identifier": "@basedagents/mcp",
    "version": "<version>",
    "transport": { "type": "stdio" },
    "environmentVariables": [
      {
        "name": "BASEDAGENTS_ACQUISITION_SOURCE",
        "description": "Optional analytics tag for where this install came from",
        "default": "mcp_registry",
        "isRequired": false,
        "isSecret": false
      }
    ]
  }
]
```

### Hosted connector (`mcp.basedagents.ai`)

The hosted server reads tags from the connection URL, and the OAuth client registration is treated as the installation:

```
https://mcp.basedagents.ai/mcp?source=<source>&campaign=<campaign>
```

## Known limitations

- **Auto-install flows** (one-click installers, registry-driven clients) may drop custom `args` or `env`. Those installs arrive untagged and count as `unknown`.
- **Stale packages.** Versions before this change send no tags or installation id. They keep working and count as `unknown` until updated.
- **Opt-out.** Installs with `BASEDAGENTS_TELEMETRY=off` or `BASEDAGENTS_NO_TELEMETRY=1` are invisible to attribution by design.
- **Shared snippets.** One copied snippet can be used by many installations. Each counts separately; nothing merges them into one person.
- **Unstable local state.** If the state file can't be written (read-only home, ephemeral containers), the server runs without an installation id and its activity is unattributed.
- **Self-reported.** A tag is evidence of the instructions someone used, not proof of how they discovered BasedAgents. A setup id proves only that the setup page issued it.
