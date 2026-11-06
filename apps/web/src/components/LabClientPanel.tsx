'use client';

/**
 * F5 do laboratório — painel do contato na conta de LABORATÓRIO. Abre pelo nome do
 * contato no chat e em Contatos, no lugar do painel da clínica: o ClientPanel escolhe
 * pelo tipo de negócio e repassa as mesmas props (mais o endereço da ficha).
 *
 * Mostra nome e e-mail (editáveis), telefone, atendente, notas internas e histórico.
 * Seção "Cobranças avulsas" (LabCobrancaAvulsa): o valor combinado com o cliente, em
 * parcelas, que vira boleto na conta Asaas do próprio laboratório.
 * Ações: "Ver ficha do cliente" (quando o contato já tem cadastro), "Tornar cliente"
 * (cadastra em Dentistas com a regra do cadastro manual: sem etapa, setor, IA nem
 * mensagem), "Abrir no chat" e "Excluir contato" (só administrador).
 * Fica de fora o que é da clínica: memória da IA, banco de documentos e pasta do
 * Drive, ficha trabalhista e casos jurídicos.
 *
 * Só o laboratório monta este componente, então todo texto visível vem de
 * lab-contato-textos.ts. O spec lab-arquivos-do-lab confere que nenhum texto daqui
 * tem palavra de clínica e que nenhuma chamada vai para rota só de clínica.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  Send,
  StickyNote,
  Trash2,
  User,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { formatPhone } from '@/lib/utils';
import { rotuloEtapaLab } from '@/lib/lab-etapa';
import { LAB_CONTATO } from '@/app/atendimento/components/lab-contato-textos';
import { LabCobrancaAvulsa } from '@/components/LabCobrancaAvulsa';

export interface LabClientPanelProps {
  leadId: string;
  onClose: () => void;
  onLightbox: (url: string) => void;
  isAdmin?: boolean;
  onDeleteSuccess?: (id: string) => void;
  /** Z-index base do modal (backdrop usa zBase-10). Padrão: 100 */
  zBase?: number;
  /** Endereço da ficha do cliente. Sem ele, o botão "Ver ficha do cliente" não aparece. */
  fichaDoCliente?: (clienteId: string) => string;
}

interface ConversaDoContato {
  id: string;
  last_message_at?: string | null;
  assigned_user?: { id: string; name: string } | null;
}

interface ContatoDetalhe {
  id: string;
  name?: string | null;
  phone: string;
  email?: string | null;
  created_at: string;
  profile_picture_url?: string | null;
  is_client?: boolean;
  conversations?: ConversaDoContato[];
}

interface NotaDoContato {
  id: string;
  text: string;
  created_at: string;
  user?: { id: string; name: string } | null;
}

interface ItemDoHistorico {
  type: string;
  id: string;
  from_stage?: string | null;
  to_stage?: string;
  actor?: { id: string; name: string } | null;
  loss_reason?: string | null;
  text?: string;
  author?: { id: string; name: string } | null;
  created_at: string;
}

type CampoEditavel = 'name' | 'email';

const soDigitos = (v?: string | null) => (v || '').replace(/\D/g, '');

/** Nome vazio ou igual ao telefone (contato que chegou pelo WhatsApp sem nome salvo). */
function nomeEhTelefone(c: ContatoDetalhe): boolean {
  const nome = (c.name || '').trim();
  if (!nome) return true;
  const digitos = soDigitos(nome);
  return digitos !== '' && digitos === soDigitos(c.phone);
}

/** Conversa mais recente: a de mensagem mais nova primeiro; sem data vai para o fim. */
function conversaMaisRecente(conversas?: ConversaDoContato[]): ConversaDoContato | null {
  const tempo = (c: ConversaDoContato) => (c.last_message_at ? new Date(c.last_message_at).getTime() : 0);
  return [...(conversas || [])].sort((a, b) => tempo(b) - tempo(a))[0] ?? null;
}

/** Nome da etapa como o chat mostra (crmStages); valor desconhecido aparece como veio. */
function rotuloDaEtapa(etapa?: string | null): string {
  if (!etapa) return '';
  return rotuloEtapaLab(etapa);
}

