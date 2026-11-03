import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { auditData, registrarAuditoria } from '../common/utils/audit-log.util';
import { criacaoLaboratorioLiberada } from './criacao-laboratorio.service';
import { LAB_CONVITE_MSG } from './cadastro-laboratorio.textos';
import { lerContaDaPlataforma } from '../billing/conta-asaas-da-plataforma';
import {
  CHAVE_CADASTRO_LABORATORIO,
  VALIDADE_MAX_DIAS,
  VALIDADE_PADRAO_DIAS,
  gerarCodigoConvite,
  lerChavesOuFalhar,
  linkDoConvite,
  situacaoDoConvite,
  type SituacaoConvite,
} from './convite-laboratorio';

/** O que a tela do SUPER_ADMIN vê de um convite. Nunca tem o hash nem o código. */
export interface ConviteLaboratorioItem {
  id: string;
  email: string | null;
  lab_name: string | null;
  waitlist_entry_id: string | null;
  created_by_user_id: string | null;
  criado_por_nome: string | null;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  tenant_id: string | null;
  tenant_nome: string | null;
  situacao: SituacaoConvite;
}

export interface ChaveCadastroLaboratorio {
  aberto: boolean;
  criacao_liberada: boolean;
  atualizado_em: Date | null;
}

export interface NovoConvite {
  waitlist_entry_id?: string;
  email?: string;
  lab_name?: string;
  dias?: number;
}

/** Colunas que saem do banco para a tela (sem token_hash). */
const COLUNAS = {
  id: true,
  email: true,
  lab_name: true,
  waitlist_entry_id: true,
  created_by_user_id: true,
  created_at: true,
  expires_at: true,
  used_at: true,
  revoked_at: true,
  tenant_id: true,
} as const;

const DIA_MS = 24 * 3600_000;

/** Aparado, com espaço colapsado e cortado no máximo (igual à lista de espera). */
const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

/**
 * F11 do laboratório — chave do cadastro aberto (LAB_SIGNUP_ENABLED) e convites
 * do cadastro de laboratório. Só o SUPER_ADMIN chega aqui. O código do convite
 * sai uma única vez (na resposta do criar) e nunca vai para log nem auditoria.
 */
@Injectable()
export class ConvitesLaboratorioService {
  private readonly logger = new Logger('ConvitesLaboratorio');

  constructor(private prisma: PrismaService) {}

  async lerChave(): Promise<ChaveCadastroLaboratorio> {
    const c = await lerChavesOuFalhar(this.prisma);
    return { aberto: c.cadastroAberto, criacao_liberada: c.criacaoLiberada, atualizado_em: c.atualizadoEm };
  }

  /**
   * Liga/desliga o cadastro aberto. Ligar com a chave mestra desligada é permitido (a
   * tela avisa); ligar sem a conta Asaas da mensalidade não (o laboratório não teria
   * onde pagar quando o teste acabar). Desligar sempre pode.
   */
  async definirChave(aberto: unknown, quem?: string | null): Promise<ChaveCadastroLaboratorio> {
    if (typeof aberto !== 'boolean') {
      throw new BadRequestException(LAB_CONVITE_MSG.aberto);
    }
    if (aberto && !(await lerContaDaPlataforma(this.prisma))) {
      throw new ConflictException(LAB_CONVITE_MSG.semMensalidade);
    }
    const key = CHAVE_CADASTRO_LABORATORIO;
    const value = aberto ? 'true' : 'false';
    const linha = await this.prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    this.logger.log(`[CADASTRO-LABORATORIO] ${aberto ? 'aberto' : 'fechado'} por ${quem || '?'}`);
    await registrarAuditoria(
      this.prisma,
      {
        tenantId: null,
        actorUserId: typeof quem === 'string' && quem ? quem : null,
        entity: 'PLATAFORMA',
        entityId: key,
        action: aberto ? 'CADASTRO_LABORATORIO_ABERTO' : 'CADASTRO_LABORATORIO_FECHADO',
      },
      this.logger,
    );
    return {
      aberto,
      criacao_liberada: await criacaoLaboratorioLiberada(this.prisma),
      atualizado_em: linha?.updated_at ?? null,
    };
  }

