import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { registrarAuditoria } from '../common/utils/audit-log.util';
import { ChatGateway } from './chat.gateway';

export const ENTIDADE_DA_TELA = 'TELA_AO_VIVO';
/** Depois disso a sessão acaba: aba esquecida aberta não acompanha ninguém para sempre. */
export const TEMPO_MAXIMO_MS = 30 * 60 * 1000;
/** Abaixo do limite de 1 MB por mensagem do socket (main.ts), mesmo com acento e aspas. */
export const MAX_CARACTERES_POR_PEDACO = 200_000;
export const MAX_PEDACOS_POR_LOTE = 400;
export const MAX_CARACTERES_POR_MINUTO = 60_000_000;
/** Fila parada no socket do dono: a tela é largada para não encher a memória da API. */
export const MAX_FILA_DO_OBSERVADOR = 300;

export type MotivoDoFim = 'observador_saiu' | 'tempo' | 'substituida' | 'excesso' | 'lento';

export interface QuadroDaTela {
  sessao: string;
  aba: string;
  lote: number;
  parte: number;
  total: number;
  dados: string;
}

interface Sessao {
  id: string;
  observadorSocketId: string;
  observadorId: string;
  alvoId: string;
  alvoTenantId: string | null;
  /** A aba que está transmitindo. Só uma por vez. */
  emissorSocketId: string | null;
  inicio: number;
  limite: ReturnType<typeof setTimeout>;
  janelaInicio: number;
  janelaCaracteres: number;
}

const inteiro = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Só aceita o formato que o navegador manda; qualquer outra coisa → null. */
export function lerQuadro(valor: unknown): QuadroDaTela | null {
  if (!valor || typeof valor !== 'object') return null;
  const { sessao, aba, lote, parte, total, dados } = valor as Record<string, unknown>;
  if (typeof sessao !== 'string' || sessao.length === 0 || sessao.length > 64) return null;
  if (typeof aba !== 'string' || aba.length === 0 || aba.length > 64) return null;
  if (!inteiro(lote) || lote < 0) return null;
  if (!inteiro(total) || total < 1 || total > MAX_PEDACOS_POR_LOTE) return null;
  if (!inteiro(parte) || parte < 0 || parte >= total) return null;
  if (typeof dados !== 'string' || dados.length === 0 || dados.length > MAX_CARACTERES_POR_PEDACO) return null;
  return { sessao, aba, lote, parte, total, dados };
}

/**
 * Tela ao vivo: o dono do sistema (SUPER_ADMIN) acompanha a tela de um usuário.
 *
 * - O servidor só REPASSA: nada do que a tela transmite é guardado, em lugar nenhum.
 * - A tela vai só para a conexão do dono que abriu a sessão, e nunca pelo Redis:
 *   com connectionStateRecovery, `socket.emit` publica no adapter; `local` não publica.
 * - A pessoa acompanhada recebe `tela_comecar` e o navegador dela mostra o aviso.
 * - Sem registro não há sessão. Início e fim ficam no AuditLog: quem viu, quem foi visto,
 *   quando e por quanto tempo. Reinício da API deixa um INICIOU sem ENCERROU: acabou ali.
 * - As sessões ficam na memória: a API roda em 1 réplica, igual à presença do ChatGateway.
 */
