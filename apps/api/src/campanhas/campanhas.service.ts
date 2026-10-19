import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CAMPANHA_MAX_DESTINATARIOS,
  CAMPANHA_MAX_MIDIAS,
  CAMPANHA_MAX_TEXTO,
  CAMPANHA_MIDIA_LIMITE_BYTES,
  campanhaMidiaTipo,
  estimativaCampanha,
  isCampanhaSetor,
  normalizarFiltros,
  type CampanhaFiltros,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../media/filesystem.service';
import { CampanhasEnvioService } from './campanhas-envio.service';
import {
  MOTIVO_FORA_LABEL,
  aniversarianteDoMes,
  motivoFora,
  wherePublico,
  type MotivoFora,
  type PacientePublico,
} from './campanhas-publico';

const EXT_POR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mp4': 'm4a',
  'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/webm': 'webm', 'video/webm': 'webm', 'video/mp4': 'mp4',
};

/**
 * Campanha MANUAL (Central de Disparos › setor › "Campanha manual"). O ADM monta um
 * RASCUNHO (nome, setor/chip, filtros de pacientes, texto, até 3 fotos/áudios), testa no
 * próprio número e INICIA (agora ou agendada) — aí a lista de destinatários é CONGELADA em
 * ManualCampaignItem e o motor (CampanhasEnvioService) envia no ritmo seguro.
 * Tudo escopado por tenant; só ADMIN (controller).
 */
@Injectable()
export class CampanhasService {
  private readonly logger = new Logger(CampanhasService.name);

  constructor(
    private prisma: PrismaService,
    private files: FileStorageService,
    private envio: CampanhasEnvioService,
  ) {}

  private async daClinica(tenantId: string, id: string) {
    const c = await this.prisma.manualCampaign.findFirst({ where: { id, tenant_id: tenantId } });
    if (!c) throw new NotFoundException('Campanha não encontrada');
    return c;
  }

  private exigeRascunho(c: { status: string }) {
    if (c.status !== 'RASCUNHO') throw new BadRequestException('Só dá pra mudar a campanha enquanto ela é rascunho');
  }

