/**
 * Qiita / Zenn compatibility engine.
 *
 * This is a *diagnosis* engine that also performs the conversions it can prove
 * are lossless. It is deliberately not a "paste and publish" converter.
 *
 * The reason is measured, not stylistic (scripts/benchmarks/qiita-zenn-syntax/):
 * of 74 syntax differences, only 37 convert deterministically. 14 need a human
 * decision and 23 have no counterpart at all. Worse, Zenn renders with
 * `html: false`, so raw HTML that Qiita accepts — `<details>`, `<img width>`,
 * `<dl>` — reaches the reader as escaped tags. Nothing throws; the article just
 * looks broken after it is published. 21 rules are that shape.
 *
 * So the contract is: always report, convert only what is safe, and never
 * silently pick a meaning the author did not choose.
 *
 * The rule table itself lives in lib/qiita-zenn-rules.generated.ts, generated
 * from the benchmark. Rules whose detection cannot be a regex over raw text
 * (frontmatter conditions, structural HTML rewrites) carry `kind: "handler"`
 * and must be claimed by a function in this file — `assertHandlerCoverage()`
 * turns a missing one into a loud failure instead of a rule that quietly
 * stops firing.
 */

import YAML from "yaml";
import {
  qiitaZennRules,
  qiitaZennHandlerDetectIds,
  qiitaZennHandlerTransformIds,
  type QzCategory,
  type QzDirection,
  type QzRule,
  type QzSeverity,
} from "./qiita-zenn-rules.generated.js";

/**
 * ルール表が持つ文言は ja と en の 2 つだけなので、ここでの locale もその 2 つに
 * 縛る。formatarc.com 側の Locale (7 言語) を持ち込むと、表に無い言語を渡せる型に
 * なってしまう。CLI は "en" 固定で、拡張はブラウザの言語から選ぶ。
 */
export type QzLocale = "ja" | "en";

export type { QzCategory, QzDirection, QzSeverity };

export type QzFinding = {
  ruleId: string;
  /** 1-indexed line in the *original* input. 0 when the finding is about the frontmatter as a whole. */
  line: number;
  /** The offending text, trimmed for display. Empty for frontmatter-level findings. */
  excerpt: string;
  category: QzCategory;
  severity: QzSeverity;
  target: "body" | "frontmatter";
  /** Localized feature name. */
  feature: string;
  /** Localized "what happens" sentence. */
  detail: string;
  /** Present only for lossy rules: the choice the author has to make. */
  choice: {
    prompt: string;
    options: Array<{ value: string; label: string }>;
    selected: string;
  } | null;
  source: string | null;
};

export type QzChoices = Record<string, string>;

export type QzResult = {
  /** Converted text. Everything the engine could not prove safe is left untouched. */
  output: string;
  findings: QzFinding[];
  counts: {
    total: number;
    breaksSilently: number;
    deterministic: number;
    lossy: number;
    unsupported: number;
  };
  /** Set when the input could not be processed at all. */
  error: string;
  status: string;
};

/**
 * Inputs larger than this are refused rather than scanned.
 *
 * 54 of the rules are regexes run over the whole document, synchronously, on
 * the main thread — there is no worker to isolate a slow one. The `<img>`
 * rules chain three `[^>]*` segments, which backtracks hard on text that opens
 * a tag and never closes it.
 *
 * Measured 2026-08-04 (scripts/benchmarks/qiita-zenn-syntax has the harness):
 *
 *   real article, longest in this repo (36 KB)   12 ms
 *   that article concatenated to 509 KB          13 ms
 *   adversarial unterminated `<img` (402 KB)   2231 ms   <- freezes the page
 *
 * 128 KB keeps the adversarial worst case near 200 ms while leaving ~3.5x
 * headroom over the longest real article. Anyone converting more than one
 * article at a time is better served by doing them one at a time anyway,
 * since every finding has to be read.
 */
const MAX_INPUT_BYTES = 128 * 1024;

const isLossless = (r: QzRule) => r.category === "deterministic";

