/**
 * F7 do laboratório — textos dos avisos de venda e da Central de Disparos do
 * laboratório: orçamento aprovado, boleto da entrada, venda feita, resumo do dia,
 * a régua de cobrança, as recusas da Central e as variáveis de exemplo do botão Testar.
 *
 * Regras deste arquivo (scripts/ci/check-pick-literals.mjs):
 *   - só os imports de tipo e consts LAB_: qualquer string fora delas conta como texto
 *     de clínica num arquivo novo e reprova a trava 1 (chave de objeto vai sem aspas);
 *   - nenhum termo da lista PROIBIDOS do script (trava 2), nem nome de variável de
 *     template com sublinhado que comece por um deles.
 */
import type { CobrancaStage, CobrancaTipo } from './cobranca';
import type { MotivoRecusaLab } from './lab-disparos';

/** Orçamento aprovado (parcelado e à vista), PDF dos serviços e fallback do item sem nome. */
export const LAB_NEGOCIACAO = Object.freeze({
  parcelado:
    'Olá, {nome}! Seu orçamento de trabalho foi *aprovado*.\n\n' +
    '{itens}\n\n' +
    '{condicoes}\n\n' +
    'Qualquer dúvida, é só chamar por aqui.',
  avista:
    'Olá, {nome}! Seu orçamento de trabalho foi *aprovado*.\n\n' +
    '{itens}\n\n' +
    '{condicoes}\n\n' +
    '{instrucao}\n\n' +
    'Qualquer dúvida, é só chamar por aqui.',
  servicoSemNome: 'Serviço',
  legendaDoPdf: (nome: string): string => `Aqui estão os serviços do seu orçamento, ${nome}.`,
  arquivoDoPdf: (nome: string): string => `servicos-${nome}.pdf`,
});

/** Boleto da entrada no fechamento da venda. */
export const LAB_ENTRADA = Object.freeze({
  mensagem: (nome: string, artigo: string, valor: string, vence?: string | null): string =>
    `${nome}, pra liberarmos o início do seu trabalho, segue o *boleto ${artigo}* de *${valor}*` +
    (vence ? ` (vence em *${vence}*)` : '') +
    '.',
});

/** Aviso de venda feita aos números da Central. */
export const LAB_VENDA_FEITA = Object.freeze({
  laboratorioSemNome: 'o laboratório',
  clienteSemNome: 'Cliente',
  servicoSemNome: 'Serviço',
});

/** Resumo do dia aos números da Central. */
export const LAB_RESUMO_DIA = Object.freeze({
  clienteSemNome: 'Cliente',
  laboratorioSemNome: 'o laboratório',
  orcamentosAprovados: '🤝 *Orçamentos aprovados:*',
});

/**
 * Régua de cobrança do laboratório: o texto padrão de cada marco, da apresentação e do
 * envio dos boletos. {item} vira a palavra do tipo de pagamento (nunca abre frase);
 * {clinica} é o nome do laboratório, {nome} o primeiro nome do cliente sem Dr./Dra. e
 * {codigo} o aviso do boleto em anexo e do código PIX, que o envio monta.
 */
