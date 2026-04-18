import Papa from "papaparse";
import YAML from "yaml";
import { marked } from "marked";
import TurndownService from "turndown";

export type ConvertResult = {
  output: string;
  error: string;
};

export type Tool =
  | "json-format"
  | "yaml-to-json"
  | "json-to-yaml"
  | "csv-to-json"
  | "csv-to-markdown"
  | "markdown-to-html"
  | "html-to-markdown";

const TOOLS: Tool[] = [
  "json-format",
  "yaml-to-json",
  "json-to-yaml",
  "csv-to-json",
  "csv-to-markdown",
  "markdown-to-html",
  "html-to-markdown",
];

export function isValidTool(value: string): value is Tool {
  return TOOLS.includes(value as Tool);
}

export function convert(tool: Tool, input: string): ConvertResult {
  if (!input.trim()) {
    return { output: "", error: "Input is empty." };
  }

  try {
    switch (tool) {
      case "json-format":
        return {
          output: JSON.stringify(JSON.parse(input), null, 2),
          error: "",
        };
      case "yaml-to-json":
        return {
          output: JSON.stringify(YAML.parse(input), null, 2),
          error: "",
        };
      case "json-to-yaml":
        return {
          output: YAML.stringify(JSON.parse(input)),
          error: "",
        };
      case "csv-to-json":
        return convertCsvToJson(input);
      case "csv-to-markdown":
        return convertCsvToMarkdown(input);
      case "markdown-to-html":
        return {
          output: marked.parse(input, { async: false, gfm: true, breaks: false }) as string,
          error: "",
        };
      case "html-to-markdown":
        return {
          output: turndownService.turndown(input),
          error: "",
        };
      default:
        return { output: "", error: `Unknown tool: ${tool}` };
    }
  } catch (err) {
    return { output: "", error: formatError(err, input, tool) };
  }
}

function convertCsvToJson(input: string): ConvertResult {
  const parsed = Papa.parse<Record<string, string>>(input, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  if (!parsed.meta.fields?.length || parsed.meta.fields.every((f) => !f)) {
    return { output: "", error: "CSV header row is missing." };
  }

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    const row = typeof first.row === "number" ? ` (row ${first.row + 1})` : "";
    return { output: "", error: `CSV parse error: ${first.message}${row}` };
  }

  return {
    output: JSON.stringify(parsed.data, null, 2),
    error: "",
  };
}

function renderMarkdownTable(rows: string[][]): string {
  const columnCount = rows[0].length;
  const escapeCell = (value: string) =>
    value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  const normalizeRow = (row: string[]) => {
    const trimmed = row.length > columnCount ? row.slice(0, columnCount) : row;
    const padded =
      trimmed.length === columnCount
        ? trimmed
        : [...trimmed, ...Array(columnCount - trimmed.length).fill("")];
    return padded.map(escapeCell);
  };
  const renderRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const header = normalizeRow(rows[0]);
  const separator = Array(columnCount).fill("---");
  const body = rows.slice(1).map(normalizeRow);
  return [renderRow(header), renderRow(separator), ...body.map(renderRow)].join("\n");
}

function convertCsvToMarkdown(input: string): ConvertResult {
  const parsed = Papa.parse<string[]>(input, {
    header: false,
    skipEmptyLines: "greedy",
  });

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    return { output: "", error: `CSV parse error: ${first.message}` };
  }

  const rows = parsed.data.filter((row) => row.length > 0);
  if (rows.length === 0) {
    return { output: "", error: "CSV is empty." };
  }

  return {
    output: renderMarkdownTable(rows) + "\n",
    error: "",
  };
}

const turndownService = (() => {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  service.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const rows = Array.from((node as unknown as Element).querySelectorAll("tr")).map((row) =>
        Array.from(row.querySelectorAll("th, td")).map((cell) => cell.textContent ?? ""),
      );
      if (rows.length === 0) return "";
      return `\n\n${renderMarkdownTable(rows)}\n\n`;
    },
  });
  return service;
})();

function formatError(err: unknown, input: string, tool: Tool): string {
  if (err instanceof YAML.YAMLParseError) {
    const line = err.linePos?.[0]?.line;
    return line ? `YAML syntax error near line ${line}.` : "YAML syntax error.";
  }

  if (err instanceof Error && err.name === "SyntaxError") {
    const match = err.message.match(/position\s+(\d+)/i);
    if (match) {
      const line = input.slice(0, Number(match[1])).split("\n").length;
      return `Invalid JSON near line ${line}.`;
    }
    return "Invalid JSON.";
  }

  if (tool === "markdown-to-html") {
    return "Failed to parse Markdown. Check the syntax.";
  }
  if (tool === "html-to-markdown") {
    return "Failed to parse HTML. Check for unclosed tags.";
  }

  return "Failed to parse input. Check the format.";
}