function appliesTo(rule: QzRule, direction: QzDirection): boolean {
  return rule.direction === direction || rule.direction === "both";
}

/**
 * What the reader has to do about a finding.
 *
 * Keyed by category first, because that is what decides whether there is an
 * action at all. Keying on severity alone told the reader that an *already
 * converted* line "breaks after publishing" — true of the input, wrong about
 * the output they are looking at.
 */
const detailByLocale: Record<"ja" | "en", { deterministic: string; lossy: string; unsupported: Record<QzSeverity, string> }> = {
  ja: {
    deterministic: "対応が一つに決まるため、下の下書きでは変換済みです。",
    lossy: "移した先に同じものがありません。どう寄せるかを選んでください。",
    unsupported: {
      "breaks-silently":
        "移した先にこの書き方がありません。残したままだと、エラーは出ないまま公開後の表示が壊れます。",
      degrades: "移した先にこの書き方がありません。公開はできますが、表示は元と変わります。",
      info: "移した先にこの書き方がありません。表示への実害はありません。",
    },
  },
  en: {
    deterministic: "The mapping is unambiguous, so this is already converted in the draft below.",
    lossy: "There is no equivalent on the other side. Choose how to map it.",
    unsupported: {
      "breaks-silently":
        "The target has no equivalent. Left in place it raises no error — the published article simply renders wrong.",
      degrades: "The target has no equivalent. It still publishes, but it will not look the same.",
      info: "The target has no equivalent. No impact on rendering.",
    },
  },
};

/** Qiita/Zenn are Japanese-language platforms; es/pt/ko readers fall back to English rule text. */
function textFor(locale: QzLocale, text: { ja: string; en: string }): string {
  return locale === "ja" ? text.ja : text.en;
}

function detailFor(locale: QzLocale, category: QzCategory, severity: QzSeverity): string {
  const table = locale === "ja" ? detailByLocale.ja : detailByLocale.en;
  if (category === "deterministic") return table.deterministic;
  if (category === "lossy") return table.lossy;
  return table.unsupported[severity];
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

type Frontmatter = {
  present: boolean;
  /** Raw YAML text between the delimiters. */
  raw: string;
  data: Record<string, unknown>;
  /** Number of lines the frontmatter block occupies, including both `---`. */
  lineCount: number;
  /** True when the block exists but did not parse as YAML. */
  malformed: boolean;
};

const EMPTY_FRONTMATTER: Frontmatter = {
  present: false,
  raw: "",
  data: {},
  lineCount: 0,
  malformed: false,
};

/**
 * Split a leading `---` fenced YAML block.
 *
 * gray-matter is not used here: it is a Node-side dependency and this module
 * runs in the browser. The format is simple enough that hand-splitting is
 * safer than pulling a parser into the client bundle.
 */
export function splitFrontmatter(input: string): { frontmatter: Frontmatter; body: string } {
  if (!/^---\r?\n/.test(input)) {
    return { frontmatter: EMPTY_FRONTMATTER, body: input };
  }
  const rest = input.replace(/^---\r?\n/, "");
  const closing = rest.match(/^---[ \t]*(\r?\n|$)/m);
  if (!closing || closing.index === undefined) {
    return { frontmatter: EMPTY_FRONTMATTER, body: input };
  }
  const raw = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length);
  const openingLines = 1;
  const rawLines = raw === "" ? 0 : raw.replace(/\r?\n$/, "").split(/\r?\n/).length;
  const lineCount = openingLines + rawLines + 1;

  let data: Record<string, unknown> = {};
  let malformed = false;
  try {
    const parsed: unknown = YAML.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    malformed = true;
  }
  return {
    frontmatter: { present: true, raw, data, lineCount, malformed },
    body,
  };
}

// ---------------------------------------------------------------------------
// Hand-written detectors
//
// Each entry answers "does this rule fire for this document?". They exist
// because the condition is about parsed frontmatter, not about text, and
// because `detect.expression` in rules.json is a description — evaluating it
// would need `new Function`, which the production CSP forbids.
// ---------------------------------------------------------------------------

