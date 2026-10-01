/**
 * Gera apps/api/src/commercial/contract-templates/overlay-map.json —
 * as COORDENADAS dos brancos (underscores) de cada termo oficial (PDFs comprados
 * no Eduzz, sem campos de formulário). O runtime (contract-pdf.service.ts) usa
 * esse mapa pra escrever os dados do paciente/clínica POR CIMA das linhas.
 *
 * Rode 1× e sempre que TROCAR/reexportar um PDF de termo:
 *   cd scripts/pdf-overlay
 *   npm i pdfjs-dist@4 pdf-lib@1   # deps só de DEV (não vão pra imagem)
 *   node build-overlay-map.mjs
 *
 * Como funciona: pdfjs extrai os itens de texto com posição; achamos os brancos
 * (runs de "_") e classificamos cada um pelo RÓTULO que vem antes ("RG nº",
 * "CPF nº", "cidade", "CEP", "dentista", "profissional", "sob o nº"…). Detecta 3
 * layouts: padrão, MENOR (Eu=responsável / paciente=menor) e uso-de-imagem.
 * A posição X exata do branco (mesmo colado no rótulo) sai da razão de larguras
 * medida com a Helvetica (pd-lib) — o tamanho da fonte cancela na razão.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '../../apps/api/src/commercial/contract-templates');
const OUT = path.join(dir, 'overlay-map.json');

let HELV; { const d = await PDFDocument.create(); HELV = await d.embedFont(StandardFonts.Helvetica); }
const wv = (s) => { try { return HELV.widthOfTextAtSize(s || '', 100); } catch { return HELV.widthOfTextAtSize((s || '').replace(/[^\x00-\xff]/g, 'a'), 100); } };
const rd = (n) => Math.round(n * 10) / 10;

async function pageLines(page) {
  const tc = await page.getTextContent({ disableNormalization: true });
  const items = tc.items.filter((i) => i.str !== undefined && i.str !== '').map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, size: i.transform[0] }));
  items.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
  const lines = []; let cur = null;
  for (const it of items) { if (!cur || Math.abs(it.y - cur.y) > 2) { cur = { y: it.y, items: [] }; lines.push(cur); } cur.items.push(it); }
  return lines;
}
function itemRuns(it) {
  const full = wv(it.s) || 1; const out = []; const re = /_{3,}/g; let m;
  while ((m = re.exec(it.s))) { const pre = it.s.slice(0, m.index);
    out.push({ prefixInItem: pre, x: it.x + it.w * (wv(pre) / full), y: it.y, w: it.w * (wv(m[0]) / full), size: it.size }); }
  return out;
}
function classify(prefix, ctx) {
  const t = prefix.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/\beu,?$/.test(t)) return ctx.isMenor ? 'responsavel_name' : 'patient_name';
  if (/\bcpf$/.test(t) && ctx.isMenor && ctx.has('responsavel_name') && !ctx.has('patient_name')) return 'responsavel_cpf';
  if (/paciente,?$/.test(t)) return 'patient_name';
  if (/rg n[ºo°]?$/.test(t)) return 'patient_rg';
  if (/cpf n[ºo°]?$/.test(t)) return 'patient_cpf';
  if (/residente ?[aà]?$/.test(t)) return 'patient_address';
  if (/\(?cidade\)?$/.test(t)) return ctx.bump('city') === 1 ? 'patient_city' : 'clinic_city';
  if (/cep$/.test(t)) return ctx.bump('cep') === 1 ? 'patient_cep' : 'clinic_cep';
  if (/dentista$/.test(t)) return 'dentist_name';
  if (/profissional$/.test(t)) return 'dentist_name';
  if (/sob o n[ºo°]?$/.test(t)) return 'dentist_cro';
  if (/consult[oó]rio( localizado| ?[aà])?$/.test(t)) return 'clinic_address';
  return null;
}
const DATE_RE = /de\s*_{3,}\s+de\s*_{3,}/;
async function extract(file) {
  const data = new Uint8Array(fs.readFileSync(path.join(dir, file)));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const perPage = []; let fullText = '';
  for (let p = 1; p <= doc.numPages; p++) { const lines = await pageLines(await doc.getPage(p)); perPage.push(lines); for (const ln of lines) fullText += ln.items.map((i) => i.s).join('') + '\n'; }
  const isMenor = /respons[aá]vel pelo\s*paciente/i.test(fullText.replace(/\n/g, ' '));
  const counts = {}; const assigned = new Set();
  const ctx = { isMenor, has: (k) => assigned.has(k), bump: (k) => { counts[k] = (counts[k] || 0) + 1; return counts[k]; } };
  const fields = [];
  for (let p = 0; p < perPage.length; p++) {
    let before = '';
    for (const ln of perPage[p]) {
      before += ' ';
      const lineStr = ln.items.map((i) => i.s).join('');
      if (DATE_RE.test(lineStr)) {
        const runs = []; for (const it of ln.items) for (const r of itemRuns(it)) runs.push(r);
        runs.sort((a, b) => a.x - b.x);
        ['date_city', 'date_day', 'date_month', 'date_year'].forEach((k, i) => { if (runs[i]) fields.push({ key: k, page: p, x: rd(runs[i].x), y: rd(runs[i].y), w: rd(runs[i].w), size: rd(runs[i].size || 9) }); });
        before += lineStr; continue;
      }
      for (const it of ln.items) {
        for (const r of itemRuns(it)) { const key = classify(before + r.prefixInItem, ctx);
          if (key && !assigned.has(key)) { assigned.add(key); fields.push({ key, page: p, x: rd(r.x), y: rd(r.y), w: rd(r.w), size: rd(r.size || 9) }); } }
        before += it.s;
      }
    }
  }
  const headers = await extractHeaders(doc);
  return { numPages: doc.numPages, isMenor, fields, headers };
}

// Cabeçalho dos termos NEUTROS: caixa do placeholder "ESPAÇO RESERVADO PARA LOGO
// / IDENTIFICAÇÃO DA CLÍNICA" — o runtime cobre e desenha o nome+logo do tenant.
async function extractHeaders(doc) {
  const out = [];
  const RE = /reservado|identifica[çc][aã]o da cl[ií]nica/i;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { height } = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent({ disableNormalization: true });
    let ph = null;
    for (const it of tc.items) {
      if (it.transform[5] > height - 120 && RE.test(it.str)) ph = { x: rd(it.transform[4]), y: rd(it.transform[5]), w: rd(it.width), size: rd(it.transform[0]) };
    }
    if (ph) out.push({ page: p - 1, ...ph });
  }
  return out;
}

// Contrato PRINCIPAL (Prestação de Serviços): mapeamento POSICIONAL (rótulos
// diferem dos termos). Campos sem dado no sistema (civil/profissao/rg_exp) entram
// no mapa, mas o runtime deixa em branco.
const MAIN_FILE = 'contrato-prestacao-servicos.pdf';
const MAIN_KEYS = [
  ['contratada_name','contratada_doc','contratada_address','dentist_name','cro_uf','cro_num','patient_name','civil','profissao','patient_rg','rg_exp','patient_cpf','patient_address','patient_addr_num','patient_neighborhood','patient_city','patient_state','valor','valor_extenso'],
  ['foro_comarca','foro_estado','date_city','date_day','date_month','date_year'],
];
async function extractMainContract(doc) {
  const fields = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent({ disableNormalization: true });
    const items = tc.items.filter((i) => i.str !== undefined && i.str !== '').map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, size: i.transform[0] }));
    const runs = [];
    for (const it of items) for (const r of itemRuns(it)) runs.push(r);
    runs.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
    const keys = MAIN_KEYS[p - 1] || [];
    runs.forEach((r, i) => { if (keys[i]) fields.push({ key: keys[i], page: p - 1, x: rd(r.x), y: rd(r.y), w: rd(r.w), size: rd(r.size || 9) }); });
  }
  return fields;
}

const map = {};
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'))) {
  if (file === MAIN_FILE) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(dir, file))), useSystemFonts: true }).promise;
    const fields = await extractMainContract(doc);
    const headers = await extractHeaders(doc);
    map[file] = { numPages: doc.numPages, isMenor: false, main: true, fields, headers };
    console.log(`${file}  [PRINCIPAL] campos=${fields.length} headers=${headers.length}`);
    continue;
  }
  const e = await extract(file); map[file] = e;
  console.log(`${file}  menor=${e.isMenor} campos=${e.fields.length} headers=${e.headers.length}  [${e.fields.map((f) => f.key).join(', ')}]`);
}
fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
console.log(`\nOK: ${OUT}`);
