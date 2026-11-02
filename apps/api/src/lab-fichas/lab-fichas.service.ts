import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  dataDoDia,
  dataParaYmd,
  hojeEmMaceio,
  linkDoEscaneamentoValido,
  normalizarCro,
  normalizarDentistas,
  tipoDoCliente,
  validarPerfilDoCliente,
  type CasosDoClienteLabResposta,
  type FichaDoCasoLabResposta,
  type FichaTecnicaLab,
  type FichaTecnicaLabResposta,
  type FichasTecnicasLabResposta,
  type PerfilDoClienteLabResposta,
  type UnidadeDoServico,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isAdminRole, isOwnPatient, restrictedPatientOwner } from '../auth/patient-scope';
import { PermissionsGuard } from '../auth/decorators/requires-permission.decorator';
import { LAB_FICHAS_API as T } from './lab-fichas-textos';
import { acharCasoNaCadeia, NIVEIS_DE_HERANCA, origemDoOrcamento } from './caso-do-orcamento';
import type { PutPatientLabProfileDto, PutProcedureLabSpecDto, PutQuoteLabCaseDto } from './dto/lab-fichas.dto';

/** Quem pede (req.user): a carteira e a permissão de ver contato dependem dele. */
export type UsuarioDasFichas = { id?: string; roles?: string[] } | undefined;

/** Primeiro dia aceito na entrega prometida. */
const ENTREGA_MINIMA = '2020-01-01';
/** A entrega prometida vai até hoje + este tanto de anos. */
const ANOS_DE_ENTREGA = 3;

/** Texto aparado; vazio, nulo ou não-texto → null. */
function textoOuNulo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** A chave veio no corpo (undefined = não veio: o DTO declara todos os campos). */
function veio(corpo: object, chave: string): boolean {
  return (corpo as Record<string, unknown>)[chave] !== undefined;
}

const iso = (d: Date | null | undefined): string | null => (d instanceof Date ? d.toISOString() : null);

function respostaDoPerfil(patientId: string, cpf: string | null, linha: any | null): PerfilDoClienteLabResposta {
  return {
    patient_id: patientId,
    gravado: !!linha,
    updated_at: iso(linha?.updated_at),
    kind: tipoDoCliente(linha?.kind ?? null, cpf),
    cro_number: linha?.cro_number ?? null,
    cro_uf: linha?.cro_uf ?? null,
    legal_name: linha?.legal_name ?? null,
    clinic_name: linha?.clinic_name ?? null,
    contact_name: linha?.contact_name ?? null,
    contact_phone: linha?.contact_phone ?? null,
    requesting_dentists: Array.isArray(linha?.requesting_dentists) ? [...linha.requesting_dentists] : [],
    delivery_notes: linha?.delivery_notes ?? null,
  };
}

function fichaDe(linha: any): FichaTecnicaLab {
  return {
    lead_time_days: linha.lead_time_days,
    warranty_days: linha.warranty_days ?? null,
    unit: linha.unit as UnidadeDoServico,
    default_material: linha.default_material ?? null,
    needs_shade: !!linha.needs_shade,
    has_tryin: !!linha.has_tryin,
  };
}

function respostaDoCaso(quoteId: string, linha: any | null, gravado: boolean, herdadoDe: string | null): FichaDoCasoLabResposta {
  return {
    quote_id: quoteId,
    gravado,
    herdado_de: herdadoDe,
    updated_at: iso(linha?.updated_at),
    patient_ref: linha?.patient_ref ?? null,
    requested_by_name: linha?.requested_by_name ?? null,
    shade: linha?.shade ?? null,
    material: linha?.material ?? null,
    due_date: dataParaYmd(linha?.due_date ?? null),
    instructions: linha?.instructions ?? null,
    external_files_url: linha?.external_files_url ?? null,
    received_at: dataParaYmd(linha?.received_at ?? null),
  };
}

/**
 * F8 do laboratório — fichas do cliente, do serviço e do caso.
 *
 * Toda leitura e gravação é pela conta do LOGIN (tenantId): registro de outra conta
 * = 404 e nada gravado. O tenant_id das tabelas novas só entra na criação e sempre
 * é o do login. PUT = upsert PARCIAL: chave ausente mantém, null limpa; as regras
 * valem no registro mesclado (gravado + corpo). Os valores do caso (paciente do
 * caso, instruções) nunca vão para log nem para AuditLog.
 */
