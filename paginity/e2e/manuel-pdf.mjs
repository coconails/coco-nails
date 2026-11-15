// Transforme docs/MANUEL.md en PDF imprimable (images incluses).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { marked } = require('marked');
const { chromium } = require('playwright');
const docs = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'docs');
const md = fs.readFileSync(path.join(docs, 'MANUEL.md'), 'utf8');
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/ /g, '-');
const renderer = new marked.Renderer();
renderer.heading = ({ tokens, depth }) => { const text = marked.Parser.parseInline(tokens); return `<h${depth} id="${slug(text)}">${text}</h${depth}>`; };
// Images converties en JPEG pour un PDF plus léger (les captures restent en WebP dans le dépôt).
const sharp = require('sharp');
const jpgDir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'manuel-jpg-'));
fs.mkdirSync(jpgDir, { recursive: true });
for (const f of fs.readdirSync(path.join(docs, 'manuel'))) {
  if (f.endsWith('.webp')) await sharp(path.join(docs, 'manuel', f)).flatten({ background: '#ffffff' }).jpeg({ quality: 78, mozjpeg: true }).toFile(path.join(jpgDir, f.replace('.webp', '.jpg')));
}
const body = marked.parse(md, { renderer }).replace(/src="manuel\/([^"]+)\.webp"/g, (_, n) => `src="file://${jpgDir}/${n}.jpg"`);
const logo = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'web', 'public', 'logo-paginity.webp')).toString('base64');
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><base href="file://${docs}/"><style>
@page { size: A4; margin: 16mm 14mm 18mm; }
body { font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; color: #13213a; font-size: 10.5pt; line-height: 1.5; }
.couverture { height: 250mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  background: radial-gradient(ellipse at top, #13213a 0%, #0b1626 70%); color: #e6eaf0; margin: -16mm -14mm 0; padding: 0 20mm; page-break-after: always; }
.couverture img { width: 120mm; border: 0; max-height: none; } .couverture h1 { color: #e8a93a; font-size: 30pt; margin: 8mm 0 2mm; border: 0; }
.couverture p { color: #c1c8d4; font-size: 12pt; }
h1 { font-size: 22pt; color: #0b1626; border-bottom: 3px solid #e8a93a; padding-bottom: 2mm; }
h2 { font-size: 16pt; color: #0b1626; margin-top: 10mm; border-bottom: 2px solid #e8a93a; padding-bottom: 1mm; page-break-before: always; }
h2#sommaire, h2#1-les-mots-à-connaître { page-break-before: auto; }
h3 { color: #7a530d; }
img { max-width: 100%; max-height: 120mm; display: block; margin: 3mm auto; border: 1px solid #c9d3e3; border-radius: 6px; page-break-inside: avoid; }
table { border-collapse: collapse; width: 100%; margin: 3mm 0; page-break-inside: avoid; font-size: 9.5pt; }
th, td { border: 1px solid #c9d3e3; padding: 1.5mm 2mm; vertical-align: top; text-align: left; } th { background: #fff8e6; }
td img { max-height: 95mm; margin: 0 auto; }
blockquote { margin: 3mm 0; padding: 2mm 4mm; background: #fff8e6; border-left: 4px solid #e8a93a; border-radius: 4px; page-break-inside: avoid; }
code { background: #eef1f6; padding: 0 1mm; border-radius: 3px; font-size: 9.5pt; }
a { color: #a06d12; text-decoration: none; } hr { border: 0; }
</style></head><body>
<section class="couverture"><img src="data:image/webp;base64,${logo}" alt=""><h1>Manuel d'utilisation</h1><p>Créer · Gérer · Publier · Suivre</p><p>Version 0.3 — prototype — novembre 2026</p></section>
${body}</body></html>`;
const out = path.join(docs, 'MANUEL-PAGINITY.html');
fs.writeFileSync(out, html);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${out}`, { waitUntil: 'load' });
await page.pdf({ path: path.join(docs, 'MANUEL-PAGINITY.pdf'), format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8pt;color:#6b7891;width:100%;text-align:center">PAGINITY — Manuel d\'utilisation — page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' } });
await browser.close();
fs.rmSync(out);
console.log('PDF prêt');