@Injectable()
export class TelaAoVivoService {
  private readonly logger = new Logger(TelaAoVivoService.name);
  private readonly porAlvo = new Map<string, Sessao>();
  private readonly porObservador = new Map<string, Sessao>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
  ) {}

  private conexao(id: string | null): Socket | undefined {
    if (!id) return undefined;
    return this.gateway.server?.sockets?.sockets?.get(id) as Socket | undefined;
  }

  private avisarObservador(s: Sessao, estado: string, extra: Record<string, unknown> = {}) {
    this.conexao(s.observadorSocketId)?.emit('tela_estado', { estado, sessao: s.id, ...extra });
  }

  /** O dono pediu para acompanhar. O papel vem do banco, nunca só do token. */
  async assistir(observador: Socket, alvoId: string): Promise<void> {
    const observadorId: unknown = observador.data?.user?.sub;
    if (typeof observadorId !== 'string') return;

    const eu = await this.prisma.user.findUnique({ where: { id: observadorId }, select: { roles: true } });
    if (!eu?.roles?.includes('SUPER_ADMIN')) {
      this.logger.warn(`[TELA] Recusado: ${observadorId} não é o dono do sistema`);
      observador.emit('tela_estado', { estado: 'negado' });
      return;
    }
    if (alvoId === observadorId) {
      observador.emit('tela_estado', { estado: 'erro', mensagem: 'Esta é a sua própria conta.' });
      return;
    }
    const alvo = await this.prisma.user.findUnique({ where: { id: alvoId }, select: { id: true, tenant_id: true } });
    if (!alvo) {
      observador.emit('tela_estado', { estado: 'erro', mensagem: 'Usuário não encontrado.' });
      return;
    }
    // A consulta leva um tempo: o dono pode ter saído da tela no meio.
    if (!observador.connected) return;

    const sessaoId = randomUUID();
    const registrado = await registrarAuditoria(
      this.prisma,
      {
        tenantId: alvo.tenant_id ?? null,
        actorUserId: observadorId,
        entity: ENTIDADE_DA_TELA,
        entityId: alvo.id,
        action: 'INICIOU',
        meta: { sessao: sessaoId },
      },
      this.logger,
    );
    if (!registrado) {
      observador.emit('tela_estado', { estado: 'erro', mensagem: 'Não foi possível registrar o acesso. Tente de novo.' });
      return;
    }

    const minha = this.porObservador.get(observador.id);
    if (minha) this.encerrar(minha, 'substituida');
    const outra = this.porAlvo.get(alvo.id);
    if (outra) this.encerrar(outra, 'substituida');

    const agora = Date.now();
    const sessao: Sessao = {
      id: sessaoId,
      observadorSocketId: observador.id,
      observadorId,
      alvoId: alvo.id,
      alvoTenantId: alvo.tenant_id ?? null,
      emissorSocketId: null,
      inicio: agora,
      limite: setTimeout(() => {
        // Roda fora do `seguro` dos eventos: um erro aqui derrubaria a API.
        try {
          this.encerrar(sessao, 'tempo');
        } catch (e: any) {
          this.logger.warn(`[TELA] Falha ao encerrar por tempo: ${e?.message}`);
        }
      }, TEMPO_MAXIMO_MS),
      janelaInicio: agora,
      janelaCaracteres: 0,
    };
    (sessao.limite as { unref?: () => void }).unref?.();
    this.porAlvo.set(alvo.id, sessao);
    this.porObservador.set(observador.id, sessao);

    // O registro também levou um tempo: saiu agora, encerra e fica anotado.
    if (!observador.connected) {
      this.encerrar(sessao, 'observador_saiu');
      return;
    }

    for (const id of this.gateway.socketsDoUsuario(alvo.id)) {
      this.conexao(id)?.emit('tela_comecar', { sessao: sessao.id });
    }
    this.avisarObservador(sessao, this.gateway.isUserOnline(alvo.id) ? 'aguardando_tela' : 'offline');
  }

  /** O dono saiu da tela (Voltar, fechou a aba). */
  deixar(observador: Socket): void {
    const sessao = this.porObservador.get(observador.id);
    if (sessao) this.encerrar(sessao, 'observador_saiu');
  }

  /** Aba nova ou recarregada de quem está sendo acompanhado: entra na sessão e vê o aviso. */
  aoConectar(socket: Socket): void {
    if (socket.data?.soTela) return;
    const sessao = this.porAlvo.get(socket.data?.user?.sub);
    if (!sessao) return;
    socket.emit('tela_comecar', { sessao: sessao.id });
    if (!sessao.emissorSocketId) this.avisarObservador(sessao, 'aguardando_tela');
  }

  /** Rode DEPOIS do ChatGateway.handleDisconnect: a presença já está atualizada. */
  aoDesconectar(socket: Socket): void {
    const minha = this.porObservador.get(socket.id);
    if (minha) this.encerrar(minha, 'observador_saiu');

    const sessao = this.porAlvo.get(socket.data?.user?.sub);
    if (!sessao) return;
    if (sessao.emissorSocketId === socket.id) sessao.emissorSocketId = null;
    if (!sessao.emissorSocketId) {
      this.avisarObservador(sessao, this.gateway.isUserOnline(sessao.alvoId) ? 'aguardando_tela' : 'offline');
    }
  }

  /** A pessoa saiu da aba do sistema: o navegador parou de transmitir. */
  escondida(socket: Socket, valor: unknown): void {
    const sessaoId = (valor as { sessao?: unknown } | null | undefined)?.sessao;
    const sessao = this.porAlvo.get(socket.data?.user?.sub);
    if (!sessao || sessao.id !== sessaoId || sessao.emissorSocketId !== socket.id) return;
    sessao.emissorSocketId = null;
    this.avisarObservador(sessao, 'aba_escondida');
  }

  /** A conexão da pessoa não dá conta da tela: encerra em vez de atrapalhar o trabalho dela. */
  desistir(socket: Socket, valor: unknown): void {
    const sessaoId = (valor as { sessao?: unknown } | null | undefined)?.sessao;
    const sessao = this.porAlvo.get(socket.data?.user?.sub);
    if (sessao && sessao.id === sessaoId) this.encerrar(sessao, 'lento');
  }

  /** Um pedaço da tela: só da pessoa acompanhada, e só para o dono daquela sessão. */
  quadro(socket: Socket, valor: unknown): void {
    const sessao = this.porAlvo.get(socket.data?.user?.sub);
    if (!sessao) return;
    const q = lerQuadro(valor);
    if (!q || q.sessao !== sessao.id) return;

    if (sessao.emissorSocketId !== socket.id) {
      // Outra aba só assume no começo de uma transmissão; a aba anterior para.
      if (q.lote !== 0 || q.parte !== 0) return;
      const anterior = sessao.emissorSocketId;
      sessao.emissorSocketId = socket.id;
      this.conexao(anterior)?.emit('tela_pausar');
    }

    const agora = Date.now();
    if (agora - sessao.janelaInicio >= 60_000) {
      sessao.janelaInicio = agora;
      sessao.janelaCaracteres = 0;
    }
    sessao.janelaCaracteres += q.dados.length;
    if (sessao.janelaCaracteres > MAX_CARACTERES_POR_MINUTO) {
      this.encerrar(sessao, 'excesso');
      return;
    }

    const observador = this.conexao(sessao.observadorSocketId);
    if (!observador) {
      this.encerrar(sessao, 'observador_saiu');
      return;
    }
    const fila = (observador.conn as unknown as { writeBuffer?: unknown[] } | undefined)?.writeBuffer?.length ?? 0;
    if (fila > MAX_FILA_DO_OBSERVADOR) {
      this.encerrar(sessao, 'lento');
      return;
    }
    // `local`: o conteúdo da tela não vai para o Redis (ver o comentário da classe).
    this.gateway.server.local
      .to(sessao.observadorSocketId)
      .emit('tela_quadro', { aba: q.aba, lote: q.lote, parte: q.parte, total: q.total, dados: q.dados });
  }

  private encerrar(sessao: Sessao, motivo: MotivoDoFim): void {
    clearTimeout(sessao.limite);
    if (this.porAlvo.get(sessao.alvoId) === sessao) this.porAlvo.delete(sessao.alvoId);
    if (this.porObservador.get(sessao.observadorSocketId) === sessao) this.porObservador.delete(sessao.observadorSocketId);

    for (const id of this.gateway.socketsDoUsuario(sessao.alvoId)) {
      this.conexao(id)?.emit('tela_parar');
    }
    this.avisarObservador(sessao, 'encerrada', { motivo });

    void registrarAuditoria(
      this.prisma,
      {
        tenantId: sessao.alvoTenantId,
        actorUserId: sessao.observadorId,
        entity: ENTIDADE_DA_TELA,
        entityId: sessao.alvoId,
        action: 'ENCERROU',
        meta: { sessao: sessao.id, motivo, duracao_s: Math.round((Date.now() - sessao.inicio) / 1000) },
      },
      this.logger,
    );
  }
}
