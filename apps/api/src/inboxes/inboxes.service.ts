import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Quem está chamando: a clínica do JWT. SUPER_ADMIN mexe em qualquer clínica. */
export type InboxCaller = { tenantId: string | null | undefined; isSuperAdmin?: boolean };

@Injectable()
export class InboxesService {
  constructor(private prisma: PrismaService) {}

  private get inbox() {
    return (this.prisma as any).inbox;
  }

  private get instance() {
    return (this.prisma as any).instance;
  }

  async findAllOperators(tenantId?: string) {
    // Fail-closed: sem tenant no JWT não lista ninguém (antes vazava setores e
    // usuários de TODAS as clínicas no modal de transferência).
    if (!tenantId) return [];
    const [inboxes, allEligible, allOperators] = await Promise.all([
      this.inbox.findMany({
        where: { tenant_id: tenantId, is_active: true },
        include: { users: { where: { tenant_id: tenantId }, select: { id: true, name: true } } },
        orderBy: { name: 'asc' },
      }),
      (this.prisma as any).user.findMany({
        where: { tenant_id: tenantId, roles: { hasSome: ['OPERADOR', 'DENTIST', 'ADMIN', 'COMERCIAL', 'FINANCEIRO', 'ASSISTANT'] } },
        select: { id: true, name: true, roles: true },
        orderBy: { name: 'asc' },
      }),
      (this.prisma as any).user.findMany({
        where: { tenant_id: tenantId, roles: { has: 'OPERADOR' } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const inboxUserIds = new Set(inboxes.flatMap((i: any) => (i.users || []).map((u: any) => u.id)));

    // Operadores sem inbox → injetar no primeiro inbox (se existir)
    const operatorsNotInInbox = (allOperators as { id: string; name: string }[]).filter(
      u => !inboxUserIds.has(u.id),
    );

    // Tipo preservado ('INBOX' | 'SECTOR') para compatibilidade com TransferModals.
    // Inboxes com auto_route=true são expostos como SECTOR para manter a UX especial
    // (ícone ⚖️, IA sugere especialista). Inboxes comuns viram INBOX.
    const inboxGroups = inboxes.map((inbox: any, idx: number) => ({
      id: inbox.id,
      name: inbox.name,
      type: inbox.auto_route ? ('SECTOR' as const) : ('INBOX' as const),
      auto_route: inbox.auto_route ?? false,
      users: idx === 0
        ? [...(inbox.users as { id: string; name: string }[]), ...operatorsNotInInbox]
        : (inbox.users as { id: string; name: string }[]),
    }));

    // Equipe: usuários elegíveis sem inbox e que não são OPERADOR (esses já foram injetados acima)
    const operatorIds = new Set((allOperators as any[]).map((u: any) => u.id));
    const ungroupedUsers = (allEligible as { id: string; name: string }[]).filter(
      u => !inboxUserIds.has(u.id) && !operatorIds.has(u.id),
    );

    const result: any[] = [...inboxGroups];

    if (ungroupedUsers.length > 0) {
      result.push({
        id: '__team__',
        name: 'Equipe',
        type: 'SECTOR' as const,
        auto_route: false,
        users: ungroupedUsers,
      });
    }

    return result;
  }

  async findAll(tenantId?: string, userId?: string) {
    return this.inbox.findMany({
      where: {
        tenant_id: tenantId,
        users: userId ? { some: { id: userId } } : undefined
      },
      include: {
        instances: true,
        users: { select: { id: true, name: true, email: true } },
        _count: {
          select: { users: true, conversations: true }
        }
      },
      orderBy: { name: 'asc' }
    });
  }

  /**
   * Setor (inbox) só é lido/alterado pela clínica dele — mesmo critério da lista
   * (findAll filtra tenant_id = clínica do JWT). De outra clínica = "não encontrada".
   */
  private async assertInboxDoChamador(inboxId: string, caller?: InboxCaller) {
    const inbox = await this.inbox.findUnique({ where: { id: inboxId }, select: { id: true, tenant_id: true } });
    if (!inbox) throw new NotFoundException('Inbox não encontrada');
    if (caller && !caller.isSuperAdmin && (inbox.tenant_id ?? null) !== (caller.tenantId ?? null)) {
      throw new NotFoundException('Inbox não encontrada');
    }
    return inbox as { id: string; tenant_id: string | null };
  }

  /** Chip de outra clínica não entra em setor desta (nem por createFull nem por addInstance). */
  private assertChipLivreParaClinica(existing: { tenant_id?: string | null } | null, tenantId: string | null | undefined) {
    if (existing?.tenant_id && existing.tenant_id !== (tenantId ?? null)) {
      throw new ConflictException('Esta instância pertence a outra clínica.');
    }
  }

  async findOne(id: string, caller?: InboxCaller) {
    if (caller) await this.assertInboxDoChamador(id, caller);
    const inbox = await this.inbox.findUnique({
      where: { id },
      include: {
        instances: true,
        users: { select: { id: true, name: true, email: true } }
      }
    });

    if (!inbox) throw new NotFoundException('Inbox não encontrada');
    return inbox;
  }

  async create(data: { name: string; color?: string | null; auto_route?: boolean; tenant_id?: string }) {
    return this.inbox.create({
      data,
      include: {
        instances: true,
        users: { select: { id: true, name: true, email: true } },
        _count: {
          select: { users: true, conversations: true }
        }
      }
    });
  }

  async update(id: string, data: { name?: string; color?: string | null; auto_route?: boolean }, caller?: InboxCaller) {
    if (caller) await this.assertInboxDoChamador(id, caller);
    return this.inbox.update({
      where: { id },
      data,
      include: {
        instances: true,
        users: { select: { id: true, name: true, email: true } },
      }
    });
  }

  async remove(id: string, caller?: InboxCaller) {
    if (caller) await this.assertInboxDoChamador(id, caller);
    await Promise.all([
      (this.prisma as any).conversation.updateMany({
        where: { inbox_id: id },
        data: { inbox_id: null },
      }),
      (this.prisma as any).instance.updateMany({
        where: { inbox_id: id },
        data: { inbox_id: null },
      }),
    ]);
    return this.inbox.delete({ where: { id } });
  }

  // --- Gestão de Usuários no Setor ---

  async addUser(inboxId: string, userId: string, caller?: InboxCaller) {
    if (caller) {
      const inbox = await this.assertInboxDoChamador(inboxId, caller);
      // Só gente da clínica do setor entra nele.
      const user = await (this.prisma as any).user.findUnique({ where: { id: userId }, select: { tenant_id: true } });
      if (!user || (user.tenant_id ?? null) !== (inbox.tenant_id ?? null)) {
        throw new NotFoundException('Usuário não encontrado');
      }
    }
    return this.inbox.update({
      where: { id: inboxId },
      data: {
        users: { connect: { id: userId } }
      }
    });
  }

  async removeUser(inboxId: string, userId: string, caller?: InboxCaller) {
    if (caller) await this.assertInboxDoChamador(inboxId, caller);
    return this.inbox.update({
      where: { id: inboxId },
      data: {
        users: { disconnect: { id: userId } }
      }
    });
  }

  // --- Gestão de Instâncias ---

  async addInstance(inboxId: string, instanceName: string, type: 'whatsapp' | 'instagram', caller?: InboxCaller) {
    if (caller) await this.assertInboxDoChamador(inboxId, caller);
    const existing = await this.instance.findUnique({ where: { name: instanceName } });
    if (existing?.inbox_id && existing.inbox_id !== inboxId) {
      const otherInbox = await this.inbox.findUnique({ where: { id: existing.inbox_id }, select: { name: true } });
      throw new ConflictException(
        `A instância "${instanceName}" já está vinculada ao setor "${otherInbox?.name ?? existing.inbox_id}". Remova-a de lá primeiro.`
      );
    }

    const parentInbox = await this.inbox.findUnique({
      where: { id: inboxId },
      select: { tenant_id: true },
    });
    if (!parentInbox) throw new NotFoundException(`Inbox ${inboxId} não encontrado`);
    this.assertChipLivreParaClinica(existing, parentInbox.tenant_id);
    const instance = await this.instance.upsert({
      where: { name: instanceName },
      update: {
        inbox_id: inboxId,
        type,
        ...(parentInbox.tenant_id ? { tenant_id: parentInbox.tenant_id } : {}),
      },
      create: {
        name: instanceName,
        type,
        inbox_id: inboxId,
        tenant_id: parentInbox.tenant_id,
      }
    });

    // Conversas antigas desta instância passam a aparecer no novo setor.
    // Também faz backfill de tenant_id quando null — conversas criadas antes do vínculo
    // ficavam com tenant=null (porque a Instance não tinha tenant na época) e eram
    // filtradas por /conversations (que sempre aplica where.tenant_id = tenantId).
    await (this.prisma as any).conversation.updateMany({
      where: {
        instance_name: instanceName,
        ...(parentInbox.tenant_id ? { OR: [{ tenant_id: parentInbox.tenant_id }, { tenant_id: null }] } : {}),
      },
      data: { inbox_id: inboxId },
    });
    if (parentInbox.tenant_id) {
      await (this.prisma as any).conversation.updateMany({
        where: { instance_name: instanceName, tenant_id: null },
        data: { tenant_id: parentInbox.tenant_id },
      });
      await (this.prisma as any).lead.updateMany({
        where: {
          tenant_id: null,
          conversations: { some: { instance_name: instanceName } },
        },
        data: { tenant_id: parentInbox.tenant_id },
      });
    }

    return instance;
  }

  /** Desvincula a instância do setor sem apagá-la (fica órfã). */
  async removeInstance(inboxId: string, instanceName: string, caller?: InboxCaller) {
    if (caller) await this.assertInboxDoChamador(inboxId, caller);
    const existing = await this.instance.findUnique({ where: { name: instanceName } });
    if (!existing || existing.inbox_id !== inboxId) {
      throw new NotFoundException('Instância não está vinculada a este setor');
    }
    return this.instance.update({
      where: { name: instanceName },
      data: { inbox_id: null },
    });
  }

  /**
   * Cria um Setor completo de forma atômica (nome, cor, auto_route, instância opcional e operadores).
   * Usado pelo modal unificado de criação na UI de Setores.
   */
  async createFull(params: {
    name: string;
    color?: string | null;
    autoRoute?: boolean;
    instanceName?: string | null;
    instanceType?: 'whatsapp' | 'instagram';
    operatorIds?: string[];
    tenant_id?: string;
  }) {
    const { name, color, autoRoute, instanceName, instanceType = 'whatsapp', operatorIds = [], tenant_id } = params;

    if (instanceName) {
      const existing = await this.instance.findUnique({ where: { name: instanceName } });
      this.assertChipLivreParaClinica(existing, tenant_id);
      if (existing?.inbox_id) {
        const other = await this.inbox.findUnique({ where: { id: existing.inbox_id }, select: { name: true } });
        throw new ConflictException(
          `A instância "${instanceName}" já está vinculada ao setor "${other?.name ?? existing.inbox_id}".`
        );
      }
    }

    // Operadores só da clínica do setor (a tela já lista só os dela).
    const operadores: string[] = operatorIds.length
      ? (await (this.prisma as any).user.findMany({
          where: { id: { in: operatorIds }, tenant_id: tenant_id ?? null },
          select: { id: true },
        })).map((u: { id: string }) => u.id)
      : [];

    return (this.prisma as any).$transaction(async (tx: any) => {
      const created = await tx.inbox.create({
        data: {
          name,
          color: color ?? null,
          auto_route: autoRoute ?? false,
          tenant_id,
          users: operadores.length > 0 ? { connect: operadores.map(id => ({ id })) } : undefined,
        },
      });

      if (instanceName) {
        await tx.instance.upsert({
          where: { name: instanceName },
          update: {
            inbox_id: created.id,
            type: instanceType,
            ...(tenant_id ? { tenant_id } : {}),
          },
          create: {
            name: instanceName,
            type: instanceType,
            inbox_id: created.id,
            tenant_id,
          },
        });

        await tx.conversation.updateMany({
          where: {
            instance_name: instanceName,
            ...(tenant_id ? { OR: [{ tenant_id }, { tenant_id: null }] } : {}),
          },
          data: { inbox_id: created.id },
        });
        // Backfill tenant_id em conversas/leads criados antes do vínculo
        if (tenant_id) {
          await tx.conversation.updateMany({
            where: { instance_name: instanceName, tenant_id: null },
            data: { tenant_id },
          });
          await tx.lead.updateMany({
            where: {
              tenant_id: null,
              conversations: { some: { instance_name: instanceName } },
            },
            data: { tenant_id },
          });
        }
      }

      return tx.inbox.findUnique({
        where: { id: created.id },
        include: {
          instances: true,
          users: { select: { id: true, name: true, email: true } },
          _count: { select: { users: true, conversations: true } },
        },
      });
    });
  }

  async findByInstanceName(instanceName: string) {
    return this.instance.findUnique({
      where: { name: instanceName },
      include: { inbox: true }
    });
  }

  /**
   * Round-robin: retorna o ID do próximo operador do inbox.
   * Usa $transaction para evitar double-assign em chamadas paralelas.
   * Retorna null se o inbox não tiver operadores cadastrados.
   *
   * @param onlineUserIds Se fornecido, filtra apenas operadores online.
   *                      Retorna null se nenhum operador online estiver no inbox.
   */
  async getNextAssignee(inboxId: string, onlineUserIds?: string[]): Promise<string | null> {
    return (this.prisma as any).$transaction(async (tx: any) => {
      const inbox = await tx.inbox.findUnique({
        where: { id: inboxId },
        include: { users: { select: { id: true }, orderBy: { id: 'asc' } } },
      });

      if (!inbox?.users?.length) return null;

      let users: { id: string }[] = inbox.users;
      if (onlineUserIds) {
        users = users.filter((u: any) => onlineUserIds.includes(u.id));
        if (users.length === 0) return null;
      }

      const currentIdx = inbox.rr_pointer
        ? users.findIndex((u: any) => u.id === inbox.rr_pointer)
        : -1;
      const nextIdx = (currentIdx + 1) % users.length;
      const nextUser = users[nextIdx];

      await tx.inbox.update({
        where: { id: inboxId },
        data: { rr_pointer: nextUser.id },
      });

      return nextUser.id;
    });
  }
}
