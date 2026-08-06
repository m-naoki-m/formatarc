// PDF → Markdown 変換。
//
// 他のツールと違い入力がバイナリなので、文字列を受け取る convert() には乗せず
// 別の関数として持つ。判定の順序は formatarc.com の実装と同じ。
//
//   refused   スキャン PDF。文字情報を持たないので変換に進まない。無理に出力すると
//             存在しない見出しを作る類の捏造になる。
//   inspector 通常。pdf-inspector が見出し・表・読み順を組んで Markdown を返す。
//   fallback  pdf-inspector が文字化けを自己申告した場合。日本語の CFF フォント
//             (Adobe-Japan1) で起きる。pdf-inspector は「CID の中央値が 0x41 以上
//             なら CID = Unicode コードポイント」とみなすヒューリスティックを持つ
//             が、Adobe-Japan1 の CID は 1〜23000 の範囲にあるため日本語フォントが
//             誤判定され、CID がそのまま Unicode として出力される (「令和」が
//             タミル文字の U+0BE7 U+0FF4 になる、など)。
//             pdf.js の素のテキストへ切り替える。pdf.js 側に見出しを推定させると
//             日本語で本文まで見出し化する破綻が出るため、段落整形だけして返す。
//
// pdf-inspector は napi 版でなく WASM 版を使う。プラットフォームごとの
// ネイティブバイナリが不要で、ブラウザ版と同じバイナリが動くため挙動も揃う。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type PdfRoute = "inspector" | "fallback" | "refused";

export type PdfResult = {
  route: PdfRoute;
  markdown: string;
  pdfType: string;
  pageCount: number;
  /** refused のとき、文字起こしが必要なページ数 */
  ocrPages: number;
  /** 表を含むと判定されたか。CLI は stderr で注意を出すのに使う */
  hasTables: boolean;
  error: string;
};

const require = createRequire(import.meta.url);

type InspectorModule = {
  initSync: (input: { module: Uint8Array }) => unknown;
  classifyPdf: (bytes: Uint8Array) => {
    pdfType: string;
    pageCount: number;
    pagesNeedingOcr: number[];
  };
  processPdf: (bytes: Uint8Array) => {
    pdfType: string;
    markdown?: string;
    pageCount: number;
    pagesNeedingOcr: number[];
    hasEncodingIssues: boolean;
    layout?: { pagesWithTables?: number[] };
  };
};

let inspector: InspectorModule | null = null;

/**
 * 出力が実際に壊れているかを判定する。
 *
 * 2 つの症状を見る。片方だけでは足りない。
 *   - U+FFFD への置換。デコードできなかった文字がこれになる
 *   - 文書と無関係なスクリプトの混入。CID をそのまま Unicode として出力すると
 *     「令和」がタミル文字の U+0BE7 U+0FF4 になるといった化け方をする。この場合
 *     U+FFFD は出ないので、置換率だけを見ていると素通りする
 *
 * 混入率に上限を置いているのは、タイ語やチベット語で書かれた PDF を誤って
 * 壊れていると判定しないため。その場合は文書全体がそのスクリプトになる。
 */
function looksGarbled(markdown: string): boolean {
  if (!markdown.length) return false;

  const replacement = (markdown.match(/\uFFFD/g) ?? []).length / markdown.length;
  if (replacement > 0.005) return true;

  const stray =
    (markdown.match(
      /[\u0900-\u097F\u0A00-\u0A7F\u0B80-\u0BFF\u0C00-\u0C7F\u0D00-\u0D7F\u0E00-\u0E7F\u0F00-\u0FFF\u10A0-\u10FF\u1200-\u137F\u1400-\u167F\u1780-\u17FF]/g
    ) ?? []).length / markdown.length;
  return stray > 0.005 && stray < 0.5;
}

async function loadInspector(): Promise<InspectorModule> {
  if (inspector) return inspector;
  const mod = (await import("@firecrawl/pdf-inspector-wasm")) as unknown as InspectorModule;
  const wasmPath = require.resolve(
    "@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm"
  );
  mod.initSync({ module: readFileSync(wasmPath) });
  inspector = mod;
  return mod;
}

async function extractWithPdfjs(bytes: Uint8Array): Promise<{ markdown: string; pageCount: number }> {
  // Node では worker を使わない (メインスレッドで動かす)。CLI は単発実行なので
  // worker を立てる利点がなく、起動コストだけが乗る。
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // CJK の CMap を渡さないと、Identity-H でない日本語 PDF が読めない
  // (pdf.js が "Ensure that the `cMapUrl` API parameter is provided" を出す)。
  // ブラウザ版は fetch で取りにいくが、Node ではパッケージ内のパスを直接渡す。
  const cMapUrl = path.join(
    path.dirname(require.resolve("pdfjs-dist/package.json")),
    "cmaps/"
  );
  const task = lib.getDocument({
    data: bytes,
    useWorkerFetch: false,
    cMapUrl,
    cMapPacked: true,
  });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
    }
    pages.push(text);
  }
  const pageCount = doc.numPages;
  await task.destroy();
  const markdown = pages
    .join("\n\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  return { markdown, pageCount };
}

export async function convertPdf(bytes: Uint8Array): Promise<PdfResult> {
  const empty: PdfResult = {
    route: "inspector",
    markdown: "",
    pdfType: "",
    pageCount: 0,
    ocrPages: 0,
    hasTables: false,
    error: "",
  };

  let wasm: InspectorModule;
  try {
    wasm = await loadInspector();
  } catch (error) {
    return { ...empty, error: `Failed to load the PDF engine: ${describe(error)}` };
  }

  let classification;
  try {
    classification = wasm.classifyPdf(bytes);
  } catch (error) {
    return { ...empty, error: pdfErrorMessage(error) };
  }

  if (classification.pdfType === "Scanned" || classification.pdfType === "ImageBased") {
    return {
      ...empty,
      route: "refused",
      pdfType: classification.pdfType,
      pageCount: classification.pageCount,
      ocrPages: classification.pagesNeedingOcr?.length ?? classification.pageCount,
    };
  }

  let result;
  try {
    result = wasm.processPdf(bytes);
  } catch (error) {
    return { ...empty, error: pdfErrorMessage(error) };
  }

  // hasEncodingIssues は過検出することがある。日本銀行の金融システムレポート
  // (113,550 文字) は全く化けていないのにフラグが立ち、そのまま落とすと
  // 正しく取れている見出しと表を捨ててしまう。実際に壊れている証拠がある
  // ときだけフォールバックする。
  const markdown = result.markdown ?? "";
  if (markdown.length > 0 && !(result.hasEncodingIssues && looksGarbled(markdown))) {
    return {
      ...empty,
      route: "inspector",
      markdown,
      pdfType: result.pdfType,
      pageCount: result.pageCount,
      ocrPages: result.pagesNeedingOcr?.length ?? 0,
      hasTables: (result.layout?.pagesWithTables?.length ?? 0) > 0,
    };
  }

  try {
    const fallback = await extractWithPdfjs(bytes);
    return {
      ...empty,
      route: "fallback",
      markdown: fallback.markdown,
      pdfType: result.pdfType,
      pageCount: fallback.pageCount || result.pageCount,
    };
  } catch (error) {
    return { ...empty, error: pdfErrorMessage(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pdfErrorMessage(error: unknown): string {
  const message = describe(error);
  if (/password/i.test(message)) {
    return "This PDF is password protected. Remove the protection and try again.";
  }
  if (/encrypted/i.test(message)) {
    return "This PDF is encrypted and could not be opened.";
  }
  return `Could not read this PDF: ${message}`;
}
