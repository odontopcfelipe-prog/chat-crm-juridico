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
   */
  async selectSkill(params: {
    skills: any[];
    lastMessages: string[];
    legalArea: string | null;
    nextStep: string | null;
    routerModel: string;
    routerProvider: LLMProvider;
    apiKey: string;
  }): Promise<RouterResult> {
    const { skills, lastMessages, legalArea, nextStep, routerModel, routerProvider, apiKey } = params;

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

    const systemPrompt = `Você é o roteador de skills de um CRM jurídico. Analise o contexto da conversa e selecione a skill mais adequada para responder.

Regras:
- Escolha a skill que melhor se encaixa no contexto da última mensagem do cliente
- Se a área jurídica já foi identificada, prefira skills dessa área
- Se o cliente está pedindo agendamento, prefira skills com tool de agendamento
- Se nenhuma skill especialista se encaixa, escolha a skill de triagem ou geral

Skills disponíveis:
${catalog}

Retorne APENAS um JSON válido: { "skill_id": "<id>", "reason": "<motivo curto>" }`;

    const contextLines = [
      legalArea ? `Área jurídica atual: ${legalArea}` : null,
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
      skillId: this.fallbackSelect(skills, legalArea),
      reason: 'fallback: area matching',
      tokensUsed: 0,
    };
  }

  /** Fallback: lógica original de seleção por area */
  private fallbackSelect(skills: any[], legalArea: string | null): string {
    if (legalArea) {
      const specialist = skills.find(
        (s: any) =>
          s.area.toLowerCase().includes(legalArea.toLowerCase()) ||
          legalArea.toLowerCase().includes(s.area.toLowerCase()),
      );
      if (specialist) return specialist.id;
    }
    const fallback = skills.find((s: any) =>
      ['geral', '*', 'triagem'].includes(s.area.toLowerCase()),
    );
    return (fallback || skills[0])?.id || '';
  }
}
