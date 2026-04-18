# formatarc

Convert JSON, YAML, CSV, Markdown, and HTML from the terminal. No config, no dependencies to manage — just pipe or pass your data.

**Web version → [formatarc.com](https://formatarc.com)**

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
- Multilingual (English / Japanese)

## License

MIT
