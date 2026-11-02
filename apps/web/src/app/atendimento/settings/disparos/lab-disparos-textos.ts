/**
 * F7 do laboratório — textos da Central de Disparos na conta de laboratório: cabeçalho,
 * setores, categorias, os cards da lista permitida e os editores (coleta, prova e
 * entrega, orçamento aprovado, confirmação de pagamento, resumo do dia, aniversário,
 * números de aviso e o teste de envio).
 *
 * Só texto. As telas escolhem `lab ? LAB_X.y : 'texto de sempre'`, então a clínica
 * continua vendo a Central de hoje. Regras deste arquivo
 * (scripts/ci/check-pick-literals.mjs):
 *   - só import de tipo e consts LAB_: qualquer string fora delas reprova a trava 1
 *     (chave de objeto vai sem aspas);
 *   - nenhum termo da lista PROIBIDOS do script (trava 2). Os nomes das variáveis e as
 *     chaves dos textos de lembrete ficam fora daqui (vêm do @crm/shared).
 *
 * As variáveis entre chaves dos editores são as que o servidor troca no envio: {nome}
 * é o primeiro nome do cliente sem Dr./Dra., {tipo} é coleta/prova/entrega em
 * minúsculas e {local} é o endereço do consultório do cliente.
 */
import type { DisparoCategoria, Setor } from './disparos.config';

/** Título do quadro de prévia nos editores do laboratório. */
export const LAB_PREVIA_DO_CLIENTE = 'Preview (como o cliente vai receber)';

/** Endereço de exemplo da prévia: o consultório do cliente, nunca o do laboratório. */
export const LAB_ENDERECO_EXEMPLO = 'Av. Exemplo, 100 — Sala 3 (consultório do cliente, exemplo)';

/** Cabeçalho, semáforo do chip e selo da régua de cobrança. */
export const LAB_CENTRAL = Object.freeze({
  cabecalho: 'Configure aqui as mensagens automáticas do laboratório. Cada aviso liga e desliga no botão do card.',
  semChipProprio: 'Sem chip próprio desta função — os disparos saem pelo chip de Atendimento ou, sem ele, pelo Comercial',
  reguaBadge: 'Em breve no laboratório',
  reguaTitulo:
    'A régua de cobrança liga no laboratório quando o envio em fila por chip chegar. Até lá fica desligada.',
});

/** Rótulos dos setores (o Comercial não aparece no laboratório). */
export const LAB_SETORES: Readonly<
  Partial<Record<Setor, Readonly<{ label?: string; chip?: string; nota?: string }>>>
> = Object.freeze({
  clinica: Object.freeze({
    label: 'Atendimento',
    chip: 'Atendimento',
    nota: 'Chip principal do laboratório — o padrão de tudo que fala com o cliente.',
  }),
  financeiro: Object.freeze({
    nota: 'Sai pelo chip Financeiro. Se ele não estiver conectado, usa o chip principal (Atendimento).',
  }),
  equipe: Object.freeze({
    chip: 'Atendimento',
    nota: 'Avisos internos para a equipe (não vão para o cliente). Saem pelo chip do laboratório.',
  }),
});

/** Rótulos das categorias que mudam no laboratório. */
export const LAB_CATEGORIAS: Readonly<Partial<Record<DisparoCategoria, string>>> = Object.freeze({
  agendamento: 'Coleta, prova e entrega',
  clinico: 'Produção',
});

/** Nome, gatilho, descrição e etiquetas dos cards do laboratório (pelo id do card). */
export const LAB_DISPAROS_CARDS: Readonly<
  Record<string, Readonly<{ nome?: string; gatilho?: string; descricao?: string; tags?: readonly string[] }>>
