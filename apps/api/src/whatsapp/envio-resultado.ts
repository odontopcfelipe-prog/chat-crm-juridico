// Como ler a resposta da Evolution num envio automático (retorno, campanha). A Evolution
// NÃO lança em erro: devolve {statusCode, error} (ver WhatsappService.request).

/** JSON da resposta, com o corpo de erro da Evolution (string JSON) desescapado. */
function safeJson(v: any): string {
  try {
    return (JSON.stringify(v) ?? '').replace(/\\"/g, '"');
  } catch {
    return '';
  }
}

/** 400 da Evolution com exists:false = o número não tem WhatsApp (falha definitiva). */
export function numeroSemWhatsapp(res: any): boolean {
  return res?.exists === false || /"exists"\s*:\s*false/.test(safeJson(res));
}

/** Mesma regra do quotes.service: a Evolution NÃO lança em erro, devolve {statusCode,error}. */
export function wasSent(res: any): boolean {
  if (!res || typeof res !== 'object') return false;
  if (typeof res.statusCode === 'number' && res.statusCode >= 400) return false;
  if (res.error && !res.key) return false;
  if (res.exists === false) return false;
  return !!(res.key?.id || res.messageId || res.id);
}

/**
 * Erro que GARANTE que não saiu (chip desconectado / instância inexistente / Evolution
 * recusou a conexão): libera a marca e pausa, em vez de "gastar" o toque. Timeout e 5xx
 * NÃO entram: pode ter saído — fica FALHOU e nunca reenvia sozinho.
 */
export function chipForaDoAr(res: any): boolean {
  const s = safeJson(res).toLowerCase();
  const code = typeof res?.statusCode === 'number' ? res.statusCode : undefined;
  return code === 404 || code === 428 || /connection closed|not connected|instance .*(not|does not) exist|econnrefused/.test(s);
}
