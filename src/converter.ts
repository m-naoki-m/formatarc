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
  | "json-to-csv"
  | "csv-to-markdown"
  | "markdown-to-csv"
  | "markdown-to-html"
  | "html-to-markdown";

const TOOLS: Tool[] = [
  "json-format",
  "yaml-to-json",
  "json-to-yaml",
  "csv-to-json",
  "json-to-csv",
  "csv-to-markdown",
  "markdown-to-csv",
  "markdown-to-html",
  "html-to-markdown",
];

export function isValidTool(value: string): value is Tool {
  return TOOLS.includes(value as Tool);
}

/**
 * PDF → Markdown だけは入力がバイナリで、文字列を受け取る convert() に乗らない。
 * Tool 型に混ぜると「型は通るが実行できない」組み合わせができるので別に持つ。
 * 実装は ./pdf.ts の convertPdf()。
 */
export const PDF_TOOL = "pdf-to-markdown";

// 実装は再 export しない。pdf.ts は node:fs / node:module / node:path を使うので、
// ここから流すとブラウザ向けにバンドルする側 (Chrome 拡張) が Node 専用 import で
// 止まる。利用側は package.json の exports 経由で "formatarc/pdf" から取る。

export function isPdfTool(value: string): boolean {
  return value === PDF_TOOL;
}

/**
 * Qiita / Zenn の互換チェックも convert() には乗らない。返すのが変換結果ではなく
 * 診断 (findings) で、CLI は終了コードで CI を止めるために使うため。
 * 実装は ./qiita-zenn.ts の analyzeQiitaZenn()。PDF と同じ理由でここからは
 * 再 export しない (rules 表 2200 行を、使わない側にまで抱えさせない)。
 */
export const QZ_TOOLS = ["qiita-to-zenn", "zenn-to-qiita"] as const;

export function isQzTool(value: string): boolean {
  return (QZ_TOOLS as readonly string[]).includes(value);
}

/**
 * HTML の整形。prettier 3 は非同期で、同期の convert() には乗らないので別に持つ
 * (PDF / QZ と同じ扱い)。web 版の html-formatter と同じく standalone +
 * plugins/html を使い、plugins/flow は html パーサからしか使わないので引き込まない。
 */
export const HTML_FORMAT_TOOL = "html-format";

export function isHtmlFormatTool(value: string): boolean {
  return value === HTML_FORMAT_TOOL;
}

export async function formatHtml(input: string): Promise<ConvertResult> {
  if (!input.trim()) {
    return { output: "", error: "Input is empty." };
  }

  try {
    const [{ format }, htmlPlugin] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/html"),
    ]);
    const output = await format(input, {
      parser: "html",
      plugins: [htmlPlugin],
      embeddedLanguageFormatting: "off",
    });
    return { output: output.endsWith("\n") ? output : `${output}\n`, error: "" };
  } catch (err) {
    const first =
      err instanceof Error
        ? err.message.split("\n")[0].replace(/^SyntaxError:\s*/i, "").trim()
        : "";
    return { output: "", error: first ? `HTML syntax error: ${first}` : "HTML syntax error." };
  }
}

export function convert(tool: Tool, input: string): ConvertResult {
  if (!input.trim()) {
    return { output: "", error: "Input is empty." };
  }

  return runConvert(tool, input);
}

function runConvert(tool: Tool, input: string): ConvertResult {
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
      case "json-to-csv":
        return convertJsonToCsv(input);
      case "csv-to-markdown":
        return convertCsvToMarkdown(input);
      case "markdown-to-csv":
        return convertMarkdownToCsv(input);
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

// JSON → CSV
//
// 実装は formatarc.com の lib/tooling.ts convertJsonToCsv() と同じ。出力を
// 突き合わせられるよう、平坦化の規則もヘッダーの並び方も揃えてある。

// ネストしたオブジェクトを "address.city" のようなドット区切りの列名へ平坦化する。
// 空オブジェクトは列そのものが消えないよう空文字の列として残す。配列と scalar は
// そのまま値として置き、CSV セルにするのは csvCellValue の仕事。
function flattenJsonRow(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out[prefix] = "";
      return;
    }
    for (const [key, child] of entries) {
      flattenJsonRow(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out[prefix] = value;
}

function csvCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function convertJsonToCsv(input: string): ConvertResult {
  // JSON.parse は投げさせる。convert() の try/catch が formatError へ回すので、
  // 構文エラーは json-format と同じ行番号つきのメッセージになる。
  const parsed: unknown = JSON.parse(input);

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

  let records: Record<string, unknown>[];
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { output: "", error: "The JSON array is empty." };
    }
    if (!parsed.every(isPlainObject)) {
      return {
        output: "",
        error: "Every array element must be an object (for example: [{...}, {...}]).",
      };
    }
    records = parsed as Record<string, unknown>[];
  } else if (isPlainObject(parsed)) {
    records = [parsed];
  } else {
    return {
      output: "",
      error: "The top-level JSON value must be an object or an array of objects.",
    };
  }

  // 列は全レコードのキーの和集合を初出順に並べる。Object.keys(records[0]) だけだと
  // 後ろのレコードにしか出てこない列 (API レスポンスの省略可能フィールド) が黙って
  // 落ちる。
  const flattenedRows = records.map((record) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      flattenJsonRow(value, key, out);
    }
    return out;
  });
  const headerOrder: string[] = [];
  const seenHeaders = new Set<string>();
  for (const row of flattenedRows) {
    for (const key of Object.keys(row)) {
      if (!seenHeaders.has(key)) {
        seenHeaders.add(key);
        headerOrder.push(key);
      }
    }
  }

  const table = [
    headerOrder,
    ...flattenedRows.map((row) => headerOrder.map((key) => csvCellValue(row[key]))),
  ];

  return { output: Papa.unparse(table), error: "" };
}