> = Object.freeze({
  confirmacao: Object.freeze({
    nome: 'Confirmação de coleta, prova e entrega',
    gatilho: 'Assim que marca (aviso na hora) · 24 h antes pede pra confirmar · a equipe marca a resposta',
    descricao:
      'Na hora em que alguém marca a coleta, a prova ou a entrega, o cliente recebe o aviso com o dia, a hora e o ' +
      'endereço do consultório. Um dia antes, recebe o pedido de confirmação. Quem marca a resposta é a equipe, na ' +
      'agenda ou no chat.',
  }),
  confirmacao_48h: Object.freeze({
    nome: 'Lembrete · 48 h antes',
    gatilho: '2 dias antes · lembra a coleta, a prova ou a entrega',
    tags: Object.freeze(['Template']),
  }),
  lembrete_1dia: Object.freeze({
    nome: 'Lembrete · 24 h antes',
    gatilho: '1 dia antes · lembra a coleta, a prova ou a entrega',
  }),
  reagendamento: Object.freeze({
    nome: 'Aviso de remarcação',
    gatilho: 'Quando o dia ou a hora da coleta, da prova ou da entrega mudam',
  }),
  negociacao_aprovada: Object.freeze({
    nome: 'Orçamento aprovado · parcelado/boleto',
    gatilho: 'Ao fechar uma venda a receber no boleto · confirma os serviços e as condições',
  }),
  negociacao_aprovada_avista: Object.freeze({
    nome: 'Orçamento aprovado · à vista (PIX/cartão)',
    gatilho: 'Ao fechar uma venda à vista em PIX ou cartão · confirma os serviços, sem falar em boleto',
  }),
  boleto_atrasado: Object.freeze({
    gatilho: 'Qualquer boleto vencido · re-toque semanal · agrupado por cliente',
  }),
  block_sched_on_overdue: Object.freeze({
    nome: 'Bloquear coleta/entrega de cliente com boleto atrasado',
    gatilho:
      'Barra marcar coleta, prova ou entrega de quem tem boleto atrasado · admin libera com motivo · destrava ao pagar/cancelar',
  }),
  aniversario_classica: Object.freeze({
    nome: 'Aniversário do cliente',
  }),
  resumo_dentista: Object.freeze({
    nome: 'Resumo do dia do protético',
    gatilho: 'Todo dia às 8h · coletas, provas e entregas do dia · 1 mensagem por responsável',
    descricao:
      'Às 8h, quem é o responsável por coleta, prova ou entrega no dia (protético, expedição ou administrador) recebe ' +
      'UMA mensagem com as dele. Quem recebe: os responsáveis com telefone no cadastro da equipe.',
  }),
  resumo_diario: Object.freeze({
    gatilho:
      'Todo dia no horário configurado · entradas, saídas, vendas em boleto e orçamentos aprovados · aos números da Central',
  }),
  venda_feita: Object.freeze({
    gatilho: 'A cada venda (venda rápida ou aprovar e cobrar) · cliente, valor, forma e serviços · aos números da Central',
  }),
  admin_agendamento_equipe: Object.freeze({
    nome: 'Aviso aos ADMs: coleta, prova ou entrega marcada',
    gatilho: 'Alguém da equipe marcou · cliente, dia e hora, tipo, responsável e quem marcou · aos números da Central',
    descricao:
      'A cada coleta, prova ou entrega marcada por alguém da equipe, um aviso vai para os números de aviso (os mesmos ' +
      'do Venda feita e do Resumo diário), com o cliente e o telefone, o dia, a hora, o tipo, o responsável e quem ' +
      'marcou. Série recorrente avisa só a 1ª; desmarcado antes do aviso não avisa. Só avisa o que for marcado depois ' +
      'de ligar.',
  }),
});

/** Descrição das variáveis comuns aos avisos de coleta, prova e entrega. */
export const LAB_VARIAVEIS_DA_AGENDA = Object.freeze({
  nome: 'Primeiro nome do cliente (sem Dr./Dra.)',
  tipo: 'Coleta, prova ou entrega (em minúsculas)',
  data: 'Data (DD/MM)',
  hora: 'Horário',
  local: 'Endereço do consultório do cliente',
});

