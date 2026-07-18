/**
 * Centraliza a normalização de telefones para evitar duplicidades no banco de dados.
 *
 * Formato canônico: 55 + DDD(2) + número(8) = 12 dígitos (sem o nono dígito).
 *
 * Exemplos:
 *   5582999615165 (13 dígitos) → 558299615165 (12 dígitos)
 *   82999615165  (11 dígitos)  → 558299615165 (12 dígitos)
 *   8299615165   (10 dígitos)  → 558299615165 (12 dígitos)
 *   558232123456 (12 dígitos, fixo) → 558232123456 (inalterado)
 */
export function normalizeBrazilianPhone(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');

  // Case 1: Formato internacional completo com prefixo 55
  // 55 + DD(2) + 9(1) + número(8) = 13 dígitos
  if (cleaned.length === 13 && cleaned.startsWith('55')) {
    const ddd = cleaned.substring(2, 4);
    const fifthDigit = cleaned.substring(4, 5);
    const rest = cleaned.substring(5);
    if (fifthDigit === '9') {
      return `55${ddd}${rest}`;
    }
  }

  // Case 2: Formato local sem prefixo 55, COM nono dígito
  // DD(2) + 9(1) + número(8) = 11 dígitos
  if (cleaned.length === 11 && !cleaned.startsWith('55')) {
    const ddd = cleaned.substring(0, 2);
    const thirdDigit = cleaned.substring(2, 3);
    const rest = cleaned.substring(3);
    if (thirdDigit === '9') {
      return `55${ddd}${rest}`;
    }
  }

  // Case 3: Formato local sem prefixo 55, SEM nono dígito
  // DD(2) + número(8) = 10 dígitos → adiciona 55
  if (cleaned.length === 10 && !cleaned.startsWith('55')) {
    return `55${cleaned}`;
  }

  return cleaned;
}

/**
 * Dado um phone normalizado (12 dígitos: 55+DD+8dígitos),
 * retorna a variante com nono dígito (13 dígitos: 55+DD+9+8dígitos).
 * Usado para encontrar registros legados que ainda têm o formato antigo.
 */
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
 * gravado no banco (com/sem o nono dígito de operadora, com/sem o DDI 55). Serve
 * pra CASAR um registro legado — vindo do cadastro manual de paciente (13 díg
 * cru), do backfill antigo (string formatada "+55 (82) 9…") ou do webhook (12 díg)
 * — sem criar um contato GÊMEO.
 *
 * SEGURO contra falso-merge: as variantes só adicionam/removem o 55 e o 9 do
 * MESMO assinante, nunca tocam nos 8 dígitos finais. Dois números de pessoas
 * diferentes jamais compartilham uma variante. Fixo (8 díg começando 2-5) só
 * gera a variante-com-9 teórica, que não existe pra fixo → não casa nada.
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
