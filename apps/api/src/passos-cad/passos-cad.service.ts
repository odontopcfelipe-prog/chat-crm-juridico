import { BadGatewayException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import type { PedidoDesenhoDto } from './desenho-ia.dto';
import { ESQUEMA_DO_PLANO, INSTRUCOES, limparPedido, textoDoPedido } from './desenho-ia.prompt';

/** Vai na frente o modelo configurado em PASSOS_CAD_MODEL, se houver. */
const MODELOS = ['gpt-6.1-sol', 'gpt-6.1-terra'];
/** Dólares por milhão de tokens (preços da OpenAI em 04/11/2026). */
const PRECOS: Record<string, { entrada: number; saida: number }> = {
  'gpt-6-astra': { entrada: 10, saida: 50 },
  'gpt-6.1-sol': { entrada: 2, saida: 10 },
  'gpt-6.1-terra': { entrada: 1, saida: 5 },
  'gpt-6-luna': { entrada: 0.1, saida: 0.5 },
};
const LIMITE_POR_DIA = 40;
/** Menos que o tempo em que o túnel corta a conexão: senão o técnico vê erro, tenta de novo e paga duas vezes. */
const TEMPO_MAXIMO_MS = 85_000;
const MAIOR_RESPOSTA_EM_TOKENS = 16_000;
const DIA_MS = 24 * 60 * 60 * 1000;
const NAO_RESPONDEU = 'A IA não respondeu. Tente de novo ou desenhe sem IA.';
const SEM_DESENHO = 'A IA não devolveu um desenho. Tente de novo ou desenhe sem IA.';

class ModeloIndisponivel extends Error {}

export function custoEmDolar(modelo: string, entrada: number, saida: number): number {
  const p = PRECOS[modelo];
  return p ? (entrada * p.entrada + saida * p.saida) / 1_000_000 : 0;
}

/** O texto da resposta. A API devolve vários blocos: o que interessa é o da mensagem. */
export function textoDaResposta(dados: unknown): string | null {
  const saida = (dados as { output?: unknown })?.output;
  if (!Array.isArray(saida)) return null;
  for (const item of saida as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (c?.type === 'output_text' && typeof c.text === 'string') return c.text;
  }
  return null;
}

@Injectable()
export class PassosCadService {
  private readonly logger = new Logger(PassosCadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Pede o plano do dente à OpenAI. Quem desenha a superfície é o motor, no navegador do técnico. */
  async desenhar(tenantId: string, dto: PedidoDesenhoDto): Promise<{ plano: unknown; modelo: string }> {
    const chave = (await this.settings.get('OPENAI_API_KEY')) || process.env.OPENAI_API_KEY;
    if (!chave) throw new ServiceUnavailableException('A IA não está configurada neste sistema.');
    const configurado = (await this.settings.get('PASSOS_CAD_MODEL'))?.trim();
    const modelos = configurado ? [configurado, ...MODELOS.filter((m) => m !== configurado)] : MODELOS;

    // A chave é uma só para o sistema todo. Reserva a vaga e só depois conta: quem conta já vê todos os
    // pedidos em andamento, e pedidos simultâneos não passam juntos pelo limite.
    const reserva = await this.prisma.aiUsage.create({ data: { tenant_id: tenantId, model: modelos[0], call_type: 'cad' } });
    const usados = await this.prisma.aiUsage.count({ where: { tenant_id: tenantId, call_type: 'cad', created_at: { gte: new Date(Date.now() - DIA_MS) } } });
    if (usados > LIMITE_POR_DIA) {
      await this.liberar(reserva.id);
      throw new HttpException(`Esta conta chegou ao limite de ${LIMITE_POR_DIA} desenhos com IA em 24 horas.`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const texto = textoDoPedido(limparPedido(dto));
    for (const modelo of modelos) {
      try {
        return await this.chamar(reserva.id, chave, modelo, texto);
      } catch (e) {
        if (!(e instanceof ModeloIndisponivel)) throw e;
        this.logger.warn(`[PassosCad] modelo ${modelo} indisponível, tentando o próximo`);
      }
    }
    await this.liberar(reserva.id);
    throw new BadGatewayException(NAO_RESPONDEU);
  }

  /** Nada foi cobrado: o pedido não conta no limite do dia. */
  private async liberar(id: string): Promise<void> {
    await this.prisma.aiUsage.delete({ where: { id } }).catch(() => undefined);
  }

  private async chamar(reservaId: string, chave: string, modelo: string, texto: string): Promise<{ plano: unknown; modelo: string }> {
    let resposta: Response;
    try {
      resposta = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelo,
          instructions: INSTRUCOES,
          input: [{ role: 'user', content: [{ type: 'input_text', text: texto }] }],
          text: { format: { type: 'json_schema', name: 'plano_do_dente', schema: ESQUEMA_DO_PLANO, strict: true } },
          // Sem guardar na OpenAI: as medidas do caso servem só para esta resposta.
          store: false,
          max_output_tokens: MAIOR_RESPOSTA_EM_TOKENS,
        }),
        signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
      });
    } catch (e) {
      // Tempo esgotado: a OpenAI pode ter cobrado. A reserva fica e conta no limite.
      this.logger.warn(`[PassosCad] falha ao chamar a OpenAI: ${e instanceof Error ? e.name : 'erro'}`);
      throw new BadGatewayException(NAO_RESPONDEU);
    }
    const corpo: unknown = await resposta.json().catch(() => null);
    if (!resposta.ok) {
      const msg = String((corpo as { error?: { message?: unknown } })?.error?.message ?? '');
      if (resposta.status === 404 || /model/i.test(msg)) throw new ModeloIndisponivel(msg);
      this.logger.warn(`[PassosCad] OpenAI respondeu ${resposta.status}: ${msg.slice(0, 200)}`);
      await this.liberar(reservaId);
      throw new BadGatewayException(NAO_RESPONDEU);
    }

    const uso = (corpo as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } })?.usage;
    if (!uso) this.logger.warn('[PassosCad] resposta sem o uso de tokens: o gasto fica registrado como zero');
    if (!PRECOS[modelo]) this.logger.warn(`[PassosCad] modelo ${modelo} sem preço na tabela: o gasto fica registrado como zero`);
    const entrada = uso?.input_tokens ?? 0;
    const saida = uso?.output_tokens ?? 0;
    // O gasto aconteceu mesmo que a resposta venha quebrada: registra antes de conferir.
    await this.prisma.aiUsage.update({
      where: { id: reservaId },
      data: { model: modelo, prompt_tokens: entrada, completion_tokens: saida, total_tokens: uso?.total_tokens ?? entrada + saida, cost_usd: custoEmDolar(modelo, entrada, saida) },
    });

    const conteudo = textoDaResposta(corpo);
    if (!conteudo) throw new BadGatewayException(SEM_DESENHO);
    try {
      return { plano: JSON.parse(conteudo), modelo };
    } catch {
      throw new BadGatewayException(SEM_DESENHO);
    }
  }
}
