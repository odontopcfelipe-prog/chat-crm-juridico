'use client';

/**
 * Conversa da equipe — bolinha no canto de baixo à direita em todas as telas (layout
 * do atendimento); ao clicar abre um balão pequeno no mesmo canto.
 * Canais: Geral + um por setor (qualquer um entra e escreve — é assim que a
 * recepção fala com o Financeiro) e conversa direta, que só os dois veem.
 * Dentista participa: é conversa interna, sem WhatsApp nem dados de contato.
 * Tempo real pelo socket ('team_message'); API em apps/api/src/team-chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeft, ChevronUp, ConciergeBell, HandHeart, Headset, LoaderCircle, Lock, MessageCircleMore, MessagesSquare,
  Search, Send, ShieldCheck, Stethoscope, UserRound, UserRoundPlus, Volume2, VolumeX, Wallet, X,
  type LucideIcon,
} from 'lucide-react';
import api from '@/lib/api';
import { useSocket, useSocketEvent } from '@/lib/SocketProvider';
import { playNotificationSound } from '@/lib/notificationSounds';
import toast from 'react-hot-toast';

type Canal = { id: string; unread: number; following: boolean; mine: boolean; last_at: string | null };
type Pessoa = { id: string; name: string; sector: string; online: boolean; channel: string; unread: number; last_at: string | null };
type Overview = { me: { id: string; sector: string }; channels: Canal[]; people: Pessoa[]; total_unread: number };
type Msg = {
  id: string; channel: string; sender_id: string; sender_name: string; sender_sector: string | null;
  text: string; patient: { id: string; name: string } | null; created_at: string;
};
type PacienteAchado = { id: string; name: string; record_number?: string | null };

const CANAIS: Record<string, { nome: string; icon: LucideIcon; sub: string }> = {
  geral: { nome: 'Geral', icon: MessagesSquare, sub: 'A clínica toda' },
  recepcao: { nome: 'Recepção', icon: ConciergeBell, sub: 'Canal da recepção' },
  dentista: { nome: 'Dentistas', icon: Stethoscope, sub: 'Canal dos dentistas' },
  acd_asb: { nome: 'ACD/ASB', icon: HandHeart, sub: 'Canal das auxiliares' },
  crc: { nome: 'CRC', icon: Headset, sub: 'Canal do comercial' },
  financeiro: { nome: 'Financeiro', icon: Wallet, sub: 'Canal do financeiro' },
  admin: { nome: 'Administração', icon: ShieldCheck, sub: 'Canal da administração' },
};

const SETOR: Record<string, { nome: string; cor: string }> = {
  recepcao: { nome: 'Recepção', cor: '#0ea5e9' },
  dentista: { nome: 'Dentista', cor: '#10b981' },
  acd_asb: { nome: 'ACD/ASB', cor: '#14b8a6' },
  crc: { nome: 'CRC', cor: '#8b5cf6' },
  financeiro: { nome: 'Financeiro', cor: '#f59e0b' },
  admin: { nome: 'Administração', cor: '#f43f5e' },
};

const SOM_KEY = 'equipe_som';

function lerLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function gravarLocal(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* aba privada */ }
}

