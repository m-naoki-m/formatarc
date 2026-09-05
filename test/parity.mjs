#!/usr/bin/env node
//
// formatarc (CLI / 拡張が使うパッケージ) と formatarc.com の出力が一致するかを
// 実入力で突き合わせる。CLI 側に単体テストは無く、Web 側の実装が事実上の
// 仕様なので、これがパリティの唯一の担保にあたる。
//
// Web リポジトリ (SimpleDataConverterWeb) が隣にあるときだけ走る。無いときは
// 「skipped」と出して 0 で抜ける (拡張が file:../../formatarc で隣を参照して
// いるのと同じ前提)。
//
//   node test/parity.mjs
//
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "..");
const webRoot = path.resolve(cliRoot, "../SimpleDataConverterWeb");

if (!existsSync(path.join(webRoot, "lib/tooling.ts"))) {
  console.log(`skipped: ${webRoot} not found (the formatarc.com repo is not checked out here)`);
  process.exit(0);
}

const tmp = path.join(cliRoot, "test/.tmp");
mkdirSync(tmp, { recursive: true });

// Web の実装は Next の "@/..." エイリアスと CJS 依存を持つので、Node で読める形へ
// 束ねてから読み込む。
async function bundleWeb(entry, outfile) {
  await build({
    entryPoints: [path.join(webRoot, entry)],
    bundle: true,
    outfile: path.join(tmp, outfile),
    format: "esm",
    platform: "node",
    alias: { "@": webRoot },
    external: ["react", "next"],
    logLevel: "silent",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  return import(path.join(tmp, outfile));
}

const web = await bundleWeb("lib/tooling.ts", "web-tooling.mjs");
const webQz = await bundleWeb("lib/qiita-zenn.ts", "web-qiita-zenn.mjs");
const cli = await import(path.join(cliRoot, "dist/converter.js"));
const cliQz = await import(path.join(cliRoot, "dist/qiita-zenn.js"));

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    return;
  }
  failures.push({ name, detail });
}

// ---- 1. 文字列変換 9 種 ----------------------------------------------------
//
// Web の slug と CLI の tool 名は json-formatter / json-format だけ食い違う。
const TOOL_MAP = {
  "json-formatter": "json-format",
  "yaml-to-json": "yaml-to-json",
  "json-to-yaml": "json-to-yaml",
  "csv-to-json": "csv-to-json",
  "json-to-csv": "json-to-csv",
  "csv-to-markdown": "csv-to-markdown",
  "markdown-to-csv": "markdown-to-csv",
  "markdown-to-html": "markdown-to-html",
  "html-to-markdown": "html-to-markdown",
};

const CASES = {
  "json-formatter": ['{"a":1,"b":[1,2,{"c":3}]}', '{"a":1,}', "{invalid"],
  "yaml-to-json": ["project: FormatArc\nfeatures:\n  - json\n  - yaml\npublic: true", "a: [1, 2\n"],
  "json-to-yaml": ['{"project":"FormatArc","features":["json","yaml"],"public":true}'],
  "csv-to-json": [
    "name,email,role\nMika,mika@example.com,admin\nNoah,noah@example.com,viewer",
    "a,b\n1,2,3\n",
  ],
  "json-to-csv": [
    '[\n  { "name": "Mika", "email": "mika@example.com", "role": "admin", "address": { "city": "Tokyo" } },\n  { "name": "Noah", "email": "noah@example.com", "role": "viewer", "address": { "city": "Osaka" } }\n]',
    '{ "a": 1, "b": { "c": 2 }, "d": [1,2], "e": null, "f": {} }',
    '[{"a":1},{"b":2}]',
    '[{"a":"x,y","b":"say \\"hi\\""}]',
    "[]",
    "[1,2,3]",
    '"just a string"',
    "{invalid",
  ],
  "csv-to-markdown": [
    "name,email,role\nMika,mika@example.com,admin\nNoah,noah@example.com,viewer",
    "a,b\n1,2\n",
  ],
  "markdown-to-csv": [
    "| Name | Note |\n|:-----|-----:|\n| Widget A | Ships in 1\\|2 days |\n| Widget B | In stock |",
    "# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntext\n\n| x | y | z |\n| --- | --- | --- |\n| 1 | 2 | 3 |",
    "```\n| not | a table |\n| --- | --- |\n```\n\n| real | table |\n| --- | --- |\n| 1 | 2 |",
    "| a | b |\n| --- | --- |\n| line1<br>line2 | &vert; &amp; &#124; |",
    "    | indented | code |\n    | --- | --- |",
    "no table here",
  ],
  "markdown-to-html": ["# FormatArc\n\nConvert **Markdown** to _HTML_.\n\n- Fast\n- Private\n"],
  "html-to-markdown": [
    "<h1>FormatArc</h1>\n<p>Convert <strong>HTML</strong> to <em>Markdown</em>.</p>",
    "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>",
  ],
};

