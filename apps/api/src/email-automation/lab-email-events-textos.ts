/**
 * Laboratório de prótese — catálogo dos e-mails automáticos com o texto do laboratório.
 *
 * Os mesmos 6 eventos da clínica (mesmas chaves, mesmos gatilhos): o que muda é o
 * vocabulário (cliente, coleta, prova, entrega e trabalho).
 * O cobranca_criada e o pagamento_confirmado seguem saindo como saem hoje; os outros
 * quatro só saem depois que a própria conta liga o e-mail na tela (nascem desligados).
 *
 * Arquivo só com consts LAB_* (scripts/ci/check-pick-literals.mjs).
 */
import { LAB_AGENDA_EMAIL } from '@crm/shared';

const LAB_VAR_NOME_DO_LABORATORIO = Object.freeze({ name: 'clinica_nome', label: 'Nome do laboratório', sample: 'Laboratório Exemplo' });
const LAB_VAR_NOME_DO_CLIENTE = Object.freeze({ name: 'cliente_nome', label: 'Nome do cliente', sample: 'Maria da Silva' });

/** E-mails que a conta de laboratório já recebia ligados: continuam ligados sem ação da conta. */
export const LAB_EMAILS_LIGADOS_POR_PADRAO: ReadonlySet<string> = new Set<string>(['cobranca_criada', 'pagamento_confirmado']);

