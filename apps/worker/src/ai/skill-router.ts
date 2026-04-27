import { Logger } from '@nestjs/common';
import { createLLMClient, type LLMProvider } from './llm-client';

interface SkillSummary {
  id: string;
  name: string;
  description: string | null;
  area: string;
  trigger_keywords: string[];
  skill_type: string;
  tool_names: string[];
}

interface RouterResult {
  skillId: string;
  reason: string;
  tokensUsed: number;
}

export class SkillRouter {
  private readonly logger = new Logger(SkillRouter.name);

  /**
   * Seleciona a skill mais adequada usando uma chamada LLM barata.
   * Fallback: area matching se a chamada falhar.
   *
   * STICKINESS: se `currentPipelineSlug` está definido (lead já classificado em
   * um funil específico), o router prioriza a skill que ATENDE esse funil — só
   * troca se o lead EXPLICITAMENTE pedir outro procedimento. Isso evita o bug
   * onde o lead mandava "me agende" e o router trocava pra Implantes mesmo
   * estando em Lentes de Porcelana (porque palavras como "agendar" matchavam
   * triggers de várias skills).
   */
  async selectSkill(params: {
    skills: any[];
    lastMessages: string[];
    specialty: string | null;
    nextStep: string | null;
    currentPipelineSlug?: string | null;
    routerModel: string;
    routerProvider: LLMProvider;
    apiKey: string;
  }): Promise<RouterResult> {
    const { skills, lastMessages, specialty, nextStep, currentPipelineSlug, routerModel, routerProvider, apiKey } = params;

    if (!skills.length) {
      return { skillId: '', reason: 'nenhuma skill disponível', tokensUsed: 0 };
    }

    // Build compact skill catalog
    const catalog = skills.map((s: any, i: number) => {
      const toolNames = (s.tools || []).map((t: any) => t.name).join(', ');
      const kw = (s.trigger_keywords || []).join(', ');
      const desc = s.description || s.name;
      return `${i + 1}. [${s.id}] "${s.name}" — ${desc}${kw ? `. Keywords: [${kw}]` : ''}${toolNames ? `. Tools: [${toolNames}]` : ''}`;
    }).join('\n');

    const stickinessRule = currentPipelineSlug
      ? `

⚠️ REGRA DE STICKINESS (PRIORITÁRIA — sobrescreve as outras):
O lead já está classificado no funil "${currentPipelineSlug}". Se existe na lista uma skill especialista que atende esse funil (procure na descrição da skill por menções a "${currentPipelineSlug}" ou pelo nome do funil), VOCÊ DEVE selecionar essa skill — mantém continuidade da conversa.

A ÚNICA exceção é se o lead EXPLICITAMENTE disser na última mensagem que quer mudar de procedimento, tipo:
- "ah, na verdade quero implante"
- "deixa pra lá lente, queria saber de aparelho"
- "esquece, mudei de ideia, queria clareamento"

Pedir AGENDAMENTO ("me agende", "que dia tem horário", "marca pra terça", "vou na quarta") NÃO é motivo pra trocar de skill — o especialista atual sabe agendar (todos têm a tool scheduling_action).
Pedir PREÇO, falar de DOR, pedir LOCALIZAÇÃO, dizer "obrigado" — também NÃO trocam skill. Mantém o especialista atual.`
      : '';

    const systemPrompt = `Você é o roteador de skills de um CRM odontológico. Analise o contexto da conversa e selecione a skill mais adequada para responder.${stickinessRule}

Regras gerais (use SE não se aplicar a stickiness acima):
- Escolha a skill que melhor se encaixa no contexto da última mensagem do cliente
- Se a especialidade já foi identificada, prefira skills dessa especialidade
- Se nenhuma skill especialista se encaixa, escolha a skill de triagem ou geral

Skills disponíveis:
${catalog}

Retorne APENAS um JSON válido: { "skill_id": "<id>", "reason": "<motivo curto explicando se aplicou stickiness ou não>" }`;

    const contextLines = [
      currentPipelineSlug ? `Funil atual do lead: ${currentPipelineSlug} (mantenha skill desse funil — ver regra de stickiness)` : null,
      specialty ? `Especialidade atual: ${specialty}` : null,
      nextStep ? `Próximo passo: ${nextStep}` : null,
      'Últimas mensagens:',
      ...lastMessages.slice(-5).map((m) => `- ${m}`),
    ].filter(Boolean).join('\n');

    try {
      const client = createLLMClient(routerProvider, apiKey);
      const response = await client.chat({
        model: routerModel,
        systemPrompt,
        messages: [{ role: 'user', content: contextLines }],
        maxTokens: 150,
        temperature: 0,
        jsonMode: true,
      });

      const text = response.content || '{}';
      const parsed = JSON.parse(text);

      // Validate skill_id exists in our list
      const matchedSkill = skills.find((s: any) => s.id === parsed.skill_id);
      if (matchedSkill) {
        this.logger.log(`[Router] Selecionou "${matchedSkill.name}" — ${parsed.reason}`);
        return {
          skillId: matchedSkill.id,
          reason: parsed.reason || '',
          tokensUsed: response.usage.totalTokens,
        };
      }

      this.logger.warn(`[Router] skill_id "${parsed.skill_id}" não encontrado, usando fallback`);
    } catch (err: any) {
      this.logger.warn(`[Router] Falha na chamada LLM: ${err.message}. Usando fallback area-matching.`);
    }

    // Fallback: area matching (lógica original)
    return {
      skillId: this.fallbackSelect(skills, specialty),
      reason: 'fallback: area matching',
      tokensUsed: 0,
    };
  }

  /** Fallback: lógica original de seleção por area */
  private fallbackSelect(skills: any[], specialty: string | null): string {
    if (specialty) {
      const specialist = skills.find(
        (s: any) =>
          s.area.toLowerCase().includes(specialty.toLowerCase()) ||
          specialty.toLowerCase().includes(s.area.toLowerCase()),
      );
      if (specialist) return specialist.id;
    }
    const fallback = skills.find((s: any) =>
      ['geral', '*', 'triagem'].includes(s.area.toLowerCase()),
    );
    return (fallback || skills[0])?.id || '';
  }
}