/** Editores de texto da Central do laboratório (título, descrição, variáveis e prévia). */
export const LAB_EDITORES = Object.freeze({
  confirmacao: Object.freeze({
    titulo: 'Mensagem da confirmação (24 h antes)',
    descricao:
      'Enviada 24 h antes da coleta, da prova ou da entrega, pedindo pra confirmar. Quem marca a resposta é a equipe, ' +
      'na agenda ou no chat. Use as variáveis abaixo.',
    variaveis: LAB_VARIAVEIS_DA_AGENDA,
    preview: Object.freeze({ nome: 'Carlos', tipo: 'coleta', data: '06/05', hora: '14:00' }),
    previewLabel: LAB_PREVIA_DO_CLIENTE,
    enderecoExemplo: LAB_ENDERECO_EXEMPLO,
  }),
  lembrete48: Object.freeze({
    titulo: 'Lembrete · 48 h antes',
    descricao:
      'Enviado 2 dias antes da coleta, da prova ou da entrega, com o dia, a hora e o endereço do consultório. Use as ' +
      'variáveis abaixo — o sistema troca pelos dados reais.',
    variaveis: LAB_VARIAVEIS_DA_AGENDA,
    preview: Object.freeze({ nome: 'Carlos', tipo: 'prova', data: '07/05', hora: '10:30' }),
    previewLabel: LAB_PREVIA_DO_CLIENTE,
    enderecoExemplo: LAB_ENDERECO_EXEMPLO,
  }),
  lembrete24: Object.freeze({
    titulo: 'Lembrete · 24 h antes',
    descricao:
      'Enviado 1 dia antes da coleta, da prova ou da entrega, com o dia, a hora e o endereço do consultório. Use as ' +
      'variáveis abaixo — o sistema troca pelos dados reais.',
    variaveis: LAB_VARIAVEIS_DA_AGENDA,
    preview: Object.freeze({ nome: 'Carlos', tipo: 'entrega', data: '07/05', hora: '10:30' }),
    previewLabel: LAB_PREVIA_DO_CLIENTE,
    enderecoExemplo: LAB_ENDERECO_EXEMPLO,
  }),
  remarcacao: Object.freeze({
    titulo: 'Mensagem de remarcação',
    descricao:
      'Enviada ao cliente quando o dia ou a hora da coleta, da prova ou da entrega mudam. Use as variáveis abaixo — o ' +
      'sistema troca pelos dados reais.',
    variaveis: Object.freeze({
      nome: 'Primeiro nome do cliente (sem Dr./Dra.)',
      tipo: 'Coleta, prova ou entrega (em minúsculas)',
      data: 'Nova data (DD/MM)',
      hora: 'Novo horário',
      local: 'Endereço do consultório do cliente',
    }),
    preview: Object.freeze({ nome: 'Carlos', tipo: 'coleta', data: '22/06', hora: '15:00' }),
    previewLabel: LAB_PREVIA_DO_CLIENTE,
    enderecoExemplo: LAB_ENDERECO_EXEMPLO,
  }),
  negociacao: Object.freeze({
    titulo: 'Orçamento aprovado · parcelado/boleto',
    descricao:
      'Enviada ao cliente pelo chip Financeiro no fechamento da venda: confirma os serviços vendidos e as condições, ' +
      'com o PDF dos serviços (sem valores). Edite e Salve; deixe em branco pra voltar ao padrão.',
    variaveis: Object.freeze({
      nome: 'Primeiro nome do cliente (sem Dr./Dra.)',
      itens: 'Lista dos serviços vendidos',
      condicoes: 'Bloco pronto: entrada + parcelas + total (ou só o total, à vista)',
      condicoes_sem_total: 'O mesmo bloco, mas SEM a linha do total (só entrada + parcelas)',
      entrada: 'Valor da entrada (ex.: 10,00)',
      parcelas: 'Nº de parcelas (ex.: 8)',
      valor_parcela: 'Valor de cada parcela (ex.: 5,34)',
      total: 'Total do orçamento (ex.: 52,74)',
      clinica: 'Nome do laboratório',
    }),
    preview: Object.freeze({
      nome: 'Carlos',
      itens: '• Coroa em zircônia (2x)\n• Placa miorrelaxante',
      condicoes: '• Entrada: R$ 10,00\n• 8x de R$ 5,34\n• Total: R$ 52,74',
      condicoes_sem_total: '• Entrada: R$ 10,00\n• 8x de R$ 5,34',
      entrada: '10,00',
      parcelas: '8',
      valor_parcela: '5,34',
      total: '52,74',
      clinica: 'Laboratório Exemplo',
    }),
    previewLabel: LAB_PREVIA_DO_CLIENTE,
    enderecoExemplo: LAB_ENDERECO_EXEMPLO,
  }),
  negociacaoAvista: Object.freeze({
    titulo: 'Orçamento aprovado · à vista (PIX/cartão)',
    descricao:
      'Enviada ao cliente pelo chip Financeiro quando a venda é à vista (PIX ou cartão, sem parcelas): confirma os ' +
      'serviços e o valor, sem prometer boleto. A variável {instrucao} vira a frase do código PIX ou do link do ' +
      'cartão, conforme a forma. Edite e Salve; deixe em branco pra voltar ao padrão.',
    variaveis: Object.freeze({
      nome: 'Primeiro nome do cliente (sem Dr./Dra.)',
      itens: 'Lista dos serviços vendidos',
      condicoes: 'Bloco pronto com o valor total (à vista)',
      instrucao: 'Frase automática: código PIX ou link do cartão, conforme a forma',
      total: 'Total do orçamento (ex.: 350,00)',
      forma: 'Forma de pagamento (PIX/cartão)',
      clinica: 'Nome do laboratório',
    }),
    preview: Object.freeze({
      nome: 'Carlos',
      itens: '• Coroa em zircônia\n• Placa miorrelaxante',
      condicoes: '• Pagamento à vista (PIX)\n• Total: R$ 350,00',
      instrucao: 'Já te envio o código PIX aqui mesmo pra você pagar.',
      total: '350,00',
      forma: 'PIX',
      clinica: 'Laboratório Exemplo',
    }),
    previewLabel: LAB_PREVIA_DO_CLIENTE,
    enderecoExemplo: LAB_ENDERECO_EXEMPLO,
  }),
  confirmacaoPagamento: Object.freeze({
    titulo: 'Confirmação de pagamento',
    descricao:
      'Enviada ao cliente pelo chip Financeiro quando um pagamento é confirmado (automático). Edite e Salve — o robô ' +
      'passa a usar este texto. Deixe em branco pra voltar ao padrão.',
    variaveis: Object.freeze({
      nome: 'Primeiro nome do cliente (sem Dr./Dra.)',
      valor: 'Valor pago (ex.: R$ 350,00)',
      metodo: 'Meio do pagamento (ex.: " via PIX", " via boleto", " via cartão") — vazio se desconhecido',
      descricao: 'Descrição do pagamento (já vem com parênteses, ou vazio)',
      vencimento:
        'Linha "📅 Boleto com vencimento em DD/MM/AAAA." — só aparece quando o pagamento é de BOLETO; nas outras formas fica vazia',
      clinica: 'Nome do laboratório',
    }),
    preview: Object.freeze({
      nome: 'Carlos',
      valor: 'R$ 350,00',
      metodo: ' via boleto',
      descricao: '',
      vencimento: '📅 Boleto com vencimento em 05/07/2026.',
      clinica: 'Laboratório Exemplo',
    }),
    previewLabel: LAB_PREVIA_DO_CLIENTE,
    enderecoExemplo: LAB_ENDERECO_EXEMPLO,
  }),
  resumoProtetico: Object.freeze({
    titulo: 'Resumo do dia do protético',
    descricao:
      'Às 8h, quem é o responsável por coleta, prova ou entrega no dia recebe UMA mensagem com as dele. Edite o texto ' +
      'abaixo; {agenda} vira a lista do dia. Use o Testar pra ver como chega.',
    variaveis: Object.freeze({
      nome: 'Primeiro nome de quem recebe',
      data: 'Data de hoje (DD/MM)',
      qtd: 'Quantidade de coletas, provas e entregas do dia',
      agenda: 'Lista do dia (hora, cliente e tipo)',
    }),
    preview: Object.freeze({
      nome: 'Marcos',
      data: '06/05',
      qtd: '2',
      agenda: '- 09:00  Dr. Carlos Lima (Coleta)\n- 14:30  Dra. Ana Souza (Entrega)',
    }),
    previewLabel: LAB_PREVIA_DO_CLIENTE,
    enderecoExemplo: LAB_ENDERECO_EXEMPLO,
  }),
});

