import { BadRequestException } from '@nestjs/common';

/** Tamanho máximo da logo embutida (imagem decodificada). O front já reduz pra
 *  ≤512px antes de enviar — uma logo assim fica bem abaixo disso. */
export const TENANT_LOGO_MAX_BYTES = 400 * 1024;

/**
 * Normaliza/valida o `logo_url` que o ADMIN da clínica grava em Configurações ›
 * Identidade. Aceita:
 *  - vazio/null → remove a logo (null);
 *  - imagem EMBUTIDA `data:image/png|jpeg;base64,...` — o conteúdo precisa ser
 *    PNG/JPG de verdade (magic bytes) e caber em TENANT_LOGO_MAX_BYTES. Só
 *    PNG/JPG porque o PDF do contrato (pdf-lib) só embute esses dois;
 *  - link http(s) (compatível com o que o super-admin já gravava).
 * Qualquer outra coisa (SVG, javascript:, texto solto, imagem gigante) → 400.
 */
export function normalizeTenantLogo(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new BadRequestException('Logo inválida.');
  const v = raw.trim();
  if (!v) return null;

  if (v.startsWith('data:')) {
    const m = v.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!m) throw new BadRequestException('Logo inválida: envie uma imagem PNG ou JPG.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > TENANT_LOGO_MAX_BYTES) {
      throw new BadRequestException('Logo muito pesada — use uma imagem menor (até 400 KB).');
    }
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if ((m[1] === 'png' && !isPng) || (m[1] === 'jpeg' && !isJpg)) {
      throw new BadRequestException('Logo inválida: o arquivo não é um PNG/JPG de verdade.');
    }
    return v;
  }

  if (/^https?:\/\//i.test(v)) {
    if (v.length > 2048) throw new BadRequestException('Link da logo muito longo.');
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo');
    } catch {
      throw new BadRequestException('Link da logo inválido.');
    }
    return v;
  }

  throw new BadRequestException('Logo inválida: envie uma imagem PNG ou JPG.');
}
