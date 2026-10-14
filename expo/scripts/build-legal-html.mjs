// Generates the hosted privacy.html and terms.html from constants/legal.ts so the
// published pages always match the in-app text.
//
//   node scripts/build-legal-html.mjs <output-dir>
//
// The output dir is a checkout of the DropDay-Legal repo (GitHub Pages).
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PRIVACY_POLICY, TERMS_OF_USE } from "../constants/legal.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/build-legal-html.mjs <output-dir>");
  process.exit(1);
}

const esc = (t) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Bold a leading "Label:" on bullet lines, like the original pages did.
function bullet(text) {
  const body = text.replace(/^•\s*/, "");
  const m = body.match(/^([^:]{2,60}):\s(.*)$/s);
  return m ? `<li><strong>${esc(m[1])}:</strong> ${esc(m[2])}</li>` : `<li>${esc(body)}</li>`;
}

function section(sec) {
  const parts = [`<h2>${esc(sec.heading)}</h2>`];
  let list = [];
  const flush = () => {
    if (list.length) parts.push("<ul>\n  " + list.join("\n  ") + "\n</ul>");
    list = [];
  };
  for (const p of sec.paragraphs) {
    if (p.startsWith("•")) list.push(bullet(p));
    else {
      flush();
      parts.push(`<p>${esc(p)}</p>`);
    }
  }
  flush();
  return parts.join("\n");
}

function page(doc) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tryal ${esc(doc.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #222; }
  h1 { font-size: 28px; }
  h2 { font-size: 20px; margin-top: 32px; }
  p, li { font-size: 16px; }
</style>
</head>
<body>
<h1>${esc(doc.title)}</h1>
<p><strong>Last updated: ${esc(doc.lastUpdated)}</strong></p>
<p>${esc(doc.intro)}</p>
${doc.sections.map(section).join("\n")}
<p><a href="privacy.html">Privacy Policy</a> | <a href="terms.html">Terms of Use</a> | <a href="support.html">Support</a></p>
</body>
</html>
`;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "privacy.html"), page(PRIVACY_POLICY));
writeFileSync(join(out, "terms.html"), page(TERMS_OF_USE));
console.log(`wrote privacy.html and terms.html to ${out}`);
