/**
 * Textos da tela Assinatura no LABORATÓRIO. Os planos são os mesmos da clínica
 * (mesmo preço e mesmos limites, vindos de /billing/plans); só a descrição e a
 * lista do que cada plano inclui mudam de nome. Plano sem texto aqui mostra o
 * que vem do banco.
 */
export const LAB_ASSINATURA_PLANOS: Readonly<Record<string, { descricao: string; recursos: readonly string[] }>> =
  Object.freeze({
    starter: Object.freeze({
      descricao: 'Para laboratórios começando',
      recursos: Object.freeze([
        'Até 5 usuários',
        'Até 300 dentistas clientes',
        '1 WhatsApp conectado',
        'Cobranças Asaas (PIX, boleto e cartão)',
        'Agenda de coleta, prova e entrega',
        'Suporte por e-mail',
      ]),
    }),
    pro: Object.freeze({
      descricao: 'Para laboratórios em crescimento',
      recursos: Object.freeze([
        'Tudo do Starter',
        'Até 20 usuários',
        'Até 3.000 dentistas clientes',
        '3 WhatsApps conectados',
        'Suporte prioritário',
      ]),
    }),
    enterprise: Object.freeze({
      descricao: 'Para redes de laboratórios',
      recursos: Object.freeze([
        'Tudo do Pro',
        'Usuários ilimitados',
        'Dentistas clientes ilimitados',
        'Até 10 WhatsApps',
        'Suporte com prioridade máxima',
      ]),
    }),
  });

/** Mensalidade em aberto e assinatura ainda não liberada. */
export const LAB_ASSINATURA = Object.freeze({
  pagarTitulo: 'Mensalidade em aberto',
  pagarDetalhe: (vencimento: string, valor: string | null) =>
    valor ? `Vencimento ${vencimento} · R$ ${valor}` : `Vencimento ${vencimento}`,
  pagarBotao: 'Pagar agora',
  pagarDica:
    'Abre a página de pagamento do Asaas. Depois de pago, a assinatura é ativada sozinha em até 1 hora.',
  semLink: 'O link de pagamento ainda está sendo gerado. Atualize a página em alguns minutos.',
  indisponivelTitulo: 'Assinatura ainda não disponível',
  indisponivelTexto:
    'O pagamento da mensalidade ainda não foi liberado. Fale com o suporte: suporte@odontosystem.com.br',
});