const ZENN_TOPIC_FORBIDDEN = /[ -/:-@[-`{-~]/;

type DetectContext = { frontmatter: Frontmatter; body: string };

const handlerDetectors: Record<string, (ctx: DetectContext) => boolean> = {
  // --- Qiita -> Zenn -------------------------------------------------------
  "q2z-fm-title": ({ frontmatter }) => {
    const t = frontmatter.data.title;
    return typeof t === "string" && t.length > 70;
  },
  "q2z-fm-tags-topics": ({ frontmatter }) => {
    const tags = frontmatter.data.tags;
    if (!Array.isArray(tags)) return false;
    if (tags.length > 5) return true;
    return tags.some((tag) => {
      const name = typeof tag === "string" ? tag : tagName(tag);
      if (!name) return false;
      return ZENN_TOPIC_FORBIDDEN.test(name) || name.length > 18;
    });
  },
  "q2z-fm-tag-versions": ({ frontmatter }) => {
    const tags = frontmatter.data.tags;
    if (!Array.isArray(tags)) return false;
    return tags.some((tag) => {
      if (!tag || typeof tag !== "object") return false;
      const versions = (tag as Record<string, unknown>).versions;
      return Array.isArray(versions) && versions.length > 0;
    });
  },
  "q2z-fm-private-false": ({ frontmatter }) => frontmatter.data.private === false,
  "q2z-fm-private-true": ({ frontmatter }) => frontmatter.data.private === true,
  // Zenn slugs are globally unique and cannot be changed after creation, so this
  // always needs a human decision when a Qiita article is being moved.
  "q2z-fm-id-slug": ({ frontmatter }) => frontmatter.present,
  "q2z-fm-emoji": ({ frontmatter }) => frontmatter.present && !frontmatter.data.emoji,
  "q2z-fm-type": ({ frontmatter }) => frontmatter.present && !frontmatter.data.type,
  "q2z-fm-slide": ({ frontmatter }) => frontmatter.data.slide === true,
  "q2z-fm-organization": ({ frontmatter }) => Boolean(frontmatter.data.organization_url_name),
  "q2z-fm-updated-at": ({ frontmatter }) => Boolean(frontmatter.data.updated_at),
  "q2z-fm-cli-only-fields": ({ frontmatter }) =>
    ["ignorePublish", "posting_campaign_uuid", "agreed_posting_campaign_term"].some(
      (k) => k in frontmatter.data,
    ),

  // --- Zenn -> Qiita -------------------------------------------------------
  "z2q-fm-title": ({ frontmatter }) => Boolean(frontmatter.data.title),
  "z2q-fm-topics-tags": ({ frontmatter }) => Array.isArray(frontmatter.data.topics),
  "z2q-fm-published": ({ frontmatter }) => typeof frontmatter.data.published === "boolean",
  // The Zenn slug is the filename; carrying it over is a decision about where
  // the Qiita CLI file lands, so it is surfaced whenever frontmatter exists.
  "z2q-fm-slug-filename": ({ frontmatter }) => frontmatter.present,
  "z2q-fm-emoji": ({ frontmatter }) => Boolean(frontmatter.data.emoji),
  "z2q-fm-type": ({ frontmatter }) => Boolean(frontmatter.data.type),
  "z2q-fm-published-at": ({ frontmatter }) => Boolean(frontmatter.data.published_at),
  "z2q-fm-publication": ({ frontmatter }) => Boolean(frontmatter.data.publication_name),
};

function tagName(tag: unknown): string | null {
  if (typeof tag === "string") return tag;
  if (tag && typeof tag === "object") {
    const name = (tag as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Code regions
//
// Syntax that appears *inside* a code block is being quoted, not used. An
// article explaining ":::note info" must not be told to convert its own
// example, and `@startuml` inside a ```plantuml fence is not a Qiita mention.
// Both were real false positives before this existed (measured 2026-08-04).
//
// Regions are half-open [start, end) offsets into the text, so a match's
// index can be tested without altering the string — line numbers stay exact.
// ---------------------------------------------------------------------------

type Region = [start: number, end: number];

/** Content lines inside fenced blocks. The fence lines themselves stay live: ```math is a rule. */
function fencedRegions(text: string): Region[] {
  const regions: Region[] = [];
  const fence = /^([ \t]*)(`{3,}|~{3,})/;
  let offset = 0;
  let marker: string | null = null;
  let blockStart = 0;
  for (const line of text.split("\n")) {
    const len = line.length + 1; // include the newline we split on
    const m = fence.exec(line);
    if (marker === null) {
      if (m) {
        marker = m[2][0];
        blockStart = offset + len; // content begins after the opening fence
      }
    } else if (m && m[2][0] === marker) {
      if (blockStart < offset) regions.push([blockStart, offset]);
      marker = null;
    }
    offset += len;
  }
  // Unterminated fence: treat the remainder as code, which is how renderers do.
  if (marker !== null && blockStart < text.length) regions.push([blockStart, text.length]);
  return regions;
}

/** Inline code spans, including the backticks. */
function inlineCodeRegions(text: string): Region[] {
  const regions: Region[] = [];
  const re = /(`+)(?:[^`\n]|(?!\1)`)*\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    regions.push([m.index, m.index + m[0].length]);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return regions;
}

function inRegions(regions: Region[], index: number): boolean {
  for (const [start, end] of regions) {
    if (index >= start && index < end) return true;
    if (index < start) break; // regions are produced in ascending order
  }
  return false;
}

/**
 * Replace matches that fall outside code.
 *
 * Every transform routes through this, so a conversion can never rewrite an
 * example inside a fence — the same guarantee the detector gives.
 */
function replaceOutside(
  text: string,
  regions: Region[],
  re: RegExp,
  replacer: (match: RegExpMatchArray) => string,
): string {
  return text.replace(re, (...args: unknown[]) => {
    const matched = args[0] as string;
    const index = args[args.length - 2] as number;
    if (inRegions(regions, index)) return matched;
    const groups = args.slice(0, args.length - 2) as RegExpMatchArray;
    return replacer(groups);
  });
}

/** `$1`-style backreferences, expanded manually because we intercept the replacer. */
function expand(replacement: string, groups: RegExpMatchArray): string {
  return replacement.replace(/\$(\d)/g, (_m, d: string) => groups[Number(d)] ?? "");
}

// ---------------------------------------------------------------------------
// Hand-written transforms
//
// These rewrite structure, not text, so a regex replacement cannot express
// them. Each returns the new text; returning the input unchanged is allowed
// (it just means nothing matched).
// ---------------------------------------------------------------------------

type TransformContext = { choices: QzChoices; regions: Region[] };

const handlerTransforms: Record<string, (text: string, ctx: TransformContext) => string> = {
  // ```math fence -> $$ ... $$ (Zenn requires blank lines around the delimiters)
  //
  // The fence *lines* are outside the masked region by construction, so this
  // is matched on the opening fence and is not suppressed by its own content.
  "q2z-math-block": (text, { regions }) =>
    replaceOutside(
      text,
      regions,
      /^```math[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm,
      (g) => `$$\n${(g[1] ?? "").replace(/\s+$/, "")}\n$$`,
    ),

  // <details><summary>T</summary> ... </details> -> :::details T ... :::
  "q2z-details-html": (text, { regions }) =>
    replaceOutside(
      text,
      regions,
      /<details(?:\s[^>]*)?>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi,
      (g) => {
        const title = (g[1] ?? "").replace(/\s+/g, " ").trim();
        const bodyText = (g[2] ?? "").replace(/^\s*\n/, "").replace(/\s+$/, "");
        // Zenn's container requires a title: /^details\s+(.*)$/
        return `:::details ${title || "詳細"}\n${bodyText}\n:::`;
      },
    ),

  // <img width="50" src="..."> -> ![](src =50x)
  "q2z-img-width": (text, ctx) => rewriteImg(text, ctx.regions, "width-only"),
  "q2z-img-width-height": (text, ctx) => rewriteImg(text, ctx.regions, "width-height"),
  "q2z-img-height-only": (text, ctx) => rewriteImg(text, ctx.regions, "height-only"),

  // $$ ... $$ -> ```math (Qiita recommends the fence; $$ can need escaping)
  "z2q-math-block": (text, { regions }) =>
    replaceOutside(
      text,
      regions,
      /^\$\$[ \t]*\r?\n([\s\S]*?)^\$\$[ \t]*$/gm,
      (g) => "```math\n" + (g[1] ?? "").replace(/\s+$/, "") + "\n```",
    ),

  // :::details T ... ::: -> <details><summary>T</summary> ... </details>
  // Qiita needs a blank line after the opening tags for the Markdown inside to render.
  "z2q-details": (text, { regions }) =>
    replaceOutside(
      text,
      regions,
      /^:::details[ \t]+(.+?)[ \t]*\r?\n([\s\S]*?)^:::[ \t]*$/gm,
      (g) =>
        `<details><summary>${(g[1] ?? "").trim()}</summary>\n\n${(g[2] ?? "").replace(/\s+$/, "")}\n\n</details>`,
    ),

  // ![alt](src =50x100) -> <img alt="alt" src="src" width="50" height="100">
  "z2q-img-size": (text, { regions }) =>
    replaceOutside(
      text,
      regions,
      /!\[([^\]]*)\]\(([^()\s]+)[ \t]+=(\d*)x(\d*)\)/g,
      (g) => {
        const [, alt, src, w, h] = g;
        const attrs = [`src="${src}"`];
        if (alt) attrs.unshift(`alt="${alt}"`);
        if (w) attrs.push(`width="${w}"`);
        if (h) attrs.push(`height="${h}"`);
        return `<img ${attrs.join(" ")}>`;
      },
    ),

  // Frontmatter field maps are applied to the YAML block, not the body.
  "q2z-fm-private-false": (text) => text,
  "z2q-fm-title": (text) => text,
  "z2q-fm-topics-tags": (text) => text,
  "z2q-fm-slug-filename": (text) => text,
};

/** Shared rewrite for the three `<img>` size rules, which differ only in which attributes are present. */
function rewriteImg(
  text: string,
  regions: Region[],
  mode: "width-only" | "height-only" | "width-height",
): string {
  return replaceOutside(text, regions, /<img\b[^>]*>/gi, (g) => {
    const tag = g[0];
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!src) return tag;
    const width = tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] ?? "";
    const height = tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] ?? "";
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";

    if (mode === "width-only" && !(width && !height)) return tag;
    if (mode === "height-only" && !(height && !width)) return tag;
    if (mode === "width-height" && !(width && height)) return tag;

    return `![${alt}](${src} =${width}x${height})`;
  });
}

