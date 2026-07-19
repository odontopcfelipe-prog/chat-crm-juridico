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
