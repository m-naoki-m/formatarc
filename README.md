# formatarc

Convert JSON, YAML, CSV, Markdown, and HTML from the terminal — your data never leaves your machine. No config, no telemetry, no upload.

[![npm version](https://img.shields.io/npm/v/formatarc.svg)](https://www.npmjs.com/package/formatarc)
[![license: MIT](https://img.shields.io/npm/l/formatarc.svg)](https://github.com/m-naoki-m/formatarc/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/formatarc.svg)](https://www.npmjs.com/package/formatarc)

**Web version → [formatarc.com](https://formatarc.com)** — the same conversions, 100% in your browser, no signup.

## Why formatarc?

Most "online JSON / YAML / CSV converters" send the data you paste to a server. In November 2025, security firm watchTowr disclosed that two popular formatter sites (jsonformatter.org and codebeautify.org) had publicly exposed **over 80,000 saved submissions (5 GB+)** through a predictable "Recent Links" URL — including Active Directory credentials, cloud access keys, private keys, CI/CD secrets, JWTs, and full AWS Secrets Manager exports from government, banking, healthcare, and aerospace organizations. ([watchTowr report](https://labs.watchtowr.com/stop-putting-your-passwords-into-random-websites-yes-seriously-you-are-the-problem/))

formatarc is built so that can't happen. The CLI runs entirely on your machine, and the [web version](https://formatarc.com) runs entirely in your browser — no upload, no logging, no telemetry, no account.

It is not only paste-to-a-server sites, either: in early 2026, a widely used JSON formatter browser extension was reported (on Hacker News and dev.to) to add third-party tracking and checkout-page injection after moving to a closed-source model — a reminder that an installed extension can change behaviour through an automatic update. Background on both risks: [are online converters safe?](https://formatarc.com/en/blog/online-converter-safety/) and [picking a JSON formatter Chrome extension by privacy and permissions](https://formatarc.com/en/blog/chrome-extension-json-formatter/).

| | formatarc CLI | formatarc web | Typical online converter | jq / yq / pandoc |
|---|:---:|:---:|:---:|:---:|
| Data stays local | ✅ | ✅ | ❌ | ✅ |
| No signup / no upload | ✅ | ✅ | ⚠️ | ✅ |
| JSON + YAML + CSV + Markdown + HTML in one tool | ✅ | ✅ | ⚠️ | ❌ |
| Works offline | ✅ | after first load | ❌ | ✅ |
| Single install | ✅ | n/a | n/a | ❌ |

## JSON formatter comparison: privacy and breach history

A field-by-field comparison of the most common ways to format JSON in 2026. Sources for the breach column are linked below — paste-to-a-server sites have a verifiable incident history that local CLIs and browser-side tools structurally cannot.

| Tool | Type | Data stays local | Open source | Multi-format | Public breach (2024–2026) |
|---|---|:---:|:---:|---|---|
| **formatarc** (CLI) | CLI / npm | ✅ | ✅ MIT | JSON, YAML, CSV, Markdown, HTML | n/a — no server, no storage |
| **formatarc.com** | Web (browser-side) | ✅ | ✅ MIT | JSON, YAML, CSV, Markdown, HTML | n/a — no server, no storage |
| [jsonformatter.org](https://jsonformatter.org/) | Web (paste-to-server) | ❌ pasted JSON sent to server | ❌ | JSON-focused | ⚠️ Nov 2025 — 80,000+ saved submissions (5 GB+) exposed via predictable "Recent Links" URL ([watchTowr](https://labs.watchtowr.com/stop-putting-your-passwords-into-random-websites-yes-seriously-you-are-the-problem/)) |
| [codebeautify.org](https://codebeautify.org/) | Web (paste-to-server) | ❌ pasted data sent to server | ❌ | multi-format | ⚠️ Nov 2025 — same watchTowr disclosure |
| [jsonlint.com](https://jsonlint.com/) | Web (paste-to-server) | ❌ pasted JSON sent to server | ❌ | JSON only | no public incident known to date |
| [jq](https://jqlang.github.io/jq/) | CLI | ✅ runs locally | ✅ MIT | JSON only | n/a |
| [prettier](https://prettier.io/) | CLI / npm | ✅ runs locally | ✅ MIT | code formatter (JSON, JS, TS, etc.) | n/a |

The takeaway is mechanical: if a tool sends your data to a third-party server, the breach surface is non-zero regardless of intent. CLIs and browser-side tools have no such surface to leak.

## Install

```bash
npm install -g formatarc
```

Or run directly with `npx`:

```bash
npx formatarc json-format '{"a":1}'
```

## Usage

```
formatarc <tool> [input or file]
cat file | formatarc <tool>
```

### Tools

| Command | Description |
|---------|-------------|
| `json-format` | Pretty-print JSON |
| `yaml-to-json` | Convert YAML to JSON |
| `json-to-yaml` | Convert JSON to YAML |
| `csv-to-json` | Convert CSV (with header row) to JSON |
| `csv-to-markdown` | Convert CSV to a Markdown (GFM) table |
| `markdown-to-html` | Convert Markdown to HTML |
| `html-to-markdown` | Convert HTML to Markdown |

### Examples

Format JSON:

```bash
formatarc json-format '{"name":"FormatArc","tools":["json","yaml","csv"]}'
```

```json
{
  "name": "FormatArc",
  "tools": [
    "json",
    "yaml",
    "csv"
  ]
}
```

Convert a YAML file to JSON:

```bash
formatarc yaml-to-json config.yaml
```

Pipe from curl:

```bash
curl -s https://api.example.com/data | formatarc json-format
```

Convert CSV from stdin:

```bash
cat users.csv | formatarc csv-to-json
```

Convert CSV to a Markdown table:

```bash
cat users.csv | formatarc csv-to-markdown
```

Render Markdown as HTML:

```bash
cat README.md | formatarc markdown-to-html > README.html
```

Strip HTML to Markdown (handy for piping web pages into LLMs):

```bash
curl -s https://example.com | formatarc html-to-markdown
```

## Validate data in CI and git hooks

Every command exits `0` on success and `1` on failure, writing the result to **stdout** and any error to **stderr**. Errors are line-numbered, so a broken file points you straight at the problem instead of a cryptic parser dump:

```bash
$ echo '{"a":1,}' | formatarc json-format
Invalid JSON: remove the trailing comma on line 1.
$ echo $?
1
```

That makes it a drop-in validator for pipelines and pre-commit hooks — and, like everything else here, the data never leaves the runner.

Fail a GitHub Actions build on malformed JSON or YAML:

```yaml
- name: Validate config files
  run: |
    npx formatarc json-format config.json > /dev/null
    npx formatarc yaml-to-json .github/settings.yaml > /dev/null
```

Block a commit that stages invalid JSON (`.git/hooks/pre-commit`):

```sh
#!/bin/sh
for f in $(git diff --cached --name-only --diff-filter=ACM | grep '\.json$'); do
  npx formatarc json-format "$f" > /dev/null || { echo "Invalid JSON in $f"; exit 1; }
done
```

## Programmatic API

```typescript
import { convert } from "formatarc";

const result = convert("json-format", '{"a":1}');
console.log(result.output);
// {
//   "a": 1
// }
```

### `convert(tool, input)`

Returns `{ output: string, error: string }`.

- `output` — the converted result (empty string on error)
- `error` — error message (empty string on success)

## Web Version

For a browser-based experience with no signup and no data upload:

**[formatarc.com](https://formatarc.com)**

- JSON Formatter, YAML ↔ JSON, CSV → JSON
- CSV → Markdown, Markdown ↔ HTML
- Runs entirely in the browser
- Multilingual (English, Japanese, Spanish, Portuguese)

There is also a [Chrome extension](https://formatarc.com/en/blog/chrome-extension-json-formatter/) for popup and right-click conversion — same browser-side processing, no upload.

## Related projects by the same author

The CLI shares conversion logic and design goals with two sister projects, all under the same "data never leaves your machine" promise:

- **Web app** — [formatarc.com](https://formatarc.com) — same 7 conversions, runs entirely in the browser, no signup
- **Chrome extension** — [JSON / YAML formatter extension for Chrome](https://formatarc.com/en/blog/chrome-extension-json-formatter/) — popup and right-click conversion, same browser-side processing
- **npm package** — [formatarc on npm](https://www.npmjs.com/package/formatarc) — this CLI's distribution channel

Companion reads on the privacy axis:

- [Are online JSON / YAML / CSV converters safe?](https://formatarc.com/en/blog/online-converter-safety/) — what the November 2025 disclosure means for any "paste here, get formatted output" site
- [Choosing a JSON formatter Chrome extension by privacy and permissions](https://formatarc.com/en/blog/chrome-extension-json-formatter/) — what to check before installing a browser extension that touches every page

## License

MIT