function iniciais(nome: string): string {
  const p = nome.trim().split(/\s+/).filter((w) => !/^(dr|dra)\.?$/i.test(w));
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '?';
}

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function rotuloDia(iso: string): string {
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date(); ontem.setDate(hoje.getDate() - 1);
  if (d.toDateString() === hoje.toDateString()) return 'Hoje';
  if (d.toDateString() === ontem.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function Avatar({ nome, setor, online, size = 30 }: { nome: string; setor?: string | null; online?: boolean; size?: number }) {
  const cor = SETOR[setor ?? '']?.cor ?? '#64748b';
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        className="inline-flex h-full w-full items-center justify-center rounded-full text-[11px] font-bold text-white"
        style={{ background: cor }}
      >
        {iniciais(nome)}
      </span>
      {online !== undefined && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card ${online ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
        />
      )}
    </span>
  );
}

function Contador({ n, forte = true }: { n: number; forte?: boolean }) {
  if (n <= 0) return null;
  return (
    <span className={`ml-auto min-w-[18px] rounded-full px-1.5 text-center text-[10px] font-bold leading-[18px] ${forte ? 'bg-red-500 text-white' : 'bg-muted text-muted-foreground'}`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

export default function EquipeChat() {
  const { userId, connected } = useSocket();
  const pathname = usePathname() || '';
  // Nas telas de conversa do WhatsApp o canto de baixo é do botão de enviar (a bolinha sobe).
  const telaDeConversa = pathname === '/atendimento' || pathname.startsWith('/atendimento/chat');
  const [aberto, setAberto] = useState(false);
  const [ov, setOv] = useState<Overview | null>(null);
  const [ativo, setAtivo] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [temMais, setTemMais] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [anexo, setAnexo] = useState<PacienteAchado | null>(null);
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState<PacienteAchado[]>([]);
  const [buscandoPac, setBuscandoPac] = useState(false);
  const [filtroPessoas, setFiltroPessoas] = useState('');
  const [som, setSom] = useState(true);
  const [mobile, setMobile] = useState(false);
  // O balão mostra uma coisa de cada vez: a lista (canais + pessoas) ou a conversa.
  const [tela, setTela] = useState<'lista' | 'conversa'>('lista');

  const ativoRef = useRef<string | null>(null);
  const abertoRef = useRef(false);
  const somRef = useRef(true);
  const listaRef = useRef<HTMLDivElement>(null);
  const textoRef = useRef<HTMLTextAreaElement>(null);
  const lerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const ovRef = useRef<Overview | null>(null);
  const buscaReq = useRef(0);
  ativoRef.current = ativo;
  abertoRef.current = aberto;
  somRef.current = som;
  ovRef.current = ov;

  useEffect(() => {
    setSom(lerLocal(SOM_KEY) !== '0');
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const carregarOverview = useCallback(async () => {
    try {
      const r = await api.get<Overview>('/team-chat/overview');
      setOv(r.data);
    } catch { /* sem rede: mantém o que tinha */ }
  }, []);

  useEffect(() => {
    if (userId) carregarOverview(); // e de novo a cada reconexão do socket
  }, [userId, connected, carregarOverview]);

  const marcarLido = useCallback((canal: string) => {
    setOv((o) => o && zerar(o, canal));
    const timers = lerTimers.current;
    const t = timers.get(canal);
    if (t) clearTimeout(t);
    timers.set(canal, setTimeout(() => {
      timers.delete(canal);
      api.post('/team-chat/read', { channel: canal }).catch(() => {});
    }, 300));
  }, []);

  const rolarProFim = useCallback(() => {
    requestAnimationFrame(() => {
      const el = listaRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const abrirCanal = useCallback(async (canal: string) => {
    setAtivo(canal);
    setTela('conversa');
    setMsgs([]);
    setTemMais(false);
    setAnexo(null);
    setBuscaAberta(false);
    setCarregando(true);
    try {
      const r = await api.get<{ messages: Msg[]; has_more: boolean }>('/team-chat/messages', { params: { channel: canal } });
      if (ativoRef.current !== canal) return;
      setMsgs(r.data.messages);
      setTemMais(r.data.has_more);
      rolarProFim();
    } catch {
      if (ativoRef.current === canal) setMsgs([]);
    } finally {
      if (ativoRef.current === canal) setCarregando(false);
    }
    marcarLido(canal);
    setTimeout(() => textoRef.current?.focus(), 50);
  }, [marcarLido, rolarProFim]);

  const verAnteriores = async () => {
    if (!ativo || !msgs.length) return;
    const el = listaRef.current;
    const alturaAntes = el?.scrollHeight ?? 0;
    try {
      const r = await api.get<{ messages: Msg[]; has_more: boolean }>('/team-chat/messages', {
        params: { channel: ativo, before: msgs[0].created_at },
      });
      setMsgs((m) => [...r.data.messages, ...m]);
      setTemMais(r.data.has_more);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - alturaAntes; });
    } catch { /* tenta de novo no próximo clique */ }
  };

  const abrir = () => {
    setAberto(true);
    carregarOverview();
    // Volta pra conversa que estava aberta (recarrega e marca lida); senão, a lista.
    if (tela === 'conversa' && ativo) abrirCanal(ativo);
  };

  useEffect(() => {
    if (!aberto) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [aberto]);

  // ─── Tempo real ─────────────────────────────────────────────────
  useSocketEvent<Msg>('team_message', (m) => {
    const vendo = abertoRef.current && ativoRef.current === m.channel && tela === 'conversa';
    if (vendo) {
      setMsgs((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
      const el = listaRef.current;
      if (!el || el.scrollHeight - el.scrollTop - el.clientHeight < 160 || m.sender_id === userId) rolarProFim();
      if (m.sender_id !== userId) marcarLido(m.channel);
      setOv((o) => o && tocar(o, m.channel, m.created_at));
      return;
    }
    if (m.sender_id === userId) {
      setOv((o) => o && tocar(o, m.channel, m.created_at));
      return;
    }
    const agora = ovRef.current ? somar(ovRef.current, m) : null;
    if (agora && !agora.conhecido) carregarOverview(); // conversa direta com alguém novo na equipe
    setOv((o) => (o ? somar(o, m).ov : o));
    if (agora?.contou && somRef.current) playNotificationSound();
  });

  useSocketEvent<{ userId: string; online: boolean }>('user_presence', ({ userId: id, online }) => {
    setOv((o) => o && { ...o, people: o.people.map((p) => (p.id === id ? { ...p, online } : p)) });
  });

  // ─── Envio ──────────────────────────────────────────────────────
  const enviar = async () => {
    if (!ativo || enviando) return;
    const t = texto.trim();
    if (!t && !anexo) return;
    setEnviando(true);
    try {
      const r = await api.post<Msg>('/team-chat/messages', { channel: ativo, text: t, patient_id: anexo?.id });
      setMsgs((cur) => (cur.some((x) => x.id === r.data.id) ? cur : [...cur, r.data]));
      setTexto('');
      setAnexo(null);
      setBuscaAberta(false);
      rolarProFim();
      setOv((o) => {
        if (!o) return o;
        const t2 = tocar(o, ativo, r.data.created_at);
        return { ...t2, channels: t2.channels.map((c) => (c.id === ativo ? { ...c, following: true } : c)) };
      });
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      toast.error(typeof msg === 'string' ? msg : 'Não foi possível enviar. Tente de novo.');
    } finally {
      setEnviando(false);
      textoRef.current?.focus();
    }
  };

  useEffect(() => {
    const el = textoRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  }, [texto]);

  // ─── Paciente anexado ───────────────────────────────────────────
  useEffect(() => {
    const q = busca.trim();
    if (!buscaAberta || q.length < 2) { setAchados([]); setBuscandoPac(false); return; }
    const id = ++buscaReq.current;
    setBuscandoPac(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get('/patients', { params: { search: q, limit: 8 } });
        if (id !== buscaReq.current) return;
        const lista = Array.isArray(r.data) ? r.data : r.data?.data || [];
        setAchados(lista.map((p: any) => ({ id: p.id, name: p.name, record_number: p.record_number })));
      } catch {
        if (id === buscaReq.current) setAchados([]);
      } finally {
        if (id === buscaReq.current) setBuscandoPac(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [busca, buscaAberta]);

  // ─── Derivados ──────────────────────────────────────────────────
  const total = ov?.total_unread ?? 0;
  const pessoas = useMemo(() => {
    const lista = [...(ov?.people ?? [])].sort((a, b) => {
      if (a.last_at && b.last_at) return b.last_at.localeCompare(a.last_at);
      if (a.last_at || b.last_at) return a.last_at ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name, 'pt-BR');
    });
    const f = filtroPessoas.trim().toLowerCase();
    return f ? lista.filter((p) => p.name.toLowerCase().includes(f)) : lista;
  }, [ov?.people, filtroPessoas]);
  const pessoaAtiva = ativo?.startsWith('dm:') ? ov?.people.find((p) => p.channel === ativo) ?? null : null;
  const canalAtivo = ativo && !ativo.startsWith('dm:') ? CANAIS[ativo] : null;

  if (!userId) return null;

  // ─── Posição: bolinha no canto de baixo à direita; o balão abre logo acima ───
  // Nas telas de conversa do WhatsApp a bolinha sobe pra não cobrir o enviar.
  const tamBolinha = mobile ? 50 : 52;
  const baseBolinha = mobile
    ? 'calc(env(safe-area-inset-bottom, 0px) + 76px)'
    : `${telaDeConversa ? 92 : 20}px`;
  const baseBalao = `calc(${baseBolinha} + ${tamBolinha + 12}px)`;

  const bolinha = (
    <button
      type="button"
      onClick={() => (aberto ? setAberto(false) : abrir())}
      aria-label={aberto ? 'Fechar conversa da equipe' : total ? `Equipe — ${total} mensagens não lidas` : 'Conversa da equipe'}
      title="Conversa da equipe"
      className="fixed right-3.5 z-[61] flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-black/25 transition hover:brightness-110 active:scale-95 md:right-5"
      style={{ bottom: baseBolinha, width: tamBolinha, height: tamBolinha }}
    >
      {aberto ? <X size={22} strokeWidth={2.4} /> : <MessageCircleMore size={24} strokeWidth={2.2} />}
      {!aberto && total > 0 && (
        <span className="absolute -right-1 -top-1 min-w-[20px] rounded-full border-2 border-card bg-red-500 px-1 text-center text-[10px] font-bold leading-4 text-white">
          {total > 99 ? '99+' : total}
        </span>
      )}
    </button>
  );

  if (!aberto) return bolinha;

  // ─── Balão ──────────────────────────────────────────────────────
  const itemCanal = (c: Canal) => {
    const meta = CANAIS[c.id];
    if (!meta) return null;
    const Icon = meta.icon;
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => abrirCanal(c.id)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-foreground transition hover:bg-muted"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Icon size={14} /></span>
        <span className="truncate">{meta.nome}</span>
        {c.mine && <span className="rounded bg-muted px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">seu</span>}
        <Contador n={c.unread} forte={c.following} />
      </button>
    );
  };

  const fechar = (
    <button type="button" onClick={() => setAberto(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Fechar">
      <X size={17} />
    </button>
  );

  return (
    <>
      {bolinha}
      <div
        className="fixed right-2.5 z-[65] flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-black/25 md:right-5"
        style={{
          bottom: baseBalao,
          width: mobile ? 'calc(100vw - 20px)' : 360,
          height: `min(${mobile ? 560 : 520}px, calc(100vh - ${baseBalao} - 16px))`,
        }}
        role="dialog"
        aria-label="Conversa da equipe"
      >
        {tela === 'lista' ? (
          /* ─── Lista: canais + pessoas ─── */
          <>
            <div className="flex items-center gap-2 bg-primary px-4 py-3 text-primary-foreground">
              <MessageCircleMore size={18} />
              <span className="text-[15px] font-bold">Equipe</span>
              <button
                type="button"
                onClick={() => { const v = !som; setSom(v); gravarLocal(SOM_KEY, v ? '1' : '0'); }}
                title={som ? 'Som ligado' : 'Som desligado'}
                className="ml-auto rounded-md p-1.5 text-primary-foreground/80 hover:bg-white/15 hover:text-primary-foreground"
              >
                {som ? <Volume2 size={15} /> : <VolumeX size={15} />}
              </button>
              <button type="button" onClick={() => setAberto(false)} className="rounded-md p-1.5 text-primary-foreground/80 hover:bg-white/15 hover:text-primary-foreground" aria-label="Fechar">
                <X size={17} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-3">
              <p className="px-2.5 pb-1 pt-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Canais</p>
              {ov ? ov.channels.map(itemCanal) : <p className="px-3 py-2 text-xs text-muted-foreground">Carregando…</p>}

              <p className="px-2.5 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Pessoas</p>
              {(ov?.people.length ?? 0) > 8 && (
                <label className="mx-1 mb-1.5 flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5">
                  <Search size={13} className="text-muted-foreground" />
                  <input
                    value={filtroPessoas}
                    onChange={(e) => setFiltroPessoas(e.target.value)}
                    placeholder="Procurar pessoa"
                    className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </label>
              )}
              {pessoas.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => abrirCanal(p.channel)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-muted"
                >
                  <Avatar nome={p.name} setor={p.sector} online={p.online} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">{p.name}</span>
                    <span className="block truncate text-[10.5px] text-muted-foreground">{SETOR[p.sector]?.nome ?? 'Equipe'}</span>
                  </span>
                  <Contador n={p.unread} />
                </button>
              ))}
              {ov && !ov.people.length && <p className="px-3 py-2 text-xs text-muted-foreground">Ninguém mais na equipe ainda.</p>}
            </div>
          </>
        ) : (
          /* ─── Conversa ─── */
          <>
            <header className="flex items-center gap-2 border-b border-border px-2.5 py-2">
              <button type="button" onClick={() => setTela('lista')} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Voltar">
                <ArrowLeft size={18} />
              </button>
              {pessoaAtiva ? (
                <>
                  <Avatar nome={pessoaAtiva.name} setor={pessoaAtiva.sector} online={pessoaAtiva.online} size={30} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-bold text-foreground">{pessoaAtiva.name}</p>
                    <p className="flex items-center gap-1 truncate text-[10.5px] text-muted-foreground">
                      <Lock size={9} className="shrink-0" /> Só vocês dois veem · {pessoaAtiva.online ? 'online' : 'offline'}
                    </p>
                  </div>
                </>
              ) : canalAtivo ? (
                <>
                  <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                    <canalAtivo.icon size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-bold text-foreground">{canalAtivo.nome}</p>
                    <p className="truncate text-[10.5px] text-muted-foreground">
                      {ativo === 'geral' ? 'A clínica toda vê e escreve' : 'Qualquer setor pode escrever'}
                    </p>
                  </div>
                </>
              ) : (
                <p className="flex-1 text-sm text-muted-foreground">Equipe</p>
              )}
              {fechar}
            </header>

            <div ref={listaRef} className="flex-1 overflow-y-auto px-3 py-2">
              {temMais && (
                <button type="button" onClick={verAnteriores} className="mx-auto mb-2 flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted">
                  <ChevronUp size={13} /> Ver mensagens anteriores
                </button>
              )}
              {carregando && (
                <p className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <LoaderCircle size={14} className="animate-spin" /> Carregando…
                </p>
              )}
              {!carregando && ativo && !msgs.length && (
                <p className="py-10 text-center text-xs text-muted-foreground">
                  {pessoaAtiva ? `Mande a primeira mensagem para ${pessoaAtiva.name.split(' ')[0]}.` : 'Nenhuma mensagem ainda. Comece a conversa.'}
                </p>
              )}
              {msgs.map((m, i) => {
                const ant = msgs[i - 1];
                const novoDia = !ant || new Date(ant.created_at).toDateString() !== new Date(m.created_at).toDateString();
                const agrupa = !novoDia && ant && ant.sender_id === m.sender_id
                  && new Date(m.created_at).getTime() - new Date(ant.created_at).getTime() < 5 * 60_000;
                const meu = m.sender_id === userId;
                return (
                  <div key={m.id}>
                    {novoDia && (
                      <div className="my-2.5 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />{rotuloDia(m.created_at)}<span className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <div className={`flex gap-2 ${agrupa ? 'mt-0.5' : 'mt-2.5'} ${meu ? 'flex-row-reverse' : ''}`}>
                      {!meu && (
                        <span className="w-[26px] shrink-0">
                          {!agrupa && <Avatar nome={m.sender_name} setor={m.sender_sector} size={26} />}
                        </span>
                      )}
                      <div className={`flex min-w-0 max-w-[82%] flex-col ${meu ? 'items-end' : 'items-start'}`}>
                        {!agrupa && (
                          <p className="mb-0.5 truncate text-[10.5px] text-muted-foreground">
                            {!meu && <b className="font-semibold text-foreground">{m.sender_name}</b>}
                            {!meu && m.sender_sector && !pessoaAtiva && <> · {SETOR[m.sender_sector]?.nome}</>}
                            {!meu && ' · '}{hora(m.created_at)}
                          </p>
                        )}
                        {m.text && (
                          <div className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[13px] leading-snug ${meu ? 'rounded-tr-md bg-primary text-primary-foreground' : 'rounded-tl-md bg-muted text-foreground'}`}>
                            {m.text}
                          </div>
                        )}
                        {m.patient && (
                          <div className="mt-1 flex max-w-full items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-1.5 shadow-sm">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary"><UserRound size={14} /></span>
                            <span className="min-w-0">
                              <span className="block text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">Paciente</span>
                              <span className="block truncate text-[12.5px] font-semibold text-foreground">{m.patient.name}</span>
                            </span>
                            <Link
                              href={`/atendimento/pacientes/${m.patient.id}`}
                              onClick={() => { if (mobile) setAberto(false); }}
                              className="ml-1 shrink-0 rounded-lg bg-primary px-2 py-1 text-[10.5px] font-semibold text-primary-foreground hover:brightness-110"
                            >
                              Abrir ficha
                            </Link>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {ativo && (
              <div className="relative border-t border-border px-2.5 pb-2.5 pt-2">
                {buscaAberta && (
                  <div className="absolute bottom-full left-2.5 right-2.5 mb-2 rounded-xl border border-border bg-card p-2 shadow-xl">
                    <label className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5">
                      <Search size={14} className="text-muted-foreground" />
                      <input
                        autoFocus
                        value={busca}
                        onChange={(e) => setBusca(e.target.value)}
                        placeholder="Anexar paciente: nome, CPF ou ficha"
                        className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                      />
                      <button type="button" onClick={() => setBuscaAberta(false)} className="text-muted-foreground hover:text-foreground" aria-label="Fechar busca"><X size={14} /></button>
                    </label>
                    <div className="mt-1 max-h-48 overflow-y-auto">
                      {busca.trim().length < 2 && <p className="px-2 py-2 text-[11px] text-muted-foreground">Digite ao menos 2 letras.</p>}
                      {achados.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => { setAnexo(p); setBuscaAberta(false); setBusca(''); textoRef.current?.focus(); }}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
                        >
                          <UserRound size={14} className="text-muted-foreground" />
                          <span className="truncate">{p.name}</span>
                          {p.record_number && <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">ficha {p.record_number}</span>}
                        </button>
                      ))}
                      {busca.trim().length >= 2 && buscandoPac && !achados.length && <p className="px-2 py-2 text-[11px] text-muted-foreground">Procurando…</p>}
                      {busca.trim().length >= 2 && !buscandoPac && !achados.length && <p className="px-2 py-2 text-[11px] text-muted-foreground">Nenhum paciente encontrado.</p>}
                    </div>
                  </div>
                )}
                {anexo && (
                  <div className="mb-2 flex w-fit max-w-full items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-[12px] text-foreground">
                    <UserRound size={13} className="text-primary" />
                    <span className="truncate">{anexo.name}</span>
                    <button type="button" onClick={() => setAnexo(null)} className="text-muted-foreground hover:text-foreground" aria-label="Tirar paciente"><X size={13} /></button>
                  </div>
                )}
                <div className="flex items-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setBuscaAberta((v) => !v)}
                    title="Anexar paciente"
                    className={`mb-0.5 rounded-lg p-2 transition ${buscaAberta ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                  >
                    <UserRoundPlus size={18} />
                  </button>
                  <textarea
                    ref={textoRef}
                    rows={1}
                    value={texto}
                    onChange={(e) => setTexto(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } }}
                    placeholder={pessoaAtiva ? `Mensagem para ${pessoaAtiva.name.split(' ')[0]}` : `Mensagem para ${canalAtivo?.nome ?? 'a equipe'}`}
                    maxLength={2000}
                    className="min-h-[38px] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-[13px] leading-snug text-foreground outline-none focus:border-primary placeholder:text-muted-foreground"
                  />
                  <button
                    type="button"
                    onClick={enviar}
                    disabled={enviando || (!texto.trim() && !anexo)}
                    aria-label="Enviar"
                    className="mb-0.5 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:brightness-110 disabled:opacity-40"
                  >
                    {enviando ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ─── Contadores no cliente (espelham a regra do servidor) ─────────

function recalcular(o: Overview): Overview {
  const total = o.channels.reduce((s, c) => s + (c.following ? c.unread : 0), 0) + o.people.reduce((s, p) => s + p.unread, 0);
  return { ...o, total_unread: total };
}

function zerar(o: Overview, canal: string): Overview {
  return recalcular({
    ...o,
    channels: o.channels.map((c) => (c.id === canal ? { ...c, unread: 0, following: true } : c)),
    people: o.people.map((p) => (p.channel === canal ? { ...p, unread: 0 } : p)),
  });
}

function tocar(o: Overview, canal: string, at: string): Overview {
  return {
    ...o,
    channels: o.channels.map((c) => (c.id === canal ? { ...c, last_at: at } : c)),
    people: o.people.map((p) => (p.channel === canal ? { ...p, last_at: at } : p)),
  };
}

/** Mensagem de outra pessoa chegou com o canal fechado: soma se eu acompanho. */
function somar(o: Overview, m: Msg): { ov: Overview; contou: boolean; conhecido: boolean } {
  if (m.channel.startsWith('dm:')) {
    const p = o.people.find((x) => x.channel === m.channel);
    if (!p) return { ov: o, contou: false, conhecido: false };
    return {
      ov: recalcular({ ...o, people: o.people.map((x) => (x === p ? { ...x, unread: x.unread + 1, last_at: m.created_at } : x)) }),
      contou: true,
      conhecido: true,
    };
  }
  const c = o.channels.find((x) => x.id === m.channel);
  if (!c) return { ov: o, contou: false, conhecido: true };
  return {
    ov: recalcular({
      ...o,
      channels: o.channels.map((x) => (x === c ? { ...x, unread: x.following ? x.unread + 1 : x.unread, last_at: m.created_at } : x)),
    }),
    contou: c.following,
    conhecido: true,
  };
}
