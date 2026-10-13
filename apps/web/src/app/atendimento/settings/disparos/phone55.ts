// Prefixo fixo "55" (código do país) pros inputs de número dos disparos internos.
// O campo editável guarda só o DDD + número; o "55" é um rótulo fixo à esquerda que
// não dá pra apagar. Sem o 55 o WhatsApp não entrega — então nunca depende de a
// pessoa lembrar de digitar. Strip/join usam SÓ UM "55" de borda, então DDD 55 (RS)
// também faz round-trip: "555599999999" -> local "5599999999" -> "555599999999".

/** Do valor salvo (ex.: "5582999998888") tira o "55" da frente pra editar só o local. */
export function stripCountry55(stored: string | null | undefined): string {
  const d = (stored || '').replace(/\D/g, '');
  return d.startsWith('55') ? d.slice(2) : d;
}

/** Do local editado monta o valor a salvar (recoloca o 55). Local vazio = "" (sem número). */
export function join55(local: string | null | undefined): string {
  const d = (local || '').replace(/\D/g, '');
  return d ? '55' + d : '';
}

/** Tem número de verdade (não só vazio)? */
export function hasLocalNumber(local: string | null | undefined): boolean {
  return (local || '').replace(/\D/g, '').length > 0;
}

// ─── Vários números (avisos internos aos ADMs) ──────────────────────────────
// VENDA_FEITA_PHONE / DAILY_SUMMARY_PHONE aceitam VÁRIOS números, salvos como
// "5582999998888, 5582988887777" (a API normaliza com o parseAlertPhones do shared).
// Aqui só separa/junta pros campos da tela — cada campo edita DDD + número.

/** Valor salvo ("5582…, 5582…") → lista de locais (DDD + número), mínimo 1 campo vazio. */
export function splitStoredPhones(stored: string | null | undefined): string[] {
  const locais = String(stored || '')
    .split(/[,;\r\n]+/)
    .map((p) => stripCountry55(p))
    .filter((p) => p.length > 0);
  return locais.length ? locais : [''];
}

/** Lista de locais → valor a salvar ("5582…, 5582…"). Campos vazios somem. */
export function joinPhones55(locais: string[]): string {
  return locais.map((l) => join55(l)).filter(Boolean).join(', ');
}

/** Algum campo tem número? */
export function hasAnyLocalNumber(locais: string[]): boolean {
  return locais.some((l) => hasLocalNumber(l));
}
