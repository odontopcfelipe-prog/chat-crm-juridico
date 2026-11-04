import type { Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { eventoSeguro, type LimiteDeEventos } from './socket-eventos';
import type { TelaAoVivoService } from './tela-ao-vivo.service';

/** Eventos da tela ao vivo no socket (o main.ts liga cada um). Nenhum erro escapa. */
export function eventosDaTela(socket: Socket, tela: TelaAoVivoService, limite: LimiteDeEventos, logger: Logger) {
  const seguro = eventoSeguro(socket, logger);

  return {
    conectou: seguro('tela_conectou', () => tela.aoConectar(socket)),
    desconectou: seguro('tela_desconectou', () => tela.aoDesconectar(socket)),

    assistir: seguro('tela_assistir', (valor) => {
      if (!limite(socket.id, 'tela_assistir', 20)) return;
      if (typeof valor !== 'string' || valor.length === 0 || valor.length > 100) return;
      return tela.assistir(socket, valor);
    }),

    deixar: seguro('tela_deixar', () => {
      if (!limite(socket.id, 'tela_deixar', 20)) return;
      tela.deixar(socket);
    }),

    // O navegador só manda o próximo pedaço depois da confirmação: em conexão lenta,
    // os pedaços não se acumulam na frente do resto (chat, ping) da pessoa.
    quadro: (valor: unknown, confirmar?: unknown) => {
      seguro('tela_quadro', () => {
        try {
          if (limite(socket.id, 'tela_quadro', 3000)) tela.quadro(socket, valor);
        } finally {
          if (typeof confirmar === 'function') confirmar();
        }
      })();
    },

    escondida: seguro('tela_escondida', (valor) => {
      if (!limite(socket.id, 'tela_escondida', 120)) return;
      tela.escondida(socket, valor);
    }),

    desistir: seguro('tela_desistir', (valor) => {
      if (!limite(socket.id, 'tela_desistir', 20)) return;
      tela.desistir(socket, valor);
    }),
  };
}
