import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { mapBackendRole } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { isOwnPatient, restrictedPatientOwner } from '../auth/patient-scope';
import { TEAM_CHANNELS, canUseChannel, dmChannel, dmPeer, parseChannel, type TeamChannel } from './team-chat-channels';
import { SendTeamMessageDto } from './team-chat.dto';

// Não lida conta no máximo as duas últimas semanas — quem nunca abriu o canal do
// próprio setor não começa com centenas de mensagens antigas.
const UNREAD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PAGE = 50;

type Pessoa = { id: string; name: string; sector: string | null; roles: string[] };

function setorDe(u: { sector?: string | null; roles?: string[] | null } | undefined): string {
  return (u?.sector as string) || mapBackendRole(u?.roles ?? []);
}

function depois(a: Date | undefined, b: Date): Date {
  return a && a > b ? a : b;
}

@Injectable()
export class TeamChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
  ) {}

  private canal(raw: string, userId: string): TeamChannel {
    const ch = parseChannel(raw);
    if (!ch) throw new BadRequestException('Canal inválido');
    if (!canUseChannel(ch, userId)) throw new ForbiddenException('Conversa privada');
    return ch;
  }

  /** Lista do botão Equipe: canais e pessoas, com não lidas e online. */
  async overview(tenantId: string, userId: string) {
    const users: Pessoa[] = await this.prisma.user.findMany({
      where: { tenant_id: tenantId },
      select: { id: true, name: true, sector: true, roles: true },
      orderBy: { name: 'asc' },
    });
    const meuSetor = setorDe(users.find((u) => u.id === userId));
    const reads = await this.prisma.teamChannelRead.findMany({
      where: { tenant_id: tenantId, user_id: userId },
      select: { channel: true, last_read_at: true },
    });
    const lidoAte = new Map(reads.map((r) => [r.channel, r.last_read_at]));
    const desde = new Date(Date.now() - UNREAD_WINDOW_MS);
    const minhasDms = [
      { channel: { startsWith: `dm:${userId}:` } },
      { channel: { endsWith: `:${userId}` } },
    ];

    // Acompanha: Geral, o canal do próprio setor e os que já abriu (tem leitura).
    const acompanha = new Set<string>(['geral', meuSetor]);
    for (const r of reads) if (!r.channel.startsWith('dm:')) acompanha.add(r.channel);
    const dmsLidas = reads.filter((r) => r.channel.startsWith('dm:')).map((r) => r.channel);

    const naoLidas = await this.prisma.teamMessage.groupBy({
      by: ['channel'],
      where: {
        tenant_id: tenantId,
        sender_id: { not: userId },
        OR: [
          ...[...acompanha, ...dmsLidas].map((c) => ({ channel: c, created_at: { gt: depois(lidoAte.get(c), desde) } })),
          { AND: [{ OR: minhasDms }, { channel: { notIn: dmsLidas } }, { created_at: { gt: desde } }] },
        ],
      },
      _count: { _all: true },
    });
    const ultimas = await this.prisma.teamMessage.groupBy({
      by: ['channel'],
      where: { tenant_id: tenantId, OR: [{ channel: { in: [...TEAM_CHANNELS] } }, ...minhasDms] },
      _max: { created_at: true },
    });
    const nl = new Map(naoLidas.map((r) => [r.channel, r._count._all]));
    const ult = new Map(ultimas.map((r) => [r.channel, r._max.created_at]));

    const channels = TEAM_CHANNELS.map((id) => ({
      id,
      unread: nl.get(id) ?? 0,
      following: acompanha.has(id),
      mine: id === meuSetor,
      last_at: ult.get(id) ?? null,
    }));
    const people = users
      .filter((u) => u.id !== userId)
      .map((u) => {
        const channel = dmChannel(userId, u.id);
        return {
          id: u.id,
          name: u.name,
          sector: setorDe(u),
          online: this.gateway.isUserOnline(u.id),
          channel,
          unread: nl.get(channel) ?? 0,
          last_at: ult.get(channel) ?? null,
        };
      });
    const total = channels.reduce((s, c) => s + c.unread, 0) + people.reduce((s, p) => s + p.unread, 0);
    return { me: { id: userId, sector: meuSetor }, channels, people, total_unread: total };
  }

  /** Mensagens do canal, da mais antiga pra mais nova; `before` pagina pra trás. */
  async messages(tenantId: string, userId: string, rawChannel: string, before?: string) {
    const ch = this.canal(rawChannel, userId);
    const antesDe = before ? new Date(before) : null;
    if (antesDe && Number.isNaN(antesDe.getTime())) throw new BadRequestException('Data inválida');
    const rows = await this.prisma.teamMessage.findMany({
      where: { tenant_id: tenantId, channel: ch.id, ...(antesDe ? { created_at: { lt: antesDe } } : {}) },
      orderBy: { created_at: 'desc' },
      take: PAGE,
    });
    const autores = await this.autores(tenantId, rows.map((r) => r.sender_id));
    return {
      messages: rows.reverse().map((r) => this.formatar(r, autores)),
      has_more: rows.length === PAGE,
    };
  }

  async send(tenantId: string, userId: string, dto: SendTeamMessageDto) {
    const ch = this.canal(dto.channel, userId);
    const text = (dto.text ?? '').trim();
    if (!text && !dto.patient_id) throw new BadRequestException('Escreva a mensagem');

    const peer = dmPeer(ch, userId);
    if (peer) {
      const existe = await this.prisma.user.findFirst({ where: { id: peer, tenant_id: tenantId }, select: { id: true } });
      if (!existe) throw new NotFoundException('Pessoa não encontrada');
    }

    let patient: { id: string; name: string } | null = null;
    if (dto.patient_id) {
      patient = await this.prisma.patient.findFirst({
        where: { id: dto.patient_id, tenant_id: tenantId },
        select: { id: true, name: true },
      });
      if (!patient) throw new NotFoundException('Paciente não encontrado');
      // Quem só vê a própria carteira (dentista) só anexa paciente dele.
      const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });
      const owner = await restrictedPatientOwner(this.prisma, { id: userId, roles: me?.roles ?? [] });
      if (owner && !(await isOwnPatient(this.prisma, tenantId, owner, patient.id))) {
        throw new ForbiddenException('Paciente fora da sua carteira');
      }
    }

    const row = await this.prisma.teamMessage.create({
      data: {
        tenant_id: tenantId,
        channel: ch.id,
        sender_id: userId,
        text,
        patient_id: patient?.id ?? null,
        patient_name: patient?.name ?? null,
      },
    });
    // Quem escreve leu o canal (e passa a acompanhar).
    await this.marcarLido(tenantId, userId, ch.id, row.created_at);

    const autores = await this.autores(tenantId, [userId]);
    const msg = this.formatar(row, autores);
    this.gateway.emitTeamMessage(tenantId, msg, ch.kind === 'dm' ? ch.users : undefined);
    return msg;
  }

  async read(tenantId: string, userId: string, rawChannel: string) {
    const ch = this.canal(rawChannel, userId);
    await this.marcarLido(tenantId, userId, ch.id, new Date());
    return { ok: true };
  }

  private marcarLido(tenantId: string, userId: string, channel: string, at: Date) {
    return this.prisma.teamChannelRead.upsert({
      where: { user_id_channel: { user_id: userId, channel } },
      create: { tenant_id: tenantId, user_id: userId, channel, last_read_at: at },
      update: { last_read_at: at },
    });
  }

  private async autores(tenantId: string, ids: string[]) {
    const unicos = [...new Set(ids)];
    if (!unicos.length) return new Map<string, Pessoa>();
    const us: Pessoa[] = await this.prisma.user.findMany({
      where: { id: { in: unicos }, tenant_id: tenantId },
      select: { id: true, name: true, sector: true, roles: true },
    });
    return new Map(us.map((u) => [u.id, u]));
  }

  private formatar(
    r: { id: string; channel: string; sender_id: string; text: string; patient_id: string | null; patient_name: string | null; created_at: Date },
    autores: Map<string, Pessoa>,
  ) {
    const a = autores.get(r.sender_id);
    return {
      id: r.id,
      channel: r.channel,
      sender_id: r.sender_id,
      sender_name: a?.name ?? 'Ex-colaborador',
      sender_sector: a ? setorDe(a) : null,
      text: r.text,
      patient: r.patient_id ? { id: r.patient_id, name: r.patient_name ?? 'Paciente' } : null,
      created_at: r.created_at,
    };
  }
}
