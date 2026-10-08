// Instruções (prompts) da MEMÓRIA da clínica odontológica — fonte única:
// extração noturna, extração retroativa, perfil do paciente e resumo da clínica
// (OrganizationProfile.summary, que vai pro prompt da assistente que fala com
// pacientes). O worker reexporta daqui (apps/worker/src/memory/memory-prompts.ts).
//
// Antes eram instruções de escritório de advocacia (advogados, fóruns, honorários,
// OAB). Os FORMATOS JSON de resposta foram mantidos — os processors leem as mesmas
// chaves:
//   extração diária   { memories[{content,scope,subcategory,type,confidence}], superseded[{old_memory_id,reason}] }
//   retroativa        { memories[{content,subcategory,confidence}] }
//   perfil paciente   { summary, facts }   (a tela LeadMemoryPanel usa facts.pending)
//   resumo da clínica { summary, facts }   (incremental: + changes_applied)
//
// Preço NUNCA vem da memória: a clínica configura em Ajustes IA › Valores
// (TenantSetting AI_PRICE_TABLE), que entra no prompt como "VALORES — ORIENTAÇÃO
// DA CLÍNICA".

import { internalOrgMemoryReason, orgMemoryPriceReason, isOrgMemorySubcategory, OrgMemorySubcategory } from './memory-categories';

// ─── Trechos comuns (mesma regra em todas as instruções) ─────────────────────

/** Subcategorias aceitas para memória da clínica (= ORG_MEMORY_SUBCATEGORIES). */
const ORG_SUBCATEGORY_GUIDE = `- "office_info": endereço, ponto de referência, telefones/WhatsApp oficiais, estrutura (estacionamento, acessibilidade), Instagram, horário de funcionamento
- "team": dentistas e suas especialidades, quem faz o quê, recepção (só pessoas reais, com função)
- "procedures": como funciona a avaliação, a anamnese, o agendamento, a confirmação, faltas, atrasos, encaixe e retorno
- "treatments": como funciona cada tratamento (etapas, duração, número de sessões, cuidados antes/depois) — SEM preço
- "payment": formas de pagamento aceitas, parcelamento, convênios — SEM valores
- "rules": políticas da clínica (o que faz e não faz, acompanhante, menores de idade, cancelamento)`;

/** O que NUNCA vira conhecimento da clínica. Rede de segurança determinística (cobre os casos
 * mais comuns, não todos): internalOrgMemoryReason + orgMemoryPriceReason em memory-categories.ts. */
const NEVER_ORG_LIST = `- preços, valores, faixas de preço, descontos, promoções (os valores ficam em Ajustes IA › Valores — não vêm da memória)
- caixa, fechamento do dia, vendas, faturamento, cobrança, boletos, inadimplência, negociações
- estoque, materiais, compras, fornecedores, laboratório
- folha de pagamento, consignado, FGTS, INSS, holerite, assuntos de RH
- CPF, CNPJ, chave PIX, dados bancários
- nomes ou listas de pacientes, casos individuais
- agenda de um dia específico ("hoje só a Dra. X atende", "amanhã não tem horário")
- pendências e recados internos da equipe
- informações sobre a IA / assistente virtual`;

/** Nome da assistente virtual nunca é pessoa da equipe. */
const AI_NAME_RULE = `CUIDADO COM O NOME DA IA:
- A clínica tem uma assistente virtual (IA) que conversa com os pacientes. Ela pode ter qualquer nome (ex.: Sophia) e NÃO é pessoa da equipe.
- Se alguma informação citar a assistente atendendo ou enviando mensagens, NÃO a inclua na Equipe.
- Na dúvida se um nome é pessoa real ou a IA, omita.`;

/** As 5 seções do resumo da clínica (OrganizationProfile.summary). */
const ORG_SUMMARY_SECTIONS = `## Sobre a clínica
<nome, endereço, ponto de referência, telefones/WhatsApp oficiais, Instagram, horário de funcionamento, estrutura>

## Equipe
<dentistas com especialidade e quem faz o quê; recepção. Só pessoas reais com função>

## Como atendemos
<como funciona a avaliação, anamnese, agendamento, confirmação, faltas, atrasos, encaixe, retorno>

## Tratamentos
<como funciona cada tratamento: etapas, duração, sessões, cuidados — sem preço>

## Pagamento e regras
<formas de pagamento, parcelamento, convênios (sem valores) e políticas da clínica. Sobre preço, diga apenas que os valores que podem ser informados estão na orientação de valores da clínica>`;