/** Editor do lembrete de 48 h e de 24 h (texto dentro da configuração dos lembretes). */
export const LAB_LEMBRETE_EDITOR = Object.freeze({
  variaveisTitulo: 'Variáveis disponíveis',
  dicaLocal: 'Use {local_line} em vez de {local} — já adiciona o 📍 e a quebra de linha.',
  placeholder: 'Texto da mensagem com variáveis…',
  caracteres: 'caracteres',
  vazia: '(mensagem vazia)',
  salvar: 'Salvar',
  salvo: 'Mensagem salva',
  falhaAoSalvar: 'Falha ao salvar',
  falhaAoCarregar: 'Falha ao carregar a mensagem',
});

/** Aniversário do cliente (só a mensagem clássica no laboratório). */
export const LAB_ANIVERSARIO_EDITOR = Object.freeze({
  preview: Object.freeze({ nome: 'Carlos', clinica: 'Laboratório Exemplo' }),
  variavelNome: 'Primeiro nome do cliente (sem Dr./Dra.)',
  variavelClinica: 'Nome do laboratório',
  previewLabel: LAB_PREVIA_DO_CLIENTE,
});

/** Resumo diário do dia aos números da Central. */
export const LAB_RESUMO_DIARIO_EDITOR = Object.freeze({
  descricao:
    'Todo dia, no horário abaixo, um resumo do último dia FECHADO é enviado aos números configurados (pelo chip do ' +
    'Financeiro, com fallback pro Atendimento): entradas (quem pagou e a forma), saídas (descrição), saldo e — com o ' +
    'nome de cada cliente — vendas em boleto, boletos compensados, boletos em atraso (com os dias de atraso) e ' +
    'orçamentos aprovados. Ligue o disparo no botão do card pra começar.',
  numeros:
    'O 55 já vem fixo — digite só o DDD + número (ex.: 82999998888). Pode cadastrar vários (o resumo vai pra todos).',
});

/** Venda feita aos números da Central. */
export const LAB_VENDA_FEITA_EDITOR = Object.freeze({
  descricao:
    'A cada venda fechada — na venda rápida ou no aprovar e cobrar — um aviso vai aos números configurados (pelo ' +
    'chip do Financeiro, com fallback pro Atendimento): cliente, valor, forma de pagamento, serviços e quem vendeu. ' +
    'Ligue o disparo no botão do card pra começar.',
  numeros:
    'É o número de aviso dos ADMs: também recebe o aviso de coleta, prova ou entrega marcada. Pode cadastrar vários — ' +
    'o aviso vai pra todos.',
});

/** Teste de entrega no WhatsApp. */
export const LAB_TESTE_ENVIO = Object.freeze({
  comTexto:
    'Manda o texto que está NA TELA agora (com dados de exemplo) — não precisa salvar pra testar. Precisa do ' +
    'WhatsApp do laboratório conectado.',
  semTexto: 'Manda a mensagem deste disparo (com dados de exemplo). Precisa do WhatsApp do laboratório conectado.',
});
