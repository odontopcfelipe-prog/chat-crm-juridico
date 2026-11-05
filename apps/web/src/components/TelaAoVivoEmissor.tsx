'use client';

/**
 * Tela ao vivo, no navegador de quem está sendo acompanhado.
 *
 * Fica parado até o servidor mandar `tela_comecar` (só o dono do sistema abre).
 * Aí mostra o aviso, que não some enquanto a sessão durar, e só depois transmite.
 * A biblioteca só é baixada nessa hora: para quem não é acompanhado, não pesa nada.
 *
 * Só a aba em primeiro plano transmite: o que está fora dela, como outros programas
 * ou outras abas do navegador, nunca sai daqui. Campo de senha é sempre mascarado;
 * campo sensível que aparece como texto precisa de `data-rr-is-password` ou `rr-block`
 * (há uma trava em apps/api/src/gateway/tela-ao-vivo.campos.spec.ts).
 */
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Eye } from 'lucide-react';
import { useSocket } from '@/lib/SocketProvider';
import { MAX_PEDACOS_POR_LOTE, emPedacos } from '@/lib/tela-ao-vivo';

const INTERVALO_DO_LOTE_MS = 400;
/** Tempo para o aviso aparecer na tela antes da primeira transmissão. */
const ESPERA_DO_AVISO_MS = 150;
const TEMPO_DA_CONFIRMACAO_MS = 20_000;
/** Mais que isso na fila: a conexão da pessoa não dá conta, e a sessão acaba. */
const MAX_EVENTOS_NA_FILA = 5_000;

function novoId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TelaAoVivoEmissor() {
  const { socket } = useSocket();
  const [ativa, setAtiva] = useState(false);

  useEffect(() => {
    if (!socket) return;
    // Iframe: a página de cima já transmite o que está dentro dele.
    if (window.self !== window.top) return;

    let sessao: string | null = null;
    let avisoNaTela = false;
    let esperaDoAviso: ReturnType<typeof setTimeout> | undefined;
    let pararGravacao: (() => void) | null = null;
    // Invalida um início que ainda está baixando a biblioteca.
    let tentativa = 0;

    const parar = () => {
      tentativa += 1;
      pararGravacao?.();
      pararGravacao = null;
    };

    const desistir = () => {
      parar();
      if (sessao) socket.emit('tela_desistir', { sessao });
    };

    const iniciar = async () => {
      if (!sessao || !avisoNaTela || pararGravacao || document.visibilityState !== 'visible') return;
      const minhaTentativa = ++tentativa;
      const sessaoDaGravacao = sessao;

      let rrweb: typeof import('rrweb');
      try {
        rrweb = await import('rrweb');
      } catch {
        desistir();
        return;
      }
      if (minhaTentativa !== tentativa || sessao !== sessaoDaGravacao) return;

      const aba = novoId();
      let fila: unknown[] = [];
      let lote = 0;
      let gravando = true;
      let enviando = false;

      // Um pedaço por vez: o próximo só sai depois de o servidor confirmar o anterior.
      const enviar = async () => {
        if (enviando || fila.length === 0) return;
        enviando = true;
        try {
          const eventos = fila;
          fila = [];
          const pedacos = emPedacos(JSON.stringify(eventos));
          if (pedacos.length > MAX_PEDACOS_POR_LOTE) {
            desistir();
            return;
          }
          const numero = lote;
          lote += 1;
          for (let parte = 0; parte < pedacos.length; parte += 1) {
            if (!gravando) return;
            await socket.timeout(TEMPO_DA_CONFIRMACAO_MS).emitWithAck('tela_quadro', {
              sessao: sessaoDaGravacao, aba, lote: numero, parte, total: pedacos.length, dados: pedacos[parte],
            });
          }
        } catch {
          if (gravando) desistir();
        } finally {
          enviando = false;
        }
      };

      try {
        const pararBiblioteca = rrweb.record({
          emit: (evento) => {
            fila.push(evento);
            if (fila.length > MAX_EVENTOS_NA_FILA) desistir();
          },
          maskInputOptions: { password: true },
          slimDOMOptions: 'all',
          recordCanvas: false,
          collectFonts: false,
          sampling: { mousemove: 100, scroll: 150, input: 'last' },
        });
        const relogio = setInterval(() => void enviar(), INTERVALO_DO_LOTE_MS);
        pararGravacao = () => {
          gravando = false;
          clearInterval(relogio);
          pararBiblioteca?.();
        };
        void enviar();
      } catch {
        // Falha ao gravar nunca atrapalha o trabalho da pessoa.
        desistir();
      }
    };

    const aoComecar = (dados: { sessao?: unknown }) => {
      if (typeof dados?.sessao !== 'string') return;
      parar();
      sessao = dados.sessao;
      // O aviso vai para a tela antes de qualquer transmissão.
      flushSync(() => setAtiva(true));
      clearTimeout(esperaDoAviso);
      esperaDoAviso = setTimeout(() => {
        avisoNaTela = true;
        void iniciar();
      }, ESPERA_DO_AVISO_MS);
    };
    const aoParar = () => {
      clearTimeout(esperaDoAviso);
      parar();
      sessao = null;
      avisoNaTela = false;
      setAtiva(false);
    };
    const aoMudarDeAba = () => {
      if (!sessao) return;
      if (document.visibilityState === 'visible') {
        void iniciar();
        return;
      }
      const transmitia = !!pararGravacao;
      parar();
      if (transmitia) socket.emit('tela_escondida', { sessao });
    };
    const aoFocar = () => { void iniciar(); };

    socket.on('tela_comecar', aoComecar);
    socket.on('tela_parar', aoParar);
    socket.on('tela_pausar', parar);
    // Sem conexão não há como transmitir. Ao reconectar, o servidor avisa de novo se a sessão continuar.
    socket.on('disconnect', aoParar);
    document.addEventListener('visibilitychange', aoMudarDeAba);
    window.addEventListener('focus', aoFocar);

    return () => {
      socket.off('tela_comecar', aoComecar);
      socket.off('tela_parar', aoParar);
      socket.off('tela_pausar', parar);
      socket.off('disconnect', aoParar);
      document.removeEventListener('visibilitychange', aoMudarDeAba);
      window.removeEventListener('focus', aoFocar);
      aoParar();
    };
  }, [socket]);

  if (!ativa) return null;

  // Aviso DISCRETO e SEMPRE visível: um selo pequeno no canto, com um ponto que
  // pisca para a pessoa perceber. Não tapa a tela, mas deixa claro que o suporte
  // está acompanhando. O aviso nunca é removido enquanto a sessão durar (a pessoa
  // acompanhada tem de saber — ver o comentário da classe). `visible` garante o
  // selo mesmo enquanto o laboratório mantém o body oculto ao carregar.
  return (
    <div
      role="status"
      className="visible fixed top-2 right-2 z-[2147483647] max-w-[calc(100vw-16px)] pointer-events-none flex items-center gap-1.5 rounded-full bg-amber-500 text-black text-[11px] font-bold pl-2 pr-2.5 py-1 shadow-md"
      title="O suporte do sistema está acompanhando esta tela em tempo real. Nada é gravado."
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-black/40 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-black" />
      </span>
      <Eye size={12} className="shrink-0" />
      <span>Suporte acompanhando</span>
    </div>
  );
}
