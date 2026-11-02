/**
 * F8 do laboratório — fichas do cliente, do serviço e do caso.
 *
 * - Ficha do CLIENTE (PatientLabProfile): tipo (dentista ou clínica), CRO, razão
 *   social, clínica onde atende, contato, dentistas solicitantes e observações de
 *   entrega.
 * - Ficha TÉCNICA do serviço (ProcedureLabSpec): prazo em dias corridos, garantia,
 *   unidade, material padrão, se pede cor e se tem prova.
 * - Ficha do CASO (QuoteLabCase): paciente do caso, dentista solicitante, cor,
 *   material, entrega prometida, instruções, link do escaneamento e recebido em.
 *
 * Datas do caso no formato 'AAAA-MM-DD' (dia em UTC, gravado como T00:00:00.000Z,
 * a mesma convenção do vencimento dos boletos). "Hoje" é o dia de Maceió
 * (UTC-3 fixo): Date.now() - 3h.
 *
 * Módulo puro (sem Prisma, sem Nest, sem tela): API e web importam daqui. Sem
 * pickBt e sem const com prefixo de laboratório (regras de
 * scripts/ci/check-pick-literals.mjs): os textos de tela ficam nos arquivos de
 * textos de cada lado.
 */
import { tipoDoDocumento, type TipoCliente } from './documento-br';

// ─── Constantes ──────────────────────────────────────────────────────────────

/** Tipos do cliente do laboratório (mesmo TipoCliente de documento-br.ts). */
export const TIPOS_DE_CLIENTE = ['DENTISTA', 'CLINICA'] as const satisfies readonly TipoCliente[];

/** Unidade em que o serviço é cobrado/produzido. */
export const UNIDADES_DO_SERVICO = ['ELEMENTO', 'ARCADA', 'PECA'] as const;
export type UnidadeDoServico = (typeof UNIDADES_DO_SERVICO)[number];

/** As 27 unidades da federação (UF do CRO). */
export const UFS_DO_BRASIL = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;
export type UfDoBrasil = (typeof UFS_DO_BRASIL)[number];

/** Cliente sem orçamento (não apagado) há este tanto de dias = Inativo. */
export const DIAS_SEM_ORCAMENTO_PARA_INATIVO = 90;
export const MAX_DENTISTAS_SOLICITANTES = 30;
/** Prazo do serviço: 0 a 365 dias corridos. */
export const PRAZO_MAX_DIAS = 365;
/** Garantia do serviço: 0 a 3650 dias. */
export const GARANTIA_MAX_DIAS = 3650;
/** Número do CRO: 1 a 8 dígitos. */
export const CRO_MAX_DIGITOS = 8;

/** Tamanho máximo (caracteres) dos campos de texto da ficha do cliente. */
export const LIMITES_DO_PERFIL = Object.freeze({
  legal_name: 160,
  clinic_name: 160,
  contact_name: 160,
  contact_phone: 20,
  /** cada nome da lista de dentistas solicitantes */
  dentista: 120,
  delivery_notes: 1000,
} as const);

/** Tamanho máximo (caracteres) dos campos de texto da ficha técnica. */
export const LIMITES_DA_FICHA = Object.freeze({ default_material: 80 } as const);

/** Tamanho máximo (caracteres) dos campos de texto da ficha do caso. */
export const LIMITES_DO_CASO = Object.freeze({
  patient_ref: 120,
  requested_by_name: 120,
  shade: 40,
  material: 80,
  instructions: 2000,
  external_files_url: 500,
} as const);

/** Campos gravados da ficha do cliente (o corpo do PUT aceita só estes). */
export const CAMPOS_DO_PERFIL = [
  'kind',
  'cro_number',
  'cro_uf',
  'legal_name',
  'clinic_name',
  'contact_name',
  'contact_phone',
  'requesting_dentists',
  'delivery_notes',
] as const;

/** Campos gravados da ficha técnica do serviço (o corpo do PUT aceita só estes). */
export const CAMPOS_DA_FICHA_TECNICA = [
  'lead_time_days',
  'warranty_days',
  'unit',
  'default_material',
  'needs_shade',
  'has_tryin',
] as const;

