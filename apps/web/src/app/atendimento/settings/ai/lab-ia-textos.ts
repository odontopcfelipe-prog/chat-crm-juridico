/**
 * Textos da tela de IA na conta de laboratório. Só consts LAB_
 * (scripts/ci/check-pick-literals.mjs).
 */
export const LAB_IA_TELA = Object.freeze({
  titulo: 'Inteligência artificial',
  subtitulo:
    'A IA atende dentistas e consultórios pelo WhatsApp do laboratório: entende o pedido, informa preço e prazo só do seu catálogo de serviços e passa para a equipe o que precisa de decisão.',
  semAssinaturaTitulo: 'A IA libera com a assinatura',
  semAssinatura:
    'A IA, a transcrição de áudio e a correção de texto usam créditos de inteligência artificial e ficam disponíveis com a assinatura do laboratório ativa. Enquanto isso, nada aqui responde aos seus clientes.',
  carregando: 'Carregando...',
  erroCarregar: 'Não foi possível carregar os ajustes da IA.',

  chipsTitulo: 'IA por canal',
  chipsAjuda:
    'Cada WhatsApp liga e desliga sozinho. Ligar vale para conversas novas; nas que já existem, a equipe liga na própria conversa.',
  ligada: 'Ligada',
  desligada: 'Desligada',
  ligar: 'Ligar',
  desligar: 'Desligar',
  salvar: 'Salvar',
  salvando: 'Salvando...',
  salvo: 'Salvo.',
  erroSalvar: 'Não foi possível salvar.',
  nome: 'Nome que a IA usa',
  nomePlaceholder: 'Em branco: nome neutro do canal',
  assinatura: 'Assinar a primeira mensagem com o nome',
  tamanho: 'Tamanho das respostas',
  tamanhos: Object.freeze({ auto: 'Automático', curta: 'Curta', media: 'Média', longa: 'Longa' }),
  espera: 'Espera antes de responder (segundos)',
  esperaPlaceholder: 'Em branco: padrão',
  instrucoes: 'Instruções para este canal',
  instrucoesPlaceholder: 'Ex.: não atendemos sábado; coleta só na cidade; número do atendimento.',

  canais: Object.freeze({
    COMERCIAL: Object.freeze({ nome: 'Comercial', ajuda: 'Pedidos novos: entende o trabalho, informa preço e prazo do catálogo e explica como enviar o caso.' }),
    CLINICA: Object.freeze({ nome: 'Atendimento', ajuda: 'Dia a dia de quem já manda trabalhos: prova, entrega e andamento. Sem dado no sistema, passa para a equipe.' }),
    FINANCEIRO: Object.freeze({ nome: 'Financeiro', ajuda: 'Cobrança: 2ª via de boleto, PIX, parcelas e vencimentos. Desconto e negociação vão para o responsável.' }),
  }),

  horarioTitulo: 'Horário de atendimento',
  horarioAjuda: 'A IA usa este horário para dizer se o laboratório está aberto.',
  fechado: 'Fechado',
  ate: 'até',

  roboTitulo: 'Robô dos administradores',
  roboAjuda:
    'Só os administradores deste laboratório, pelo próprio WhatsApp cadastrado: criar tarefa, marcar coleta, prova ou entrega, resumo financeiro e lançar despesa.',

  testeTitulo: 'Testar uma conversa',
  testeAjuda: 'Nada é enviado no WhatsApp e nada é gravado. O teste gasta créditos e entra no custo abaixo.',
  testeCanal: 'Canal',
  testeCliente: 'Conversar como cliente já cadastrado',
  testePlaceholder: 'Escreva como se fosse o dentista...',
  testeEnviar: 'Enviar',
  testeRecomecar: 'Recomeçar',
  testeEspera: 'Pensando...',
  testeEquipe: 'Nesta resposta a IA passaria a conversa para a equipe.',
  testeErro: 'Não foi possível testar agora.',
  testeVoce: 'Você',

  custoTitulo: 'Custo da IA',
  custoAjuda: 'Só o gasto deste laboratório.',
  custoHoje: 'Hoje',
  custoMes: 'Este mês',
  custoChamadas: 'chamadas',
});
