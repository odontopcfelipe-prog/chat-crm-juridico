import { Logger } from '@nestjs/common';
import type { LLMToolDef } from './llm-client';

/**
 * Rotulos legiveis das subcategorias de memoria organizacional.
 * Usado para compor o bloco "Informacoes do Escritorio" no prompt.
 */
const ORG_SUBCATEGORY_LABELS: Record<string, string> = {
  office_info: 'Escritorio',
  team: 'Equipe',
  fees: 'Honorarios',
  procedures: 'Procedimentos',
  court_info: 'Foruns e Varas',
  legal_knowledge: 'Conhecimento Local',
  contacts: 'Contatos Uteis',
  rules: 'Regras',
  geral: 'Geral',
};

/**
 * PromptBuilder: monta o system prompt final e as definições de tools
 * a partir da skill selecionada, suas references e variáveis de contexto.
 */
export class PromptBuilder {
  private readonly logger = new Logger(PromptBuilder.name);

  /**
   * Compoe o bloco de "Informacoes do Escritorio" a partir das memorias
   * organizacionais ativas (agrupadas por subcategoria).
   * Retorna null quando nao ha memorias suficientes.
   *
   * Token budget: truncado em ~2000 chars (~500 tokens).
   */
  buildOrganizationMemoryBlock(memories: Array<{ content: string; subcategory: string | null }>): string | null {
    if (!memories || memories.length === 0) return null;

    const grouped: Record<string, string[]> = {};
    for (const m of memories) {
      const cat = m.subcategory || 'geral';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(m.content);
    }

    let block = '';
    for (const [cat, items] of Object.entries(grouped)) {
      const label = ORG_SUBCATEGORY_LABELS[cat] || cat;
      block += `**${label}:** ${items.join('. ')}.\n`;
    }

    if (block.length > 2000) {
      block = block.substring(0, 2000) + '\n[...memorias omitidas por espaco]';
    }
    return block.trim();
  }