export const LAB_EMAIL_EVENTS = Object.freeze({
  cobranca_criada: Object.freeze({
    label: 'Cobrança gerada',
    description: 'Enviado ao cliente quando uma cobrança (PIX, boleto ou cartão) é emitida.',
    variables: Object.freeze([
      LAB_VAR_NOME_DO_CLIENTE,
      LAB_VAR_NOME_DO_LABORATORIO,
      Object.freeze({ name: 'valor', label: 'Valor (R$)', sample: 'R$ 350,00' }),
      Object.freeze({ name: 'vencimento', label: 'Data de vencimento', sample: '20/06/2026' }),
      Object.freeze({ name: 'forma_pagamento', label: 'Forma de pagamento', sample: 'PIX' }),
    ]),
    defaultSubject: 'Sua cobrança da {{clinica_nome}} chegou',
    defaultBody:
      'Olá, {{cliente_nome}}!\n\n' +
      'A {{clinica_nome}} gerou uma cobrança pra você:\n\n' +
      'Valor: {{valor}}\n' +
      'Vencimento: {{vencimento}}\n' +
      'Forma de pagamento: {{forma_pagamento}}\n\n' +
      'É só clicar no botão abaixo pra pagar com segurança.',
  }),
  vencimento_proximo: Object.freeze({
    label: 'Vencimento amanhã',
    description: 'Lembrete enviado ao cliente 1 dia antes do vencimento de cobranças ainda em aberto. Só sai depois que o laboratório liga este e-mail.',
    variables: Object.freeze([
      LAB_VAR_NOME_DO_CLIENTE,
      LAB_VAR_NOME_DO_LABORATORIO,
      Object.freeze({ name: 'valor', label: 'Valor (R$)', sample: 'R$ 350,00' }),
      Object.freeze({ name: 'vencimento', label: 'Data de vencimento', sample: '12/06/2026' }),
      Object.freeze({ name: 'forma_pagamento', label: 'Forma de pagamento', sample: 'Boleto' }),
    ]),
    defaultSubject: 'Lembrete: sua cobrança vence amanhã — {{clinica_nome}}',
    defaultBody:
      'Olá, {{cliente_nome}}!\n\n' +
      'Passando pra lembrar que sua cobrança da {{clinica_nome}} vence amanhã:\n\n' +
      'Valor: {{valor}}\n' +
      'Vencimento: {{vencimento}}\n' +
      'Forma de pagamento: {{forma_pagamento}}\n\n' +
      'Pagando em dia você evita juros. Qualquer dúvida, é só falar com a gente.',
  }),
  pagamento_confirmado: Object.freeze({
    label: 'Pagamento confirmado',
    description: 'Enviado ao cliente quando o pagamento de uma cobrança é confirmado.',
    variables: Object.freeze([
      LAB_VAR_NOME_DO_CLIENTE,
      LAB_VAR_NOME_DO_LABORATORIO,
      Object.freeze({ name: 'valor', label: 'Valor pago (R$)', sample: 'R$ 350,00' }),
      Object.freeze({ name: 'data_pagamento', label: 'Data do pagamento', sample: '11/06/2026' }),
    ]),
    defaultSubject: 'Pagamento confirmado — {{clinica_nome}}',
    defaultBody:
      'Olá, {{cliente_nome}}!\n\n' +
      'Recebemos o seu pagamento de {{valor}} em {{data_pagamento}}. Tudo certo por aqui!\n\n' +
      'Obrigado pela confiança.\n{{clinica_nome}}',
  }),
  pagamento_atrasado: Object.freeze({
    label: 'Pagamento atrasado',
    description: 'Enviado ao cliente quando o banco informa que uma cobrança venceu sem pagamento. Só sai depois que o laboratório liga este e-mail.',
    variables: Object.freeze([
      LAB_VAR_NOME_DO_CLIENTE,
      LAB_VAR_NOME_DO_LABORATORIO,
      Object.freeze({ name: 'valor', label: 'Valor (R$)', sample: 'R$ 350,00' }),
      Object.freeze({ name: 'vencimento', label: 'Data de vencimento', sample: '10/06/2026' }),
    ]),
    defaultSubject: 'Sua cobrança da {{clinica_nome}} está em aberto',
    defaultBody:
      'Olá, {{cliente_nome}}.\n\n' +
      'Notamos que a cobrança abaixo venceu e ainda não identificamos o pagamento:\n\n' +
      'Valor: {{valor}}\n' +
      'Venceu em: {{vencimento}}\n\n' +
      'Você pode regularizar agora pelo botão abaixo. Se já pagou, desconsidere esta mensagem — a confirmação pode levar algumas horas.',
  }),
  agendamento_criado: Object.freeze({
    label: 'Coleta, prova ou entrega agendada',
    description: 'Enviado ao cliente quando uma coleta, prova ou entrega é marcada na agenda. Só sai depois que o laboratório liga este e-mail.',
    variables: Object.freeze([
      LAB_VAR_NOME_DO_CLIENTE,
      LAB_VAR_NOME_DO_LABORATORIO,
      Object.freeze({ name: 'tipo', label: 'Coleta, prova ou entrega', sample: 'prova' }),
      Object.freeze({ name: 'data', label: 'Data', sample: '15/06/2026' }),
      Object.freeze({ name: 'hora', label: 'Horário', sample: '14:30' }),
      Object.freeze({ name: 'local', label: 'Local', sample: 'Rua Exemplo, 100' }),
    ]),
    defaultSubject: LAB_AGENDA_EMAIL.agendado.assunto,
    defaultBody: LAB_AGENDA_EMAIL.agendado.corpo,
  }),
  agendamento_remarcado: Object.freeze({
    label: 'Coleta, prova ou entrega remarcada',
    description: 'Enviado ao cliente quando o horário de uma coleta, prova ou entrega é alterado na agenda. Só sai depois que o laboratório liga este e-mail.',
    variables: Object.freeze([
      LAB_VAR_NOME_DO_CLIENTE,
      LAB_VAR_NOME_DO_LABORATORIO,
      Object.freeze({ name: 'tipo', label: 'Coleta, prova ou entrega', sample: 'prova' }),
      Object.freeze({ name: 'data', label: 'Nova data', sample: '16/06/2026' }),
      Object.freeze({ name: 'hora', label: 'Novo horário', sample: '15:00' }),
      Object.freeze({ name: 'local', label: 'Local', sample: 'Rua Exemplo, 100' }),
    ]),
    defaultSubject: LAB_AGENDA_EMAIL.remarcado.assunto,
    defaultBody: LAB_AGENDA_EMAIL.remarcado.corpo,
  }),
});

/** Erros da API de e-mails automáticos na conta de laboratório. */
export const LAB_EMAIL_ERROS = Object.freeze({
  textoDeClinica: 'O texto usa palavras que só existem na clínica. Reescreva com o vocabulário do laboratório.',
  semConta: 'Usuário sem laboratório vinculado.',
  limiteDeTeste: 'Limite de 5 e-mails de teste por dia atingido neste laboratório. Tente de novo amanhã.',
});
