import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeDay,
  computeMonth,
  holidaysForMonth,
  isValidYm,
  isValidYmd,
  maceioHhmm,
  maceioLocalToInstant,
  maceioYmd,
  monthRange,
  normalizeWeek,
  punchLabel,
  scheduleOn,
  type DayCalc,
  type MonthTotals,
  type ScheduleVersion,
  type WeekSchedule,
} from './ponto-calc';
import { coordsFromText, evalGeo, isGoogleMapsUrl, MAX_PRECISAO_M, type PontoLocal } from './ponto-geo';
import { CreateMemberDto, ManualPunchDto, PontoLocalDto, PunchDto, ScheduleDto, UpdateMemberDto } from './ponto.dto';

// Local base do ponto: JSON em TenantSetting ({ local: {lat, lng, raio_m} }).
const CONFIG_KEY = 'PONTO_CONFIG';
// Duas batidas em menos de 1 min = clique duplo / reenvio — a 2ª é recusada.
const ANTI_DUPLO_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type PunchRow = {
  id: string;
  user_id: string;
  user_name: string;
  punched_at: Date;
  source: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  distance_m: number | null;
  geo_status: string;
  note: string | null;
  created_by_id: string | null;
  voided_at: Date | null;
  voided_by_id: string | null;
  void_reason: string | null;
};

type MemberRow = {
  id: string;
  user_id: string;
  user_name: string;
  start_date: string;
  end_date: string | null;
  schedules: { valid_from: string; days: unknown; created_at: Date }[];
};