/** Campos gravados da ficha do caso (o corpo do PUT aceita só estes). */
export const CAMPOS_DO_CASO = [
  'patient_ref',
  'requested_by_name',
  'shade',
  'material',
  'due_date',
  'instructions',
  'external_files_url',
  'received_at',
] as const;

// ─── Formas ──────────────────────────────────────────────────────────────────

export interface PerfilDoClienteLab {
  kind: TipoCliente;
  cro_number: string | null;
  cro_uf: string | null;
  legal_name: string | null;
  clinic_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  requesting_dentists: string[];
  delivery_notes: string | null;
}

export interface FichaTecnicaLab {
  lead_time_days: number;
  warranty_days: number | null;
  unit: UnidadeDoServico;
  default_material: string | null;
  needs_shade: boolean;
  has_tryin: boolean;
}

export interface FichaDoCasoLab {
  patient_ref: string | null;
  requested_by_name: string | null;
  shade: string | null;
  material: string | null;
  /** 'AAAA-MM-DD' */
  due_date: string | null;
  instructions: string | null;
  external_files_url: string | null;
  /** 'AAAA-MM-DD' */
  received_at: string | null;
}

/** GET/PUT /patients/:patientId/lab-profile. Sem linha gravada: gravado=false e kind pelo documento. */
export type PerfilDoClienteLabResposta = PerfilDoClienteLab & {
  patient_id: string;
  gravado: boolean;
  /** ISO */
  updated_at: string | null;
};

/** GET/PUT /procedures/:procedureId/lab-spec. Sem linha gravada: ficha=null. */
export interface FichaTecnicaLabResposta {
  procedure_id: string;
  ficha: FichaTecnicaLab | null;
}

/** GET /lab/procedure-specs: só os serviços com ficha gravada, por procedure_id. */
export interface FichasTecnicasLabResposta {
  fichas: Record<string, FichaTecnicaLab>;
}

/**
 * GET/PUT /quotes/:quoteId/lab-case. gravado=true: a linha é do próprio orçamento.
 * herdado_de: sem linha própria, o caso veio do orçamento de origem (aprovação
 * parcial ou renegociação) com esse id. Sem caso nenhum: campos null.
 */
export type FichaDoCasoLabResposta = FichaDoCasoLab & {
  quote_id: string;
  gravado: boolean;
  herdado_de: string | null;
  /** ISO */
  updated_at: string | null;
};

/** GET /patients/:patientId/lab-cases: o caso efetivo de cada orçamento não apagado do cliente. */
export interface CasosDoClienteLabResposta {
  casos: FichaDoCasoLabResposta[];
}

/** Chave do erro de validarPerfilDoCliente. */
export type ErroDoPerfilDoCliente = 'croObrigatorio' | 'croEmPar' | 'croInvalido' | 'ufInvalida' | 'dentistasDemais';

// ─── Funções ─────────────────────────────────────────────────────────────────

const DIA_MS = 24 * 60 * 60 * 1000;
const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;
const RE_YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

const ehTipo = (v: unknown): v is TipoCliente => (TIPOS_DE_CLIENTE as readonly unknown[]).includes(v);

/** Texto aparado; vazio, nulo ou não-texto → null. */
function textoOuNulo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Tipo do cliente: o gravado (se válido); senão o do documento (CPF → dentista, CNPJ → clínica); senão dentista. */
export function tipoDoCliente(kind: unknown, cpf: string | null | undefined): TipoCliente {
  if (ehTipo(kind)) return kind;
  return tipoDoDocumento(cpf) ?? 'DENTISTA';
}

/** Número do CRO: só os dígitos, de 1 a 8. Fora disso, null. */
export function normalizarCro(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = String(v).replace(/\D/g, '');
  return d.length >= 1 && d.length <= CRO_MAX_DIGITOS ? d : null;
}

/** Chave de comparação de nome: sem acento, minúsculas, espaços simples. */
function chaveDeNome(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lista de dentistas solicitantes: apara, junta espaços, tira vazios e remove
 * repetidos sem diferenciar acento ou maiúscula (fica a primeira grafia).
 */
export function normalizarDentistas(lista: unknown): string[] {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const item of lista) {
    if (typeof item !== 'string') continue;
    const nome = item.replace(/\s+/g, ' ').trim();
    if (!nome) continue;
    const chave = chaveDeNome(nome);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(nome);
  }
  return saida;
}

