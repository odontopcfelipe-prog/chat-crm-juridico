import { Logger } from '@nestjs/common';
import { createLLMClient, type LLMProvider } from './llm-client';

export type NonPatientCategory =
  | 'PACIENTE'
  | 'FORNECEDOR'
  | 'CURRICULO'
  | 'PARCERIA'
  | 'SPAM';

/**
 * Classificador barato "paciente vs não-paciente" — 1 chamada LLM curta (JSON mode,
 * temperatura 0), no MOLDE do SkillRouter. Roda ANTES do LLM de venda pra detectar
 * quando quem escreve NÃO é paciente/lead (fornecedor oferecendo serviço, currículo,
 * parceria, propaganda) — nesses casos a IA encaminha ao responsável e encerra, em vez
 * de "tentar vender dente".
 *
 * PRINCÍPIO DE SEGURANÇA: na dúvida, retorna PACIENTE (nunca bloqueia paciente real).
 * Qualquer erro/timeout cai em PACIENTE → o fluxo de venda segue normal.
 */
export class NonPatientClassifier {
  private readonly logger = new Logger(NonPatientClassifier.name);

  async classify(params: {
    /** Só as mensagens DO CONTATO (inbound), as mais recentes. */
    inboundMessages: string[];
    model: string;
    provider: LLMProvider;
    apiKey: string;
  }): Promise<{ category: NonPatientCategory; reason: string }> {
    const { inboundMessages, model, provider, apiKey } = params;

    const systemPrompt = `Você classifica QUEM está escrevendo para uma clínica odontológica no WhatsApp. Leia SÓ as mensagens do contato e diga em qual categoria ele se encaixa:

- PACIENTE: alguém interessado em TRATAMENTO/consulta/preço/dor/orçamento/agendamento, ou um paciente atual. QUALQUER dúvida sobre serviços odontológicos, valores, horários, localização, convênio = PACIENTE.
- FORNECEDOR: alguém VENDENDO ou OFERECENDO um produto/serviço PARA a clínica (marketing, Google, tráfego, software, materiais, sistema, consultoria, etc.).
- CURRICULO: alguém procurando EMPREGO/vaga, enviando currículo, se candidatando a trabalhar na clínica.
- PARCERIA: proposta de parceria/permuta/indicação comercial entre empresas.
- SPAM: propaganda em massa, corrente, golpe, link suspeito, nada a ver com a clínica.

REGRA DE OURO: na menor DÚVIDA, responda PACIENTE — é sempre mais seguro atender. Só classifique como não-PACIENTE quando estiver CLARO que a pessoa NÃO quer tratamento e sim vender/oferecer algo para a clínica ou se candidatar a emprego.

Retorne APENAS JSON válido: { "categoria": "PACIENTE|FORNECEDOR|CURRICULO|PARCERIA|SPAM", "motivo": "<curto>" }`;

    const userContent = [
      'Mensagens do contato:',
      ...inboundMessages.slice(-6).map((m) => `- ${m}`),
    ].join('\n');

    try {
      const client = createLLMClient(provider, apiKey);
      const response = await client.chat({
        model,
        systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        maxTokens: 80,
        temperature: 0,
        jsonMode: true,
      });

      const parsed = JSON.parse(response.content || '{}');
      const raw = String(parsed.categoria || '').trim().toUpperCase();
      const valid: NonPatientCategory[] = ['PACIENTE', 'FORNECEDOR', 'CURRICULO', 'PARCERIA', 'SPAM'];
      const category = (valid.includes(raw as NonPatientCategory) ? raw : 'PACIENTE') as NonPatientCategory;
      return { category, reason: String(parsed.motivo || '').slice(0, 120) };
    } catch (err: any) {
      // Fail-safe: qualquer erro → PACIENTE (segue o atendimento normal).
      this.logger.warn(`[NÃO-PACIENTE] classify falhou (assume PACIENTE): ${err?.message}`);
      return { category: 'PACIENTE', reason: 'erro/segue normal' };
    }
  }
}
