'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Eye, Loader2, RefreshCw } from 'lucide-react';
import { Replayer } from 'rrweb';
import 'rrweb/dist/style.css';
import { io, type Socket } from 'socket.io-client';
import api from '@/lib/api';
import { getAuthToken, getSocketPath, getWsUrl } from '@/lib/socketConfig';
import type { QuadroRecebido } from '@/lib/tela-ao-vivo';

type Evento = ConstructorParameters<typeof Replayer>[0][number];
type Estado = 'conectando' | 'ao_vivo' | 'aguardando_tela' | 'aba_escondida' | 'offline' | 'negado' | 'erro' | 'encerrada';

/** Margem para a tela chegar inteira antes de aparecer. */
const FOLGA_MS = 300;

const MOTIVOS: Record<string, string> = {
  tempo: 'Encerrada depois de 30 minutos. Clique em "Ver de novo" para continuar.',
  substituida: 'Esta tela foi aberta em outra aba.',
  excesso: 'Encerrada: a tela estava mandando dados demais.',
  lento: 'Encerrada: a conexão não acompanhou a tela.',
};

interface Pessoa {
  id: string;
  name: string;
  email: string;
}

export default function Visor({ contaId, usuarioId }: { contaId: string; usuarioId: string }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [estado, setEstado] = useState<Estado>('conectando');
  const [aviso, setAviso] = useState<string | null>(null);
  const [pessoa, setPessoa] = useState<Pessoa | null>(null);
  const [nomeDaConta, setNomeDaConta] = useState<string | null>(null);
  const [temTela, setTemTela] = useState(false);
  const [rodada, setRodada] = useState(0);

  const areaRef = useRef<HTMLDivElement>(null);
  const palcoRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const abaRef = useRef<string | null>(null);
  const pedacosRef = useRef(new Map<number, string[]>());
  const tamanhoRef = useRef<{ width: number; height: number } | null>(null);

  // Conexão só desta tela: o dono não fica online no chat nem recebe conversas por estar aqui.
  useEffect(() => {
    const token = getAuthToken();
    if (!token) return;
    const conexao = io(getWsUrl(), {
      path: getSocketPath(),
      transports: ['polling', 'websocket'],
      auth: { token, soTela: true },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      timeout: 10000,
    });
    setSocket(conexao);
    return () => {
      conexao.disconnect();
      setSocket(null);
    };
  }, []);

  useEffect(() => {
    let ativo = true;
    api
      .get<{ conta: { name: string }; usuarios: Pessoa[] }>(`/admin/contas/${contaId}/usuarios`)
      .then(({ data }) => {
        if (!ativo) return;
        setNomeDaConta(data.conta.name);
        setPessoa(data.usuarios.find((u) => u.id === usuarioId) ?? null);
      })
      .catch(() => {});
    return () => { ativo = false; };
  }, [contaId, usuarioId]);

  /** A tela da pessoa pode ser maior que a sua: reduz para caber, sem cortar. */
  const ajustar = useCallback(() => {
    const area = areaRef.current;
    const tamanho = tamanhoRef.current;
    const wrapper = replayerRef.current?.wrapper;
    if (!area || !tamanho || !wrapper) return;
    const escala = Math.min(area.clientWidth / tamanho.width, area.clientHeight / tamanho.height, 1);
    wrapper.style.transformOrigin = 'top left';
    wrapper.style.transform = `translate(${Math.max(0, (area.clientWidth - tamanho.width * escala) / 2)}px, 0) scale(${escala})`;
  }, []);

  useEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === 'undefined') return;
    const observador = new ResizeObserver(ajustar);
    observador.observe(area);
    return () => observador.disconnect();
  }, [ajustar]);

  const desmontarTela = useCallback(() => {
    try {
      replayerRef.current?.destroy();
    } catch {
      // A tela já estava fora do ar.
    }
    replayerRef.current = null;
    tamanhoRef.current = null;
    if (palcoRef.current) palcoRef.current.innerHTML = '';
  }, []);

  useEffect(() => {
    if (!socket) return;

    // Encerrada, só reabre pelo "Ver de novo": aba esquecida não acompanha ninguém.
    let encerrada = false;

    const ligar = () => {
      if (encerrada) return;
      // A conexão voltou com a aba escondida: ninguém está olhando, então não reabre.
      if (document.visibilityState === 'hidden') {
        encerrada = true;
        setEstado('encerrada');
        setAviso('A conexão caiu. Clique em "Ver de novo" para continuar.');
        return;
      }
      setEstado('conectando');
      setAviso(null);
      socket.emit('tela_assistir', usuarioId);
    };

    const aoMudarEstado = (dados: { estado?: Estado; motivo?: string; mensagem?: string }) => {
      if (!dados?.estado) return;
      if (dados.estado === 'encerrada' || dados.estado === 'erro' || dados.estado === 'negado') encerrada = true;
      setEstado(dados.estado);
      if (dados.estado === 'erro') setAviso(dados.mensagem ?? 'Não foi possível abrir a tela.');
      else if (dados.estado === 'encerrada') setAviso((dados.motivo && MOTIVOS[dados.motivo]) || 'Sessão encerrada.');
      else setAviso(null);
    };

    const aplicar = (eventos: Evento[]) => {
      if (eventos.length === 0 || !palcoRef.current) return;
      let replayer = replayerRef.current;
      if (!replayer) {
        replayer = new Replayer([], {
          root: palcoRef.current,
          liveMode: true,
          showWarning: false,
          showDebug: false,
          mouseTail: false,
          triggerFocus: false,
        });
        replayer.on('resize', (tamanho) => {
          tamanhoRef.current = tamanho as { width: number; height: number };
          ajustar();
        });
        replayerRef.current = replayer;
        const primeiro = eventos[0] as { timestamp: number };
        replayer.startLive(primeiro.timestamp - FOLGA_MS);
      }
      for (const evento of eventos) replayer.addEvent(evento);
      setTemTela(true);
      setEstado('ao_vivo');
      setAviso(null);
    };

    const aoReceberQuadro = (q: QuadroRecebido) => {
      if (q.aba !== abaRef.current) {
        // Outra aba da pessoa assumiu: a tela recomeça do zero.
        if (q.lote !== 0 || q.parte !== 0) return;
        abaRef.current = q.aba;
        pedacosRef.current.clear();
        desmontarTela();
      }
      // Os lotes chegam em ordem: lote novo descarta o que ficou pela metade.
      if (q.parte === 0) pedacosRef.current.clear();
      let partes = pedacosRef.current.get(q.lote);
      if (!partes) {
        partes = [];
        pedacosRef.current.set(q.lote, partes);
      }
      partes[q.parte] = q.dados;
      if (q.parte !== q.total - 1) return;
      pedacosRef.current.delete(q.lote);
      try {
        aplicar(JSON.parse(partes.join('')) as Evento[]);
      } catch {
        setAviso('Parte da tela não pôde ser mostrada. Clique em "Ver de novo".');
      }
    };

    socket.on('connect', ligar);
    socket.on('tela_estado', aoMudarEstado);
    socket.on('tela_quadro', aoReceberQuadro);
    if (socket.connected) ligar();

    return () => {
      socket.off('connect', ligar);
      socket.off('tela_estado', aoMudarEstado);
      socket.off('tela_quadro', aoReceberQuadro);
      socket.emit('tela_deixar');
      abaRef.current = null;
      pedacosRef.current.clear();
      desmontarTela();
      setTemTela(false);
    };
  }, [socket, usuarioId, rodada, ajustar, desmontarTela]);

  const nome = pessoa?.name ?? 'a pessoa';
  const situacao: Record<Estado, string> = {
    conectando: 'Conectando...',
    ao_vivo: 'Ao vivo',
    aguardando_tela: `Aguardando ${nome} abrir a aba do sistema`,
    aba_escondida: `${nome} saiu da aba do sistema`,
    offline: `${nome} está offline`,
    negado: 'Só o adm master pode ver esta tela',
    erro: 'Não foi possível abrir',
    encerrada: 'Sessão encerrada',
  };
  const podeRepetir = estado === 'encerrada' || estado === 'erro' || !!aviso;

  return (
    <div className="flex flex-col h-[calc(100vh-57px)]">
      <div className="px-4 py-2 border-b border-border bg-card flex items-center gap-3 flex-wrap">
        <Link
          href={`/admin/tenants/${contaId}`}
          className="text-xs font-bold px-3 py-1.5 rounded-md border border-border hover:bg-accent/40 inline-flex items-center gap-1.5 shrink-0"
        >
          <ArrowLeft size={14} />
          Voltar para {nomeDaConta ?? 'a conta'}
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground truncate">{pessoa?.name ?? 'Usuário'}</p>
          {pessoa?.email && <p className="text-[11px] text-muted-foreground truncate">{pessoa.email}</p>}
        </div>
        <span
          className={`text-[11px] font-bold px-2.5 py-1 rounded-full inline-flex items-center gap-1.5 ${
            estado === 'ao_vivo' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700'
          }`}
        >
          {estado === 'ao_vivo' ? <Eye size={12} /> : estado === 'conectando' ? <Loader2 size={12} className="animate-spin" /> : null}
          {situacao[estado]}
        </span>
        {podeRepetir && (
          <button
            type="button"
            onClick={() => setRodada((r) => r + 1)}
            className="text-xs font-bold px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} />
            Ver de novo
          </button>
        )}
      </div>

      <p className="px-4 py-1 text-[11px] text-muted-foreground bg-muted/30 border-b border-border">
        Só para ver: você não mexe na tela da pessoa. Ela vê um aviso enquanto você estiver aqui. Nada é gravado, e este acesso fica registrado.
      </p>

      <div ref={areaRef} className="relative flex-1 overflow-hidden bg-neutral-900">
        <div ref={palcoRef} className="absolute inset-0" />
        {(!temTela || aviso) && (
          <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none">
            <p className="text-sm font-semibold text-white bg-black/70 rounded-lg px-4 py-2 text-center">
              {aviso ?? situacao[estado]}
            </p>
          </div>
        )}
        {temTela && !aviso && estado !== 'ao_vivo' && (
          <p className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs font-semibold text-white bg-black/70 rounded-lg px-3 py-1.5 pointer-events-none">
            {situacao[estado]}. Esta é a última imagem.
          </p>
        )}
      </div>
    </div>
  );
}
