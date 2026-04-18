#!/usr/bin/env node

import { readFileSync, existsSync } from "fs";
import { convert, isValidTool, type Tool } from "./converter.js";

const USAGE = `
formatarc — convert JSON, YAML, and CSV from the terminal

Usage:
  formatarc <tool> [input]
  formatarc <tool> <file>
  cat file | formatarc <tool>

Tools:
  json-format       Pretty-print JSON
  yaml-to-json      Convert YAML to JSON
  json-to-yaml      Convert JSON to YAML
  csv-to-json       Convert CSV to JSON
  csv-to-markdown   Convert CSV to a Markdown table
  markdown-to-html  Convert Markdown to HTML
  html-to-markdown  Convert HTML to Markdown

Examples:
  formatarc json-format '{"a":1}'
  formatarc yaml-to-json config.yaml
  cat data.csv | formatarc csv-to-json
  cat table.csv | formatarc csv-to-markdown
  cat README.md | formatarc markdown-to-html
  cat page.html | formatarc html-to-markdown

Web version: https://formatarc.com
`.trim();

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const toolArg = args[0];
  if (!isValidTool(toolArg)) {
    console.error(`Unknown tool: ${toolArg}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  const tool: Tool = toolArg;
  let input: string;

  if (args[1]) {
    if (existsSync(args[1])) {
      input = readFileSync(args[1], "utf-8");
    } else {
      input = args[1];
    }
  } else if (!process.stdin.isTTY) {
    input = readFileSync(0, "utf-8");
  } else {
    console.error("No input provided. Pass a string, a file path, or pipe from stdin.\n");
    console.error(USAGE);
    process.exit(1);
  }

  const result = convert(tool, input);

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  process.stdout.write(result.output + "\n");
}

main();
