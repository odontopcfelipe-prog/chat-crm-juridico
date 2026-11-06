/**
 * Laboratório de prótese — sequências de mensagens (follow-up) e comunicados.
 *
 * No laboratório o passo da sequência é TEXTO FIXO, escrito pela conta (fica em
 * `custom_prompt`, com {{nome}} = primeiro nome do cliente). A geração do texto por
 * IA não existe no laboratório. As sequências padrão nascem DESLIGADAS e sem etapa
 * automática: só enviam depois que a conta liga a sequência e uma regra de automação
 * inscreve o cliente.
 *
 * Arquivo só com consts LAB_* (scripts/ci/check-pick-literals.mjs).
 */

export const LAB_FOLLOWUP_PASSO = Object.freeze({
  /** Rótulo interno do passo (o campo "objetivo" é obrigatório no cadastro). */
  objetivo: 'Mensagem de texto fixo',
  canal: 'whatsapp',
  tom: 'amigavel',
});

export const LAB_FOLLOWUP_ERROS = Object.freeze({
  semTexto: 'Todo passo precisa de um texto escrito por você. A geração de texto por IA ainda não está disponível no laboratório.',
  semPassos: 'A sequência não tem passos. Crie ao menos um passo com texto antes de ligar.',
  textoDeClinica: 'O texto usa palavras que só existem na clínica. Reescreva com o vocabulário do laboratório.',
  soWhatsapp: 'No laboratório o passo envia só por WhatsApp.',
  prazoInvalido: 'Prazo inválido: informe as horas depois do passo anterior (de 0 a 8760).',
  semAcesso: 'Só o administrador do laboratório cria as sequências padrão.',
  disparoSoComunicado: 'No laboratório o disparo em massa é só o comunicado, com texto fixo.',
  comunicadoSemTexto: 'Escreva o texto do comunicado.',
  semConta: 'Conta do laboratório não identificada.',
  contatoNaoRecebe: 'Este contato pediu para não receber mensagens ou não tem WhatsApp.',
  sequenciaDesligada: 'Sequência desligada ou de outra conta.',
});

export const LAB_FOLLOWUP_COMUNICADO = Object.freeze({
  nome: 'Comunicado',
});

/** Sequências padrão do laboratório: desligadas, sem etapa automática, texto fixo. */
export const LAB_FOLLOWUP_SEMENTES = Object.freeze([
  Object.freeze({
    nome: 'Retomada de contato',
    descricao: 'Para o contato que parou de responder: três mensagens curtas, espaçadas, oferecendo orçamento.',
    categoria: 'LEADS',
    passos: Object.freeze([
      Object.freeze({
        atrasoHoras: 24,
        texto: 'Olá, {{nome}}! Tudo bem? Estamos à disposição para ajudar com o seu próximo trabalho de prótese. Posso preparar um orçamento para você?',
      }),
      Object.freeze({
        atrasoHoras: 72,
        texto: 'Oi, {{nome}}! Passando para saber se você ainda precisa de orçamento ou de prazo para algum trabalho. É só responder por aqui.',
      }),
      Object.freeze({
        atrasoHoras: 168,
        texto: '{{nome}}, deixo o nosso contato por aqui. Quando precisar de um orçamento, de uma coleta ou de uma entrega, é só chamar.',
      }),
    ]),
  }),
  Object.freeze({
    nome: 'Orçamento sem resposta',
    descricao: 'Para o cliente que recebeu o orçamento e não respondeu: duas mensagens para tirar dúvidas e combinar a coleta.',
    categoria: 'LEADS',
    passos: Object.freeze([
      Object.freeze({
        atrasoHoras: 48,
        texto: 'Olá, {{nome}}! Conseguiu ver o orçamento que enviamos? Se tiver qualquer dúvida sobre o trabalho ou o prazo, me chame por aqui.',
      }),
      Object.freeze({
        atrasoHoras: 120,
        texto: 'Oi, {{nome}}! Posso ajustar o orçamento ou combinar a coleta para começarmos o trabalho. Como prefere?',
      }),
    ]),
  }),
]);

/** Motivo gravado na inscrição quando o contato responde. */
export const LAB_MOTIVO_CONTATO_RESPONDEU = 'O contato respondeu: a conversa fica com a equipe';
