'use client';

/**
 * F11 do laboratório — convites de cadastro (SUPER_ADMIN, /admin/lista-espera).
 *
 * O convite libera o /cadastrar do laboratório para UMA conta. O link sai uma vez só,
 * no passo 2 do modal: o servidor guarda só o hash do código, e esta tela não grava o
 * link em lugar nenhum (nada de localStorage, console, aviso ou endereço da página).
 * Ao fechar o modal, o link some; se perder, revoga e cria outro.
 *
 * Todo texto visível vem de ../lab-cadastro-admin-textos (LAB_CONVITES_ADMIN).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle, CheckCircle2, Copy, ExternalLink, Info, Loader2, MessageSquare, Plus, RefreshCw, Send, X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { LAB_CONVITES_ADMIN } from '../lab-cadastro-admin-textos';

const T = LAB_CONVITES_ADMIN;
const ROTA_CONVITES = '/plataforma/cadastro-laboratorio/convites';

export type SituacaoConvite = 'VALIDO' | 'USADO' | 'VENCIDO' | 'REVOGADO';

/** Item da lista de convites (GET /plataforma/cadastro-laboratorio/convites). Nunca traz o código. */
export interface ConviteLaboratorio {
  id: string;
  email: string | null;
  lab_name: string | null;
  waitlist_entry_id: string | null;
  created_by_user_id: string | null;
  criado_por_nome: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  tenant_id: string | null;
  tenant_nome: string | null;
  situacao: SituacaoConvite;
}

/** Resposta do POST de criação: a única vez que o link aparece. */
export interface ConviteCriado {
  convite: ConviteLaboratorio;
  codigo: string;
  link: string;
}

export interface PedidoDeConvite {
  waitlist_entry_id?: string;
  lab_name?: string;
  email?: string;
}

/** O que o modal usa da inscrição da lista de espera. */
export interface InscricaoParaConvite {
  id: string;
  lab_name: string;
  phone: string | null;
  email: string | null;
}

const SITUACOES: readonly SituacaoConvite[] = ['VALIDO', 'USADO', 'VENCIDO', 'REVOGADO'];

/** A situação vem do servidor; se faltar, mesma precedência dele: USADO > REVOGADO > VENCIDO > VALIDO. */
export function situacaoDe(c: ConviteLaboratorio, agora: number = Date.now()): SituacaoConvite {
  if (SITUACOES.includes(c.situacao)) return c.situacao;
  if (c.used_at) return 'USADO';
  if (c.revoked_at) return 'REVOGADO';
  const vence = new Date(c.expires_at).getTime();
  if (Number.isFinite(vence) && vence <= agora) return 'VENCIDO';
  return 'VALIDO';
}

const quando = (iso: string | null | undefined): number => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Convite que representa a inscrição: USADO > VALIDO > o mais recente. */
export function conviteDaInscricao(
  convites: ConviteLaboratorio[] | null | undefined,
  entryId: string,
): ConviteLaboratorio | null {
  if (!convites) return null;
  const daInscricao = convites.filter((c) => c.waitlist_entry_id === entryId);
  return (
    daInscricao.find((c) => situacaoDe(c) === 'USADO') ??
    daInscricao.find((c) => situacaoDe(c) === 'VALIDO') ??
    daInscricao.reduce<ConviteLaboratorio | null>((m, c) => (!m || quando(c.created_at) > quando(m.created_at) ? c : m), null)
  );
}

/** Mensagem do servidor: string, ou string[] do ValidationPipe; senão o padrão. */
export function msgErro(err: unknown, padrao: string): string {
  const m = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (Array.isArray(m)) {
    const partes = m.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (partes.length) return partes.join(', ');
  }
  return padrao;
}

const statusDe = (err: unknown): number | undefined =>
  (err as { response?: { status?: number } })?.response?.status;

/** Só os campos preenchidos (o servidor recusa e-mail vazio e campo a mais). */
export function montarPedido(p: PedidoDeConvite): PedidoDeConvite {
  const out: PedidoDeConvite = {};
  const id = p.waitlist_entry_id?.trim();
  const nome = p.lab_name?.trim();
  const email = p.email?.trim();
  if (id) out.waitlist_entry_id = id;
  if (nome) out.lab_name = nome;
  if (email) out.email = email;
  return out;
}

/** dd/mm */
export function dataCurta(iso: string | null | undefined): string {
  const t = quando(iso);
  return t ? new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
}

/** dd/mm/aaaa */
export function dataLonga(iso: string | null | undefined): string {
  const t = quando(iso);
  return t ? new Date(t).toLocaleDateString('pt-BR') : '';
}

