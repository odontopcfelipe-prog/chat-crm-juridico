/**
 * F8 do laboratório — Ativo/Inativo do cliente e a busca da lista, só para conta
 * de laboratório. patients.service.ts (arquivo de muito movimento) só ganha os
 * portões `opts.lab ? ... : <caminho da clínica>` e chama daqui.
 *
 * Regra: Inativo = sem orçamento NÃO apagado há DIAS_SEM_ORCAMENTO_PARA_INATIVO
 * dias (90). Cadastro que nunca teve orçamento conta pela data de criação (a mesma
 * ideia da clínica, que usa o cadastro quando não há atendimento). Arquivado é o
 * status salvo e vale primeiro. Os baldes ACTIVE e INACTIVE repartem todo
 * cadastro não arquivado (nenhum fica nos dois nem fora dos dois).
 *
 * A busca acrescenta nome fantasia, razão social e CRO (só com 3 ou mais dígitos
 * no termo), pela relação lab_profile. Contato do perfil e dentistas solicitantes
 * ficam fora da busca de propósito.
 *
 * Funções puras, sem provider Nest e sem texto que vá para a tela.
 */
import { DIAS_SEM_ORCAMENTO_PARA_INATIVO, type Prisma } from '@crm/shared';

const DIA_MS = 86_400_000;

/** Corte do laboratório: quem tem a referência antes dele é Inativo. */
export function corteDoLaboratorio(agora: Date = new Date()): Date {
  return new Date(agora.getTime() - DIAS_SEM_ORCAMENTO_PARA_INATIVO * DIA_MS);
}

/** Fragmento de WHERE de cada balde (combinável por AND ou spread), como activityWhere da clínica. */
export function atividadeDoLaboratorioWhere(bucket: 'ACTIVE' | 'INACTIVE', corte: Date): Prisma.PatientWhereInput {
  if (bucket === 'ACTIVE') {
    return {
      status: { not: 'ARCHIVED' },
      OR: [
        { quotes: { some: { deleted_at: null, created_at: { gte: corte } } } },
        { quotes: { none: { deleted_at: null } }, created_at: { gte: corte } },
      ],
    };
  }
  return {
    status: { not: 'ARCHIVED' },
    quotes: { none: { deleted_at: null, created_at: { gte: corte } } },
    OR: [{ quotes: { some: { deleted_at: null } } }, { created_at: { lt: corte } }],
  };
}

/** Selo da linha: Arquivado primeiro; depois o último orçamento não apagado (ou o cadastro) contra o corte. */
export function statusDoLaboratorio(
  p: { status: string; created_at: Date },
  ultimoOrcamento: Date | null | undefined,
  corte: Date,
): 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' {
  if (p.status === 'ARCHIVED') return 'ARCHIVED';
  const ref = ultimoOrcamento ?? p.created_at;
  return ref < corte ? 'INACTIVE' : 'ACTIVE';
}

/** OR extra da busca do laboratório (vai no FIM do OR da clínica). */
export function buscaDoLaboratorio(termo: string): Prisma.PatientWhereInput[] {
  const extra: Prisma.PatientWhereInput[] = [
    { lab_profile: { is: { clinic_name: { contains: termo, mode: 'insensitive' } } } },
    { lab_profile: { is: { legal_name: { contains: termo, mode: 'insensitive' } } } },
  ];
  const digitos = termo.replace(/\D/g, '');
  if (digitos.length >= 3) extra.push({ lab_profile: { is: { cro_number: { contains: digitos } } } });
  return extra;
}

/** Include extra da lista do laboratório: o tipo, o CRO e os nomes do perfil, sem contato. */
export const includeDoLaboratorio = {
  lab_profile: { select: { kind: true, cro_number: true, cro_uf: true, clinic_name: true, legal_name: true } },
} satisfies Prisma.PatientInclude;

/** Só o que ultimosOrcamentosDoLaboratorio usa do prisma (o spec passa um gravador). */
type DbDosOrcamentos = { quote: { groupBy(args: any): Promise<any> } };

/**
 * Data do último orçamento NÃO apagado de cada cadastro da página, numa consulta
 * agregada só (sem leitura por linha). Página vazia não consulta. Quem não está no
 * mapa nunca teve orçamento (ou só tem apagado).
 */
export async function ultimosOrcamentosDoLaboratorio(db: DbDosOrcamentos, ids: string[]): Promise<Map<string, Date>> {
  const mapa = new Map<string, Date>();
  if (ids.length === 0) return mapa;
  const grupos: Array<{ patient_id: string; _max?: { created_at?: Date | null } | null }> = await db.quote.groupBy({
    by: ['patient_id'],
    where: { patient_id: { in: ids }, deleted_at: null },
    _max: { created_at: true },
  });
  for (const g of grupos) {
    const quando = g._max?.created_at;
    if (quando) mapa.set(g.patient_id, new Date(quando));
  }
  return mapa;
}
