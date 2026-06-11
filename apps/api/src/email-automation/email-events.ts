/**
 * Onda 17.32.181 — Catalogo dos e-mails automaticos (estilo Nuvemshop).
 *
 * Cada evento tem assunto/corpo PADRAO com {{variaveis}}. O tenant pode
 * ligar/desligar e editar assunto+corpo na tela Configuracoes →
 * E-mails automaticos (override salvo em TenantEmailTemplate).
 *
 * Corpo e texto simples: quebras de linha viram <br> e o conteudo
 * entra no template visual padrao do sistema (MailService).
 */

export interface EmailEventVariable {
  name: string; // usado como {{name}}
  label: string;
  sample: string; // valor de exemplo pro "Enviar teste"
}

export interface EmailEventDef {
  key: string;
  label: string;
  description: string;
  variables: EmailEventVariable[];
  defaultSubject: string;
  defaultBody: string;
  /** Rotulo do botao de acao quando o gatilho fornecer um link */
  ctaLabel?: string;
}

export const EMAIL_EVENTS: EmailEventDef[] = [
  {
    key: 'cobranca_criada',
    label: 'Cobrança gerada',
    description: 'Enviado ao paciente quando uma cobrança (PIX, boleto ou cartão) é emitida.',
    variables: [
      { name: 'paciente_nome', label: 'Nome do paciente', sample: 'Maria da Silva' },
      { name: 'clinica_nome', label: 'Nome da clínica', sample: 'Clínica Exemplo' },
      { name: 'valor', label: 'Valor (R$)', sample: 'R$ 350,00' },
      { name: 'vencimento', label: 'Data de vencimento', sample: '20/06/2026' },
      { name: 'forma_pagamento', label: 'Forma de pagamento', sample: 'PIX' },
    ],
    defaultSubject: 'Sua cobrança da {{clinica_nome}} chegou',
    defaultBody:
      'Olá, {{paciente_nome}}!\n\n' +
      'A {{clinica_nome}} gerou uma cobrança pra você:\n\n' +
      'Valor: {{valor}}\n' +
      'Vencimento: {{vencimento}}\n' +
      'Forma de pagamento: {{forma_pagamento}}\n\n' +
      'É só clicar no botão abaixo pra pagar com segurança.',
    ctaLabel: 'Pagar agora',
  },
  {
    key: 'pagamento_confirmado',
    label: 'Pagamento confirmado',
    description: 'Enviado ao paciente quando o pagamento de uma cobrança é confirmado.',
    variables: [
      { name: 'paciente_nome', label: 'Nome do paciente', sample: 'Maria da Silva' },
      { name: 'clinica_nome', label: 'Nome da clínica', sample: 'Clínica Exemplo' },
      { name: 'valor', label: 'Valor pago (R$)', sample: 'R$ 350,00' },
      { name: 'data_pagamento', label: 'Data do pagamento', sample: '11/06/2026' },
    ],
    defaultSubject: 'Pagamento confirmado — {{clinica_nome}}',
    defaultBody:
      'Olá, {{paciente_nome}}!\n\n' +
      'Recebemos o seu pagamento de {{valor}} em {{data_pagamento}}. Tudo certo por aqui!\n\n' +
      'Obrigado pela confiança.\n{{clinica_nome}}',
  },
  {
    key: 'agendamento_criado',
    label: 'Consulta agendada',
    description: 'Enviado ao paciente quando uma consulta é marcada na agenda.',
    variables: [
      { name: 'paciente_nome', label: 'Nome do paciente', sample: 'Maria da Silva' },
      { name: 'clinica_nome', label: 'Nome da clínica', sample: 'Clínica Exemplo' },
      { name: 'data', label: 'Data da consulta', sample: '15/06/2026' },
      { name: 'hora', label: 'Horário', sample: '14:30' },
      { name: 'profissional_nome', label: 'Profissional', sample: 'Dr. João' },
      { name: 'titulo', label: 'Título do agendamento', sample: 'Avaliação inicial' },
    ],
    defaultSubject: 'Consulta agendada — {{clinica_nome}}',
    defaultBody:
      'Olá, {{paciente_nome}}!\n\n' +
      'Sua consulta na {{clinica_nome}} foi agendada:\n\n' +
      'Data: {{data}}\n' +
      'Horário: {{hora}}\n' +
      'Profissional: {{profissional_nome}}\n\n' +
      'Se precisar remarcar, é só entrar em contato com a gente.',
  },
];

export function getEmailEvent(key: string): EmailEventDef | undefined {
  return EMAIL_EVENTS.find((e) => e.key === key);
}
