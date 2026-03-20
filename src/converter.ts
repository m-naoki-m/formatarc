import Papa from "papaparse";
import YAML from "yaml";

export type ConvertResult = {
  output: string;
  error: string;
};

export type Tool = "json-format" | "yaml-to-json" | "json-to-yaml" | "csv-to-json";

const TOOLS: Tool[] = ["json-format", "yaml-to-json", "json-to-yaml", "csv-to-json"];

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
        return convertCsv(input);
      default:
        return { output: "", error: `Unknown tool: ${tool}` };
    }
  } catch (err) {
    return { output: "", error: formatError(err, input, tool) };
  }
}

function convertCsv(input: string): ConvertResult {
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

  return "Failed to parse input. Check the format.";
}