const nomeDoConvite = (c: ConviteLaboratorio): string => c.lab_name || c.email || T.secao.avulso;

export function useConvitesLaboratorio() {
  const [convites, setConvites] = useState<ConviteLaboratorio[] | null>(null);
  const [erro, setErro] = useState(false);
  const [revogando, setRevogando] = useState<string | null>(null);
  // Só vale a resposta do último pedido (recarregar depois de criar/revogar).
  const ultimo = useRef(0);

  const carregar = useCallback(async () => {
    const n = ++ultimo.current;
    setErro(false);
    try {
      const { data } = await api.get<ConviteLaboratorio[]>(ROTA_CONVITES);
      if (n !== ultimo.current) return;
      setConvites(Array.isArray(data) ? data : []);
    } catch {
      if (n !== ultimo.current) return;
      setConvites(null);
      setErro(true);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  /** Cria e recarrega a lista (o convite anterior da inscrição volta como revogado). */
  const criar = useCallback(async (pedido: PedidoDeConvite): Promise<ConviteCriado> => {
    try {
      const { data } = await api.post<ConviteCriado>(ROTA_CONVITES, montarPedido(pedido));
      if (!data || typeof data.codigo !== 'string' || !data.codigo) throw new Error();
      if (data.convite?.id) {
        setConvites((atual) => (atual ? [data.convite, ...atual.filter((x) => x.id !== data.convite.id)] : atual));
      }
      void carregar();
      return data;
    } catch (err) {
      const s = statusDe(err);
      if (s === 404 || s === 409) void carregar();
      throw err;
    }
  }, [carregar]);

  /** Revoga com confirmação e troca a linha pela que o servidor devolveu. */
  const revogar = useCallback(async (c: ConviteLaboratorio) => {
    if (!window.confirm(T.secao.revogar.confirmaRevogar(nomeDoConvite(c)))) return;
    setRevogando(c.id);
    try {
      const { data } = await api.post<{ convite: ConviteLaboratorio }>(`${ROTA_CONVITES}/${c.id}/revogar`);
      const novo = data?.convite;
      if (novo?.id) setConvites((atual) => (atual ? atual.map((x) => (x.id === novo.id ? novo : x)) : atual));
      else void carregar();
      showSuccess(T.secao.revogar.revogado);
    } catch (err) {
      const s = statusDe(err);
      if (s === 404 || s === 409) {
        showError(msgErro(err, T.secao.revogar.erroRevogar));
        void carregar();
      } else {
        showError(T.secao.revogar.erroRevogar);
      }
    } finally {
      setRevogando(null);
    }
  }, [carregar]);

  return { convites, erro, revogando, carregar, criar, revogar };
}

/** Linha do link de WhatsApp: só dígitos. */
const soDigitos = (v: string | null | undefined) => (v || '').replace(/\D/g, '');

export function ModalConvite({
  entrada, temValido, criacaoLiberada, onCriar, onFechar,
}: {
  entrada?: InscricaoParaConvite | null;
  temValido: boolean;
  criacaoLiberada?: boolean | null;
  onCriar: (pedido: PedidoDeConvite) => Promise<ConviteCriado>;
  onFechar: () => void;
}) {
  const tituloId = useId();
  const [nome, setNome] = useState(() => (entrada?.lab_name || '').slice(0, 120));
  const [email, setEmail] = useState(() => (entrada?.email || '').slice(0, 160));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Passo 2: o link fica só aqui (memória do modal) e some ao fechar.
  const [link, setLink] = useState<string | null>(null);
  const [nomeNoTexto, setNomeNoTexto] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);

  const fone = soDigitos(entrada?.phone);
  const mestraDesligada = criacaoLiberada === false;

  const fechar = useCallback(() => {
    if (salvando) return;
    if (link && !copiado && !window.confirm(T.modal.fecharSemCopiar)) return;
    setLink(null);
    onFechar();
  }, [salvando, link, copiado, onFechar]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        fechar();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fechar]);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (salvando) return;
    setErro(null);
    setSalvando(true);
    try {
      const data = await onCriar({ waitlist_entry_id: entrada?.id, lab_name: nome, email });
      const codigo = data.codigo;
      setNomeNoTexto(nome.trim() || entrada?.lab_name || null);
      setLink(
        typeof data.link === 'string' && data.link
          ? data.link
          : `${window.location.origin}/cadastrar?tipo=laboratorio&convite=${encodeURIComponent(codigo)}`,
      );
      setCopiado(false);
    } catch (err) {
      const s = statusDe(err);
      setErro(
        s === 404
          ? entrada ? T.modal.inscricaoSumiu : T.modal.erroCriar
          : s === 400 || s === 409
            ? msgErro(err, T.modal.erroCriar)
            : T.modal.erroCriar,
      );
    } finally {
      setSalvando(false);
    }
  };

  const copiar = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopiado(true);
      showSuccess(T.modal.copiado);
    } catch {
      linkRef.current?.focus();
      linkRef.current?.select();
      showError(T.modal.copiaFalhou);
    }
  };

  const titulo = link ? T.modal.criadoTitulo : entrada ? T.modal.tituloInscricao(entrada.lab_name) : T.modal.tituloAvulso;

  const avisoMestra = mestraDesligada && (
    <p className="text-[11px] text-amber-800 dark:text-amber-200 bg-amber-500/5 border border-amber-500/20 rounded-md px-3 py-2 flex items-start gap-1.5">
      <AlertCircle size={12} className="shrink-0 mt-0.5" />
      <span>{T.modal.mestraDesligada}</span>
    </p>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => {
        // No passo 2 o clique fora NÃO fecha: o link não aparece de novo.
        if (!link && !salvando) onFechar();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[95vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border bg-violet-500/5 shrink-0">
          <h2 id={tituloId} className="text-base font-bold inline-flex items-center gap-2 min-w-0">
            {link ? (
              <CheckCircle2 size={16} className="shrink-0 text-emerald-600" />
            ) : (
              <Send size={16} className="shrink-0 text-violet-700 dark:text-violet-300" />
            )}
            <span className="truncate">{titulo}</span>
          </h2>
          <button
            type="button"
            onClick={fechar}
            disabled={salvando}
            aria-label={T.modal.fechar}
            title={T.modal.fechar}
            className="p-1.5 rounded-md hover:bg-accent/40 disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        {link ? (
          <div className="flex-1 overflow-auto p-5 space-y-4">
            <p className="text-xs text-amber-800 dark:text-amber-200 bg-amber-500/5 border border-amber-500/20 rounded-md px-3 py-2 flex items-start gap-1.5">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <span>{T.modal.copieAgora}</span>
            </p>
            <div>
              <label className="block text-[11px] font-bold text-muted-foreground mb-1" htmlFor={`${tituloId}-link`}>
                {T.modal.linkRotulo}
              </label>
              <input
                id={`${tituloId}-link`}
                ref={linkRef}
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                onCopy={() => setCopiado(true)}
                className="w-full px-3 py-2 text-xs font-mono border border-border rounded-lg bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
              />
            </div>
            {avisoMestra}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { void copiar(); }}
                autoFocus
                className="inline-flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700"
              >
                {copiado ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                {copiado ? T.modal.copiado : T.modal.copiar}
              </button>
              {fone && (
                <a
                  href={`https://wa.me/${fone}?text=${encodeURIComponent(T.modal.textoWhatsapp(nomeNoTexto, link))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setCopiado(true)}
                  className="inline-flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  <MessageSquare size={12} />
                  {T.modal.whatsapp}
                </a>
              )}
              <button
                type="button"
                onClick={fechar}
                className="ml-auto text-xs font-bold px-3 py-2 rounded-lg border border-border hover:bg-accent/40"
              >
                {T.modal.fechar}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={enviar} className="flex-1 overflow-auto p-5 space-y-4">
            {temValido && (
              <p className="text-[11px] text-sky-800 dark:text-sky-200 bg-sky-500/5 border border-sky-500/20 rounded-md px-3 py-2 flex items-start gap-1.5">
                <Info size={12} className="shrink-0 mt-0.5" />
                <span>{T.modal.substitui}</span>
              </p>
            )}
            {avisoMestra}
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-muted-foreground mb-1" htmlFor={`${tituloId}-nome`}>
                  {T.modal.nome}
                </label>
                <input
                  id={`${tituloId}-nome`}
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  maxLength={120}
                  autoFocus
                  placeholder={T.modal.exemploNome}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-muted-foreground mb-1" htmlFor={`${tituloId}-email`}>
                  {T.modal.email}
                </label>
                <input
                  id={`${tituloId}-email`}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={160}
                  placeholder={T.modal.exemploEmail}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">{T.modal.ajuda}</p>
            {erro && (
              <p role="alert" className="text-xs text-red-700 dark:text-red-300 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2 flex items-start gap-1.5">
                <AlertCircle size={12} className="shrink-0 mt-0.5" />
                <span>{erro}</span>
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onFechar}
                disabled={salvando}
                className="text-xs font-bold px-3 py-2 rounded-lg border border-border hover:bg-accent/40 disabled:opacity-50"
              >
                {T.modal.cancelar}
              </button>
              <button
                type="submit"
                disabled={salvando}
                className="inline-flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {salvando ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                {T.modal.criar}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function SeloSituacao({ c }: { c: ConviteLaboratorio }) {
  const s = situacaoDe(c);
  const [texto, cls] =
    s === 'VALIDO'
      ? [T.secao.situacao.valido(dataLonga(c.expires_at)), 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30']
      : s === 'USADO'
        ? [T.secao.situacao.usado(dataLonga(c.used_at)), 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30']
        : s === 'VENCIDO'
          ? [T.secao.situacao.vencido(dataLonga(c.expires_at)), 'bg-muted text-muted-foreground border-border']
          : [T.secao.situacao.revogado(dataLonga(c.revoked_at)), 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30'];
  return (
    <span className={`inline-flex items-center text-[11px] font-bold px-2 py-1 rounded-md border whitespace-nowrap ${cls}`}>
      {texto}
    </span>
  );
}

/** Seção "Convites": avisos das chaves, lista com a situação, "Revogar" e "Novo convite". */
export function SecaoConvites({
  convites, erro, criacaoLiberada, cadastroAberto, revogando, onNovo, onRevogar, onRecarregar,
}: {
  convites: ConviteLaboratorio[] | null;
  erro: boolean;
  criacaoLiberada?: boolean | null;
  cadastroAberto?: boolean | null;
  revogando?: string | null;
  onNovo: () => void;
  onRevogar: (c: ConviteLaboratorio) => void;
  onRecarregar: () => void;
}) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-extrabold text-foreground flex items-center gap-2">
            <Send size={15} className="text-violet-600" />
            {T.secao.titulo}
          </h2>
          {convites && <p className="text-xs font-semibold text-muted-foreground mt-0.5">{T.secao.contagem(convites.length)}</p>}
        </div>
        <button
          type="button"
          onClick={onNovo}
          className="inline-flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700"
        >
          <Plus size={12} />
          {T.secao.novo}
        </button>
      </div>

      {criacaoLiberada === false && (
        <p className="mb-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2 flex items-start gap-1.5">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>{T.secao.avisoMestra}</span>
        </p>
      )}
      {cadastroAberto === true && (
        <p className="mb-2 text-xs text-sky-800 dark:text-sky-200 bg-sky-500/5 border border-sky-500/20 rounded-lg px-3 py-2 flex items-start gap-1.5">
          <Info size={12} className="shrink-0 mt-0.5" />
          <span>{T.secao.avisoAberto}</span>
        </p>
      )}

      {erro ? (
        <div className="border border-red-500/30 bg-red-500/5 rounded-xl p-6 text-center">
          <AlertCircle size={18} className="mx-auto mb-2 text-red-600" />
          <p className="text-sm font-semibold text-foreground">{T.secao.erro}</p>
          <button
            type="button"
            onClick={onRecarregar}
            className="mt-3 text-xs font-bold px-3 py-2 rounded-lg border border-border hover:bg-accent/40 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} />
            {T.secao.tentar}
          </button>
        </div>
      ) : convites === null ? (
        <div className="flex justify-center py-10">
          <Loader2 size={18} className="animate-spin text-muted-foreground" />
        </div>
      ) : convites.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          {T.secao.vazio}
        </div>
      ) : (
        <div className="space-y-2">
          {convites.map((c) => {
            const s = situacaoDe(c);
            return (
              <div key={c.id} className="bg-card border border-border rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-foreground truncate">{nomeDoConvite(c)}</div>
                  {c.lab_name && c.email && <div className="text-xs text-muted-foreground break-all">{c.email}</div>}
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {T.secao.criadoEm(dataCurta(c.created_at), c.criado_por_nome)}
                  </div>
                </div>
                <div className="shrink-0 flex flex-wrap items-center gap-2">
                  <SeloSituacao c={c} />
                  {s === 'USADO' && c.tenant_id && (
                    <Link
                      href={`/admin/tenants/${c.tenant_id}`}
                      title={c.tenant_nome || undefined}
                      className="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1.5 rounded-lg border border-border hover:bg-accent/40 text-foreground"
                    >
                      <ExternalLink size={11} />
                      {T.inscricao.verConta}
                    </Link>
                  )}
                  {s === 'VALIDO' && (
                    <button
                      type="button"
                      onClick={() => onRevogar(c)}
                      disabled={revogando === c.id}
                      className="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1.5 rounded-lg border border-red-500/30 text-red-700 dark:text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {revogando === c.id && <Loader2 size={11} className="animate-spin" />}
                      {T.secao.revogar.revogar}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