  /**
   * Compoe as 3 camadas de memoria que vao no inicio do system prompt:
   *   1. Informacoes do Escritorio (OrganizationProfile.summary OU fallback
   *      bloco agrupado de memorias organizacionais cruas)
   *   2. Perfil do Cliente (LeadProfile.summary)
   *   3. Interacoes Recentes (memorias episodicas)
   *
   * Aceita:
   *   - `orgSummary` (preferido) — texto ja consolidado pronto para injetar
   *   - `orgMemories` (fallback) — lista crua para agrupar via buildOrganizationMemoryBlock
   */
  buildMemoryLayers(params: {
    orgSummary?: string | null;
    orgMemories?: Array<{ content: string; subcategory: string | null }>;
    leadProfileSummary?: string | null;
    recentEpisodes?: Array<{ content: string }>;
  }): string {
    const parts: string[] = [];

    let orgText: string | null = null;
    if (params.orgSummary && params.orgSummary.trim()) {
      orgText = params.orgSummary.trim();
    } else if (params.orgMemories && params.orgMemories.length > 0) {
      orgText = this.buildOrganizationMemoryBlock(params.orgMemories);
    }
    if (orgText) {
      parts.push(`## Informacoes do Escritorio (use naturalmente, nao cite como "base de dados"):\n${orgText}`);
    }

    if (params.leadProfileSummary && params.leadProfileSummary.trim()) {
      parts.push(`## Perfil do Cliente (use naturalmente, nao cite como "ficha"):\n${params.leadProfileSummary.trim()}`);
    }

    if (params.recentEpisodes && params.recentEpisodes.length > 0) {
      const lines = params.recentEpisodes.map((m) => `- ${m.content}`).join('\n');
      parts.push(`## Interacoes Recentes:\n${lines}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : '';
  }

  /**
   * Monta o system prompt completo para uma chamada LLM.
   * Composição: MEDIA_CAPABILITIES + BEHAVIOR_RULES + skill.system_prompt + references
   *
   * Regras específicas de plantão noturno não ficam aqui — a skill decide
   * via variável {{business_hours_info}} (injetada por ai.processor.ts).
   */
  buildSystemPrompt(params: {
    mediaCapabilities: string;
    behaviorRules: string;
    skillPrompt: string;
    references: { name: string; content: string }[];
    maxContextTokens: number;
    vars: Record<string, string>;
    extraInjections?: string; // ex: FORM_DATA_INJECTION legado
    memoryBlock?: string; // 3 camadas de memoria (org + perfil + episodios)
    pipelinesBlock?: string; // Fase 4: bloco de funis CRM dinâmicos (ver pipeline-context.ts)
    /**
     * Onda 5e v16 (Fase 25) — Regras IMUTAVEIS injetadas POR ULTIMO no prompt,
     * depois ate dos pipelinesBlock/memoryBlock. Razao: LLMs costumam pesar mais
     * o que vem no final. Skills custom no banco podiam contradizer regras de
     * agendamento do CORE_RULES (que vem cedo no prompt). Esse bloco passa
     * APOS tudo, garantindo override mesmo de skill mal escrita.
     */
    finalRules?: string;
  }): string {
    const { mediaCapabilities, behaviorRules, skillPrompt, references, maxContextTokens, vars, extraInjections, memoryBlock, pipelinesBlock, finalRules } = params;

    let prompt = mediaCapabilities + '\n\n';
    prompt += this.injectVariables(behaviorRules, vars) + '\n\n';
    prompt += this.injectVariables(skillPrompt, vars);

    // Injeta bloco de funis CRM no system prompt quando o tenant tem Pipelines
    // configurados. A IA usa os slugs de etapas/funis nas tools respond_to_client
    // (updates.stage_slug / pipeline_slug) e o handler resolve pra IDs do Prisma.
    if (pipelinesBlock && pipelinesBlock.trim()) {
      prompt += '\n\n' + pipelinesBlock;
    }

    // Injeta bloco de memoria automaticamente APENAS se a skill nao referenciar
    // nenhuma das variaveis de memoria novas ({{office_memories}},
    // {{lead_profile}}, {{recent_episodes}}, {{memory_block}}).
    // Assim skills adaptadas controlam o posicionamento via {{...}}, e skills
    // antigas continuam recebendo a memoria no final por retrocompatibilidade.
    if (memoryBlock && memoryBlock.trim()) {
      const usesNewVars = /\{\{(office_memories|lead_profile|recent_episodes|memory_block)\}\}/.test(skillPrompt);
      if (!usesNewVars) {
        prompt += '\n\n' + memoryBlock;
      }
    }

    // Inject references within token budget
    if (references.length > 0) {
      let refBlock = '\n\n--- DOCUMENTOS DE REFERÊNCIA ---\n';
      let totalChars = 0;
      const charBudget = maxContextTokens * 4; // rough token-to-char ratio

      for (const ref of references) {
        if (totalChars + ref.content.length > charBudget) {
          this.logger.warn(`[PromptBuilder] Reference "${ref.name}" truncada (budget de ${maxContextTokens} tokens)`);
          const remaining = charBudget - totalChars;
          if (remaining > 100) {
            refBlock += `\n### ${ref.name}\n${ref.content.slice(0, remaining)}...[truncado]\n`;
          }
          break;
        }
        refBlock += `\n### ${ref.name}\n${ref.content}\n`;
        totalChars += ref.content.length;
      }

