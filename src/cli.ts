#!/usr/bin/env node

import { readFileSync, existsSync } from "fs";
import { convert, isPdfTool, isValidTool, PDF_TOOL, type Tool } from "./converter.js";
import { convertPdf } from "./pdf.js";

const USAGE = `
formatarc — convert JSON, YAML, CSV, Markdown, HTML, and PDF from the terminal

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
  pdf-to-markdown   Extract the text of a PDF as Markdown

Examples:
  formatarc json-format '{"a":1}'
  formatarc yaml-to-json config.yaml
  cat data.csv | formatarc csv-to-json
  cat table.csv | formatarc csv-to-markdown
  cat README.md | formatarc markdown-to-html
  cat page.html | formatarc html-to-markdown
  formatarc pdf-to-markdown report.pdf
  cat report.pdf | formatarc pdf-to-markdown

Notes on pdf-to-markdown:
  Works on PDFs that contain text. A scanned PDF holds no text and cannot be
  converted — the command says so instead of guessing. Tables can come out
  misaligned when the PDF carries no table structure, so check the result
  against the original. Formulas are not supported.

Web version: https://formatarc.com
`.trim();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * stdin をストリームで読み切る。readFileSync(0) はパイプの中身が大きいと
 * EAGAIN で落ちる (PDF のような数百 KB 以上で顕在化する)。
 */
async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/** PDF はバイナリなので utf-8 で読まない。ファイルか stdin から生バイトを取る。 */
async function readBinaryInput(arg: string | undefined): Promise<Uint8Array> {
  if (arg) {
    if (!existsSync(arg)) {
      fail(`File not found: ${arg}\n\nPass a path to a PDF file, or pipe one from stdin.`);
    }
    return new Uint8Array(readFileSync(arg));
  }
  if (process.stdin.isTTY) {
    fail(`No input provided. Pass a PDF file path, or pipe one from stdin.\n\n${USAGE}`);
  }
  return new Uint8Array(await readStdin());
}

async function runPdf(fileArg: string | undefined): Promise<void> {
  const bytes = await readBinaryInput(fileArg);

  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    fail("This does not look like a PDF file (missing the %PDF- header).");
  }

  const result = await convertPdf(bytes);

  if (result.error) fail(result.error);

  if (result.route === "refused") {
    fail(
      `This PDF is a scanned image and contains no text (${result.ocrPages} of ` +
        `${result.pageCount} pages need OCR). Converting it would require OCR, ` +
        `which this tool does not do.`
    );
  }

  // 注意書きは stderr に出す。stdout はパイプで受け取れるよう Markdown だけにする。
  if (result.route === "fallback") {
    console.error(
      "note: text in this PDF was hard to read reliably, so only the text was " +
        "extracted — no headings or tables were generated."
    );
  } else if (result.hasTables) {
    console.error(
      "note: this PDF contains tables. If the file carries no table structure, " +
        "rows and columns can shift. Check the result against the original."
    );
  }

  process.stdout.write(result.markdown + "\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const toolArg = args[0];

  if (isPdfTool(toolArg)) {
    await runPdf(args[1]);
    return;
  }

  if (!isValidTool(toolArg)) {
    console.error(`Unknown tool: ${toolArg}\n`);
    fail(USAGE);
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
    // readFileSync(0) は大きなパイプ入力で EAGAIN を返すため、ここもストリームで読む。
    input = (await readStdin()).toString("utf-8");
  } else {
    console.error("No input provided. Pass a string, a file path, or pipe from stdin.\n");
    fail(USAGE);
  }

  const result = convert(tool, input);

  if (result.error) fail(result.error);

  process.stdout.write(result.output + "\n");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

// PDF_TOOL は USAGE と型の両方から参照される。未使用警告を避けるためのダミー参照は
// 置かない (isPdfTool 経由で使われている)。
void PDF_TOOL;