const fmtYmd = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`);

@Injectable()
export class PontoService {
  constructor(private prisma: PrismaService) {}

  // ─── Local base ─────────────────────────────────────────
  async getLocal(tenantId: string): Promise<PontoLocal | null> {
    const row = await this.prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key: CONFIG_KEY } },
    });
    try {
      const l = row?.value ? JSON.parse(row.value)?.local : null;
      if (l && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)) && Number(l.raio_m) > 0) {
        return { lat: Number(l.lat), lng: Number(l.lng), raio_m: Number(l.raio_m) };
      }
    } catch {
      /* config corrompida = sem local */
    }
    return null;
  }

  async saveLocal(tenantId: string, dto: PontoLocalDto) {
    const value = JSON.stringify({ local: { lat: dto.lat, lng: dto.lng, raio_m: dto.raio_m } });
    await this.prisma.tenantSetting.upsert({
      where: { tenant_id_key: { tenant_id: tenantId, key: CONFIG_KEY } },
      create: { tenant_id: tenantId, key: CONFIG_KEY, value },
      update: { value },
    });
    return this.getLocal(tenantId);
  }

  /**
   * Coordenadas de um link do Google Maps — inclusive o curto do "Compartilhar"
   * (maps.app.goo.gl), que o navegador não consegue abrir por causa do CORS. Segue
   * os redirecionamentos (só pra domínios do Google Maps, no máx. 6) e lê o PINO
   * (!3d/!4d) ou ponto explícito (?q=lat,lng) das URLs. Nunca o "centro da tela"
   * nem o HTML da página: lá vem o centro do mapa, que pode estar a centenas de
   * metros (com ele salvo, ninguém bate o ponto). Sem pino = recusa e explica.
   */
  async resolveMapLink(raw: string) {
    const url = String(raw ?? '').trim();
    // Link: só pino/ponto explícito (o "@" de um link é o centro da tela). Texto puro: números.
    const direct = coordsFromText(url, { strict: /^https?:\/\//i.test(url) });
    if (direct) return direct;
    if (!isGoogleMapsUrl(url)) {
      throw new BadRequestException('Cole um link do Google Maps (maps.app.goo.gl ou google.com/maps).');
    }
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let res: Response;
      try {
        res = await fetch(current, {
          redirect: 'manual',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (ponto; +https://sistema.institutoodontopassos.com.br)', 'Accept-Language': 'pt-BR' },
        });
      } catch {
        throw new BadRequestException('Não consegui abrir o link do Google Maps agora. Tente de novo ou cole as coordenadas.');
      } finally {
        clearTimeout(timer);
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, current).toString();
        const pin = coordsFromText(next, { strict: true });
        if (pin) return pin;
        if (!isGoogleMapsUrl(next)) break;
        current = next;
        continue;
      }
      break;
    }
    throw new BadRequestException(
      'Esse link não traz o ponto exato da clínica. No Google Maps, abra a clínica e use "Compartilhar", ou toque e segure em cima dela e copie os números que aparecem.',
    );
  }

  // ─── Equipe do ponto (adm) ──────────────────────────────
  async configView(tenantId: string) {
    const [local, members, users, tenant] = await Promise.all([
      this.getLocal(tenantId),
      this.prisma.timeClockMember.findMany({
        where: { tenant_id: tenantId },
        include: { schedules: { orderBy: { valid_from: 'desc' } } },
      }),
      this.prisma.user.findMany({
        where: { tenant_id: tenantId },
        select: { id: true, name: true, sector: true, roles: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { address: true, address_number: true, neighborhood: true, city: true, state: true },
      }),
    ]);
    const nameBy = new Map(users.map((u) => [u.id, u.name]));
    const today = maceioYmd(new Date());
    // Endereço cadastrado em Identidade da clínica: a tela busca por ele sozinha
    // (sugestões perto da cidade e, sem local salvo, já propõe o ponto).
    const t = tenant ?? null;
    const cidade = [t?.city, t?.state].filter(Boolean).join(' - ') || null;
    const endereco = t?.address ? [t.address, t.address_number, t.neighborhood, cidade].filter(Boolean).join(', ') : null;
    return {
      local,
      clinic_address: endereco,
      clinic_city: cidade,
      max_precisao_m: MAX_PRECISAO_M,
      today,
      members: members
        .map((m) => ({
          user_id: m.user_id,
          name: nameBy.get(m.user_id) ?? m.user_name,
          removed_user: !nameBy.has(m.user_id),
          start_date: m.start_date,
          end_date: m.end_date,
          active: today >= m.start_date && (!m.end_date || today <= m.end_date),
          schedules: m.schedules.map((s) => ({ valid_from: s.valid_from, days: this.parseDays(s.days) })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      users: users
        .filter((u) => !(u.roles || []).includes('SUPER_ADMIN'))
        .map((u) => ({ id: u.id, name: u.name, sector: u.sector })),
    };
  }

  async createMember(tenantId: string, adminId: string, dto: CreateMemberDto) {
    if (!isValidYmd(dto.start_date)) throw new BadRequestException('Data de início inválida.');
    const week = normalizeWeek(dto.days);
    if (!week.ok) throw new BadRequestException(week.error);
    const user = await this.assertUser(tenantId, dto.user_id);
    const exists = await this.prisma.timeClockMember.findUnique({
      where: { tenant_id_user_id: { tenant_id: tenantId, user_id: user.id } },
      select: { id: true },
    });
    if (exists) throw new BadRequestException(`${user.name} já está na equipe do ponto — edite o cadastro dele.`);
    await this.prisma.timeClockMember.create({
      data: {
        tenant_id: tenantId,
        user_id: user.id,
        user_name: user.name,
        start_date: dto.start_date,
        schedules: {
          create: { tenant_id: tenantId, valid_from: dto.start_date, days: week.value as any, created_by_id: adminId },
        },
      },
    });
    return this.configView(tenantId);
  }

  async updateMember(tenantId: string, userId: string, dto: UpdateMemberDto) {
    const m = await this.findMember(tenantId, userId);
    if (!m) throw new NotFoundException('Funcionário não está na equipe do ponto.');
    const start = dto.start_date ?? m.start_date;
    const end = dto.end_date === undefined ? m.end_date : dto.end_date;
    if (!isValidYmd(start)) throw new BadRequestException('Data de início inválida.');
    if (end != null && !isValidYmd(end)) throw new BadRequestException('Data de saída inválida.');
    if (end != null && end < start) throw new BadRequestException('O último dia não pode ser antes do início.');
    await this.prisma.timeClockMember.update({ where: { id: m.id }, data: { start_date: start, end_date: end } });
    return this.configView(tenantId);
  }

  async saveSchedule(tenantId: string, adminId: string, userId: string, dto: ScheduleDto) {
    const m = await this.findMember(tenantId, userId);
    if (!m) throw new NotFoundException('Funcionário não está na equipe do ponto.');
    if (!isValidYmd(dto.valid_from)) throw new BadRequestException('Data de vigência inválida.');
    const week = normalizeWeek(dto.days);
    if (!week.ok) throw new BadRequestException(week.error);
    await this.prisma.timeClockSchedule.upsert({
      where: { member_id_valid_from: { member_id: m.id, valid_from: dto.valid_from } },
      create: { tenant_id: tenantId, member_id: m.id, valid_from: dto.valid_from, days: week.value as any, created_by_id: adminId },
      update: { days: week.value as any, created_by_id: adminId },
    });
    return this.configView(tenantId);
  }

  async deleteSchedule(tenantId: string, userId: string, validFrom: string) {
    const m = await this.findMember(tenantId, userId);
    if (!m) throw new NotFoundException('Funcionário não está na equipe do ponto.');
    if (m.schedules.length <= 1) throw new BadRequestException('O funcionário precisa ter pelo menos um horário.');
    const s = m.schedules.find((x) => x.valid_from === validFrom);
    if (!s) throw new NotFoundException('Horário não encontrado.');
    await this.prisma.timeClockSchedule.delete({
      where: { member_id_valid_from: { member_id: m.id, valid_from: validFrom } },
    });
    return this.configView(tenantId);
  }

  // ─── Bater o ponto (funcionário) ────────────────────────
  async punch(tenantId: string, userId: string, dto: PunchDto, ip: string | null, userAgent: string | null) {
    const today = maceioYmd(new Date());
    const member = await this.findMember(tenantId, userId);
    if (!member) throw new ForbiddenException('Você não está na equipe do ponto. Fale com o administrador.');
    if (today < member.start_date) throw new ForbiddenException(`Seu ponto começa em ${fmtYmd(member.start_date)}.`);
    if (member.end_date && today > member.end_date) {
      throw new ForbiddenException('Seu ponto foi encerrado. Fale com o administrador.');
    }

    const local = await this.getLocal(tenantId);
    const pos =
      Number.isFinite(dto.latitude) && Number.isFinite(dto.longitude)
        ? { latitude: dto.latitude as number, longitude: dto.longitude as number, accuracy: dto.accuracy ?? null }
        : null;
    const geo = evalGeo(pos, local);
    if (geo.status !== 'NO_LOCAL') {
      const msg: Record<string, string> = {
        SEM_REF: 'O administrador ainda não cadastrou o local do ponto.',
        SEM_GPS: 'Ative a localização do aparelho e permita o acesso para registrar o ponto.',
        FORA: `Você está a ${fmtDist(geo.distance_m ?? 0)} da clínica (área de ${local?.raio_m ?? 0} m). O ponto só pode ser registrado no local.`,
        IMPRECISO:
          pos?.accuracy != null && pos.accuracy > 1000
            ? `Este aparelho está sem GPS (localização aproximada, ± ${fmtDist(pos.accuracy)}). Bata o ponto pelo celular, com a localização precisa ligada.`
            : `Sinal de GPS fraco${pos?.accuracy != null ? ` (± ${fmtDist(pos.accuracy)})` : ''}. Aguarde alguns segundos, de preferência perto de uma janela, e tente de novo.`,
      };
      throw new BadRequestException(msg[geo.status] ?? 'Localização inválida.');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // Uma batida por vez por funcionário (dois cliques ao mesmo tempo não viram duas).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), 31)`;
      const now = new Date();
      const last = await tx.timeClockPunch.findFirst({
        where: { tenant_id: tenantId, user_id: userId, voided_at: null },
        orderBy: { punched_at: 'desc' },
        select: { punched_at: true },
      });
      if (last && now.getTime() - last.punched_at.getTime() < ANTI_DUPLO_MS) {
        throw new BadRequestException(
          `Ponto já registrado às ${maceioHhmm(last.punched_at)}. Aguarde 1 minuto para registrar de novo.`,
        );
      }
      return tx.timeClockPunch.create({
        data: {
          tenant_id: tenantId,
          user_id: userId,
          user_name: member.user_name,
          punched_at: now,
          source: 'APP',
          latitude: pos!.latitude,
          longitude: pos!.longitude,
          accuracy_m: pos!.accuracy != null ? Math.round(pos!.accuracy) : null,
          distance_m: geo.distance_m,
          geo_status: geo.status,
          ip,
          user_agent: userAgent ? userAgent.slice(0, 300) : null,
        },
      });
    });

    const count = (await this.validPunchesOfDay(tenantId, userId, today)).length;
    const sched = scheduleOn(this.versionsOf(member), today);
    return {
      label: punchLabel(count - 1, !!sched?.break_start),
      hora: maceioHhmm(created.punched_at),
      distance_m: created.distance_m,
    };
  }

  // ─── Meu ponto (funcionário) ────────────────────────────
  async me(tenantId: string, userId: string, ym?: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenant_id: tenantId },
      select: { id: true, name: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado nesta clínica.');
    const now = new Date();
    const todayYmd = maceioYmd(now);
    const month = isValidYm(ym ?? '') ? (ym as string) : todayYmd.slice(0, 7);

    const [member, local, data] = await Promise.all([
      this.findMember(tenantId, userId),
      this.getLocal(tenantId),
      this.monthData(tenantId, month, userId),
    ]);
    const espelho = this.buildEspelho(month, userId, user.name, member, data.rows, data.clinicHol, data.names, now);

    const todayRows = await this.prisma.timeClockPunch.findMany({
      where: { tenant_id: tenantId, user_id: userId, ...this.dayWhere(todayYmd) },
      orderBy: { punched_at: 'asc' },
    });
    const todayHol = holidaysForMonth(todayYmd.slice(0, 7), await this.clinicHolidays(tenantId, todayYmd.slice(0, 7)));
    const sched = member ? scheduleOn(this.versionsOf(member), todayYmd) : null;
    const valid = todayRows.filter((r) => !r.voided_at);
    const todayCalc = computeDay({
      date: todayYmd,
      punches: valid.map((r) => r.punched_at),
      schedule: sched,
      holiday: todayHol.get(todayYmd) ?? null,
      todayYmd,
      now,
      startYmd: member?.start_date ?? null,
      endYmd: member?.end_date ?? null,
    });
    const names = await this.userNames(
      tenantId,
      todayRows.flatMap((r) => [r.created_by_id, r.voided_by_id]).filter((x): x is string => !!x),
    );
    const active = !!member && todayYmd >= member.start_date && (!member.end_date || todayYmd <= member.end_date);

    return {
      server_now: now.toISOString(),
      today: todayYmd,
      user: { id: user.id, name: user.name },
      member: member ? { start_date: member.start_date, end_date: member.end_date, active } : null,
      local,
      max_precisao_m: MAX_PRECISAO_M,
      today_schedule: sched,
      next_label: punchLabel(valid.length, !!sched?.break_start),
      next_is_entry: valid.length % 2 === 0,
      today_calc: todayCalc,
      today_punches: this.mapDayPunches(todayRows, !!sched?.break_start, names),
      espelho,
    };
  }

  /** Só pra mostrar/esconder atalhos (balão, menu). */
  async status(tenantId: string, userId: string) {
    const m = await this.findMember(tenantId, userId);
    const today = maceioYmd(new Date());
    return { member: !!m, active: !!m && today >= m.start_date && (!m.end_date || today <= m.end_date) };
  }

  // ─── Espelhos (adm) ─────────────────────────────────────
  async espelho(tenantId: string, userId: string, ym: string) {
    if (!isValidYm(ym)) throw new BadRequestException('Mês inválido (AAAA-MM).');
    const [user, member, data] = await Promise.all([
      this.prisma.user.findFirst({ where: { id: userId, tenant_id: tenantId }, select: { name: true } }),
      this.findMember(tenantId, userId),
      this.monthData(tenantId, ym, userId),
    ]);
    const anyPunch = user || member ? null : await this.prisma.timeClockPunch.findFirst({
      where: { tenant_id: tenantId, user_id: userId },
      select: { user_name: true },
    });
    if (!user && !member && !anyPunch) throw new NotFoundException('Usuário não encontrado nesta clínica.');
    const name = user?.name ?? member?.user_name ?? anyPunch!.user_name;
    return this.buildEspelho(ym, userId, name, member, data.rows, data.clinicHol, data.names, new Date());
  }

  /** Todos os espelhos do mês (pra contabilidade) — mesma conta do espelho individual. */
  async report(tenantId: string, ym?: string) {
    const now = new Date();
    const month = isValidYm(ym ?? '') ? (ym as string) : maceioYmd(now).slice(0, 7);
    const data = await this.monthData(tenantId, month);
    const people = this.peopleOfMonth(month, data);
    return {
      ym: month,
      today: maceioYmd(now),
      people: people.map((p) =>
        this.buildEspelho(month, p.user_id, p.name, p.member, data.rows, data.clinicHol, data.names, now),
      ),
    };
  }

  async team(tenantId: string, ym?: string) {
    const rep = await this.report(tenantId, ym);
    const todayRows = await this.prisma.timeClockPunch.findMany({
      where: { tenant_id: tenantId, voided_at: null, ...this.dayWhere(rep.today) },
      select: { user_id: true, punched_at: true },
      orderBy: { punched_at: 'asc' },
    });
    const todayBy = new Map<string, Date[]>();
    for (const r of todayRows) {
      const arr = todayBy.get(r.user_id);
      if (arr) arr.push(r.punched_at);
      else todayBy.set(r.user_id, [r.punched_at]);
    }
    return {
      ym: rep.ym,
      today: rep.today,
      people: rep.people.map((e) => {
        const today = todayBy.get(e.user_id) ?? [];
        return {
          user_id: e.user_id,
          name: e.name,
          member: e.member,
          totals: e.totals,
          punches_count: e.punches_count,
          adjustments: e.adjustments,
          alerts_count: e.days.reduce((s, d) => s + d.alerts.length, 0),
          trabalhando_agora: today.length % 2 === 1,
          ultima_batida: today.length ? maceioHhmm(today[today.length - 1]) : null,
        };
      }),
    };
  }

  // ─── Ajustes do adm ─────────────────────────────────────
  async addManual(tenantId: string, adminId: string, userId: string, dto: ManualPunchDto) {
    if (!isValidYmd(dto.date)) throw new BadRequestException('Data inválida.');
    const user = await this.assertUser(tenantId, userId);
    const at = maceioLocalToInstant(dto.date, dto.time);
    if (at.getTime() > Date.now() + 60_000) throw new BadRequestException('Não dá para lançar batida no futuro.');
    const minute = Math.floor(at.getTime() / 60000) * 60000;
    const dup = await this.prisma.timeClockPunch.findFirst({
      where: {
        tenant_id: tenantId,
        user_id: userId,
        voided_at: null,
        punched_at: { gte: new Date(minute), lt: new Date(minute + 60000) },
      },
      select: { id: true },
    });
    if (dup) throw new BadRequestException(`Já existe uma batida às ${dto.time} nesse dia.`);
    await this.prisma.timeClockPunch.create({
      data: {
        tenant_id: tenantId,
        user_id: userId,
        user_name: user.name,
        punched_at: at,
        source: 'MANUAL',
        geo_status: 'MANUAL',
        note: dto.note.trim(),
        created_by_id: adminId,
      },
    });
    return this.espelho(tenantId, userId, dto.date.slice(0, 7));
  }

  async voidPunch(tenantId: string, adminId: string, punchId: string, reason: string) {
    const p = await this.prisma.timeClockPunch.findFirst({
      where: { id: punchId, tenant_id: tenantId },
      select: { id: true, user_id: true, punched_at: true, voided_at: true },
    });
    if (!p) throw new NotFoundException('Batida não encontrada.');
    if (p.voided_at) throw new BadRequestException('Essa batida já foi anulada.');
    await this.prisma.timeClockPunch.update({
      where: { id: p.id },
      data: { voided_at: new Date(), voided_by_id: adminId, void_reason: reason.trim() },
    });
    return this.espelho(tenantId, p.user_id, maceioYmd(p.punched_at).slice(0, 7));
  }

  // ─── Montagem do espelho (uma regra só pra tudo) ────────
  private async monthData(tenantId: string, ym: string, onlyUserId?: string) {
    const { startUtc, endUtc } = monthRange(ym);
    const [members, rows, clinicHol] = await Promise.all([
      this.prisma.timeClockMember.findMany({
        where: { tenant_id: tenantId, ...(onlyUserId ? { user_id: onlyUserId } : {}) },
        include: { schedules: true },
      }),
      this.prisma.timeClockPunch.findMany({
        where: {
          tenant_id: tenantId,
          ...(onlyUserId ? { user_id: onlyUserId } : {}),
          punched_at: { gte: new Date(startUtc.getTime() - DAY_MS), lt: endUtc },
        },
        orderBy: { punched_at: 'asc' },
      }),
      this.clinicHolidays(tenantId, ym),
    ]);
    const names = await this.userNames(
      tenantId,
      rows.flatMap((r) => [r.created_by_id, r.voided_by_id]).filter((x): x is string => !!x),
    );
    const users = await this.prisma.user.findMany({
      where: { tenant_id: tenantId, id: { in: [...new Set([...members.map((m) => m.user_id), ...rows.map((r) => r.user_id)])] } },
      select: { id: true, name: true },
    });
    return { members: members as MemberRow[], rows: rows as PunchRow[], clinicHol, names, userNames: new Map(users.map((u) => [u.id, u.name])) };
  }

  /** Quem entra no mês: membro com período no mês + quem tem batida no mês. */
  private peopleOfMonth(ym: string, data: Awaited<ReturnType<PontoService['monthData']>>) {
    const { days } = monthRange(ym);
    const first = days[0];
    const last = days[days.length - 1];
    const out = new Map<string, { user_id: string; name: string; member: MemberRow | null }>();
    for (const m of data.members) {
      if (m.start_date <= last && (!m.end_date || m.end_date >= first)) {
        out.set(m.user_id, { user_id: m.user_id, name: data.userNames.get(m.user_id) ?? m.user_name, member: m });
      }
    }
    for (const r of data.rows) {
      if (!out.has(r.user_id) && maceioYmd(r.punched_at).startsWith(ym)) {
        const m = data.members.find((x) => x.user_id === r.user_id) ?? null;
        out.set(r.user_id, { user_id: r.user_id, name: data.userNames.get(r.user_id) ?? r.user_name, member: m });
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  private buildEspelho(
    ym: string,
    userId: string,
    name: string,
    member: MemberRow | null,
    allRows: PunchRow[],
    clinicHol: Map<string, string>,
    names: Map<string, string>,
    now: Date,
  ) {
    const rows = allRows.filter((r) => r.user_id === userId);
    const versions = member ? this.versionsOf(member) : [];
    const { days, totals } = computeMonth({
      ym,
      punches: rows.filter((r) => !r.voided_at).map((r) => r.punched_at),
      versions,
      holidays: clinicHol,
      todayYmd: maceioYmd(now),
      now,
      startYmd: member?.start_date ?? null,
      endYmd: member?.end_date ?? null,
    });
    const byDay = new Map<string, PunchRow[]>();
    for (const r of rows) {
      const k = maceioYmd(r.punched_at);
      if (!k.startsWith(ym)) continue;
      const arr = byDay.get(k);
      if (arr) arr.push(r);
      else byDay.set(k, [r]);
    }
    const inMonth = rows.filter((r) => maceioYmd(r.punched_at).startsWith(ym));
    return {
      ym,
      user_id: userId,
      name,
      member: member ? { start_date: member.start_date, end_date: member.end_date } : null,
      schedules: versions
        .filter((v) => v.valid_from <= `${ym}-31`)
        .sort((a, b) => b.valid_from.localeCompare(a.valid_from)),
      totals: totals as MonthTotals,
      punches_count: inMonth.filter((r) => !r.voided_at).length,
      adjustments: inMonth.filter((r) => r.source === 'MANUAL' || r.voided_at).length,
      days: days.map((d: DayCalc) => ({
        ...d,
        punches: this.mapDayPunches(byDay.get(d.date) ?? [], !!d.schedule?.break_start, names),
      })),
    };
  }

  private mapDayPunches(rows: PunchRow[], hasBreak: boolean, names: Map<string, string>) {
    let idx = 0;
    return rows.map((r) => {
      const label = r.voided_at ? null : punchLabel(idx, hasBreak);
      const kind = r.voided_at ? null : idx % 2 === 0 ? 'ENTRADA' : 'SAIDA';
      if (!r.voided_at) idx++;
      return {
        id: r.id,
        at: r.punched_at.toISOString(),
        hora: maceioHhmm(r.punched_at),
        kind,
        label,
        source: r.source,
        geo_status: r.geo_status,
        distance_m: r.distance_m,
        accuracy_m: r.accuracy_m,
        latitude: r.latitude,
        longitude: r.longitude,
        note: r.note,
        created_by: r.created_by_id ? names.get(r.created_by_id) ?? null : null,
        voided: !!r.voided_at,
        voided_at: r.voided_at ? r.voided_at.toISOString() : null,
        void_reason: r.void_reason,
        voided_by: r.voided_by_id ? names.get(r.voided_by_id) ?? null : null,
      };
    });
  }

  // ─── Apoio ──────────────────────────────────────────────
  private parseDays(raw: unknown): WeekSchedule {
    const w = normalizeWeek(raw);
    return w.ok ? w.value : [null, null, null, null, null, null, null];
  }

  private versionsOf(m: MemberRow): ScheduleVersion[] {
    return m.schedules.map((s) => ({ valid_from: s.valid_from, days: this.parseDays(s.days) }));
  }

  private findMember(tenantId: string, userId: string): Promise<MemberRow | null> {
    return this.prisma.timeClockMember.findUnique({
      where: { tenant_id_user_id: { tenant_id: tenantId, user_id: userId } },
      include: { schedules: true },
    }) as Promise<MemberRow | null>;
  }

  private async assertUser(tenantId: string, userId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, tenant_id: tenantId },
      select: { id: true, name: true },
    });
    if (!u) throw new NotFoundException('Usuário não encontrado nesta clínica.');
    return u;
  }

  private dayWhere(ymd: string) {
    const start = maceioLocalToInstant(ymd, '00:00');
    return { punched_at: { gte: start, lt: new Date(start.getTime() + DAY_MS) } };
  }

  private async validPunchesOfDay(tenantId: string, userId: string, ymd: string): Promise<Date[]> {
    const rows = await this.prisma.timeClockPunch.findMany({
      where: { tenant_id: tenantId, user_id: userId, voided_at: null, ...this.dayWhere(ymd) },
      select: { punched_at: true },
      orderBy: { punched_at: 'asc' },
    });
    return rows.map((r) => r.punched_at);
  }

  /**
   * Feriados da CLÍNICA no mês (os da clínica + os globais da tabela Holiday). Os
   * nacionais entram no cálculo (holidaysForMonth). `date` segue a convenção da
   * agenda (dia local nos componentes UTC); recorrente vale todo ano.
   */
  private async clinicHolidays(tenantId: string, ym: string): Promise<Map<string, string>> {
    const rows = await this.prisma.holiday.findMany({
      where: { OR: [{ tenant_id: tenantId }, { tenant_id: null }] },
      select: { date: true, name: true, recurring_yearly: true },
    });
    const [y, m] = ym.split('-');
    const map = new Map<string, string>();
    for (const r of rows) {
      const iso = r.date.toISOString().slice(0, 10);
      const name = r.name || 'Feriado';
      if (r.recurring_yearly) {
        if (iso.slice(5, 7) === m) map.set(`${y}-${iso.slice(5)}`, name);
      } else if (iso.startsWith(ym)) {
        map.set(iso, name);
      }
    }
    return map;
  }

  private async userNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniq }, tenant_id: tenantId },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
