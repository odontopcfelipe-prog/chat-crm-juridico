/**
 * Structured Logger (Fase 25 Onda 2.8).
 *
 * Adiciona CONTEXTO estruturado (tenant_id, user_id, action, etc) a cada
 * log line, sem precisar substituir o NestJS Logger nativo nem instalar
 * dependencia nova (pino, winston).
 *
 * Por que estruturado importa:
 *   Sem contexto:
 *     [QuotesService] Erro ao salvar orcamento
 *   <- qual tenant? qual usuario? qual quote? qual ambiente?
 *
 *   Com contexto:
 *     [QuotesService] Erro ao salvar orcamento {"tenant_id":"abc","user_id":"xyz","quote_id":"qwe","duration_ms":420}
 *   <- tudo que precisa pra debugar producao em 30s.
 *
 * Em log aggregator (Loki, Datadog, ELK), filtra por qualquer campo
 * facilmente (tenant_id="abc", action="create_quote", duration_ms>1000).
 *
 * Uso (padrao recomendado):
 *
 *   import { logCtx } from '../common/logger/structured-logger';
 *
 *   @Injectable()
 *   export class QuotesService {
 *     private readonly logger = new Logger(QuotesService.name);
 *
 *     async create(patientId, tenantId, userId, dto) {
 *       const ctx = logCtx({ tenant_id: tenantId, user_id: userId, action: 'create_quote', patient_id: patientId });
 *       const start = Date.now();
 *       try {
 *         const quote = await this.prisma.quote.create({ ... });
 *         this.logger.log(ctx({ quote_id: quote.id, duration_ms: Date.now() - start }, 'Orcamento criado'));
 *         return quote;
 *       } catch (e: any) {
 *         this.logger.error(ctx({ duration_ms: Date.now() - start, error: e.message }, 'Falha ao criar orcamento'));
 *         throw e;
 *       }
 *     }
 *   }
 *
 * Output:
 *   [Nest] LOG [QuotesService] Orcamento criado {"tenant_id":"...","user_id":"...","action":"create_quote","quote_id":"...","duration_ms":42}
 *
 * Mantem compatibilidade total com NestJS Logger — eh so um helper que
 * formata a mensagem.
 */

export type LogContext = Record<string, unknown>;

/**
 * logCtx(base) — cria um formatter que aceita extra context + mensagem
 * e retorna a string final pronta pra logger.log/warn/error.
 *
 * @param base contexto base aplicado a TODAS as chamadas (tenant_id, etc)
 * @returns funcao (extra, message) => "message {json}"
 */
export function logCtx(base: LogContext) {
  return (extra: LogContext, message: string): string => {
    const merged = { ...base, ...extra };
    // Remove chaves undefined/null pra nao poluir output
    const clean = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined && v !== null),
    );
    if (Object.keys(clean).length === 0) return message;
    return `${message} ${JSON.stringify(clean)}`;
  };
}

/**
 * fmtError(err) — extrai info util de erro pra logar (message + stack curta).
 *
 * Use junto com logCtx pra registrar excecoes:
 *   this.logger.error(ctx({ error: fmtError(e) }, 'Falha X'));
 */
export function fmtError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name };
  }
  return { message: String(err) };
}
