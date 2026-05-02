/**
 * Helpers de erro pro frontend (Fase 25 Onda 2.6).
 *
 * Substitui o anti-pattern `.catch(() => {})` que engole erros silenciosamente
 * por algo documentado e debugavel.
 */

/**
 * swallow() — descarta erro INTENCIONALMENTE com motivo registrado.
 *
 * Use quando voce realmente quer ignorar a falha (ex: autoplay bloqueado
 * pelo navegador, navegacao opcional do calendar lib que pode falhar antes
 * do mount, lazy loading de dado nao essencial).
 *
 * - DEV: mostra console.warn com o motivo + objeto de erro
 * - PROD: silente (nao polui console do cliente)
 *
 * Exemplos:
 *   audioEl.play().catch(swallow('autoplay bloqueado pelo navegador'));
 *   api.get('/users/agents').then(...).catch(swallow('lazy load opcional'));
 *   try { (calendar as any).navigate(date); } catch (e) { swallow('calendar nao montou')(e); }
 *
 * Anti-pattern que isso substitui:
 *   .catch(() => {})       <-- ZERO contexto pra debug, vira mistério
 *   try {...} catch {}      <-- mesma coisa
 */
export function swallow(reason: string) {
  return (err: unknown) => {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(`[swallowed: ${reason}]`, err);
    }
  };
}

/**
 * logError() — registra erro SEM mostrar toast (uso interno / background).
 *
 * Use quando o erro nao deve interromper o fluxo do usuario MAS voce quer
 * rastreabilidade. Ex: telemetria que falha, sincronizacao secundaria.
 *
 * Sempre loga (mesmo em prod) — sem mostrar pro usuario.
 *
 * Exemplo:
 *   api.post('/analytics/track', payload).catch(logError('analytics track'));
 */
export function logError(context: string) {
  return (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[${context}]`, err);
  };
}