for (const [slug, inputs] of Object.entries(CASES)) {
  for (const [i, input] of inputs.entries()) {
    const w = web.runToolConversion(slug, input, "en");
    const c = cli.convert(TOOL_MAP[slug], input);
    check(
      `convert ${slug}[${i}]`,
      w.output === c.output && Boolean(w.error) === Boolean(c.error),
      `web.output=${JSON.stringify(w.output)}\n    cli.output=${JSON.stringify(c.output)}\n` +
        `    web.error=${JSON.stringify(w.error)}\n    cli.error=${JSON.stringify(c.error)}`,
    );
  }
}

// ---- 2. Qiita / Zenn 互換チェック -----------------------------------------
const QZ_CASES = [
  `---
title: サンプル記事
tags:
  - TypeScript
  - Node.js
private: false
---

# 見出し

:::note warn
Qiita のノート記法。
:::

<details><summary>折りたたみ</summary>
中身
</details>

\`\`\`math
E = mc^2
\`\`\`
`,
  `---
title: Zenn の記事
emoji: "🦁"
type: tech
topics: ["typescript"]
published: true
---

:::message
Zenn のメッセージ。
:::

@[tweet](https://twitter.com/example/status/1)
`,
  "本文だけで frontmatter が無い記事。\n\n普通の段落。\n",
  "",
];

for (const direction of ["qiita-to-zenn", "zenn-to-qiita"]) {
  for (const [i, input] of QZ_CASES.entries()) {
    const w = webQz.analyzeQiitaZenn(input, direction, "en");
    const c = cliQz.analyzeQiitaZenn(input, direction, "en");
    check(
      `qz ${direction}[${i}] output`,
      w.output === c.output,
      `web=${JSON.stringify(w.output)}\n    cli=${JSON.stringify(c.output)}`,
    );
    check(
      `qz ${direction}[${i}] counts`,
      JSON.stringify(w.counts) === JSON.stringify(c.counts),
      `web=${JSON.stringify(w.counts)} cli=${JSON.stringify(c.counts)}`,
    );
    check(
      `qz ${direction}[${i}] findings`,
      JSON.stringify(w.findings) === JSON.stringify(c.findings),
      `${w.findings.length} vs ${c.findings.length} findings`,
    );
  }
}

// ---- 3. 移植ファイルのドリフト ---------------------------------------------
//
// src/qiita-zenn.ts と src/qiita-zenn-rules.generated.ts は Web 側からのコピー。
// ルールの生成スクリプトは向こうにしか無く、エンジン本体も向こうが手を入れる側
// なので、コピーが取り残されると「Web では直っているのに CLI と拡張だけ古い」が
// 起きる。Web 版へ既知の置き換えを当てた結果と、こちらの src が一致するかで見る。
//
// 置き換えは 2 つだけ:
//   - Next の "@/..." エイリアス経由の import を、このパッケージ内の相対 import へ
//   - 7 言語の Locale 型を、ルール表が持つ ja / en だけの QzLocale へ
const digest = (text) => createHash("sha256").update(text).digest("hex");

/** Web 版のソースへ、コピー時に当てている置き換えを再現する。 */
function portToCli(text) {
  return text
    .replace(
      'import YAML from "yaml";\nimport type { Locale } from "@/lib/site";\nimport {',
      'import YAML from "yaml";\nimport {',
    )
    .replace(
      '} from "@/lib/qiita-zenn-rules.generated";',
      '} from "./qiita-zenn-rules.generated.js";\n\n/**\n * ルール表が持つ文言は ja と en の 2 つだけなので、ここでの locale もその 2 つに\n * 縛る。formatarc.com 側の Locale (7 言語) を持ち込むと、表に無い言語を渡せる型に\n * なってしまう。CLI は "en" 固定で、拡張はブラウザの言語から選ぶ。\n */\nexport type QzLocale = "ja" | "en";',
    )
    .replaceAll("locale: Locale", "locale: QzLocale");
}

check(
  "qiita-zenn engine in sync with formatarc.com",
  digest(portToCli(readFileSync(path.join(webRoot, "lib/qiita-zenn.ts"), "utf-8"))) ===
    digest(readFileSync(path.join(cliRoot, "src/qiita-zenn.ts"), "utf-8")),
  "copy ../SimpleDataConverterWeb/lib/qiita-zenn.ts over src/qiita-zenn.ts,\n" +
    "    then re-apply the two replacements this test reproduces (see portToCli above)",
);

// ルール表はヘッダーに出典コメントを足しているので、本体 (最初の export 以降) で比べる。
const bodyOf = (p) => {
  const text = readFileSync(p, "utf-8");
  return digest(text.slice(text.indexOf("export type QzDirection")));
};
check(
  "rules table in sync with formatarc.com",
  bodyOf(path.join(webRoot, "lib/qiita-zenn-rules.generated.ts")) ===
    bodyOf(path.join(cliRoot, "src/qiita-zenn-rules.generated.ts")),
  "copy ../SimpleDataConverterWeb/lib/qiita-zenn-rules.generated.ts over\n" +
    "    src/qiita-zenn-rules.generated.ts and keep the header comment",
);

// ---- 結果 ------------------------------------------------------------------
for (const f of failures) {
  console.log(`FAIL ${f.name}\n    ${f.detail}`);
}
console.log(`\npass=${pass} fail=${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