  /**
   * Convite novo. A partir de uma inscrição da lista de espera, completa e-mail e
   * nome com os dela (o corpo vence) e revoga os convites dela que ainda valiam.
   * Devolve o código e o link UMA vez; o banco guarda só o hash.
   */
  async criar(
    dados: NovoConvite,
    quem?: string | null,
  ): Promise<{ convite: ConviteLaboratorioItem; codigo: string; link: string }> {
    const agora = new Date();
    const pedido = dados?.dias;
    if (pedido !== undefined && pedido !== null && !(Number.isInteger(pedido) && pedido >= 1 && pedido <= VALIDADE_MAX_DIAS)) {
      throw new BadRequestException(LAB_CONVITE_MSG.validade);
    }
    const dias = typeof pedido === 'number' ? pedido : VALIDADE_PADRAO_DIAS;
    const inscricaoId = typeof dados?.waitlist_entry_id === 'string' && dados.waitlist_entry_id ? dados.waitlist_entry_id : null;
    let email = texto(dados?.email, 160).toLowerCase() || null;
    let labName = texto(dados?.lab_name, 120) || null;

    if (inscricaoId) {
      const inscricao = await this.prisma.labWaitlistEntry.findUnique({
        where: { id: inscricaoId },
        select: { id: true, email: true, lab_name: true },
      });
      if (!inscricao) throw new NotFoundException(LAB_CONVITE_MSG.inscricaoNaoEncontrada);
      const usado = await this.prisma.labSignupInvite.findFirst({
        where: { waitlist_entry_id: inscricaoId, used_at: { not: null } },
        select: { id: true },
      });
      if (usado) throw new ConflictException(LAB_CONVITE_MSG.inscricaoJaVirouConta);
      email = email || texto(inscricao.email, 160).toLowerCase() || null;
      labName = labName || texto(inscricao.lab_name, 120) || null;
    }

    const expiresAt = new Date(agora.getTime() + dias * DIA_MS);
    const autor = typeof quem === 'string' && quem ? quem : null;
    const { codigo, token_hash } = gerarCodigoConvite();

    const linha = await this.prisma.$transaction(async (tx) => {
      let revogados = 0;
      if (inscricaoId) {
        const r = await tx.labSignupInvite.updateMany({
          where: { waitlist_entry_id: inscricaoId, used_at: null, revoked_at: null, expires_at: { gt: agora } },
          data: { revoked_at: agora },
        });
        revogados = r?.count ?? 0;
      }
      const criado = await tx.labSignupInvite.create({
        data: {
          token_hash,
          email,
          lab_name: labName,
          waitlist_entry_id: inscricaoId,
          created_by_user_id: autor,
          expires_at: expiresAt,
        },
        select: COLUNAS,
      });
      await tx.auditLog.create({
        data: auditData({
          tenantId: null,
          actorUserId: autor,
          entity: 'PLATAFORMA',
          entityId: criado.id,
          action: 'CONVITE_LABORATORIO_CRIADO',
          meta: { waitlist_entry_id: inscricaoId, expires_at: expiresAt, revogados },
        }),
      });
      return criado;
    });

    this.logger.log(`[CONVITE-LABORATORIO] criado ${linha.id} por ${autor || '?'}`);
    const [convite] = await this.montarItens([linha], agora);
    return { convite, codigo, link: linkDoConvite(codigo) };
  }

  /** Até 500 convites, do mais novo, sem o hash. */
  async listar(agora: Date = new Date()): Promise<ConviteLaboratorioItem[]> {
    const linhas = await this.prisma.labSignupInvite.findMany({
      orderBy: { created_at: 'desc' },
      take: 500,
      select: COLUNAS,
    });
    return this.montarItens(linhas, agora);
  }

  /** Revoga um convite que ainda não foi usado. Já revogado: devolve igual (sem auditoria nova). */
  async revogar(id: string, quem?: string | null): Promise<{ convite: ConviteLaboratorioItem }> {
    const agora = new Date();
    const r = await this.prisma.labSignupInvite.updateMany({
      where: { id, used_at: null, revoked_at: null },
      data: { revoked_at: agora },
    });
    const linha = await this.prisma.labSignupInvite.findUnique({ where: { id }, select: COLUNAS });
    if (!linha) throw new NotFoundException(LAB_CONVITE_MSG.conviteNaoEncontrado);
    if (r?.count === 1) {
      const autor = typeof quem === 'string' && quem ? quem : null;
      this.logger.log(`[CONVITE-LABORATORIO] revogado ${id} por ${autor || '?'}`);
      await registrarAuditoria(
        this.prisma,
        { tenantId: null, actorUserId: autor, entity: 'PLATAFORMA', entityId: id, action: 'CONVITE_LABORATORIO_REVOGADO' },
        this.logger,
      );
    } else if (linha.used_at) {
      throw new ConflictException(LAB_CONVITE_MSG.conviteJaUsado);
    }
    const [convite] = await this.montarItens([linha], agora);
    return { convite };
  }

  /** Acrescenta o nome da conta criada, o de quem convidou e a situação (1 leitura de cada). */
  private async montarItens(linhas: any[], agora: Date): Promise<ConviteLaboratorioItem[]> {
    const tenantIds = [...new Set(linhas.map((l) => l.tenant_id).filter((x): x is string => !!x))];
    const userIds = [...new Set(linhas.map((l) => l.created_by_user_id).filter((x): x is string => !!x))];
    const tenants = tenantIds.length
      ? await this.prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
      : [];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const nomeTenant = new Map((tenants || []).map((t) => [t.id, t.name] as const));
    const nomeUser = new Map((users || []).map((u) => [u.id, u.name] as const));
    return linhas.map((l) => ({
      id: l.id,
      email: l.email ?? null,
      lab_name: l.lab_name ?? null,
      waitlist_entry_id: l.waitlist_entry_id ?? null,
      created_by_user_id: l.created_by_user_id ?? null,
      criado_por_nome: (l.created_by_user_id && nomeUser.get(l.created_by_user_id)) || null,
      created_at: l.created_at,
      expires_at: l.expires_at,
      used_at: l.used_at ?? null,
      revoked_at: l.revoked_at ?? null,
      tenant_id: l.tenant_id ?? null,
      tenant_nome: (l.tenant_id && nomeTenant.get(l.tenant_id)) || null,
      situacao: situacaoDoConvite(l, agora),
    }));
  }
}