@Injectable()
export class LabFichasService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Dono e permissões ─────────────────────────────────────────────────────

  private async clienteDaConta(tenantId: string, patientId: string): Promise<{ id: string; cpf: string | null }> {
    const p = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
      select: { id: true, cpf: true },
    });
    if (!p) throw new NotFoundException(T.clienteNaoEncontrado);
    return p;
  }

  private async servicoDaConta(tenantId: string, procedureId: string): Promise<void> {
    const s = await this.prisma.procedure.findFirst({
      where: { id: procedureId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!s) throw new NotFoundException(T.servicoNaoEncontrado);
  }

  private async orcamentoDaConta(
    tenantId: string,
    quoteId: string,
  ): Promise<{ id: string; patient_id: string; accepted_from_id: string | null; renegotiated_from_id: string | null }> {
    const q = await this.prisma.quote.findFirst({
      where: { id: quoteId, deleted_at: null, patient: { tenant_id: tenantId } },
      select: { id: true, patient_id: true, accepted_from_id: true, renegotiated_from_id: true },
    });
    if (!q) throw new NotFoundException(T.orcamentoNaoEncontrado);
    return q;
  }

  /** Usuário restrito à carteira: o orçamento tem de ser de cliente dele (como assertQuoteInScope). */
  private async garantirCarteira(user: UsuarioDasFichas, tenantId: string, patientId: string): Promise<void> {
    const owner = await restrictedPatientOwner(this.prisma, user);
    if (!owner) return;
    if (await isOwnPatient(this.prisma, tenantId, owner, patientId)) return;
    throw new ForbiddenException({ message: T.foraDaCarteira, code: 'PERMISSION_DENIED' });
  }

  /** Mesma regra do dropHiddenContact do PatientsController. */
  private async podeVerContato(user: UsuarioDasFichas): Promise<boolean> {
    if (isAdminRole(user?.roles)) return true;
    if (!user?.id) return false;
    const perms = await PermissionsGuard.permissionsFor(this.prisma, user.id, user.roles ?? []);
    return perms.has('view_patient_contact');
  }

  /** Upsert com uma nova tentativa como update se dois PUT simultâneos criarem ao mesmo tempo (P2002). */
  private async gravarComRetentativa<R>(upsert: () => Promise<R>, update: () => Promise<R>): Promise<R> {
    try {
      return await upsert();
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'P2002') return update();
      throw e;
    }
  }

  // ─── Ficha do cliente ──────────────────────────────────────────────────────

  async lerPerfil(tenantId: string, patientId: string): Promise<PerfilDoClienteLabResposta> {
    const cliente = await this.clienteDaConta(tenantId, patientId);
    const linha = await this.prisma.patientLabProfile.findFirst({ where: { patient_id: patientId, tenant_id: tenantId } });
    return respostaDoPerfil(patientId, cliente.cpf, linha);
  }

  async gravarPerfil(
    user: UsuarioDasFichas,
    tenantId: string,
    patientId: string,
    dto: PutPatientLabProfileDto,
  ): Promise<PerfilDoClienteLabResposta> {
    const cliente = await this.clienteDaConta(tenantId, patientId);
    const corpo: Record<string, unknown> = { ...(dto as Record<string, unknown>) };
    // Quem não vê contato recebe contact_phone null no GET: reenviar o null apagaria o gravado.
    if (!(await this.podeVerContato(user))) delete corpo.contact_phone;

    const atual = await this.prisma.patientLabProfile.findUnique({ where: { patient_id: patientId } });
    if (atual && atual.tenant_id !== tenantId) throw new NotFoundException(T.clienteNaoEncontrado);

    const kind = veio(corpo, 'kind')
      ? tipoDoCliente(textoOuNulo(corpo.kind), cliente.cpf)
      : tipoDoCliente(atual?.kind ?? null, cliente.cpf);

    let cro_number: string | null = atual?.cro_number ?? null;
    if (veio(corpo, 'cro_number')) {
      const bruto = textoOuNulo(corpo.cro_number);
      cro_number = bruto === null ? null : normalizarCro(bruto);
      if (bruto !== null && cro_number === null) throw new BadRequestException(T.croInvalido);
    }
    const cro_uf = veio(corpo, 'cro_uf') ? (textoOuNulo(corpo.cro_uf)?.toUpperCase() ?? null) : (atual?.cro_uf ?? null);
    const texto = (k: 'legal_name' | 'clinic_name' | 'contact_name' | 'contact_phone' | 'delivery_notes'): string | null =>
      veio(corpo, k) ? textoOuNulo(corpo[k]) : (atual?.[k] ?? null);
    let requesting_dentists: string[] = veio(corpo, 'requesting_dentists')
      ? normalizarDentistas(corpo.requesting_dentists ?? [])
      : [...(atual?.requesting_dentists ?? [])];
    if (kind === 'DENTISTA') requesting_dentists = [];

    const erro = validarPerfilDoCliente({ kind, cro_number, cro_uf, requesting_dentists });
    if (erro) throw new BadRequestException(T[erro]);

    const dados = {
      kind,
      cro_number,
      cro_uf,
      legal_name: texto('legal_name'),
      clinic_name: texto('clinic_name'),
      contact_name: texto('contact_name'),
      contact_phone: texto('contact_phone'),
      requesting_dentists,
      delivery_notes: texto('delivery_notes'),
    };
    const linha = await this.gravarComRetentativa(
      () =>
        this.prisma.patientLabProfile.upsert({
          where: { patient_id: patientId },
          create: { patient_id: patientId, tenant_id: tenantId, ...dados },
          update: dados,
        }),
      () => this.prisma.patientLabProfile.update({ where: { patient_id: patientId }, data: dados }),
    );
    return respostaDoPerfil(patientId, cliente.cpf, linha);
  }

  // ─── Ficha técnica do serviço ──────────────────────────────────────────────

  async listarFichas(tenantId: string): Promise<FichasTecnicasLabResposta> {
    const linhas = await this.prisma.procedureLabSpec.findMany({ where: { tenant_id: tenantId } });
    const fichas: Record<string, FichaTecnicaLab> = {};
    for (const l of linhas) fichas[l.procedure_id] = fichaDe(l);
    return { fichas };
  }

  async lerFicha(tenantId: string, procedureId: string): Promise<FichaTecnicaLabResposta> {
    await this.servicoDaConta(tenantId, procedureId);
    const linha = await this.prisma.procedureLabSpec.findFirst({ where: { procedure_id: procedureId, tenant_id: tenantId } });
    return { procedure_id: procedureId, ficha: linha ? fichaDe(linha) : null };
  }

  async gravarFicha(tenantId: string, procedureId: string, dto: PutProcedureLabSpecDto): Promise<FichaTecnicaLabResposta> {
    await this.servicoDaConta(tenantId, procedureId);
    const corpo: Record<string, unknown> = { ...(dto as Record<string, unknown>) };
    const atual = await this.prisma.procedureLabSpec.findUnique({ where: { procedure_id: procedureId } });
    if (atual && atual.tenant_id !== tenantId) throw new NotFoundException(T.servicoNaoEncontrado);

    const lead_time_days = veio(corpo, 'lead_time_days') ? (corpo.lead_time_days as number | null) : (atual?.lead_time_days ?? null);
    const unit = veio(corpo, 'unit') ? textoOuNulo(corpo.unit) : (atual?.unit ?? null);
    // Colunas obrigatórias: na criação (e se alguém tentar limpar) o prazo e a unidade têm de existir.
    if (lead_time_days === null || unit === null) throw new BadRequestException(T.prazoEUnidade);

    const dados = {
      lead_time_days,
      unit,
      warranty_days: veio(corpo, 'warranty_days') ? ((corpo.warranty_days as number | null) ?? null) : (atual?.warranty_days ?? null),
      default_material: veio(corpo, 'default_material') ? textoOuNulo(corpo.default_material) : (atual?.default_material ?? null),
      needs_shade: veio(corpo, 'needs_shade') ? corpo.needs_shade === true : (atual?.needs_shade ?? false),
      has_tryin: veio(corpo, 'has_tryin') ? corpo.has_tryin === true : (atual?.has_tryin ?? false),
    };
    const linha = await this.gravarComRetentativa(
      () =>
        this.prisma.procedureLabSpec.upsert({
          where: { procedure_id: procedureId },
          create: { procedure_id: procedureId, tenant_id: tenantId, ...dados },
          update: dados,
        }),
      () => this.prisma.procedureLabSpec.update({ where: { procedure_id: procedureId }, data: dados }),
    );
    return { procedure_id: procedureId, ficha: fichaDe(linha) };
  }

  // ─── Ficha do caso ─────────────────────────────────────────────────────────

  async lerCaso(user: UsuarioDasFichas, tenantId: string, quoteId: string): Promise<FichaDoCasoLabResposta> {
    const q = await this.orcamentoDaConta(tenantId, quoteId);
    await this.garantirCarteira(user, tenantId, q.patient_id);
    const achado = await acharCasoNaCadeia(this.prisma, quoteId, tenantId, undefined, origemDoOrcamento(q));
    if (!achado) return respostaDoCaso(quoteId, null, false, null);
    return achado.de === quoteId ? respostaDoCaso(quoteId, achado.caso, true, null) : respostaDoCaso(quoteId, achado.caso, false, achado.de);
  }

  async gravarCaso(
    user: UsuarioDasFichas,
    tenantId: string,
    quoteId: string,
    dto: PutQuoteLabCaseDto,
  ): Promise<FichaDoCasoLabResposta> {
    const q = await this.orcamentoDaConta(tenantId, quoteId);
    await this.garantirCarteira(user, tenantId, q.patient_id);
    const corpo: Record<string, unknown> = { ...(dto as Record<string, unknown>) };

    const proprio = await this.prisma.quoteLabCase.findUnique({ where: { quote_id: quoteId } });
    if (proprio && proprio.tenant_id !== tenantId) throw new NotFoundException(T.orcamentoNaoEncontrado);
    // Sem caso próprio, o ponto de partida é o caso herdado (o que o GET mostrou): a
    // chave ausente mantém o que a tela via. A gravação é sempre no orçamento pedido.
    const base: any =
      proprio ?? (await acharCasoNaCadeia(this.prisma, quoteId, tenantId, undefined, origemDoOrcamento(q)))?.caso ?? null;

    const hoje = hojeEmMaceio();
    const entregaMaxima = `${Number(hoje.slice(0, 4)) + ANOS_DE_ENTREGA}${hoje.slice(4)}`;
    const data = (k: 'due_date' | 'received_at'): Date | null => {
      if (!veio(corpo, k)) return base?.[k] ?? null;
      const ymd = textoOuNulo(corpo[k]);
      if (ymd === null) return null;
      const d = dataDoDia(ymd);
      if (!d) throw new BadRequestException(T.dataInvalida);
      if (k === 'due_date' && (ymd < ENTREGA_MINIMA || ymd > entregaMaxima)) throw new BadRequestException(T.entregaFora);
      if (k === 'received_at' && ymd < ENTREGA_MINIMA) throw new BadRequestException(T.recebidoAntigo);
      if (k === 'received_at' && ymd > hoje) throw new BadRequestException(T.recebidoFuturo);
      return d;
    };
    const texto = (k: 'patient_ref' | 'requested_by_name' | 'shade' | 'material' | 'instructions'): string | null =>
      veio(corpo, k) ? textoOuNulo(corpo[k]) : (base?.[k] ?? null);
    let external_files_url: string | null = base?.external_files_url ?? null;
    if (veio(corpo, 'external_files_url')) {
      external_files_url = textoOuNulo(corpo.external_files_url);
      if (external_files_url !== null && !linkDoEscaneamentoValido(external_files_url)) throw new BadRequestException(T.linkInvalido);
    }

    const dados = {
      patient_ref: texto('patient_ref'),
      requested_by_name: texto('requested_by_name'),
      shade: texto('shade'),
      material: texto('material'),
      due_date: data('due_date'),
      instructions: texto('instructions'),
      external_files_url,
      received_at: data('received_at'),
    };
    const linha = await this.gravarComRetentativa(
      () =>
        this.prisma.quoteLabCase.upsert({
          where: { quote_id: quoteId },
          create: { quote_id: quoteId, tenant_id: tenantId, ...dados },
          update: dados,
        }),
      () => this.prisma.quoteLabCase.update({ where: { quote_id: quoteId }, data: dados }),
    );
    return respostaDoCaso(quoteId, linha, true, null);
  }

  /**
   * O caso efetivo (próprio ou herdado) de cada orçamento NÃO apagado do cliente,
   * do mais novo para o mais antigo, em 2 leituras (sem N+1). Os orçamentos apagados
   * entram só como elo da cadeia de origem. Orçamento sem caso: campos null.
   */
  async listarCasosDoCliente(tenantId: string, patientId: string): Promise<CasosDoClienteLabResposta> {
    await this.clienteDaConta(tenantId, patientId);
    const orcamentos = await this.prisma.quote.findMany({
      where: { patient_id: patientId, patient: { tenant_id: tenantId } },
      select: { id: true, deleted_at: true, accepted_from_id: true, renegotiated_from_id: true },
      orderBy: { created_at: 'desc' },
      take: 500,
    });
    if (!orcamentos.length) return { casos: [] };
    const linhas = await this.prisma.quoteLabCase.findMany({
      where: { tenant_id: tenantId, quote_id: { in: orcamentos.map((q) => q.id) } },
    });
    const porOrcamento = new Map(linhas.map((l) => [l.quote_id, l]));
    const origem = new Map(orcamentos.map((q) => [q.id, origemDoOrcamento(q)]));

    const casos = orcamentos
      .filter((q) => !q.deleted_at)
      .map((q) => {
        const proprio = porOrcamento.get(q.id);
        if (proprio) return respostaDoCaso(q.id, proprio, true, null);
        let id = origem.get(q.id) ?? null;
        for (let nivel = 1; id && nivel <= NIVEIS_DE_HERANCA; nivel++) {
          const herdado = porOrcamento.get(id);
          if (herdado) return respostaDoCaso(q.id, herdado, false, id);
          id = origem.get(id) ?? null;
        }
        return respostaDoCaso(q.id, null, false, null);
      });
    return { casos };
  }
}