/**
 * Regras da ficha do cliente, no registro MESCLADO (gravado + corpo do PUT):
 * - número do CRO, se veio, com 1 a 8 dígitos;
 * - UF, se veio, uma das 27;
 * - DENTISTA exige número e UF;
 * - CLINICA aceita sem CRO, mas número e UF vêm juntos;
 * - no máximo 30 dentistas solicitantes.
 * Devolve a chave do erro ou null.
 */
export function validarPerfilDoCliente(p: {
  kind: TipoCliente | string | null | undefined;
  cro_number?: string | null;
  cro_uf?: string | null;
  requesting_dentists?: readonly string[] | null;
}): ErroDoPerfilDoCliente | null {
  const numero = textoOuNulo(p.cro_number);
  const uf = textoOuNulo(p.cro_uf);
  if (numero !== null && normalizarCro(numero) === null) return 'croInvalido';
  if (uf !== null && !(UFS_DO_BRASIL as readonly string[]).includes(uf)) return 'ufInvalida';
  if (p.kind === 'DENTISTA' && (numero === null || uf === null)) return 'croObrigatorio';
  if ((numero === null) !== (uf === null)) return 'croEmPar';
  if ((p.requesting_dentists?.length ?? 0) > MAX_DENTISTAS_SOLICITANTES) return 'dentistasDemais';
  return null;
}

/** 'AAAA-MM-DD' → Date em T00:00:00.000Z, conferindo a ida e volta (recusa 2026-02-30). Inválida → null. */
export function dataDoDia(ymd: unknown): Date | null {
  if (typeof ymd !== 'string' || !RE_YMD.test(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === ymd ? d : null;
}

/** Date (ou texto ISO) → 'AAAA-MM-DD' do dia em UTC. Vazio ou inválido → null. */
export function dataParaYmd(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined || d === '') return null;
  const data = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString().slice(0, 10);
}

/** Dia de hoje em Maceió (UTC-3 fixo), 'AAAA-MM-DD'. */
export function hojeEmMaceio(agoraMs: number = Date.now()): string {
  return new Date(agoraMs - MACEIO_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'AAAA-MM-DD' + n dias corridos (n inteiro, pode ser negativo). Data ou n inválido → null. */
export function somarDiasYmd(ymd: string, n: number): string | null {
  const d = dataDoDia(ymd);
  if (!d || !Number.isInteger(n)) return null;
  return new Date(d.getTime() + n * DIA_MS).toISOString().slice(0, 10);
}

/**
 * Entrega SUGERIDA: hoje + o MAIOR prazo (> 0) dos serviços, em dias corridos.
 * Ignora prazo nulo, zero ou inválido. Sem prazo nenhum (ou hoje inválido) → null.
 */
export function entregaSugerida(
  prazos: ReadonlyArray<number | null | undefined>,
  hojeYmd: string,
): { data: string; dias: number } | null {
  let dias = 0;
  for (const p of prazos) {
    if (typeof p === 'number' && Number.isInteger(p) && p > dias) dias = p;
  }
  if (dias <= 0) return null;
  const data = somarDiasYmd(hojeYmd, dias);
  return data ? { data, dias } : null;
}

/** Dias de hoje até o alvo (negativo = já passou). Alguma data inválida → null. */
export function diasAte(alvoYmd: string, hojeYmd: string): number | null {
  const alvo = dataDoDia(alvoYmd);
  const hoje = dataDoDia(hojeYmd);
  if (!alvo || !hoje) return null;
  return Math.round((alvo.getTime() - hoje.getTime()) / DIA_MS);
}

/** 'AAAA-MM-DD' (ou ISO que começa assim) → 'dd/mm/aaaa'. Vazio ou inválido → ''. */
export function formatarYmdBR(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''));
  if (!m || !dataDoDia(`${m[1]}-${m[2]}-${m[3]}`)) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Link do escaneamento: só http:// ou https:// com endereço, sem espaço. */
export function linkDoEscaneamentoValido(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const t = url.trim();
  if (!t || t.length > LIMITES_DO_CASO.external_files_url) return false;
  return /^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(t);
}