// ─── 1) Extração diária (DailyMemoryBatchProcessor) ──────────────────────────

export const BATCH_EXTRACTION_PROMPT = `Você é o extrator de memórias de uma CLÍNICA ODONTOLÓGICA.
Analise a conversa abaixo (mensagens do dia) e extraia MEMÓRIAS que ajudem a atender bem.

REMETENTES (campo "sender" de cada mensagem):
- CLIENTE: o paciente ou interessado (lead) que conversa com a clínica.
- EQUIPE_OU_SISTEMA: mensagem enviada pelo número da clínica que NÃO é da assistente virtual. Pode ser a recepção, um(a) dentista ou outra pessoa da equipe — OU uma mensagem AUTOMÁTICA do sistema (lembrete ou confirmação de consulta, cobrança, boleto, relatório interno como fechamento de caixa, vendas do dia, boletos em atraso, listas de pacientes "X dias sem agendar"). Mensagens automáticas e relatórios internos NUNCA viram conhecimento da clínica.
- IA: a assistente virtual da clínica (qualquer nome, ex.: Sophia — nunca é pessoa da equipe). Costuma repetir o que já se sabe; extraia só se houver dado novo do paciente.

ESCOPO (CRÍTICO):

1. scope "lead" — informação DESTE paciente:
   queixa ou motivo do contato, tratamentos de interesse ou já realizados, orçamento apresentado,
   forma de pagamento combinada, preferências (dia/horário, canal, dentista), consultas marcadas,
   remarcadas ou faltas, pendências DELE (exame a trazer, retorno, pagamento, documento).
   NÃO registre CPF, RG, dados bancários nem chave PIX.

2. scope "organization" — SÓ fato DURÁVEL da clínica que serve para atender QUALQUER paciente.
   Subcategoria OBRIGATÓRIA quando scope=organization (use apenas estas):
${ORG_SUBCATEGORY_GUIDE}

NUNCA gere memória "organization" de:
${NEVER_ORG_LIST}
NA DÚVIDA, NÃO extraia como "organization".

REGRA DE OURO: trocando o paciente, a informação continua verdadeira e útil para atender, e é um fato
estável da clínica (não um acontecimento do dia)? Só então "organization". Se só vale para este
paciente -> "lead". Se é dado interno da clínica -> não extraia.

Se o payload trouxer "organization_allowed": false (conversa do chip Financeiro), gere SOMENTE memórias "lead".

REGRAS DE EXTRAÇÃO:
1. Extraia FATOS concretos, não impressões vagas.
2. Cada memória deve ser auto-contida (compreensível sem a conversa).
3. AGRUPE dados relacionados numa memória só, em vez de várias pequenas.
4. type: "episodic" para acontecimento datado (consulta marcada, faltou, fechou orçamento); "semantic" para fato estável.
5. confidence: 1.0 para fatos explícitos, 0.7 para inferências.
6. Se uma informação nova CONTRADIZ uma memória existente (existing_lead_memories / existing_org_memories), inclua em "superseded" com o id dela.
7. IGNORE: "ok", "sim", "bom dia", emojis, agradecimentos, confirmações soltas.
8. QUALIDADE acima de quantidade — 3 memórias boas valem mais que 10 fracas.

JSON de resposta (OBRIGATÓRIO):
{
  "memories": [
    {
      "content": "texto natural da memória",
      "scope": "lead" | "organization",
      "subcategory": "office_info|team|procedures|treatments|payment|rules" (null quando scope=lead),
      "type": "semantic" | "episodic",
      "confidence": 0.0-1.0
    }
  ],
  "superseded": [
    { "old_memory_id": "uuid", "reason": "motivo" }
  ]
}

Se nenhuma memória relevante: { "memories": [], "superseded": [] }`;

// ─── 2) Perfil do paciente (ProfileConsolidationProcessor → LeadProfile) ─────