// Markdown → CSV
//
// 実装は formatarc.com の lib/tooling.ts convertMarkdownToCsv() と同じ。

const SEPARATOR_CELL_PATTERN = /^:?-+:?$/;

// フェンス付きコードブロック (``` または ~~~、CommonMark のブロック字下げ上限に
// あたる 3 スペースまでの字下げを許す) の中にある行へ印を付ける。その中のパイプの
// 並びは表ではなくソースコードなので、表の走査から外す。閉じられていないフェンスは
// 以降を全部コードとして扱う (CommonMark と同じ)。
function computeFencedLines(lines: string[]): boolean[] {
  const inFence: boolean[] = new Array(lines.length).fill(false);
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceChar === null) {
      if (match) {
        fenceChar = match[1][0];
        fenceLen = match[1].length;
        inFence[i] = true;
      }
      continue;
    }
    inFence[i] = true;
    // 閉じるフェンスは、同じ文字で、開いたときと同じ長さ以上で、フェンス記号の
    // ほかに何も持たない (info string を付けられない)。
    if (
      match &&
      match[1][0] === fenceChar &&
      match[1].length >= fenceLen &&
      line.slice(match[0].length).trim() === ""
    ) {
      fenceChar = null;
      fenceLen = 0;
    }
  }
  return inFence;
}

// 表の 1 行を生のセル文字列へ割る。GFM では行頭と行末のパイプは省略できるので、
// あれば剥がす。`|` が区切りになるかどうかは直前のバックスラッシュの本数で決まる。
// GFM は `\\` を literal のバックスラッシュとして読むので、奇数本のときだけ
// 相方のいない `\` が残ってパイプをエスケープする。エスケープされたパイプは列の
// 区切りと取り違えないようセルの中へそのまま (バックスラッシュ列 + `|`) 残し、
// 境界が確定してから decodeCellText がまとめて解く。
function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);

  if (body.endsWith("|")) {
    let trailingBackslashes = 0;
    for (let k = body.length - 2; k >= 0 && body[k] === "\\"; k--) trailingBackslashes++;
    if (trailingBackslashes % 2 === 0) body = body.slice(0, -1);
  }

  const cells: string[] = [];
  let buf = "";
  let backslashRun = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "|") {
      if (backslashRun % 2 === 1) {
        // 直前の奇数本目のバックスラッシュは既に buf に入っているので、パイプを
        // セルへ畳み込むだけでよい。
        buf += "|";
      } else {
        cells.push(buf);
        buf = "";
      }
      backslashRun = 0;
      continue;
    }
    buf += ch;
    backslashRun = ch === "\\" ? backslashRun + 1 : 0;
  }
  cells.push(buf);
  return cells;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL_PATTERN.test(cell.trim()));
}

// CommonMark の ASCII 約物集合。Markdown のソースでバックスラッシュがエスケープ
// できるのはこれだけで、ほかの文字の前に置かれたバックスラッシュは literal として残る。
const ASCII_PUNCTUATION_ESCAPE = /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