// ---------------------------------------------------------------------------
// Coverage guard
// ---------------------------------------------------------------------------

/**
 * Every generated `handler` id must have an implementation above.
 *
 * Without this, adding a rule to rules.json would produce a rule that never
 * fires and never reports — the exact failure mode this project hit when a
 * PDF hypothesis condition became structurally unreachable. Fail loudly at
 * module load instead.
 */
function assertHandlerCoverage(): void {
  const missingDetect = qiitaZennHandlerDetectIds.filter((id) => !(id in handlerDetectors));
  const missingTransform = qiitaZennHandlerTransformIds.filter(
    (id) => !(id in handlerTransforms),
  );
  if (missingDetect.length || missingTransform.length) {
    throw new Error(
      "[qiita-zenn] rule table has handlers without an implementation — " +
        `detect: [${missingDetect.join(", ")}], transform: [${missingTransform.join(", ")}]`,
    );
  }
}

assertHandlerCoverage();

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function excerptAt(text: string, index: number, matched: string): string {
  const oneLine = matched.split(/\r?\n/)[0] ?? "";
  const trimmed = oneLine.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  // Multi-line match that starts with a newline: show the line it begins on.
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  const line = text.slice(start, end === -1 ? undefined : end).trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function buildChoice(
  rule: QzRule,
  locale: QzLocale,
  choices: QzChoices,
): QzFinding["choice"] {
  if (!rule.userAction) return null;
  const selected = choices[rule.id] ?? rule.userAction.fallback;
  return {
    prompt: textFor(locale, rule.userAction.prompt),
    options: rule.userAction.options.map((o) => ({
      value: o.value,
      label: locale === "ja" ? o.ja : o.en,
    })),
    selected,
  };
}

export function analyzeQiitaZenn(
  input: string,
  direction: QzDirection,
  locale: QzLocale,
  choices: QzChoices = {},
): QzResult {
  const empty: QzResult["counts"] = {
    total: 0,
    breaksSilently: 0,
    deterministic: 0,
    lossy: 0,
    unsupported: 0,
  };

  if (!input.trim()) {
    return {
      output: "",
      findings: [],
      counts: empty,
      error:
        locale === "ja"
          ? "記事の Markdown を貼り付けてください。"
          : "Paste the article's Markdown first.",
      status: "",
    };
  }

  if (new Blob([input]).size > MAX_INPUT_BYTES) {
    return {
      output: "",
      findings: [],
      counts: empty,
      error:
        locale === "ja"
          ? "入力が大きすぎます。記事 1 本ずつ処理してください。"
          : "Input is too large. Process one article at a time.",
      status: "",
    };
  }

  const { frontmatter, body } = splitFrontmatter(input);
  const rules = qiitaZennRules.filter((r) => appliesTo(r, direction));
  const findings: QzFinding[] = [];
  // Body findings are reported at their position in the whole document.
  const bodyLineOffset = frontmatter.present ? frontmatter.lineCount : 0;

  const fenced = fencedRegions(body);
  const inlineCode = inlineCodeRegions(body);
  const allCode = [...fenced, ...inlineCode].sort((a, b) => a[0] - b[0]);

  for (const rule of rules) {
    if (rule.detect.kind === "handler") {
      const detector = handlerDetectors[rule.id];
      if (!detector || !detector({ frontmatter, body })) continue;
      findings.push({
        ruleId: rule.id,
        line: 0,
        excerpt: "",
        category: rule.category,
        severity: rule.severity,
        target: rule.target,
        feature: textFor(locale, rule.feature),
        detail: detailFor(locale, rule.category, rule.severity),
        choice: buildChoice(rule, locale, choices),
        source: rule.source,
      });
      continue;
    }

    const re = new RegExp(rule.detect.pattern, ensureGlobal(rule.detect.flags));
    const haystack = rule.target === "frontmatter" ? frontmatter.raw : body;
    const offset = rule.target === "frontmatter" ? 1 : bodyLineOffset;
    // A rule whose own syntax is backticks (Qiita's inline math is $`x`$)
    // cannot be filtered by "is this inside inline code" — it would filter
    // itself. Those rules only skip fenced blocks.
    const skip =
      rule.target === "frontmatter"
        ? []
        : rule.detect.pattern.includes("`")
          ? fenced
          : allCode;
    let match: RegExpExecArray | null;
    let guard = 0;
    while ((match = re.exec(haystack)) !== null) {
      // Several patterns anchor on leading whitespace ((?:^|\s)@name), so the
      // raw match starts on the *previous* line's newline. Reporting that
      // index would blame the wrong line and, worse, test the wrong side of a
      // fence boundary — that is how `@startuml` inside a ```plantuml block
      // escaped the code mask (measured 2026-08-04).
      const lead = /^\s*/.exec(match[0])?.[0].length ?? 0;
      const at = match.index + (lead < match[0].length ? lead : 0);
      if (inRegions(skip, at)) {
        if (match.index === re.lastIndex) re.lastIndex += 1;
        continue;
      }
      findings.push({
        ruleId: rule.id,
        line: lineOf(haystack, at) + offset,
        excerpt: excerptAt(haystack, at, match[0].slice(lead)),
        category: rule.category,
        severity: rule.severity,
        target: rule.target,
        feature: textFor(locale, rule.feature),
        detail: detailFor(locale, rule.category, rule.severity),
        choice: buildChoice(rule, locale, choices),
        source: rule.source,
      });
      // Zero-length matches would spin forever; advance manually.
      if (match.index === re.lastIndex) re.lastIndex += 1;
      guard += 1;
      if (guard > 500) break; // one rule cannot flood the panel
    }
  }

  findings.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));

  // ---- conversion: only what is provably lossless, plus explicit choices ----
  //
  // Regions are recomputed after each rewrite: a conversion can create or
  // destroy a fence (```math becomes $$), and a stale region map would let a
  // later rule edit inside code it now believes is prose.
  let output = body;
  for (const rule of rules) {
    if (!rule.transform) continue;
    if (rule.transform.kind === "identity") continue;
    if (!isLossless(rule)) continue;
    if (rule.target === "frontmatter") continue;
    const regions = currentRegions(output, rule.transform.kind === "handler" ? "fenced" : "all");
    if (rule.transform.kind === "regex-replace") {
      const { pattern, flags, replacement } = rule.transform;
      output = replaceOutside(
        output,
        regions,
        new RegExp(pattern, ensureGlobal(flags)),
        (g) => expand(replacement, g),
      );
    } else {
      const fn = handlerTransforms[rule.id];
      if (fn) output = fn(output, { choices, regions });
    }
  }

  // Lossy rules only convert once the author has picked a target.
  for (const rule of rules) {
    if (rule.category !== "lossy" || !rule.userAction) continue;
    if (rule.target === "frontmatter") continue;
    const picked = choices[rule.id];
    if (!picked) continue;
    if (rule.detect.kind !== "regex") continue;
    const regions = currentRegions(output, rule.detect.pattern.includes("`") ? "fenced" : "all");
    output = replaceOutside(
      output,
      regions,
      new RegExp(rule.detect.pattern, ensureGlobal(rule.detect.flags)),
      () => picked,
    );
  }

  if (frontmatter.present) {
    output = `${rewriteFrontmatter(frontmatter, direction, choices)}\n${output}`;
  }

  const counts = {
    total: findings.length,
    breaksSilently: findings.filter((f) => f.severity === "breaks-silently").length,
    deterministic: findings.filter((f) => f.category === "deterministic").length,
    lossy: findings.filter((f) => f.category === "lossy").length,
    unsupported: findings.filter((f) => f.category === "unsupported").length,
  };

  return { output, findings, counts, error: "", status: "" };
}