export const PROFILE_CONSOLIDATION_PROMPT = `Você gera o PERFIL RESUMIDO de um paciente (ou interessado) de uma CLÍNICA ODONTOLÓGICA.
Esse perfil vai no prompt da assistente virtual que conversa com o paciente: quando ele mandar
mensagem, ela lê o perfil e já sabe quem ele é, sem parecer que está consultando uma ficha.

VOCÊ RECEBE: lead_data (cadastro), memories (memórias deste paciente), legacy_memory (memória do
sistema antigo, pode ser null), recent_messages (direction "in" = paciente, "out" = clínica) e
existing_summary (perfil atual, pode ser null).

GERE:

1. "summary": texto corrido em português (máximo 300 palavras):
   - Quem é (nome; se já é paciente da clínica ou ainda interessado)
   - Queixa principal / motivo do contato
   - Tratamentos de interesse, em andamento e já realizados
   - Orçamento apresentado e pagamento pendente (se houver)
   - Preferências (dia/horário, canal, dentista, jeito de conversar)
   - Próximos passos (consulta marcada, retorno, exame a trazer, decisão sobre o orçamento)

2. "facts": JSON estruturado:
{
  "name": "nome completo ou null",
  "phone": "telefone ou null",
  "email": "email ou null",
  "is_client": true/false,
  "address": "endereço ou null",
  "treatments": [
    { "name": "ex.: limpeza, restauração, canal, implante, aparelho, clareamento", "status": "interesse|orçado|em andamento|concluído|desistiu", "notes": "1 linha" }
  ],
  "preferences": { "channel": "whatsapp/telefone", "time": "manhã/tarde/noite/null", "tone": "formal/informal/ansioso", "language_level": "simples/técnico" },
  "key_dates": [{ "date": "YYYY-MM-DD", "description": "descrição" }],
  "pending": ["lista de pendências do paciente"],
  "sentiment": "satisfeito/neutro/ansioso/insatisfeito",
  "risk_flags": ["ex.: urgência/dor, medo de dentista, faltou consulta, pagamento em atraso"]
}

REGRAS:
- Seja factual. Não invente. Use null ou lista vazia para o que não souber.
- NÃO registre CPF, RG, dados bancários nem chave PIX (nem no summary, nem nos facts).
- Se o perfil existente já estiver bom, atualize apenas o que mudou.
- Contradições: vale a informação mais recente.
- A assistente virtual (qualquer nome, ex.: Sophia) não é o paciente nem pessoa da equipe.
- legacy_memory (sistema antigo, JSON com summary e facts): use só o que serve para o atendimento
  odontológico (nome, queixa, tratamentos, preferências, pendências). Ignore campos de processo
  judicial/trabalhista (sobra do sistema antigo) e metadados técnicos (version, last_updated_at).

Responda APENAS: { "summary": "...", "facts": { ... } }`;

// ─── 3) Extração retroativa (script manual retroactive-extraction.ts) ────────

export const RETROACTIVE_ORG_PROMPT = `Você recebe uma lista de mensagens ENVIADAS pelo número de uma CLÍNICA ODONTOLÓGICA.
Elas podem ser da recepção, de dentistas ou da equipe — OU mensagens automáticas do sistema
(lembretes, confirmações, cobranças, boletos, relatórios internos como fechamento de caixa,
vendas do dia e listas de pacientes). Mensagens automáticas e relatórios NUNCA viram conhecimento.

Extraia APENAS fatos DURÁVEIS da clínica que servem para atender QUALQUER paciente
(nada sobre um paciente específico).

Subcategorias válidas (obrigatória, use apenas estas):
${ORG_SUBCATEGORY_GUIDE}

NUNCA extraia:
${NEVER_ORG_LIST}
NA DÚVIDA, NÃO extraia.

JSON: { "memories": [{ "content": "...", "subcategory": "office_info|team|procedures|treatments|payment|rules", "confidence": 0.0-1.0 }] }
Se nada servir: { "memories": [] }`;

// ─── 4) Resumo da clínica do zero (OrgProfileConsolidation "Refazer do zero") ─

