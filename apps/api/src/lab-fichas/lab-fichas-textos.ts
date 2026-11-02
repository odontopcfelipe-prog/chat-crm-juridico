/**
 * F8 do laboratório — textos das rotas de fichas (cliente, serviço e caso). Só a
 * conta de laboratório chega nelas (a clínica leva 403 no SoLaboratorioGuard).
 * Só const LAB_ (regras de scripts/ci/check-pick-literals.mjs): qualquer outra
 * string aqui contaria como texto de clínica. Sem vocabulário de clínica (só
 * "paciente do caso" passa na trava 2).
 */
import { CRO_MAX_DIGITOS, GARANTIA_MAX_DIAS, MAX_DENTISTAS_SOLICITANTES, PRAZO_MAX_DIAS } from '@crm/shared';

export const LAB_FICHAS_API = Object.freeze({
  clienteNaoEncontrado: 'Cliente não encontrado.',
  servicoNaoEncontrado: 'Serviço não encontrado.',
  orcamentoNaoEncontrado: 'Orçamento de trabalho não encontrado.',
  foraDaCarteira: 'Cliente fora da sua carteira: fale com o administrador para liberar.',
  tipoInvalido: 'Tipo do cliente: Dentista ou Clínica.',
  croObrigatorio: 'Dentista: informe o número do CRO e a UF.',
  croEmPar: 'Informe o número do CRO junto com a UF.',
  croInvalido: `Número do CRO inválido: só números, até ${CRO_MAX_DIGITOS} dígitos.`,
  ufInvalida: 'UF do CRO inválida.',
  dentistasDemais: `No máximo ${MAX_DENTISTAS_SOLICITANTES} dentistas solicitantes por clínica.`,
  listaInvalida: 'Lista de dentistas solicitantes inválida.',
  textoInvalido: 'Texto inválido.',
  textoLongo: (campo: string, max: number): string => `${campo}: no máximo ${max} caracteres.`,
  booleano: 'Valor inválido (sim ou não).',
  prazoInvalido: `Prazo: número inteiro de dias, de 0 a ${PRAZO_MAX_DIAS}.`,
  garantiaInvalida: `Garantia: número inteiro de dias, de 0 a ${GARANTIA_MAX_DIAS}.`,
  unidadeInvalida: 'Unidade: elemento, arcada ou peça.',
  prazoEUnidade: 'Informe o prazo e a unidade do serviço.',
  dataInvalida: 'Data inválida (use AAAA-MM-DD).',
  entregaFora: 'Entrega prometida fora do intervalo aceito.',
  recebidoFuturo: 'A data de recebimento não pode ser no futuro.',
  recebidoAntigo: 'Data de recebimento anterior a 2020. Confira o ano.',
  linkInvalido: 'Link do escaneamento inválido: use um endereço http ou https.',
  /** Nome de cada campo nas mensagens de tamanho (textoLongo). */
  campos: Object.freeze({
    legal_name: 'Razão social',
    clinic_name: 'Clínica onde atende',
    contact_name: 'Nome do contato',
    contact_phone: 'Telefone do contato',
    dentista: 'Cada dentista solicitante',
    delivery_notes: 'Observações de entrega',
    default_material: 'Material padrão',
    patient_ref: 'Paciente do caso',
    requested_by_name: 'Dentista solicitante',
    shade: 'Cor',
    material: 'Material',
    instructions: 'Instruções',
    external_files_url: 'Link do escaneamento',
  }),
});