function ensureGlobal(flags: string): string {
  return flags.includes("g") ? flags : `${flags}g`;
}

/** Fenced blocks only, or fenced plus inline code — see the note at the detection loop. */
function currentRegions(text: string, scope: "fenced" | "all"): Region[] {
  const fenced = fencedRegions(text);
  if (scope === "fenced") return fenced;
  return [...fenced, ...inlineCodeRegions(text)].sort((a, b) => a[0] - b[0]);
}

/**
 * Normalize a Qiita tag into something Zenn accepts as a topic.
 *
 * Zenn rejects symbols and spaces and caps each topic at 18 characters, so
 * `C++` and `Node.js` cannot travel as-is. The mapping for the two the Zenn
 * UI itself names (`C++` -> `cpp`, `C#` -> `csharp`) is unambiguous; anything
 * else is a guess, which is why this only runs when the author picks
 * `auto-normalize` and why the finding stays on screen either way.
 */
function normalizeTopic(tag: string): string | null {
  const known: Record<string, string> = { "c++": "cpp", "c#": "csharp", "f#": "fsharp" };
  const lower = tag.toLowerCase();
  if (known[lower]) return known[lower];
  const stripped = lower.replace(/[^a-z0-9぀-ヿ一-鿿]/g, "");
  if (!stripped) return null;
  return stripped.slice(0, 18);
}