export const ORG_PROFILE_CONSOLIDATION_PROMPT = `Você gera o RESUMO DA CLÍNICA de uma CLÍNICA ODONTOLÓGICA.

Recebe uma lista de memórias atômicas sobre UMA clínica e escreve um RESUMO COESO em prosa que vai
no prompt da assistente virtual que conversa com os pacientes. Ela lê esse resumo e sabe como a
clínica funciona, sem parecer que está consultando fichas.

IMPORTANTE:
- As memórias podem ter CONFLITOS. Quando duas dizem coisas diferentes, prefira a de CONFIDENCE
  mais alta; se empatar, a mais RECENTE.
- PRESERVE informação minoritária que parece verdadeira (ex.: um segundo endereço ou um dia extra de
  atendimento com confidence 0.8). Não descarte só porque é minoria.
- Memórias com confidence abaixo de 0.75: trate com CETICISMO (só inclua se outras de alta confiança
  confirmarem).
- AGRUPE e RESOLVA REDUNDÂNCIAS: se 5 memórias dizem o endereço, escreva uma frase só.
- IGNORE o que é de UM paciente específico — foque no que serve para QUALQUER paciente.
- Descarte lixo evidente (ex.: "a atendente é uma IA"). Se não ajuda a atender melhor, descarte.

NUNCA COLOQUE NO RESUMO (mesmo que apareça nas memórias):
${NEVER_ORG_LIST}
Categorias antigas: "court_info" (fóruns, sistema jurídico) e "fees" (preços) — ignore. "legal_knowledge"
e "contacts" — use só se for informação útil da clínica e sem preço. Qualquer menção a advogado,
fórum, processo, honorários ou OAB é sobra do sistema antigo: descarte.

${AI_NAME_RULE}

GERE:

1. "summary": texto em português brasileiro com estas 5 seções (headers MARKDOWN):

${ORG_SUMMARY_SECTIONS}

Seção sem informação: escreva uma frase curta dizendo que não há informação registrada (não invente).
Tamanho alvo: 250-500 palavras. Seja DIRETO E FACTUAL — prosa corrida, sem bullets em excesso.
Escreva como um briefing para uma nova recepcionista.

2. "facts": JSON estruturado:
{
  "office": { "name": null, "address": null, "city": null, "state": null, "phones": [], "instagram": null, "hours": null },
  "team": [{ "name": null, "role": null, "specialty": null }],
  "procedures": ["como funciona a avaliação, o agendamento..."],
  "treatments": ["como funciona cada tratamento, sem preço"],
  "payment": { "methods": [], "installments": null, "insurance": null },
  "rules": []
}

Preencha só o que conseguir inferir com segurança. Use null/array vazio para o que não souber.
Nada de preço nem de dado interno nos facts.

Responda APENAS JSON: { "summary": "...", "facts": { ... } }`;

// ─── 5) Resumo da clínica incremental (cron 02h e após editar memória) ───────

