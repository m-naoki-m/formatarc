#!/usr/bin/env node

import { readFileSync, existsSync } from "fs";
import {
  convert,
  formatHtml,
  isHtmlFormatTool,
  isPdfTool,
  isQzTool,
  isValidTool,
  PDF_TOOL,
  type Tool,
} from "./converter.js";
import { convertPdf } from "./pdf.js";
import { analyzeQiitaZenn, type QzDirection, type QzFinding } from "./qiita-zenn.js";

const USAGE = `
formatarc — convert and format JSON, YAML, CSV, Markdown, HTML, and PDF from the terminal

Usage:
  formatarc <tool> [input]
  formatarc <tool> <file>
  cat file | formatarc <tool>

Tools:
  json-format       Pretty-print JSON
  yaml-to-json      Convert YAML to JSON
  json-to-yaml      Convert JSON to YAML
  csv-to-json       Convert CSV to JSON
  json-to-csv       Convert JSON (objects) to CSV
  csv-to-markdown   Convert CSV to a Markdown table
  markdown-to-csv   Convert Markdown tables to CSV
  markdown-to-html  Convert Markdown to HTML
  html-to-markdown  Convert HTML to Markdown
  html-format       Pretty-print HTML (uses Prettier)
  pdf-to-markdown   Extract the text of a PDF as Markdown
  qiita-to-zenn     Check a Qiita article for Zenn compatibility
  zenn-to-qiita     Check a Zenn article for Qiita compatibility

Examples:
  formatarc json-format '{"a":1}'
  formatarc yaml-to-json config.yaml
  cat data.csv | formatarc csv-to-json
  cat data.json | formatarc json-to-csv
  cat table.csv | formatarc csv-to-markdown
  cat table.md | formatarc markdown-to-csv
  cat README.md | formatarc markdown-to-html
  cat page.html | formatarc html-to-markdown
  cat page.html | formatarc html-format
  formatarc pdf-to-markdown report.pdf
  cat report.pdf | formatarc pdf-to-markdown
  formatarc qiita-to-zenn article.md > converted.md
  formatarc zenn-to-qiita article.md > /dev/null

Notes on pdf-to-markdown:
  Works on PDFs that contain text. A scanned PDF holds no text and cannot be
  converted — the command says so instead of guessing. Tables can come out
  misaligned when the PDF carries no table structure, so check the result
  against the original. Formulas are not supported.

Notes on qiita-to-zenn / zenn-to-qiita:
  Reports every syntax difference and converts only the ones that convert
  without losing meaning. The converted Markdown goes to stdout; the report
  goes to stderr. Exits 1 when the article carries anything that breaks
  silently, needs a human decision, or has no counterpart on the other
  platform — so it can gate a publishing pipeline. Exits 0 when the only
  findings were converted losslessly.

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

/**
 * Qiita / Zenn の互換チェック。
 *
 * stdout は変換後の Markdown だけにして、報告は stderr へ回す。そうしないと
 * `formatarc qiita-to-zenn article.md > out.md` で診断文が記事に混ざる。
 *
 * 意味を選ばないと変換できないルール (lossy) は、変換せずに報告だけする。
 * 対話できない CLI が著者の代わりに意味を選ぶわけにいかないため、選択肢を
 * 出したうえで終了コードを 1 にして人の目に戻す。
 */
function runQiitaZenn(direction: QzDirection, input: string): void {
  const result = analyzeQiitaZenn(input, direction, "en");

  if (result.error) fail(result.error);

  if (result.findings.length > 0) {
    const label: Record<QzFinding["severity"], string> = {
      "breaks-silently": "breaks silently",
      degrades: "degrades",
      info: "info",
    };
    console.error(`${result.counts.total} finding(s):`);
    for (const f of result.findings) {
      const where = f.line > 0 ? `line ${f.line}` : "frontmatter";
      console.error(`  ${where}: [${label[f.severity]}] ${f.feature} — ${f.detail}`);
      if (f.excerpt) console.error(`    ${f.excerpt}`);
      if (f.choice) {
        const options = f.choice.options.map((o) => o.value).join(" | ");
        console.error(`    choice needed: ${f.choice.prompt} (${options})`);
      }
    }
    console.error(
      `converted: ${result.counts.deterministic}, needs a decision: ` +
        `${result.counts.lossy}, no counterpart: ${result.counts.unsupported}, ` +
        `breaks silently: ${result.counts.breaksSilently}`,
    );
  }

  process.stdout.write(result.output + "\n");

  // 自動で解決できなかったものが 1 件でもあれば非ゼロ。deterministic だけなら 0。
  const unresolved =
    result.counts.lossy + result.counts.unsupported + result.counts.breaksSilently;
  if (unresolved > 0) process.exit(1);
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

  if (!isValidTool(toolArg) && !isQzTool(toolArg) && !isHtmlFormatTool(toolArg)) {
    console.error(`Unknown tool: ${toolArg}\n`);
    fail(USAGE);
  }

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

  if (isHtmlFormatTool(toolArg)) {
    const result = await formatHtml(input);
    if (result.error) fail(result.error);
    process.stdout.write(result.output);
    return;
  }

  if (isQzTool(toolArg)) {
    runQiitaZenn(toolArg as QzDirection, input);
    return;
  }

  const result = convert(toolArg as Tool, input);

  if (result.error) fail(result.error);

  process.stdout.write(result.output + "\n");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

// PDF_TOOL は USAGE と型の両方から参照される。未使用警告を避けるためのダミー参照は
// 置かない (isPdfTool 経由で使われている)。
void PDF_TOOL;