/**
 * Rewrite the frontmatter for the target platform.
 *
 * `published` is forced to `false` in the Zenn direction on purpose. Zenn
 * auto-deploys on push, and `slug` / `published_at` cannot be changed once the
 * article exists — a tool that emitted `published: true` would turn a bad
 * conversion into a permanent one. The author opts in by editing one line.
 *
 * Fields the author has to decide (emoji, type, topic normalization) follow
 * `choices`, so picking an option in the panel is visible in the output. Until
 * one is picked, the value stays empty rather than being guessed: an empty
 * `emoji` fails Zenn's own validation, which is a loud failure, whereas a
 * silently invented one is not.
 */
function rewriteFrontmatter(
  frontmatter: Frontmatter,
  direction: QzDirection,
  choices: QzChoices,
): string {
  if (frontmatter.malformed) {
    // Do not touch YAML we could not parse; round-trip it verbatim.
    return `---\n${frontmatter.raw.replace(/\r?\n$/, "")}\n---\n`;
  }
  const src = frontmatter.data;
  const out: Record<string, unknown> = {};

  if (direction === "qiita-to-zenn") {
    if (typeof src.title === "string") {
      out.title =
        choices["q2z-fm-title"] === "truncate" && src.title.length > 70
          ? src.title.slice(0, 70)
          : src.title;
    }
    out.emoji =
      typeof src.emoji === "string"
        ? src.emoji
        : choices["q2z-fm-emoji"] === "placeholder"
          ? "📝"
          : "";
    out.type =
      typeof src.type === "string"
        ? src.type
        : choices["q2z-fm-type"] === "idea"
          ? "idea"
          : "tech";

    const rawTags = Array.isArray(src.tags)
      ? src.tags.map(tagName).filter((t): t is string => Boolean(t))
      : [];
    const topics =
      choices["q2z-fm-tags-topics"] === "auto-normalize"
        ? rawTags
            .map(normalizeTopic)
            .filter((t): t is string => Boolean(t))
            .slice(0, 5)
        : rawTags;
    if (topics.length) out.topics = topics;

    // `published` is `private` inverted (rules q2z-fm-private-false and
    // q2z-fm-private-true). A Qiita `private: true` article has no published
    // counterpart, so it lands as a draft either way — `abort` only means the
    // author does not want a Zenn file at all, which is a decision made
    // outside this output. When the field is absent the article also becomes a
    // draft: Qiita CLI defaults to `private: false`, but turning a value the
    // author never wrote into "publish this" is exactly the kind of unasked-for
    // choice this engine refuses to make.
    out.published = src.private === false;
  } else {
    if (typeof src.title === "string") out.title = src.title;
    const topics = Array.isArray(src.topics)
      ? src.topics.filter((t): t is string => typeof t === "string")
      : [];
    if (topics.length) out.tags = topics;
    // `hold` (the default) keeps the article out of sight on Qiita too, so a
    // half-converted draft cannot go public by accident.
    out.private = choices["z2q-fm-published"] === "private-true" ? true : src.published !== true;
  }

  const yaml = YAML.stringify(out).replace(/\n$/, "");
  const notes = frontmatterNotes(src, direction, choices);
  return `---\n${notes}${yaml}\n---\n`;
}

/**
 * Decisions that have no frontmatter field to land in.
 *
 * A Zenn slug is the *filename* (`articles/<slug>.md`) and a publication is
 * set outside the article, so picking an option for those would otherwise
 * change nothing on screen — a control that does nothing reads as a broken
 * one. Emitting them as YAML comments keeps the choice visible and carries
 * the value to wherever the author actually needs it.
 */
function frontmatterNotes(
  src: Record<string, unknown>,
  direction: QzDirection,
  choices: QzChoices,
): string {
  const lines: string[] = [];
  if (direction === "qiita-to-zenn") {
    if (choices["q2z-fm-id-slug"] === "from-qiita-id" && typeof src.id === "string") {
      lines.push(`# slug: articles/${src.id}.md`);
    }
    if (choices["q2z-fm-organization"] === "manual" && src.organization_url_name) {
      lines.push(`# publication_name: ${String(src.organization_url_name)}`);
    }
  } else {
    if (typeof src.slug === "string") {
      lines.push(`# Qiita CLI: public/${src.slug}.md`);
    }
    if (typeof src.published_at === "string") {
      lines.push(`# Zenn published_at: ${src.published_at}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
