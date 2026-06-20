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
