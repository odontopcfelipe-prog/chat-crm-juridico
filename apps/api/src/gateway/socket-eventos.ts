import type { Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { ChatGateway } from './chat.gateway';

/**
 * Id de conversa vindo do cliente: texto curto e sem ":" (as salas de sistema —
 * tenant:, inbox:, operators:, user: — têm ":"). Qualquer outra coisa → null.
 */
export function idDeConversa(valor: unknown): string | null {
  return typeof valor === 'string' && valor.length > 0 && valor.length <= 100 && !valor.includes(':') ? valor : null;
}

type LimiteDeEventos = (socketId: string, evento: string, maxPorMinuto: number) => boolean;

/**
 * O que roda em cada evento que o cliente manda pelo socket (o main.ts liga cada
 * um com socket.on). Nenhum erro daqui pode escapar: no Node 20, uma promise
 * rejeitada sem tratamento — ou um erro lançado dentro do evento, que o socket.io
 * roda fora de qualquer try — encerra o processo. Por isso todo evento passa por
 * `seguro`, e nenhum valor do cliente vai para o log sem antes ser checado como texto.
 */
export function eventosDoSocket(socket: Socket, gateway: ChatGateway, limite: LimiteDeEventos, logger: Logger) {
  const falhou = (evento: string, e: any) =>
    logger.warn(`[SOCKET] ${evento} falhou (${socket.id}): ${typeof e?.message === 'string' ? e.message : 'erro'}`);
  const seguro = (evento: string, tratar: (valor: unknown) => unknown) => (valor: unknown) => {
    try {
      const r = tratar(valor) as PromiseLike<unknown> | undefined;
      if (r && typeof r.then === 'function') r.then(undefined, (e) => falhou(evento, e));
    } catch (e) {
      falhou(evento, e);
    }
  };

  return {
    joinConversation: seguro('join_conversation', (valor) => {
      if (!limite(socket.id, 'join_conversation', 30)) {
        logger.warn(`[SOCKET] Rate limited: join_conversation de ${socket.id}`);
        return;
      }
      const id = idDeConversa(valor);
      if (!id) {
        logger.warn(`[SOCKET] BLOQUEADO: join_conversation com id invalido de ${socket.id}`);
        return;
      }
      return gateway.handleJoinConversation(id, socket);
    }),

    leaveConversation: seguro('leave_conversation', (valor) => {
      if (!limite(socket.id, 'leave_conversation', 30)) return;
      const id = idDeConversa(valor);
      if (!id) return;
      gateway.handleLeaveConversation(id, socket);
    }),

    joinUser: seguro('join_user', (valor) => {
      if (!limite(socket.id, 'join_user', 10)) {
        logger.warn(`[SOCKET] Rate limited: join_user de ${socket.id}`);
        return;
      }
      // Só o id da própria pessoa (texto curto); nada estranho chega ao log do gateway.
      if (typeof valor !== 'string' || valor.length > 100) return;
      gateway.handleJoinUser(valor, socket);
    }),

    typing: seguro('typing', (valor) => {
      if (!limite(socket.id, 'typing', 30)) return;
      const user = socket.data.user;
      if (!user?.sub || !valor || typeof valor !== 'object') return;
      const dados = valor as { conversationId?: unknown; isTyping?: unknown };
      // "Digitando" só numa conversa em que a pessoa entrou (o join_conversation já
      // checou a clínica) — nunca numa sala de sistema.
      const id = idDeConversa(dados.conversationId);
      if (!id || !socket.rooms.has(id)) return;
      gateway.emitTypingIndicator(id, {
        userId: user.sub,
        userName: user.name || 'Operador',
        isTyping: dados.isTyping === true,
      });
    }),
  };
}