export const LAB_REGUA = Object.freeze({
  palavras: Object.freeze<Record<CobrancaTipo, string>>({
    pix: 'seu pagamento',
    boleto: 'seu boleto',
    parcelado: 'sua parcela',
  }),
  marcos: Object.freeze<Record<CobrancaStage, string>>({
    boleto_1d_antes:
      'Oi {nome}! Aqui é o financeiro de {clinica}. Passando pra lembrar que {item} de *{valor}* vence *amanhã ({data})*.\n\n' +
      '{codigo}\n\nQualquer dúvida, é só chamar aqui.',
    boleto_no_dia:
      'Oi {nome}! Aqui é o financeiro de {clinica}. Hoje ({data}) vence {item} de *{valor}*.\n\n' +
      '{codigo}\n\nSe já pagou, pode desconsiderar.',
    boleto_atraso_1d:
      'Oi {nome}, tudo bem? Aqui é o financeiro de {clinica}. Notamos que {item} de *{valor}* venceu ontem ({data}) e ainda consta em aberto.\n\n' +
      '{codigo}\n\nSe já pagou, é só desconsiderar.',
    boleto_atraso_2d:
      'Oi {nome}, aqui é o financeiro de {clinica}. Consta que {item} de *{valor}* venceu em {data} e continua em aberto.\n\n' +
      '{codigo}\n\nSe já pagou, é só desconsiderar.',
    boleto_atraso_3d:
      'Oi {nome}, aqui é o financeiro de {clinica}. Consta que {item} de *{valor}* está em aberto há *3 dias* (venceu em {data}).\n\n' +
      '{codigo}\n\nConsegue regularizar hoje? Se precisar de um novo prazo, é só falar com a gente.',
    boleto_atraso_15d:
      'Oi {nome}, aqui é o financeiro de {clinica}. Consta que {item} de *{valor}* está em aberto há *15 dias* (venceu em {data}).\n\n' +
      '{codigo}\n\nPrecisa de ajuda ou quer renegociar? É só chamar a gente aqui.',
    boleto_atraso_30d:
      'Oi {nome}, aqui é o financeiro de {clinica}. Consta que {item} de *{valor}* está com *30 dias* de atraso (venceu em {data}).\n\n' +
      '{codigo}\n\nSe estiver com dificuldade, fale com a gente: podemos encontrar uma solução juntos.',
    boleto_atrasado:
      'Oi {nome}, tudo bem? Aqui é o financeiro de {clinica}. Consta que {item} de *{valor}* venceu em {data} e ainda está em aberto.\n\n' +
      '{codigo}\n\nSe já pagou, é só desconsiderar. Se preferir combinar um novo prazo ou renegociar, é só chamar aqui.',
  }),
  apresentacao:
    'Olá, {nome}!\n\n' +
    'Aqui é o setor financeiro de {clinica}. A partir de agora é por aqui que a gente cuida de tudo sobre os ' +
    'pagamentos dos seus trabalhos.\n\n' +
    'Amanhã vou te enviar todos os seus boletos em PDF, certinho pra você se organizar.\n\n' +
    'Qualquer dúvida, é só me chamar por aqui.',
  entrega:
    'Olá, {nome}! Aqui é o financeiro de {clinica}. Seguem os seus boletos, todos em PDF. ' +
    'Qualquer dúvida, é só me chamar por aqui.',
  clienteSemNome: 'Cliente',
  laboratorioSemNome: 'o laboratório',
  /** Abertura do aviso agrupado (cliente com 2 ou mais cobranças no mesmo marco). */
  grupoAbertura: (primeiroNome: string, quantidade: number, oque: string, laboratorio: string, total: string): string =>
    `Olá ${primeiroNome}, você tem ${quantidade} ${oque} em aberto com ${laboratorio}, no total de *${total}*.`,
});

/** Recusas da Central de Disparos no laboratório (403 com o código da recusa de vertical). */
export const LAB_RECUSA_DISPAROS: Readonly<Record<MotivoRecusaLab, string>> = Object.freeze({
  escondido: 'Este aviso não existe no laboratório.',
  antecedencia: 'No laboratório os lembretes são só de 48 h e de 24 h antes, pelo WhatsApp.',
  aniversario: 'No laboratório só a mensagem clássica de aniversário pode ser ligada.',
  template: 'Este texto não é editável no laboratório.',
  teste: 'Este aviso não tem teste no laboratório.',
});

/** Variáveis de exemplo do Testar da Central no laboratório (dados fictícios). */
export const LAB_TESTE_DA_CENTRAL = Object.freeze({
  nome: 'Carlos (teste)',
  nomeCompleto: 'Dr. Carlos Lima (teste)',
  tipo: 'coleta',
  local: 'Av. Exemplo, 100 — Sala 3 (consultório do cliente, exemplo)',
  laboratorio: 'o laboratório',
  itens: '• Coroa em zircônia (2x)\n• Placa miorrelaxante',
  agenda: '- 14:00  Dr. Carlos Lima (teste) (Coleta)',
});