      prompt += refBlock;
      this.logger.log(`[PromptBuilder] ${references.length} references injetadas (${totalChars} chars)`);
    } else {
      this.logger.warn('[PromptBuilder] NENHUMA reference encontrada para injeção');
    }

    if (extraInjections) {
      prompt += '\n\n' + this.injectVariables(extraInjections, vars);
    }

    // v16: finalRules injetadas POR ULTIMO — override de skills mal escritas.
    // Vem depois de tudo (skill, pipelines, memoria, references) pra ter peso
    // maximo no comportamento da IA.
    if (finalRules && finalRules.trim()) {
      prompt += '\n\n' + this.injectVariables(finalRules, vars);
    }

    this.logger.log(`[PromptBuilder] Prompt total: ${prompt.length} chars (~${Math.round(prompt.length/4)} tokens)`);
    return prompt;
  }

  /**
   * Converte SkillTool[] do banco para o formato OpenAI/Anthropic function calling.
   */
  buildToolDefinitions(skillTools: any[]): LLMToolDef[] {
    return skillTools
      .filter((t: any) => t.active)
      .map((t: any) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters_json || { type: 'object', properties: {} },
        },
      }));
  }

  /**
   * Tool especial "respond_to_client" que garante o formato de saída consistente.
   * O modelo DEVE chamar este tool como ação final quando tem tools disponíveis.
   */
  buildRespondToClientTool(): LLMToolDef {
    return {
      type: 'function',
      function: {
        name: 'respond_to_client',
        description: 'Envia a resposta final ao cliente via WhatsApp. SEMPRE use esta função como sua ação final para responder ao cliente.',
        parameters: {
          type: 'object',
          properties: {
            reply: {
              type: 'string',
              description: 'Texto da mensagem a enviar ao cliente via WhatsApp',
            },
            updates: {
              type: 'object',
              description: 'Atualizações opcionais do lead. Preencha sempre que houver mudança de estágio ou informação nova coletada.',
              properties: {
                name: {
                  type: 'string',
                  description: 'Nome real do cliente quando informado',
                },
                status: {
                  type: 'string',
                  description: 'DEPRECADO (legado): estágio fixo do funil jurídico. Prefira `stage_slug` + `pipeline_slug` do novo CRM dinâmico. Mantido pra compat com skills antigas. Valores aceitos: QUALIFICANDO, AGUARDANDO_FORM, AGUARDANDO_DOCS, AGUARDANDO_PROC, REUNIAO_AGENDADA, FINALIZADO, PERDIDO.',
                },
                stage_slug: {
                  type: 'string',
                  description: 'Slug da etapa para onde mover o lead no funil CRM dinâmico (ver bloco "FUNIS DISPONÍVEIS" no system prompt). Ex: "qualificando", "consulta-agendada", "orcamento-enviado". Use SEMPRE em vez de `status` quando o admin configurou funis.',
                },
                pipeline_slug: {
                  type: 'string',
                  description: 'Slug do funil onde classificar o lead (ver bloco "FUNIS DISPONÍVEIS"). Use no PRIMEIRO contato pra escolher o funil certo (ex: "odonto", "estetica"). Omita se o lead já está no funil correto.',
                },
                loss_reason: {
                  type: 'string',
                  description: 'Motivo da perda (obrigatório quando status = PERDIDO)',
                },
                area: {
                  type: 'string',
                  description: 'Área jurídica do caso (ex: Trabalhista, Cível, Criminal)',
                },
                lead_summary: {
                  type: 'string',
                  description: 'Resumo do caso coletado até agora',
                },
                next_step: {
                  type: 'string',
                  description: 'Próximo passo do atendimento',
                },
                notes: {
                  type: 'string',
                  description: 'Observações internas sobre o lead',
                },
                form_data: {
                  type: 'object',
                  description: 'Campos do formulário trabalhista coletados. Inclua todos os campos já obtidos.',
                },
              },
            },
            scheduling_action: {
              type: 'object',
              description: 'Use para confirmar agendamento de reunião. Preencha quando o lead CONFIRMAR o horário.',
              properties: {
                action: { type: 'string', enum: ['confirm_slot'] },
                date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
                time: { type: 'string', description: 'Horário no formato HH:MM' },
              },
            },
            slots_to_offer: {
              type: 'array',
              description: 'Quando oferecer horários de reunião ao lead, liste aqui os horários disponíveis. O sistema enviará como mensagem interativa (lista clicável) no WhatsApp. Use APENAS quando estiver na etapa de oferecer horários, NÃO quando já confirmou.',
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string', description: 'Data YYYY-MM-DD' },
                  time: { type: 'string', description: 'Horário HH:MM' },
                  label: { type: 'string', description: 'Texto amigável ex: "Segunda 07/04 às 09:00"' },
                },
              },
            },
          },
          required: ['reply'],
        },
      },
    };
  }

  private injectVariables(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
    }
    return result;
  }
}