export const ORG_PROFILE_INCREMENTAL_PROMPT = `Você atualiza o RESUMO DA CLÍNICA de uma CLÍNICA ODONTOLÓGICA.

ATUALIZAÇÃO INCREMENTAL (não regeração): você recebe o summary ATUAL da clínica e uma lista curta de
mudanças (memórias novas + memórias removidas). Produza o summary ATUALIZADO aplicando APENAS essas
mudanças, preservando todo o resto.

CONTEXTO RECEBIDO:
- current_summary: texto atual em prosa com as seções (## Sobre a clínica, ## Equipe, ## Como atendemos,
  ## Tratamentos, ## Pagamento e regras)
- new_memories: memórias CRIADAS desde a última atualização (com subcategory)
- deleted_memories: memórias REMOVIDAS desde a última atualização (o conteúdo apagado — use para achar
  frases a retirar do summary)

REGRAS DE OURO (não violar):

1. PRESERVE o texto atual sem motivo. Se uma seção não tem mudança relevante, copie-a IGUAL.
2. NÃO reformule parágrafos inteiros. Edite CIRURGICAMENTE — adicione uma frase, troque uma palavra,
   ajuste um dado específico. O texto atual é a fonte de verdade.
3. INCORPORE new_memories na seção certa:
   - office_info -> Sobre a clínica
   - team -> Equipe
   - procedures -> Como atendemos
   - treatments -> Tratamentos
   - payment e rules -> Pagamento e regras
   - categorias antigas (fees, court_info, legal_knowledge, contacts): só se forem úteis para atender
     paciente e sem preço; "court_info" e "fees" praticamente nunca servem.
4. Se uma new_memory CONTRADIZ algo do current_summary (ex.: summary diz "atende até 18h", a nova diz
   "até 19h"), a NOVA vence — atualize o dado.
5. REMOVA referências a deleted_memories: se o summary menciona "X" e "X" foi removido, retire a
   frase. Se o parágrafo ficar vazio ou quebrado, reescreva só aquele parágrafo.
6. NÃO invente. Nada além do que está em current_summary e new_memories.
7. Ignore new_memory que não agrega (já coberta, de um paciente específico, ou sobre a IA).
8. NUNCA acrescente (e, se já estiver no current_summary, RETIRE e registre em changes_applied):
${NEVER_ORG_LIST}
   - qualquer sobra do sistema jurídico antigo (advogado, fórum, processo, honorários, OAB)
   Sobre preço, o resumo diz apenas que os valores que podem ser informados estão na orientação de
   valores da clínica.
9. Se o current_summary ainda estiver no formato antigo (ex.: "## Sobre o Escritorio", "## Honorarios e
   Regras"), troque só os cabeçalhos pelas 5 seções acima, movendo os parágrafos para a seção certa
   sem reescrevê-los.
10. Se NÃO HÁ MUDANÇAS RELEVANTES após avaliar tudo, retorne o summary IDÊNTICO ao current_summary e
    changes_applied: [].

${AI_NAME_RULE}

RESPOSTA (JSON):
{
  "summary": "<texto atualizado com as 5 seções>",
  "facts": {
    "office": { "name": null, "address": null, "city": null, "state": null, "phones": [], "instagram": null, "hours": null },
    "team": [{ "name": null, "role": null, "specialty": null }],
    "procedures": [],
    "treatments": [],
    "payment": { "methods": [], "installments": null, "insurance": null },
    "rules": []
  },
  "changes_applied": ["lista curta em português das mudanças aplicadas, ex.: 'Adicionei novo telefone (82) 99999-0000 em Sobre a clínica', 'Incluí a Dra. Ana (ortodontista) em Equipe'. Array vazio se nenhuma mudança foi feita."]
}
Os "facts" refletem o summary ATUALIZADO (preencha só o que estiver nele; nada de preço nem dado interno).

Se new_memories e deleted_memories estão vazios ou não trouxeram nada útil, retorne o current_summary
inalterado e changes_applied: [].`;

// ─── Peneira determinística do que a extração devolve ────────────────────────

export type ExtractedOrgMemoryScreen =
  | { ok: true; subcategory: OrgMemorySubcategory }
  | { ok: false; reason: 'internal' | 'subcategory'; detail: string };

/**
 * Decide se uma memória "da clínica" vinda da extração (LLM) pode ser gravada e
 * com qual subcategoria. Rede de segurança além das instruções:
 *   1) dado interno (internalOrgMemoryReason) → descarta;
 *   2) subcategoria nova (ORG_MEMORY_SUBCATEGORIES) → mantém;
 *      legal_knowledge (antiga "conhecimento") → treatments;
 *      fees (preço), court_info (jurídico), contacts, vazia ou desconhecida → descarta.
 * `detail` é o motivo/categoria — nunca o conteúdo (pode ter dado de paciente).
 */
export function screenExtractedOrgMemory(content: string, subcategory: unknown): ExtractedOrgMemoryScreen {
  const internal = internalOrgMemoryReason(content, typeof subcategory === 'string' ? subcategory.trim().toLowerCase() : null);
  if (internal) return { ok: false, reason: 'internal', detail: internal };
  // Preço nunca vira memória da clínica (fica em Ajustes IA › Valores) — mesma regra
  // da revisão da API (orgMemoryPriceReason), pra extração não gravar o que a revisão manda arquivar.
  const price = orgMemoryPriceReason(content);
  if (price) return { ok: false, reason: 'internal', detail: price };
  const sub = typeof subcategory === 'string' ? subcategory.trim().toLowerCase() : '';
  if (isOrgMemorySubcategory(sub)) return { ok: true, subcategory: sub };
  if (sub === 'legal_knowledge') return { ok: true, subcategory: 'treatments' };
  return { ok: false, reason: 'subcategory', detail: sub || '(vazia)' };
}
