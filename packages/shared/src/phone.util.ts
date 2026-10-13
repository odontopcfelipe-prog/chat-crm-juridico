// Onda 17.56 — normaliza numero brasileiro pra Evolution/WhatsApp.
//
// O problema: telefones de paciente costumam ser salvos SEM o codigo do pais
// (ex.: "(82) 99657-8143"), porque a mascara do cadastro tira o 55. A Evolution
// le isso como pais errado e responde exists:false -> o disparo nao entrega, em
// silencio. Esta funcao adiciona o 55 na HORA do envio.
//
// CIRURGICA e IDEMPOTENTE:
//  - so adiciona o 55 quando o numero tem 10-11 digitos (DDD + numero, "pelado");
//  - numero que JA tem DDI (12-13 digitos) passa intacto (so vira digitos);
//  - JID de grupo/individual (tem "@") passa 100% intacto;
//  - rodar de novo no resultado nao muda nada.
export function toBrazilWhatsappNumber(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return (raw ?? '') as string;
  if (raw.includes('@')) return raw; // JID (ex.: 5582...@s.whatsapp.net, ...@g.us)
  const d = raw.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`; // BR sem DDI -> adiciona
  return d; // ja tem DDI, ou formato incomum -> so digitos (Evolution quer digitos)
}

// ─── Forma CANÔNICA de armazenamento/casamento (ANTI-duplicata) ──────────────
// DIFERENTE de toBrazilWhatsappNumber (acima): aquela é só pra ENVIO (preserva o
// 9 → 13 díg). Estas gravam/casam na forma canônica 55+DDD+8 (SEM o 9, 12 díg).
// Antes viviam só em apps/api/common/utils/phone.ts; movidas pra cá pra o WORKER e
// os scripts usarem a MESMA lógica (nunca recriar paralelo). apps/api re-exporta.
//
// Formato canônico: 55 + DDD(2) + número(8) = 12 dígitos (sem o nono dígito).

/** Normaliza um telefone BR pra forma canônica (55+DDD+8, sem o 9). Idempotente. */
export function normalizeBrazilianPhone(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');

  // 55 + DD(2) + 9(1) + número(8) = 13 dígitos → tira o 9.
  if (cleaned.length === 13 && cleaned.startsWith('55')) {
    const ddd = cleaned.substring(2, 4);
    const fifthDigit = cleaned.substring(4, 5);
    const rest = cleaned.substring(5);
    if (fifthDigit === '9') {
      return `55${ddd}${rest}`;
    }
  }

  // DD(2) + 9(1) + número(8) = 11 dígitos (sem 55, com 9) → 55 + DDD + 8.
  if (cleaned.length === 11 && !cleaned.startsWith('55')) {
    const ddd = cleaned.substring(0, 2);
    const thirdDigit = cleaned.substring(2, 3);
    const rest = cleaned.substring(3);
    if (thirdDigit === '9') {
      return `55${ddd}${rest}`;
    }
  }

  // DD(2) + número(8) = 10 dígitos (sem 55, sem 9) → adiciona 55.
  if (cleaned.length === 10 && !cleaned.startsWith('55')) {
    return `55${cleaned}`;
  }

  return cleaned;
}

/** Dado o canônico (12 díg), devolve a variante COM o nono dígito (13 díg). */
export function denormalizeBrazilianPhone(normalizedPhone: string): string {
  const cleaned = normalizedPhone.replace(/\D/g, '');
  if (cleaned.length === 12 && cleaned.startsWith('55')) {
    const ddd = cleaned.substring(2, 4);
    const number = cleaned.substring(4);
    return `55${ddd}9${number}`;
  }
  return cleaned;
}

/**
 * Todas as variantes de DÍGITOS por onde o MESMO telefone brasileiro pode estar
 * gravado (com/sem o 9, com/sem o DDI 55). Serve pra CASAR um registro legado sem
 * criar um contato GÊMEO. SEGURO contra falso-merge: só adiciona/remove 55 e o 9
 * do MESMO assinante, nunca toca nos 8 dígitos finais — pessoas diferentes jamais
 * compartilham uma variante. Fixo (8 díg) só gera a variante-com-9 teórica (não casa).
 */
export function brazilPhoneMatchVariants(raw: string | null | undefined): string[] {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return [];
  const canon = normalizeBrazilianPhone(digits); // 55 + DDD + 8 (forma canônica)
  const set = new Set<string>([digits, canon]);
  if (canon.length === 12 && canon.startsWith('55')) {
    const ddd = canon.slice(2, 4);
    const num8 = canon.slice(4);
    set.add(`${ddd}${num8}`); // DDD + 8 (local, sem 55)
    set.add(`55${ddd}9${num8}`); // 55 + DDD + 9 + 8 (com nono dígito)
    set.add(`${ddd}9${num8}`); // DDD + 9 + 8 (com nono, sem 55)
  }
  return [...set];
}

// ─── Números de AVISO INTERNO aos ADMs (vários por clínica) ─────────────────
// VENDA_FEITA_PHONE_<t> / DAILY_SUMMARY_PHONE_<t> aceitam VÁRIOS números separados
// por vírgula, ponto-e-vírgula ou quebra de linha ("5582999998888, 82988887777").
// Fonte ÚNICA do parse — a API (venda feita, resumo diário, anexo de não-paciente)
// e o worker (admin-alerts) usam esta mesma função; nunca recriar.

/** Separadores aceitos entre os números de aviso. */
export const ALERT_PHONES_SEPARATOR_RE = /[,;\r\n]+/;

/**
 * Celular/fixo BR no formato de ENVIO: 55 + DDD (2 dígitos, sem 0) + 8 dígitos
 * (fixo / celular antigo) ou 9 + 8 dígitos (celular). Barra o que o
 * toBrazilWhatsappNumber deixa passar mas nunca entrega: dois números colados
 * ("8299999888882988887777"), local de 9 dígitos com 55 ("55829999988" → 5555829999988),
 * 55 digitado duas vezes ("555582999998888").
 */
const ALERT_PHONE_SEND_RE = /^55[1-9]{2}(?:9\d{8}|\d{8})$/;

/** Um trecho → número pronto pra envio (toBrazilWhatsappNumber), ou null se não é um telefone BR válido. */
export function toAlertPhone(part: string | null | undefined): string | null {
  const digits = String(part ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const envio = toBrazilWhatsappNumber(digits);
  return ALERT_PHONE_SEND_RE.test(envio) ? envio : null;
}

/**
 * Lista de números de aviso → números PRONTOS PRA ENVIO (toBrazilWhatsappNumber),
 * sem repetidos (o mesmo assinante com/sem 9 ou 55 conta 1 vez — casa pelo
 * canônico) e sem lixo (trecho que não é telefone BR válido — toAlertPhone — é
 * descartado). Ordem preservada.
 */
export function parseAlertPhones(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const parte of raw.split(ALERT_PHONES_SEPARATOR_RE)) {
    const envio = toAlertPhone(parte);
    if (!envio) continue;
    const canon = normalizeBrazilianPhone(envio);
    if (vistos.has(canon)) continue;
    vistos.add(canon);
    out.push(envio);
  }
  return out;
}

/**
 * Trechos que NÃO viram telefone BR válido (curto demais, dois números colados,
 * 55 repetido...) — pra a tela recusar em vez de salvar e silenciar o aviso.
 * Trechos vazios são ignorados.
 */
export function invalidAlertPhoneParts(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(ALERT_PHONES_SEPARATOR_RE)
    .map((p) => p.trim())
    .filter((p) => p && !toAlertPhone(p));
}
