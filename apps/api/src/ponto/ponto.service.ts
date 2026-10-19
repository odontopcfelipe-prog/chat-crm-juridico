import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeDay,
  computeMonth,
  DEFAULT_WEEKLY,
  isValidYm,
  maceioHhmm,
  maceioLocalToInstant,
  maceioYmd,
  monthRange,
  normalizeWeekly,
  type MonthTotals,
} from './ponto-calc';
import { evalGeo, isPublicIp, normalizeIp, type PontoLocal } from './ponto-geo';
import { ManualPunchDto, PontoConfigDto, PunchDto } from './ponto.dto';

// Config do ponto da clínica: um JSON em TenantSetting (sem tabela própria).
const CONFIG_KEY = 'PONTO_CONFIG';
// Duas batidas em menos de 1 min = clique duplo / reenvio — a 2ª é recusada.
const ANTI_DUPLO_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PontoConfig {
  local: PontoLocal | null;
  exigir_local: boolean;
  ips: string[];
  jornada_padrao: number[];
  /** Jornada própria por usuário (minutos por dia da semana, 0 = domingo). */
  jornadas: Record<string, number[]>;
}

type PunchRow = {
  id: string;
  user_id: string;
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

@Injectable()
export class PontoService {
  constructor(private prisma: PrismaService) {}

  // ─── Config ─────────────────────────────────────────────
  async getConfig(tenantId: string): Promise<PontoConfig> {
    const row = await this.prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key: CONFIG_KEY } },
    });
    let raw: any = {};
    try {
      raw = row?.value ? JSON.parse(row.value) : {};
    } catch {
      raw = {};
    }
    const l = raw.local;
    const local: PontoLocal | null =
      l && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng))
        ? { lat: Number(l.lat), lng: Number(l.lng), raio_m: Number(l.raio_m) || 150 }
        : null;
    const jornadas: Record<string, number[]> = {};
    for (const [uid, w] of Object.entries(raw.jornadas ?? {})) {
      const n = normalizeWeekly(w);
      if (n) jornadas[uid] = n;
    }
    return {
      local,
      exigir_local: !!raw.exigir_local,
      ips: Array.isArray(raw.ips) ? raw.ips.filter((ip: string) => isPublicIp(ip)) : [],
      jornada_padrao: normalizeWeekly(raw.jornada_padrao) ?? DEFAULT_WEEKLY,
      jornadas,
    };
  }

  private async writeConfig(tenantId: string, cfg: PontoConfig) {
    const value = JSON.stringify(cfg);
    await this.prisma.tenantSetting.upsert({
      where: { tenant_id_key: { tenant_id: tenantId, key: CONFIG_KEY } },
      create: { tenant_id: tenantId, key: CONFIG_KEY, value },
      update: { value },
    });
  }

  async adminConfig(tenantId: string, ip: string | null) {
    const cfg = await this.getConfig(tenantId);
    return { ...cfg, my_ip: ip, my_ip_publico: isPublicIp(ip) };
  }

  async saveConfig(tenantId: string, dto: PontoConfigDto, ip: string | null) {
    const cfg = await this.getConfig(tenantId);
    if (dto.local !== undefined) {
      cfg.local = dto.local ? { lat: dto.local.lat, lng: dto.local.lng, raio_m: dto.local.raio_m } : null;
    }
    if (dto.exigir_local !== undefined) cfg.exigir_local = dto.exigir_local;
    if (dto.ips !== undefined) {
      const ips = [...new Set(dto.ips.map((x) => normalizeIp(x)).filter((x): x is string => !!x))];
      const ruins = ips.filter((x) => !isPublicIp(x));
      if (ruins.length) {
        throw new BadRequestException(`IP interno ou inválido não pode ser usado como rede da clínica: ${ruins.join(', ')}`);
      }
      cfg.ips = ips;
    }
    if (dto.jornada_padrao !== undefined) {
      const n = normalizeWeekly(dto.jornada_padrao);
      if (!n) throw new BadRequestException('Jornada inválida (7 dias, de 0 a 24h).');
      cfg.jornada_padrao = n;
    }
    await this.writeConfig(tenantId, cfg);
    return this.adminConfig(tenantId, ip);
  }

  async saveUserSchedule(tenantId: string, userId: string, minutes: number[] | null | undefined) {
    await this.assertUser(tenantId, userId);
    const cfg = await this.getConfig(tenantId);
    if (minutes == null) {
      delete cfg.jornadas[userId];
    } else {
      const n = normalizeWeekly(minutes);
      if (!n) throw new BadRequestException('Jornada inválida (7 dias, de 0 a 24h).');
      cfg.jornadas[userId] = n;
    }
    await this.writeConfig(tenantId, cfg);
    return { user_id: userId, jornada: cfg.jornadas[userId] ?? null, jornada_padrao: cfg.jornada_padrao };
  }

  // ─── Bater o ponto ──────────────────────────────────────
  async punch(tenantId: string, userId: string, dto: PunchDto, ip: string | null, userAgent: string | null) {
    const user = await this.assertUser(tenantId, userId);
    const cfg = await this.getConfig(tenantId);

    const pos =
      Number.isFinite(dto.latitude) && Number.isFinite(dto.longitude)
        ? { latitude: dto.latitude as number, longitude: dto.longitude as number, accuracy: dto.accuracy ?? null }
        : null;
    const geo = evalGeo(pos, cfg.local, !!ip && cfg.ips.includes(ip));

    // Exigir o local só vale com alguma referência (local no mapa ou rede da clínica).
    const exige = cfg.exigir_local && (!!cfg.local || cfg.ips.length > 0);
    if (exige && geo.status !== 'NO_LOCAL' && geo.status !== 'REDE_CLINICA') {
      if (geo.status === 'FORA' && geo.distance_m != null && cfg.local) {
        throw new BadRequestException(
          `Você está a ${fmtDist(geo.distance_m)} da clínica (limite de ${cfg.local.raio_m} m). O ponto só pode ser registrado no local.`,
        );
      }
      throw new BadRequestException(
        cfg.local
          ? 'Ative a localização do aparelho para registrar o ponto — a clínica exige estar no local.'
          : 'O ponto só pode ser registrado pela rede (Wi-Fi) da clínica.',
      );
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
          user_name: user.name,
          punched_at: now,
          source: 'APP',
          latitude: pos?.latitude ?? null,
          longitude: pos?.longitude ?? null,
          accuracy_m: pos?.accuracy != null ? Math.round(pos.accuracy) : null,
          distance_m: geo.distance_m,
          geo_status: geo.status,
          ip,
          user_agent: userAgent ? userAgent.slice(0, 300) : null,
        },
      });
    });

    const today = await this.validPunchesOfDay(tenantId, userId, maceioYmd(created.punched_at));
    const kind = today.length % 2 === 1 ? 'ENTRADA' : 'SAIDA';
    return {
      kind,
      hora: maceioHhmm(created.punched_at),
      geo_status: created.geo_status,
      distance_m: created.distance_m,
    };
  }

  // ─── Meu ponto ──────────────────────────────────────────
  async me(tenantId: string, userId: string, ym?: string) {
    const user = await this.assertUser(tenantId, userId);
    const cfg = await this.getConfig(tenantId);
    const now = new Date();
    const todayYmd = maceioYmd(now);
    const month = isValidYm(ym ?? '') ? (ym as string) : todayYmd.slice(0, 7);

    const [espelho, todayRows, holidays] = await Promise.all([
      this.espelho(tenantId, userId, month, cfg),
      this.prisma.timeClockPunch.findMany({
        where: { tenant_id: tenantId, user_id: userId, ...this.dayWhere(todayYmd) },
        orderBy: { punched_at: 'asc' },
      }),
      this.holidaysOf(tenantId, todayYmd.slice(0, 7)),
    ]);
    const valid = todayRows.filter((r) => !r.voided_at);
    const todayCalc = computeDay({
      date: todayYmd,
      punches: valid.map((r) => r.punched_at),
      weekly: cfg.jornadas[userId] ?? cfg.jornada_padrao,
      holiday: holidays.get(todayYmd) ?? null,
      todayYmd,
      now,
      startYmd: todayYmd,
    });
    const names = await this.userNames(
      tenantId,
      todayRows.flatMap((r) => [r.created_by_id, r.voided_by_id]).filter((x): x is string => !!x),
    );
    let idx = 0;
    const todayPunches = todayRows.map((r) =>
      this.mapPunch(r, r.voided_at ? null : idx++ % 2 === 0 ? 'ENTRADA' : 'SAIDA', names),
    );

    return {
      server_now: now.toISOString(),
      today: todayYmd,
      user: { id: user.id, name: user.name },
      next: valid.length % 2 === 0 ? 'ENTRADA' : 'SAIDA',
      today_calc: todayCalc,
      today_punches: todayPunches,
      config: {
        local: cfg.local,
        exigir_local: cfg.exigir_local && (!!cfg.local || cfg.ips.length > 0),
        tem_rede: cfg.ips.length > 0,
      },
      espelho,
    };
  }

  // ─── Espelho do mês (funcionário ou gestor) ─────────────
  async espelho(tenantId: string, userId: string, ym: string, cfgIn?: PontoConfig) {
    if (!isValidYm(ym)) throw new BadRequestException('Mês inválido (AAAA-MM).');
    const cfg = cfgIn ?? (await this.getConfig(tenantId));
    const now = new Date();
    const { startUtc, endUtc } = monthRange(ym);

    const [rows, first, holidays] = await Promise.all([
      this.prisma.timeClockPunch.findMany({
        where: {
          tenant_id: tenantId,
          user_id: userId,
          punched_at: { gte: new Date(startUtc.getTime() - DAY_MS), lt: endUtc },
        },
        orderBy: { punched_at: 'asc' },
      }),
      this.prisma.timeClockPunch.findFirst({
        where: { tenant_id: tenantId, user_id: userId, voided_at: null },
        orderBy: { punched_at: 'asc' },
        select: { punched_at: true },
      }),
      this.holidaysOf(tenantId, ym),
    ]);

    const weekly = cfg.jornadas[userId] ?? cfg.jornada_padrao;
    const { days, totals } = computeMonth({
      ym,
      punches: rows.filter((r) => !r.voided_at).map((r) => r.punched_at),
      weekly,
      holidays,
      todayYmd: maceioYmd(now),
      now,
      startYmd: first ? maceioYmd(first.punched_at) : null,
    });

    const names = await this.userNames(
      tenantId,
      rows.flatMap((r) => [r.created_by_id, r.voided_by_id]).filter((x): x is string => !!x),
    );
    const byDay = new Map<string, PunchRow[]>();
    for (const r of rows) {
      const k = maceioYmd(r.punched_at);
      if (!k.startsWith(ym)) continue;
      const arr = byDay.get(k);
      if (arr) arr.push(r);
      else byDay.set(k, [r]);
    }

    return {
      ym,
      user_id: userId,
      jornada: weekly,
      jornada_propria: !!cfg.jornadas[userId],
      totals,
      days: days.map((d) => {
        let idx = 0;
        const punches = (byDay.get(d.date) ?? []).map((r) => {
          const kind = r.voided_at ? null : idx++ % 2 === 0 ? 'ENTRADA' : 'SAIDA';
          return this.mapPunch(r, kind, names);
        });
        return { ...d, punches };
      }),
    };
  }

  // ─── Equipe (gestor) ────────────────────────────────────
  async team(tenantId: string, ym?: string) {
    const now = new Date();
    const todayYmd = maceioYmd(now);
    const month = isValidYm(ym ?? '') ? (ym as string) : todayYmd.slice(0, 7);
    const cfg = await this.getConfig(tenantId);
    const { startUtc, endUtc } = monthRange(month);

    const [users, rows, firsts, holidays, todayRows] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenant_id: tenantId },
        select: { id: true, name: true, sector: true, roles: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.timeClockPunch.findMany({
        where: {
          tenant_id: tenantId,
          voided_at: null,
          punched_at: { gte: new Date(startUtc.getTime() - DAY_MS), lt: endUtc },
        },
        select: { user_id: true, user_name: true, punched_at: true, geo_status: true },
        orderBy: { punched_at: 'asc' },
      }),
      this.prisma.timeClockPunch.groupBy({
        by: ['user_id'],
        where: { tenant_id: tenantId, voided_at: null },
        _min: { punched_at: true },
      }),
      this.holidaysOf(tenantId, month),
      this.prisma.timeClockPunch.findMany({
        where: { tenant_id: tenantId, voided_at: null, ...this.dayWhere(todayYmd) },
        select: { user_id: true, punched_at: true },
        orderBy: { punched_at: 'asc' },
      }),
    ]);

    const firstBy = new Map(firsts.map((f) => [f.user_id, f._min.punched_at]));
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byUser.get(r.user_id);
      if (arr) arr.push(r);
      else byUser.set(r.user_id, [r]);
    }
    const todayBy = new Map<string, Date[]>();
    for (const r of todayRows) {
      const arr = todayBy.get(r.user_id);
      if (arr) arr.push(r.punched_at);
      else todayBy.set(r.user_id, [r.punched_at]);
    }

    // Usuários atuais (menos o SUPER_ADMIN do SaaS) + quem tem batida mas foi excluído.
    const people: { id: string; name: string; sector: string | null; removed: boolean }[] = users
      .filter((u) => !(u.roles || []).includes('SUPER_ADMIN') || byUser.has(u.id))
      .map((u) => ({ id: u.id, name: u.name, sector: u.sector, removed: false }));
    const known = new Set(people.map((p) => p.id));
    for (const [uid, list] of byUser) {
      if (!known.has(uid)) people.push({ id: uid, name: list[0].user_name, sector: null, removed: true });
    }

    const list = people.map((p) => {
      const mine = byUser.get(p.id) ?? [];
      const first = firstBy.get(p.id);
      const { totals } = computeMonth({
        ym: month,
        punches: mine.map((r) => r.punched_at),
        weekly: cfg.jornadas[p.id] ?? cfg.jornada_padrao,
        holidays,
        todayYmd,
        now,
        startYmd: first ? maceioYmd(first) : null,
      });
      const inMonth = mine.filter((r) => maceioYmd(r.punched_at).startsWith(month));
      const today = todayBy.get(p.id) ?? [];
      return {
        ...p,
        jornada: cfg.jornadas[p.id] ?? null,
        totals: totals as MonthTotals,
        punches_count: inMonth.length,
        fora_do_local: inMonth.filter((r) => r.geo_status === 'FORA').length,
        sem_gps: inMonth.filter((r) => r.geo_status === 'SEM_GPS').length,
        trabalhando_agora: today.length % 2 === 1,
        ultima_batida: today.length ? maceioHhmm(today[today.length - 1]) : null,
      };
    });

    return { ym: month, today: todayYmd, jornada_padrao: cfg.jornada_padrao, people: list };
  }

  // ─── Ajustes do gestor ──────────────────────────────────
  async addManual(tenantId: string, adminId: string, userId: string, dto: ManualPunchDto) {
    const user = await this.assertUser(tenantId, userId);
    const at = maceioLocalToInstant(dto.date, dto.time);
    if (Number.isNaN(at.getTime())) throw new BadRequestException('Data/hora inválida.');
    if (at.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('Não dá para lançar batida no futuro.');
    }
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

  // ─── Apoio ──────────────────────────────────────────────
  private async assertUser(tenantId: string, userId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, tenant_id: tenantId },
      select: { id: true, name: true },
    });
    if (!u) throw new NotFoundException('Usuário não encontrado nesta clínica.');
    return u;
  }

  /** Funcionário ativo OU excluído com batidas nesta clínica (o espelho continua acessível). */
  async assertPerson(tenantId: string, userId: string) {
    const u = await this.prisma.user.findFirst({ where: { id: userId, tenant_id: tenantId }, select: { id: true } });
    if (u) return;
    const p = await this.prisma.timeClockPunch.findFirst({
      where: { tenant_id: tenantId, user_id: userId },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Usuário não encontrado nesta clínica.');
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
   * Feriados do mês: os da clínica + os globais. `date` segue a convenção da agenda
   * (dia local nos componentes UTC); recorrente vale todo ano no mesmo dia/mês.
   */
  private async holidaysOf(tenantId: string, ym: string): Promise<Map<string, string>> {
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

  private mapPunch(r: PunchRow, kind: 'ENTRADA' | 'SAIDA' | null, names: Map<string, string>) {
    return {
      id: r.id,
      at: r.punched_at.toISOString(),
      hora: maceioHhmm(r.punched_at),
      kind,
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
  }
}

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`;
}
