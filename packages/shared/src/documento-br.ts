/**
 * F5 do laboratório — documento do cliente (CPF ou CNPJ).
 *
 * O cliente do laboratório é um dentista (CPF, opcional) ou uma clínica (CNPJ,
 * obrigatório). Até existir um campo próprio para o tipo, ele sai do tamanho do
 * documento: 11 posições = dentista, 14 = clínica.
 *
 * O CNPJ aceita o formato alfanumérico: as 12 primeiras posições podem ter
 * letra (A-Z) e os 2 dígitos verificadores são sempre numéricos. O valor de
 * cada caractere no cálculo é o código ASCII menos 48 (dígito = ele mesmo,
 * 'A' = 17 ... 'Z' = 42), com os pesos de sempre do módulo 11.
 *
 * O cadastro grava o documento MASCARADO, igual ao CPF do cadastro de hoje.
 *
 * Módulo puro (sem Prisma, sem Nest, sem tela): API, worker e web importam daqui.
 */

export type TipoCliente = 'DENTISTA' | 'CLINICA';

/** Maiúsculas e só [0-9A-Z] (tira pontos, barra, traço e espaço). */
export function soDocumento(v: string | null | undefined): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

/** Mesmo algoritmo do isValidCPF do web (apps/web/src/lib/utils.ts), copiado. */
function cpfValido(cpf: string): boolean {
  const d = (cpf || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(d[i], 10) * (10 - i);
  let r = (s * 10) % 11; if (r >= 10) r = 0;
  if (r !== parseInt(d[9], 10)) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(d[i], 10) * (11 - i);
  r = (s * 10) % 11; if (r >= 10) r = 0;
  return r === parseInt(d[10], 10);
}

const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function dvCnpj(base: string, pesos: readonly number[]): number {
  let soma = 0;
  for (let i = 0; i < pesos.length; i++) soma += (base.charCodeAt(i) - 48) * pesos[i];
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * CNPJ válido (numérico ou alfanumérico). Aceita o valor mascarado.
 * 14 posições: as 12 primeiras [0-9A-Z] e os 2 verificadores numéricos.
 * Recusa todos os caracteres iguais.
 */
export function isValidCnpj(v: string): boolean {
  const d = soDocumento(v);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(d)) return false;
  if (/^(.)\1{13}$/.test(d)) return false;
  const dv1 = dvCnpj(d, PESOS_DV1);
  if (dv1 !== d.charCodeAt(12) - 48) return false;
  const dv2 = dvCnpj(d, PESOS_DV2);
  return dv2 === d.charCodeAt(13) - 48;
}

/**
 * Validação para o cadastro: '' quando está OK ou vazio. Senão
 * 'Faltam N dígito(s)', 'CPF inválido' ou 'CNPJ inválido'.
 * Sem tipo: até 11 posições é CPF, acima disso é CNPJ.
 */
export function vCpfCnpj(v: string, tipo?: TipoCliente): string {
  const d = soDocumento(v);
  if (!d) return '';
  const t: TipoCliente = tipo ?? (d.length <= 11 ? 'DENTISTA' : 'CLINICA');
  if (t === 'DENTISTA') {
    if (d.length < 11) return `Faltam ${11 - d.length} dígito(s)`;
    return /^\d{11}$/.test(d) && cpfValido(d) ? '' : 'CPF inválido';
  }
  if (d.length < 14) return `Faltam ${14 - d.length} dígito(s)`;
  return isValidCnpj(d) ? '' : 'CNPJ inválido';
}

function mascaraCpf(d: string): string {
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function mascaraCnpj(d: string): string {
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/**
 * Máscara conforme digita.
 * DENTISTA (CPF): '000.000.000-00', só números.
 * CLINICA (CNPJ): 'XX.XXX.XXX/XXXX-00', letra aceita nas 12 primeiras posições
 * e só número nos 2 verificadores.
 */
export function maskCpfCnpjInput(v: string, tipo: TipoCliente): string {
  if (tipo === 'DENTISTA') return mascaraCpf(String(v ?? '').replace(/\D/g, '').slice(0, 11));
  let d = '';
  for (const c of soDocumento(v)) {
    if (d.length >= 14) break;
    if (d.length < 12 || /[0-9]/.test(c)) d += c;
  }
  return mascaraCnpj(d);
}

/**
 * Documento para exibir: 11 posições → CPF formatado; 14 → CNPJ formatado;
 * outro tamanho → o valor como veio; vazio → ''.
 */
export function formatCpfCnpj(doc: string | null | undefined): string {
  const d = soDocumento(doc);
  if (!d) return '';
  if (d.length === 11) return mascaraCpf(d);
  if (d.length === 14) return mascaraCnpj(d);
  return String(doc);
}

/** Tipo do cliente pelo tamanho do documento: 11 → 'DENTISTA', 14 → 'CLINICA', outro → null. */
export function tipoDoDocumento(doc: string | null | undefined): TipoCliente | null {
  const d = soDocumento(doc);
  if (d.length === 11) return 'DENTISTA';
  if (d.length === 14) return 'CLINICA';
  return null;
}