  async listar(tenantId: string, setor?: string) {
    return this.prisma.manualCampaign.findMany({
      where: { tenant_id: tenantId, ...(isCampanhaSetor(setor) ? { setor } : {}) },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true, name: true, setor: true, status: true, total: true, sent_count: true, failed_count: true,
        skipped_count: true, scheduled_for: true, started_at: true, completed_at: true, created_at: true, pause_reason: true,
      },
    });
  }

  async detalhe(tenantId: string, id: string) {
    const c = await this.daClinica(tenantId, id);
    const [media, porStatus] = await Promise.all([
      this.prisma.manualCampaignMedia.findMany({
        where: { campaign_id: id },
        orderBy: { position: 'asc' },
        select: { id: true, kind: true, mime_type: true, size: true, original_name: true, position: true },
      }),
      this.prisma.manualCampaignItem.groupBy({ by: ['status'], where: { campaign_id: id }, _count: { _all: true } }),
    ]);
    const contagem = Object.fromEntries(porStatus.map((r) => [r.status, r._count._all]));
    return { ...c, media, contagem };
  }

  async criar(tenantId: string, userId: string | undefined, body: any) {
    const setor = isCampanhaSetor(body?.setor) ? body.setor : 'CLINICA';
    return this.prisma.manualCampaign.create({
      data: {
        tenant_id: tenantId,
        name: String(body?.name || '').trim().slice(0, 120) || 'Nova campanha',
        setor,
        text: String(body?.text || '').slice(0, CAMPANHA_MAX_TEXTO),
        filters_json: normalizarFiltros(body?.filters) as any,
        created_by_id: userId || null,
      },
    });
  }

  async atualizar(tenantId: string, id: string, body: any) {
    const c = await this.daClinica(tenantId, id);
    this.exigeRascunho(c);
    const data: any = {};
    if (body?.name !== undefined) data.name = String(body.name || '').trim().slice(0, 120) || c.name;
    if (body?.setor !== undefined) {
      if (!isCampanhaSetor(body.setor)) throw new BadRequestException('Setor inválido');
      data.setor = body.setor;
    }
    if (body?.text !== undefined) {
      const t = String(body.text || '');
      if (t.length > CAMPANHA_MAX_TEXTO) throw new BadRequestException(`Mensagem muito longa (máx. ${CAMPANHA_MAX_TEXTO} caracteres)`);
      data.text = t;
    }
    if (body?.filters !== undefined) data.filters_json = normalizarFiltros(body.filters) as any;
    return this.prisma.manualCampaign.update({ where: { id }, data });
  }

  async excluir(tenantId: string, id: string) {
    const c = await this.daClinica(tenantId, id);
    this.exigeRascunho(c);
    const media = await this.prisma.manualCampaignMedia.findMany({ where: { campaign_id: id }, select: { file_path: true } });
    for (const m of media) await this.files.delete(m.file_path).catch(() => undefined);
    await this.prisma.manualCampaign.delete({ where: { id } });
    return { ok: true };
  }

  /** Quem entra com estes filtros (agora) e quem fica de fora — prévia e base do iniciar. */
  async publico(tenantId: string, filtrosBrutos: any, agora = new Date()) {
    const f: CampanhaFiltros = normalizarFiltros(filtrosBrutos);
    let pacientes = (await this.prisma.patient.findMany({
      where: wherePublico(tenantId, f, agora),
      select: {
        id: true, name: true, phone: true, birth_date: true,
        lead: { select: { contact_opt_out_at: true, whatsapp_invalid_at: true, non_patient_category: true } },
      },
      orderBy: { name: 'asc' },
      take: 5000,
    })) as PacientePublico[];
    if (f.aniversariantesDoMes) pacientes = pacientes.filter((p) => aniversarianteDoMes(p.birth_date, agora));
    const fora: Record<MotivoFora, number> = { sem_telefone: 0, nao_recebe: 0, numero_invalido: 0 };
    const recebem: PacientePublico[] = [];
    for (const p of pacientes) {
      const m = motivoFora(p);
      if (m) fora[m]++;
      else recebem.push(p);
    }
    return { filtros: f, total: pacientes.length, recebem, fora };
  }

  async previa(tenantId: string, filtros: any) {
    const r = await this.publico(tenantId, filtros);
    return {
      total: r.total,
      recebem: r.recebem.length,
      fora: Object.entries(r.fora).filter(([, n]) => n > 0).map(([k, n]) => ({ motivo: MOTIVO_FORA_LABEL[k as MotivoFora], n })),
      amostra: r.recebem.slice(0, 30).map((p) => ({ nome: p.name, telefone: p.phone })),
      acimaDoLimite: r.recebem.length > CAMPANHA_MAX_DESTINATARIOS,
      limite: CAMPANHA_MAX_DESTINATARIOS,
      estimativa: estimativaCampanha(Math.min(r.recebem.length, CAMPANHA_MAX_DESTINATARIOS)),
    };
  }

  // ─── Anexos (fotos e áudio) ─────────────────────────────────────────────────

  async anexar(tenantId: string, id: string, file: { buffer: Buffer; mimetype: string; size: number; originalname?: string } | undefined) {
    const c = await this.daClinica(tenantId, id);
    this.exigeRascunho(c);
    if (!file?.buffer?.length) throw new BadRequestException('Arquivo vazio');
    const kind = campanhaMidiaTipo(file.mimetype);
    if (!kind) throw new BadRequestException('Só fotos (JPG, PNG, WEBP), vídeos MP4 e áudios (MP3, OGG, M4A, WAV, WEBM) — vídeo .MOV do iPhone: compartilhe como MP4');
    if (file.size > CAMPANHA_MIDIA_LIMITE_BYTES[kind]) {
      throw new BadRequestException(`${kind === 'image' ? 'Foto' : kind === 'video' ? 'Vídeo' : 'Áudio'} muito grande (máx. ${CAMPANHA_MIDIA_LIMITE_BYTES[kind] / 1024 / 1024} MB)`);
    }
    const qtd = await this.prisma.manualCampaignMedia.count({ where: { campaign_id: id } });
    if (qtd >= CAMPANHA_MAX_MIDIAS) throw new BadRequestException(`Máximo de ${CAMPANHA_MAX_MIDIAS} anexos por campanha`);
    const mid = randomUUID();
    const mime = file.mimetype.toLowerCase().split(';')[0].trim();
    const filePath = `campanhas/${id}/${mid}.${EXT_POR_MIME[mime] || 'bin'}`;
    await this.files.write(filePath, file.buffer);
    return this.prisma.manualCampaignMedia.create({
      data: {
        id: mid, campaign_id: id, kind, file_path: filePath, mime_type: mime, size: file.size,
        original_name: (file.originalname || '').slice(0, 120) || null, position: qtd,
      },
      select: { id: true, kind: true, mime_type: true, size: true, original_name: true, position: true },
    });
  }

  async removerAnexo(tenantId: string, id: string, mediaId: string) {
    const c = await this.daClinica(tenantId, id);
    this.exigeRascunho(c);
    const m = await this.prisma.manualCampaignMedia.findFirst({ where: { id: mediaId, campaign_id: id } });
    if (!m) throw new NotFoundException('Anexo não encontrado');
    await this.files.delete(m.file_path).catch(() => undefined);
    await this.prisma.manualCampaignMedia.delete({ where: { id: mediaId } });
    return { ok: true };
  }

  /** Arquivo do anexo (pra prévia na tela — só a própria clínica). */
  async arquivoAnexo(tenantId: string, id: string, mediaId: string) {
    await this.daClinica(tenantId, id);
    const m = await this.prisma.manualCampaignMedia.findFirst({ where: { id: mediaId, campaign_id: id } });
    if (!m) throw new NotFoundException('Anexo não encontrado');
    return { buffer: await this.files.read(m.file_path), mime: m.mime_type };
  }

  // ─── Teste, início e controle ───────────────────────────────────────────────

  private async validarConteudo(c: { text: string }, id: string) {
    const media = await this.prisma.manualCampaignMedia.findMany({ where: { campaign_id: id }, orderBy: { position: 'asc' } });
    if (!c.text.trim() && !media.length) throw new BadRequestException('Escreva a mensagem ou anexe uma foto/áudio');
    return media;
  }

  async testar(tenantId: string, id: string, telefone: string) {
    const c = await this.daClinica(tenantId, id);
    const num = (telefone || '').replace(/\D/g, '');
    if (num.length < 10) throw new BadRequestException('Telefone inválido — use DDD + número');
    const media = await this.validarConteudo(c, id);
    const chip = await this.envio.chipDoSetor(tenantId, c.setor);
    if (!chip) throw new BadRequestException('Este setor não tem chip de WhatsApp conectado nesta clínica');
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const r = await this.envio.enviarPara(tenantId, chip, num, c.text, media, {
      nome: 'Felipe (teste)', nome_completo: 'Felipe Passos (teste)', clinica: tenant?.name || 'a clínica',
    });
    if (!r.saiu) {
      throw new BadRequestException(
        r.semWhatsapp ? 'Esse número não tem WhatsApp — confira' : r.chipCaido ? 'O chip deste setor está desconectado' : `Não saiu: ${r.erros[0] || 'erro'}`,
      );
    }
    return { ok: true, avisos: r.erros };
  }

  /** Congela a lista e começa (ou agenda). */
  async iniciar(tenantId: string, id: string, agendarPara?: string | null) {
    const c = await this.daClinica(tenantId, id);
    this.exigeRascunho(c);
    await this.validarConteudo(c, id);
    if (!(await this.envio.chipDoSetor(tenantId, c.setor))) {
      throw new BadRequestException('Este setor não tem chip de WhatsApp conectado nesta clínica — conecte antes de iniciar');
    }
    const quando = agendarPara ? new Date(agendarPara) : null;
    if (quando && Number.isNaN(quando.getTime())) throw new BadRequestException('Data de agendamento inválida');
    const agora = new Date();
    const r = await this.publico(tenantId, c.filters_json || {}, agora);
    if (!r.recebem.length) throw new BadRequestException('Ninguém recebe com estes filtros');
    if (r.recebem.length > CAMPANHA_MAX_DESTINATARIOS) {
      throw new BadRequestException(`São ${r.recebem.length} pacientes — o máximo por campanha é ${CAMPANHA_MAX_DESTINATARIOS}. Refine os filtros.`);
    }
    const agendada = !!quando && quando.getTime() > agora.getTime() + 60_000;
    await this.prisma.$transaction(async (tx) => {
      // Trava contra duplo clique: só um iniciar vira o rascunho.
      const vira = await tx.manualCampaign.updateMany({
        where: { id, tenant_id: tenantId, status: 'RASCUNHO' },
        data: {
          status: agendada ? 'AGENDADA' : 'ENVIANDO',
          total: r.recebem.length,
          scheduled_for: agendada ? quando : null,
          started_at: agendada ? null : agora,
          filters_json: r.filtros as any,
        },
      });
      if (vira.count === 0) throw new BadRequestException('Esta campanha já foi iniciada');
      await tx.manualCampaignItem.createMany({
        data: r.recebem.map((p) => ({
          campaign_id: id, tenant_id: tenantId, patient_id: p.id, name: p.name, phone: p.phone || '',
        })),
        skipDuplicates: true,
      });
    });
    this.logger.log(`[CAMPANHA] ${id} ${agendada ? 'agendada' : 'iniciada'} — ${r.recebem.length} pacientes`);
    return this.detalhe(tenantId, id);
  }

  async pausar(tenantId: string, id: string) {
    await this.daClinica(tenantId, id);
    const r = await this.prisma.manualCampaign.updateMany({
      where: { id, tenant_id: tenantId, status: { in: ['ENVIANDO', 'AGENDADA'] } },
      data: { status: 'PAUSADA', pause_reason: 'Pausada manualmente' },
    });
    if (!r.count) throw new BadRequestException('Só dá pra pausar uma campanha enviando ou agendada');
    return this.detalhe(tenantId, id);
  }

  async retomar(tenantId: string, id: string) {
    const c = await this.daClinica(tenantId, id);
    if (c.status !== 'PAUSADA') throw new BadRequestException('A campanha não está pausada');
    const agendada = !!c.scheduled_for && c.scheduled_for.getTime() > Date.now();
    await this.prisma.manualCampaign.update({
      where: { id },
      data: { status: agendada ? 'AGENDADA' : 'ENVIANDO', pause_reason: null, ...(c.started_at || agendada ? {} : { started_at: new Date() }) },
    });
    return this.detalhe(tenantId, id);
  }

  async cancelar(tenantId: string, id: string) {
    await this.daClinica(tenantId, id);
    const r = await this.prisma.manualCampaign.updateMany({
      where: { id, tenant_id: tenantId, status: { in: ['ENVIANDO', 'AGENDADA', 'PAUSADA'] } },
      data: { status: 'CANCELADA', completed_at: new Date() },
    });
    if (!r.count) throw new BadRequestException('Esta campanha não pode ser cancelada');
    const pulados = await this.prisma.manualCampaignItem.updateMany({
      where: { campaign_id: id, status: 'PENDENTE' },
      data: { status: 'PULADO', reason: 'campanha cancelada' },
    });
    if (pulados.count) await this.prisma.manualCampaign.update({ where: { id }, data: { skipped_count: { increment: pulados.count } } });
    return this.detalhe(tenantId, id);
  }

  async itens(tenantId: string, id: string, status?: string) {
    await this.daClinica(tenantId, id);
    return this.prisma.manualCampaignItem.findMany({
      where: { campaign_id: id, ...(status ? { status } : {}) },
      orderBy: [{ sent_at: 'desc' }, { created_at: 'asc' }],
      take: 500,
      select: { id: true, name: true, phone: true, status: true, reason: true, sent_at: true },
    });
  }
}