// 表のセルに実際に現れる名前つき文字参照。HTML5 の定義は 2000 個以上あるが、
// セルの中で要るのはこれだけなので、実体表を丸ごと持たずに列挙する。
const NAMED_CHAR_REFS: Record<string, string> = {
  vert: "|",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// 3 つの復元規則を 1 本の選択にまとめ、1 回の replace で走らせる。`.replace()` を
// 連ねると、復元済みの参照 (`&amp;#124;` の `&amp;` が先に `&` になったもの) を
// 後の回が拾って `|` まで復元してしまう。GFM はそこまで解かない。
const DECODE_PATTERN = new RegExp(
  `<br\\s*/?>|${ASCII_PUNCTUATION_ESCAPE.source}|&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|(${Object.keys(
    NAMED_CHAR_REFS,
  ).join("|")}));`,
  "gi",
);

// セルの literal な文字列以外が表せるもの、つまり `<br>` (物理的な改行は行を
// 終わらせるので、GFM の表がセル内改行を表す唯一の手段)、バックスラッシュ
// エスケープ、文字参照 (10 進・16 進・上の名前つき) を解く。先に前後の空白を
// 落とすので、端にある `<br>` の改行も一緒に消えずに残る。
function decodeCellText(raw: string): string {
  return raw.trim().replace(DECODE_PATTERN, (match, dec?: string, hex?: string, named?: string) => {
    if (match[0] === "\\") return match[1];
    if (match[0] === "<") return "\n";
    if (dec !== undefined) return String.fromCodePoint(Number(dec));
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
    return NAMED_CHAR_REFS[(named ?? "").toLowerCase()] ?? match;
  });
}

function convertMarkdownToCsv(input: string): ConvertResult {
  const lines = input.split(/\r\n|\r|\n/);
  const fencedLines = computeFencedLines(lines);
  const tableBlocks: string[][][] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // フェンス付きコードブロックは中身を表の判定から守る。GFM の表のヘッダー行に
    // 許される字下げは 3 スペースまでで、4 以上は字下げコードブロックになる。
    if (fencedLines[i] || line.trim() === "" || !line.includes("|") || /^ {4,}/.test(line)) {
      i++;
      continue;
    }
    const nextLine = lines[i + 1];
    if (nextLine === undefined || fencedLines[i + 1] || !nextLine.includes("|")) {
      i++;
      continue;
    }
    const headerCells = splitTableRow(line);
    const separatorCells = splitTableRow(nextLine);
    if (separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      i++;
      continue;
    }

    // 表が見つかった。ヘッダー行、区切り行 (構造でありデータではないので落とす)、
    // そのあと空行かパイプを持たない行に当たるまでがデータ行。
    const columnCount = headerCells.length;
    const normalizeRow = (cells: string[]) => {
      const trimmed = cells.length > columnCount ? cells.slice(0, columnCount) : cells;
      const padded =
        trimmed.length === columnCount
          ? trimmed
          : [...trimmed, ...Array(columnCount - trimmed.length).fill("")];
      return padded.map(decodeCellText);
    };

    const rows: string[][] = [normalizeRow(headerCells)];
    let j = i + 2;
    while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) {
      rows.push(normalizeRow(splitTableRow(lines[j])));
      j++;
    }
    tableBlocks.push(rows);
    i = j;
  }

  if (tableBlocks.length === 0) {
    return { output: "", error: "No Markdown table was found. Paste a pipe-delimited table." };
  }

  // 表ごとに Papa.unparse を呼ぶ。全部を 1 つの配列へ積んで 1 回で unparse すると
  // 全行が同じ列数を共有するため、列数の違う 2 つの表がぶら下がった CSV になる。
  // 複数の表は空行 1 つで区切る形にしてあり、Papa の既定の行終端は CRLF なので
  // "\r\n\r\n" がちょうど空行 1 行にあたる。
  const output = tableBlocks.map((rows) => Papa.unparse(rows)).join("\r\n\r\n");

  return { output, error: "" };
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

// Locate a trailing comma (a comma whose next non-whitespace character is `}`
// or `]`). String-aware so commas/brackets inside string values are ignored.
// Returns the comma's 1-based line, or null if there is none.
function findTrailingCommaLine(input: string): number | null {
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (j < input.length && (input[j] === "}" || input[j] === "]")) {
        return input.slice(0, i + 1).split("\n").length;
      }
    }
  }
  return null;
}

function formatError(err: unknown, input: string, tool: Tool): string {
  if (err instanceof YAML.YAMLParseError) {
    const line = err.linePos?.[0]?.line;
    return line ? `YAML syntax error near line ${line}.` : "YAML syntax error.";
  }

  if (err instanceof Error && err.name === "SyntaxError") {
    // Trailing comma is the most common JSON mistake, and parsers report it at
    // the *following* bracket (often on the next line), not at the comma. Find
    // the comma ourselves and point at its line.
    const trailingCommaLine = findTrailingCommaLine(input);
    if (trailingCommaLine !== null) {
      return `Invalid JSON: remove the trailing comma on line ${trailingCommaLine}.`;
    }
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
