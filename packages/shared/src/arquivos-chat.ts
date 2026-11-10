/**
 * Arquivos que o chat aceita enviar (front e API usam esta mesma lista).
 *
 * Nov/2026 — escaneamento 3D e radiografia (STL, PLY, OBJ, 3MF, DICOM) e RAR/7z passam a
 * ser aceitos: a clínica e o laboratório trocam esses arquivos pelo WhatsApp, e o chat
 * recusava ("Tipo de arquivo não permitido"). Para esses vale a EXTENSÃO, porque o
 * navegador manda tipos variados (o Windows registra .stl como application/vnd.ms-pki.stl;
 * outros mandam vazio ou application/octet-stream).
 */

const TIPOS_DE_MIDIA = /^(image|video|audio)\//;

const TIPOS_DE_DOCUMENTO = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-excel',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
];

/** Extensão → tipo com que o arquivo é gravado e enviado (no lugar do que o navegador mandou). */
const TIPO_POR_EXTENSAO: Readonly<Record<string, string>> = {
  stl: 'model/stl',
  ply: 'application/octet-stream',
  obj: 'model/obj',
  '3mf': 'model/3mf',
  dcm: 'application/dicom',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
};

/** `accept` do seletor de arquivos do chat. */
export const ACCEPT_ARQUIVOS_DO_CHAT =
  'image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,' +
  Object.keys(TIPO_POR_EXTENSAO)
    .map((e) => `.${e}`)
    .join(',');

function extensao(nome: string | null | undefined): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(nome || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** O chat aceita enviar este arquivo? */
export function arquivoDoChatPermitido(tipo: string | null | undefined, nome: string | null | undefined): boolean {
  const t = String(tipo || '').toLowerCase();
  if (TIPOS_DE_MIDIA.test(t) || TIPOS_DE_DOCUMENTO.some((d) => t.startsWith(d))) return true;
  return extensao(nome) in TIPO_POR_EXTENSAO;
}

/** Tipo com que o arquivo é gravado e enviado: o da extensão de escaneamento, senão o que veio. */
export function tipoDoArquivoDoChat(tipo: string | null | undefined, nome: string | null | undefined): string {
  return TIPO_POR_EXTENSAO[extensao(nome)] || String(tipo || '') || 'application/octet-stream';
}
