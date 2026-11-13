# westerm plugins

The plugin list of [westerm](https://github.com/SteelCrab/westerm). The plugin manager's **Browse** tab reads `index.json` from this repository. A plugin installed from it has the `verified` badge.

## How westerm uses the list

- westerm downloads `https://raw.githubusercontent.com/westerm-dev/plugins/main/index.json` when you open the plugin manager, and keeps it for one hour.
- **Install** downloads the entry's `url` and refuses the package when its SHA-256 differs from `sha256`.
- Once a day, westerm looks here for a newer `version` of each plugin installed from the list. It never updates by itself.
- westerm leaves out an entry it cannot use. The [Check](.github/workflows/check.yml) workflow fails on it instead.

## `index.json`

A JSON array, sorted by `id`. One object per plugin:

```json
[
  {
    "id": "k8s-tools.kubernetes",
    "name": "Kubernetes",
    "description": "See pods by namespace. Open logs and exec shells as westerm panes.",
    "repo": "https://github.com/k8s-tools/westerm-k8s",
    "version": "0.3.1",
    "url": "https://github.com/k8s-tools/westerm-k8s/releases/download/v0.3.1/westerm-plugin.tar.gz",
    "sha256": "<64 lowercase hex digits>",
    "permissions": { "run": ["kubectl"], "panes": true, "background": true }
  }
]
```

| Key | Required | Rule |
|---|---|---|
| `id` | yes | `<author>.<name>`. Each part is 1 to 32 characters of `a-z`, `0-9`, `-`. The same as in `plugin.json`. |
| `name` | yes | 1 to 40 characters. The same as in `plugin.json`. |
| `description` | no | At most 200 characters. |
| `repo` | yes | `https://github.com/<owner>/<repo>`: the source, for people to read. |
| `version` | yes | `x.y.z`, digits only. The same as in `plugin.json`. |
| `url` | yes | An `https://` link to the `.tar.gz` package. |
| `sha256` | yes | The SHA-256 of the package, in lowercase hex. |
| `permissions` | no | `run` (program names), `panes`, and `background`, the same as in `plugin.json`. |

## Add or update a plugin

1. Build the package and attach it to a GitHub release of your plugin. See [Writing plugins](https://github.com/SteelCrab/westerm/blob/main/docs/plugins.md).
2. Get its SHA-256: `shasum -a 256 westerm-plugin.tar.gz` (macOS) or `sha256sum westerm-plugin.tar.gz` (Linux).
3. Open a pull request that adds or changes your entry. Keep the list sorted by `id`. One plugin per pull request.
4. The Check workflow downloads the package and checks it: the SHA-256, the size limits (5 MiB packed, 10 MiB unpacked, 300 entries), regular files and folders only, and that `plugin.json` has the same `id`, `name`, `version`, and `permissions` as the entry.
5. A maintainer reads the plugin's code at that release before merging. `verified` means: reviewed at that version, and pinned by its SHA-256.

## Check locally

Node.js 24 or later, no dependencies:

```bash
npm test         # the checker's own tests
npm run check    # index.json and every package in it
```

`node scripts/check-index.mjs index.json --offline` checks the entries without downloading.

## License

[MIT](LICENSE)
