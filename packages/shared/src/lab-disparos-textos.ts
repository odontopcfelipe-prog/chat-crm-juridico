/**
 * F7 do laboratório — textos dos avisos de venda e da Central de Disparos do
 * laboratório: orçamento aprovado, boleto da entrada, venda feita, resumo do dia,
 * as recusas da Central e as variáveis de exemplo do botão Testar.
 *
 * Regras deste arquivo (scripts/ci/check-pick-literals.mjs):
 *   - só o import de tipo e consts LAB_: qualquer string fora delas conta como texto
 *     de clínica num arquivo novo e reprova a trava 1 (chave de objeto vai sem aspas);
 *   - nenhum termo da lista PROIBIDOS do script (trava 2), nem nome de variável de
 *     template com sublinhado que comece por um deles.
 */
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

/** Recusas da Central de Disparos no laboratório (403 com o código da recusa de vertical). */
export const LAB_RECUSA_DISPAROS: Readonly<Record<MotivoRecusaLab, string>> = Object.freeze({
  escondido: 'Este aviso não existe no laboratório.',
  regua: 'A régua de cobrança ainda não liga no laboratório: o envio em fila por chip chega numa próxima fase.',
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