function dataCurta(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function dataHora(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Mensagem que a API devolveu (string ou lista do ValidationPipe); null quando não há. */
function mensagemDoServidor(e: unknown): string | null {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (Array.isArray(m)) {
    const texto = m.filter((x): x is string => typeof x === 'string').join(', ');
    return texto || null;
  }
  return null;
}

/** Cadastro do cliente ligado ao contato (null = sem cadastro). */
async function buscarCadastro(leadId: string): Promise<{ id: string } | null> {
  const { data } = await api.get<{ id?: string } | null>(`/patients/by-lead/${leadId}`);
  return data && typeof data === 'object' && data.id ? { id: data.id } : null;
}

export function LabClientPanel({
  leadId,
  onClose,
  onLightbox,
  isAdmin = false,
  onDeleteSuccess,
  zBase = 100,
  fichaDoCliente,
}: LabClientPanelProps) {
  const router = useRouter();
  const [contato, setContato] = useState<ContatoDetalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [editando, setEditando] = useState<CampoEditavel | null>(null);
  const [salvando, setSalvando] = useState(false);
  // Cadastro do cliente ligado a este contato: undefined enquanto a busca não volta.
  const [cadastro, setCadastro] = useState<{ id: string } | null | undefined>(undefined);
  const [tornando, setTornando] = useState(false);
  const [abrindoChat, setAbrindoChat] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);
  const [excluindo, setExcluindo] = useState(false);

  // Notas internas
  const [notasAbertas, setNotasAbertas] = useState(false);
  const [notas, setNotas] = useState<NotaDoContato[]>([]);
  const [textoDaNota, setTextoDaNota] = useState('');
  const [salvandoNota, setSalvandoNota] = useState(false);
  const [excluindoNotaId, setExcluindoNotaId] = useState<string | null>(null);

  // Histórico (mudanças de etapa e notas); null = ainda não carregado
  const [historicoAberto, setHistoricoAberto] = useState(false);
  const [historico, setHistorico] = useState<ItemDoHistorico[] | null>(null);
  const [carregandoHistorico, setCarregandoHistorico] = useState(false);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setContato(null);
    setCadastro(undefined);
    setEditando(null);
    setConfirmandoExclusao(false);
    setNotasAbertas(false);
    setNotas([]);
    setHistoricoAberto(false);
    setHistorico(null);
    buscarCadastro(leadId)
      .then((c) => {
        if (vivo) setCadastro(c);
      })
      .catch(() => {
        if (vivo) setCadastro(null);
      });
    api
      .get<ContatoDetalhe>(`/leads/${leadId}`)
      .then((r) => {
        if (!vivo) return;
        setContato(r.data || null);
        setCarregando(false);
      })
      .catch(() => {
        if (!vivo) return;
        setContato(null);
        setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [leadId]);

  // Notas: carrega quando a seção abre (de novo a cada abertura).
  useEffect(() => {
    if (!notasAbertas) return;
    let vivo = true;
    api
      .get<NotaDoContato[]>(`/leads/${leadId}/notes`)
      .then((r) => {
        if (vivo) setNotas(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [notasAbertas, leadId]);

  // Histórico: carrega quando a seção abre e depois de mexer numa nota.
  useEffect(() => {
    if (!historicoAberto || historico !== null) return;
    let vivo = true;
    setCarregandoHistorico(true);
    api
      .get<ItemDoHistorico[]>(`/leads/${leadId}/timeline`)
      .then((r) => {
        if (!vivo) return;
        const itens = Array.isArray(r.data) ? r.data : [];
        setHistorico(itens.filter((i) => i.type === 'stage_change' || i.type === 'note'));
        setCarregandoHistorico(false);
      })
      .catch(() => {
        if (!vivo) return;
        setHistorico([]);
        setCarregandoHistorico(false);
      });
    return () => {
      vivo = false;
    };
  }, [historicoAberto, historico, leadId]);

  const salvarCampo = async (campo: CampoEditavel, valor: string) => {
    if (!contato) return;
    const atual = ((campo === 'name' ? contato.name : contato.email) || '').trim();
    if (valor === atual || (campo === 'name' && !valor)) {
      setEditando(null);
      return;
    }
    setSalvando(true);
    try {
      const novo = valor || null;
      await api.patch(`/leads/${leadId}`, { [campo]: novo });
      setContato((c) => (c ? { ...c, [campo]: novo } : c));
      setEditando(null);
    } catch (e) {
      showError(mensagemDoServidor(e) ?? LAB_CONTATO.erroAoSalvar);
    } finally {
      setSalvando(false);
    }
  };

  // Tornar cliente: no laboratório a rota cria o cadastro (em Dentistas) e marca o
  // contato como cliente, sem mudar etapa nem setor.
  const tornarCliente = async () => {
    if (!contato || tornando) return;
    setTornando(true);
    try {
      const { data } = await api.post<{ ok?: boolean } | null>(`/leads/${leadId}/promote-to-client`);
      if (data && data.ok === false) {
        showError(LAB_CONTATO.erroAoTornarCliente);
        return;
      }
      setContato((c) => (c ? { ...c, is_client: true } : c));
      setCadastro(await buscarCadastro(leadId).catch(() => null));
      showSuccess(LAB_CONTATO.virouCliente);
    } catch (e) {
      showError(mensagemDoServidor(e) ?? LAB_CONTATO.erroAoTornarCliente);
    } finally {
      setTornando(false);
    }
  };

  const abrirNoChat = async () => {
    if (!contato || abrindoChat) return;
    setAbrindoChat(true);
    let convId = conversaMaisRecente(contato.conversations)?.id;
    // Sem conversa: cria uma (o servidor escolhe o chip) ou acha a que já existe.
    if (!convId && contato.phone) {
      try {
        const res = await api.post<{ id?: string }>('/conversations', { lead_id: contato.id, channel: 'whatsapp' });
        convId = res.data?.id;
      } catch {
        try {
          const res = await api.get(`/conversations?leadId=${contato.id}&limit=1`);
          const lista: Array<{ id?: string }> = Array.isArray(res.data) ? res.data : res.data?.data ?? [];
          convId = lista[0]?.id;
        } catch {
          // sem conversa
        }
      }
    }
    setAbrindoChat(false);
    if (!convId) {
      showError(LAB_CONTATO.erroAoAbrirChat);
      return;
    }
    sessionStorage.setItem('crm_open_conv', convId);
    router.push('/atendimento');
    onClose();
  };

  const excluirContato = async () => {
    if (!contato) return;
    setExcluindo(true);
    try {
      await api.delete(`/leads/${contato.id}`);
      onDeleteSuccess?.(contato.id);
      onClose();
    } catch (e) {
      showError(mensagemDoServidor(e) ?? LAB_CONTATO.erroAoExcluir);
      setConfirmandoExclusao(false);
    } finally {
      setExcluindo(false);
    }
  };

  const salvarNota = async () => {
    const texto = textoDaNota.trim();
    if (!texto || salvandoNota) return;
    setSalvandoNota(true);
    try {
      const res = await api.post<NotaDoContato>(`/leads/${leadId}/notes`, { text: texto });
      setNotas((prev) => [res.data, ...prev]);
      setTextoDaNota('');
      setHistorico(null);
    } catch (e) {
      showError(mensagemDoServidor(e) ?? LAB_CONTATO.erroAoSalvarNota);
    } finally {
      setSalvandoNota(false);
    }
  };

  const excluirNota = async (id: string) => {
    if (!window.confirm(LAB_CONTATO.confirmarExcluirNota)) return;
    setExcluindoNotaId(id);
    try {
      await api.delete(`/leads/${leadId}/notes/${id}`);
      setNotas((prev) => prev.filter((n) => n.id !== id));
      setHistorico(null);
    } catch (e) {
      showError(mensagemDoServidor(e) ?? LAB_CONTATO.erroAoExcluirNota);
    } finally {
      setExcluindoNotaId(null);
    }
  };

  const atendente = conversaMaisRecente(contato?.conversations)?.assigned_user ?? null;
  const ehCliente = !!contato?.is_client || !!cadastro;
  const semNomeProprio = contato ? nomeEhTelefone(contato) : true;
  const fotoUrl = contato?.profile_picture_url || null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-[3px]" style={{ zIndex: zBase - 10 }} onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] max-w-[95vw] max-h-[90vh] bg-card border border-border rounded-2xl shadow-2xl flex flex-col animate-in fade-in zoom-in-95 duration-200"
        style={{ zIndex: zBase }}
      >
        {/* Cabeçalho */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-[15px] font-bold text-foreground">
            {ehCliente ? LAB_CONTATO.tituloCliente : LAB_CONTATO.tituloContato}
          </h2>
          <div className="flex items-center gap-2">
            {salvando && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
            <button
              type="button"
              onClick={onClose}
              title={LAB_CONTATO.fechar}
              aria-label={LAB_CONTATO.fechar}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {carregando ? (
          <div className="flex-1 flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : !contato ? (
          <div className="flex-1 flex items-center justify-center py-16 text-muted-foreground text-sm">
            {LAB_CONTATO.erroAoCarregar}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* Identidade */}
            <div className="px-6 py-6">
              <div className="flex items-start gap-4">
                <button
                  type="button"
                  disabled={!fotoUrl}
                  onClick={fotoUrl ? () => onLightbox(fotoUrl) : undefined}
                  className={`w-20 h-20 rounded-2xl bg-primary/10 border border-border flex items-center justify-center overflow-hidden shrink-0 shadow-md ${fotoUrl ? 'cursor-pointer hover:opacity-80 transition-opacity' : 'cursor-default'}`}
                >
                  {fotoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={fotoUrl} alt={contato.name || ''} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-primary font-bold text-3xl">{(contato.name || '?').charAt(0).toUpperCase()}</span>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {editando === 'name' ? (
                      <CampoEmLinha
                        valor={contato.name || ''}
                        placeholder={LAB_CONTATO.nomePlaceholder}
                        onSalvar={(v) => salvarCampo('name', v)}
                        onCancelar={() => setEditando(null)}
                      />
                    ) : (
                      <>
                        <h3 className="text-[18px] font-bold text-foreground leading-tight truncate">
                          {contato.name || LAB_CONTATO.semNome}
                        </h3>
                        <span
                          className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold border ${ehCliente ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' : 'bg-foreground/[0.04] text-muted-foreground border-border'}`}
                        >
                          {ehCliente ? LAB_CONTATO.seloCliente : LAB_CONTATO.seloContato}
                        </span>
                        <button
                          type="button"
                          onClick={() => setEditando('name')}
                          title={LAB_CONTATO.editarNome}
                          aria-label={LAB_CONTATO.editarNome}
                          className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                        >
                          <Pencil size={13} />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="mt-3 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <Phone size={13} className="shrink-0" />
                      <span className="font-mono">{formatPhone(contato.phone)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground min-w-0">
                      <Mail size={13} className="shrink-0" />
                      {editando === 'email' ? (
                        <CampoEmLinha
                          tipo="email"
                          valor={contato.email || ''}
                          placeholder={LAB_CONTATO.emailPlaceholder}
                          onSalvar={(v) => salvarCampo('email', v)}
                          onCancelar={() => setEditando(null)}
                        />
                      ) : (
                        <>
                          <span className="truncate">
                            {contato.email || <span className="italic opacity-50">{LAB_CONTATO.semEmail}</span>}
                          </span>
                          <button
                            type="button"
                            onClick={() => setEditando('email')}
                            title={LAB_CONTATO.editarEmail}
                            aria-label={LAB_CONTATO.editarEmail}
                            className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                          >
                            <Pencil size={11} />
                          </button>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <UserCheck size={13} className="shrink-0" />
                      {atendente ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-bold border border-primary/20">
                          <span className="w-4 h-4 rounded-full bg-primary/20 flex items-center justify-center text-[9px] font-bold">
                            {atendente.name.charAt(0).toUpperCase()}
                          </span>
                          {atendente.name}
                        </span>
                      ) : (
                        <span className="italic opacity-40">{LAB_CONTATO.semAtendente}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <Calendar size={13} className="shrink-0" />
                      <span>{LAB_CONTATO.desde(dataCurta(contato.created_at))}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Notas internas */}
            <Secao
              icone={<StickyNote size={15} className="text-sky-400" />}
              titulo={LAB_CONTATO.notas}
              contagem={notas.length}
              aberta={notasAbertas}
              onAlternar={() => setNotasAbertas((v) => !v)}
            >
              <div className="flex flex-col gap-3">
                <div className="flex gap-2 items-end">
                  <textarea
                    value={textoDaNota}
                    onChange={(e) => setTextoDaNota(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) salvarNota();
                    }}
                    placeholder={LAB_CONTATO.notaPlaceholder}
                    rows={2}
                    className="flex-1 resize-none bg-foreground/[0.04] border border-border rounded-xl px-3 py-2 text-[12px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-sky-400/30"
                  />
                  <button
                    type="button"
                    onClick={salvarNota}
                    disabled={!textoDaNota.trim() || salvandoNota}
                    title={LAB_CONTATO.salvarNota}
                    aria-label={LAB_CONTATO.salvarNota}
                    className="h-9 px-3 rounded-xl bg-sky-500/15 text-sky-400 border border-sky-500/20 hover:bg-sky-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-[12px] font-medium shrink-0"
                  >
                    {salvandoNota ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  </button>
                </div>
                {notas.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground/50 italic text-center py-3">{LAB_CONTATO.semNotas}</p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {notas.map((nota) => (
                      <div key={nota.id} className="group bg-foreground/[0.03] border border-border rounded-xl p-3.5 relative">
                        <div className="flex items-center justify-between gap-2 mb-1.5 pr-6">
                          <span className="text-[11px] font-bold text-sky-400">{nota.user?.name ?? ''}</span>
                          <span className="text-[10px] text-muted-foreground/60">{dataHora(nota.created_at)}</span>
                        </div>
                        <p className="text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">{nota.text}</p>
                        <button
                          type="button"
                          onClick={() => excluirNota(nota.id)}
                          disabled={excluindoNotaId === nota.id}
                          title={LAB_CONTATO.excluirNota}
                          aria-label={LAB_CONTATO.excluirNota}
                          className="absolute top-2.5 right-2.5 w-6 h-6 flex items-center justify-center rounded-md text-red-400 opacity-60 group-hover:opacity-100 hover:bg-red-400/10 transition-all"
                        >
                          {excluindoNotaId === nota.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Secao>

            {/* Histórico */}
            <Secao
              icone={<Clock size={15} className="text-sky-400" />}
              titulo={LAB_CONTATO.historico}
              contagem={historico?.length ?? 0}
              aberta={historicoAberto}
              onAlternar={() => setHistoricoAberto((v) => !v)}
            >
              {carregandoHistorico || historico === null ? (
                <div className="flex justify-center py-4">
                  <Loader2 size={16} className="animate-spin text-muted-foreground" />
                </div>
              ) : historico.length === 0 ? (
                <p className="text-[12px] text-muted-foreground/50 italic text-center py-3">{LAB_CONTATO.semHistorico}</p>
              ) : (
                <div className="relative">
                  <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />
                  <div className="space-y-4">
                    {historico.map((item) => (
                      <div key={item.id} className="flex gap-3 items-start pl-8 relative">
                        <div className="absolute left-0 w-6 h-6 rounded-full border border-sky-500/40 bg-sky-500/10 flex items-center justify-center shrink-0">
                          {item.type === 'stage_change' ? (
                            <ArrowRight size={10} className="text-sky-400" />
                          ) : (
                            <StickyNote size={10} className="text-sky-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          {item.type === 'stage_change' ? (
                            <p className="text-[12px] text-foreground leading-snug">
                              {item.from_stage ? (
                                <>
                                  <span className="text-muted-foreground">{rotuloDaEtapa(item.from_stage)}</span>
                                  <span className="mx-1.5 text-muted-foreground/50">→</span>
                                  <span className="font-semibold text-sky-400">{rotuloDaEtapa(item.to_stage)}</span>
                                </>
                              ) : (
                                <span className="text-muted-foreground">
                                  {LAB_CONTATO.iniciadoEm}{' '}
                                  <span className="text-foreground font-semibold">{rotuloDaEtapa(item.to_stage)}</span>
                                </span>
                              )}
                              {item.loss_reason && <span className="ml-1 text-red-400 text-[11px]">— {item.loss_reason}</span>}
                            </p>
                          ) : (
                            <p className="text-[12px] text-foreground bg-sky-500/5 border border-sky-500/15 rounded-lg px-2.5 py-1.5 leading-snug whitespace-pre-wrap">
                              {item.text}
                            </p>
                          )}
                          <p className="text-[10px] text-muted-foreground/50 mt-1">
                            {item.type === 'stage_change' ? item.actor?.name ?? LAB_CONTATO.sistema : item.author?.name ?? ''}
                            {' · '}
                            {dataHora(item.created_at)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Secao>

            {/* Cobranças avulsas */}
            <LabCobrancaAvulsa leadId={leadId} />
          </div>
        )}

        {/* Rodapé */}
        {contato && (
          <div className="px-6 py-4 border-t border-border shrink-0 space-y-2">
            {cadastro && fichaDoCliente && (
              <button
                type="button"
                className="w-full py-2.5 rounded-xl bg-emerald-600 text-white text-[13px] font-semibold flex items-center justify-center gap-2 hover:bg-emerald-700 transition-colors shadow-sm"
                onClick={() => {
                  router.push(fichaDoCliente(cadastro.id));
                  onClose();
                }}
              >
                <User size={15} />
                {LAB_CONTATO.verFicha}
              </button>
            )}
            {cadastro === null && !contato.is_client && (
              <button
                type="button"
                onClick={tornarCliente}
                disabled={tornando || semNomeProprio}
                title={semNomeProprio ? LAB_CONTATO.dicaSemNome : LAB_CONTATO.dicaTornarCliente}
                className="w-full py-2.5 rounded-xl bg-violet-600 text-white text-[13px] font-semibold flex items-center justify-center gap-2 hover:bg-violet-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {tornando ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
                {LAB_CONTATO.tornarCliente}
              </button>
            )}
            {cadastro === null && !contato.is_client && semNomeProprio && (
              <p className="text-[11px] text-muted-foreground text-center">{LAB_CONTATO.dicaSemNome}</p>
            )}
            <button
              type="button"
              onClick={abrirNoChat}
              disabled={abrindoChat}
              className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-[13px] font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 transition-colors shadow-sm disabled:opacity-60"
            >
              {abrindoChat ? <Loader2 size={15} className="animate-spin" /> : <MessageSquare size={15} />}
              {LAB_CONTATO.abrirNoChat}
            </button>
            {isAdmin &&
              (!confirmandoExclusao ? (
                <button
                  type="button"
                  onClick={() => setConfirmandoExclusao(true)}
                  className="w-full py-2 rounded-xl border border-destructive/30 text-destructive text-[12px] font-semibold flex items-center justify-center gap-2 hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 size={13} />
                  {LAB_CONTATO.excluirContato}
                </button>
              ) : (
                <div className="p-3 bg-destructive/5 border border-destructive/30 rounded-xl space-y-2">
                  <p className="text-[11px] font-bold text-destructive flex items-center gap-1.5">
                    <AlertCircle size={13} />
                    {LAB_CONTATO.atencao}
                  </p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{LAB_CONTATO.avisoExclusao}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={excluirContato}
                      disabled={excluindo}
                      className="flex-1 py-2 text-[12px] font-bold bg-destructive text-white rounded-lg hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 transition-opacity"
                    >
                      {excluindo ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      {excluindo ? LAB_CONTATO.excluindo : LAB_CONTATO.confirmarExclusao}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmandoExclusao(false)}
                      disabled={excluindo}
                      className="px-4 py-2 text-[12px] text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
                    >
                      {LAB_CONTATO.cancelar}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Seção que abre e fecha (notas, histórico). */
function Secao({
  icone,
  titulo,
  contagem,
  aberta,
  onAlternar,
  children,
}: {
  icone: ReactNode;
  titulo: string;
  contagem: number;
  aberta: boolean;
  onAlternar: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-border">
      <button
        type="button"
        aria-expanded={aberta}
        onClick={onAlternar}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-accent/30 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          {icone}
          <span className="text-[13px] font-bold text-foreground">{titulo}</span>
          {contagem > 0 && (
            <span className="text-[11px] text-muted-foreground bg-foreground/[0.06] px-2 py-0.5 rounded-full font-mono">{contagem}</span>
          )}
        </div>
        {aberta ? <ChevronUp size={15} className="text-muted-foreground" /> : <ChevronDown size={15} className="text-muted-foreground" />}
      </button>
      {aberta && <div className="px-6 pb-5">{children}</div>}
    </div>
  );
}

/** Campo editável em linha: Enter salva, Esc cancela. */
function CampoEmLinha({
  valor,
  placeholder,
  tipo = 'text',
  onSalvar,
  onCancelar,
}: {
  valor: string;
  placeholder: string;
  tipo?: 'text' | 'email';
  onSalvar: (v: string) => void;
  onCancelar: () => void;
}) {
  const [v, setV] = useState(valor);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const aoTeclar = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onSalvar(v.trim());
    if (e.key === 'Escape') onCancelar();
  };
  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <input
        ref={ref}
        type={tipo}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={aoTeclar}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-background border border-primary/40 rounded-lg px-2.5 py-1 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-primary/20"
      />
      <button
        type="button"
        onClick={() => onSalvar(v.trim())}
        title={LAB_CONTATO.salvar}
        aria-label={LAB_CONTATO.salvar}
        className="w-6 h-6 flex items-center justify-center rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors shrink-0"
      >
        <Check size={12} />
      </button>
      <button
        type="button"
        onClick={onCancelar}
        title={LAB_CONTATO.cancelar}
        aria-label={LAB_CONTATO.cancelar}
        className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground transition-colors shrink-0"
      >
        <X size={12} />
      </button>
    </div>
  );
}
