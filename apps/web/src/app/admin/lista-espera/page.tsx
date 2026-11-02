'use client';

/**
 * Lista de espera do caminho "Laboratório de prótese" do /cadastrar (SUPER_ADMIN),
 * mais os convites de cadastro (F11).
 * Cada linha é um laboratório que deixou o contato enquanto o cadastro de
 * laboratório não abre. Um e-mail de aviso chega a cada hora com inscrição nova.
 * "Convidar" gera o link de cadastro de uma conta só (mostrado uma vez); a seção
 * "Convites", embaixo, lista todos (também os avulsos) com a situação e o "Revogar".
 * A lista de espera e os convites carregam separados: um erro não derruba o outro.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, FlaskConical, Phone, Mail, MapPin, MessageSquare, Trash2, AlertCircle, Send, CheckCircle2, ExternalLink,
} from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import {
  ModalConvite, SecaoConvites, conviteDaInscricao, dataCurta, situacaoDe, useConvitesLaboratorio,
  type ConviteLaboratorio, type PedidoDeConvite,
} from './ConvitesLaboratorio';
import { useCadastroAbertoLaboratorio } from '../tenants/CadastroAbertoLaboratorio';
import { LAB_CONVITES_ADMIN } from '../lab-cadastro-admin-textos';

interface Inscricao {
  id: string;
  lab_name: string;
  contact_name: string;
  phone: string;
  email: string | null;
  city: string | null;
  created_at: string;
}

export default function AdminListaEsperaPage() {
  const [itens, setItens] = useState<Inscricao[] | null>(null);
  const [erro, setErro] = useState(false);
  const [removendo, setRemovendo] = useState<string | null>(null);
  // F11 — convites: modal aberto (com a inscrição, ou avulso) e as duas chaves da plataforma
  const [modal, setModal] = useState<{ entrada?: Inscricao; temValido: boolean } | null>(null);
  const convites = useConvitesLaboratorio();
  const chaves = useCadastroAbertoLaboratorio();

  const carregar = useCallback(() => {
    setErro(false);
    setItens(null);
    api
      .get<Inscricao[]>('/lab-waitlist')
      .then((r) => setItens(Array.isArray(r.data) ? r.data : []))
      .catch(() => setErro(true));
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const remover = async (i: Inscricao) => {
    const convite = conviteDaInscricao(convites.convites, i.id);
    const pergunta = convite && situacaoDe(convite) === 'VALIDO'
      ? LAB_CONVITES_ADMIN.inscricao.removerComConvite(i.lab_name)
      : `Remover "${i.lab_name}" da lista de espera?`;
    if (!window.confirm(pergunta)) return;
    setRemovendo(i.id);
    try {
      await api.delete(`/lab-waitlist/${i.id}`);
      setItens((atual) => (atual ?? []).filter((x) => x.id !== i.id));
      showSuccess('Removido da lista');
    } catch {
      showError('Não foi possível remover');
    } finally {
      setRemovendo(null);
    }
  };

  /** Cria o convite; se a inscrição sumiu (404), relê a lista de espera também. */
  const criarConvite = async (pedido: PedidoDeConvite) => {
    try {
      return await convites.criar(pedido);
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 404 && pedido.waitlist_entry_id) carregar();
      throw err;
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-xl font-extrabold text-foreground flex items-center gap-2">
          <FlaskConical size={18} className="text-violet-600" />
          Lista de espera — Laboratórios
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {LAB_CONVITES_ADMIN.subtitulo}
        </p>
      </div>

      {erro ? (
        <div className="border border-red-500/30 bg-red-500/5 rounded-xl p-8 text-center">
          <AlertCircle size={20} className="mx-auto mb-2 text-red-600" />
          <p className="text-sm font-semibold text-foreground">Não foi possível carregar a lista de espera.</p>
          <button
            type="button"
            onClick={carregar}
            className="mt-3 text-xs font-bold px-3 py-2 rounded-lg border border-border hover:bg-accent/40"
          >
            Tentar de novo
          </button>
        </div>
      ) : itens === null ? (
        <div className="flex justify-center py-16">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : itens.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
          Nenhum laboratório na lista ainda.
        </div>
      ) : (
        <div className="space-y-2.5">
          <p className="text-xs font-semibold text-muted-foreground">
            {itens.length} {itens.length === 1 ? 'laboratório' : 'laboratórios'}
          </p>
          {itens.map((i) => (
            <div key={i.id} className="bg-card border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-foreground truncate">{i.lab_name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {i.contact_name} · {new Date(i.created_at).toLocaleDateString('pt-BR')}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Phone size={11} />{i.phone}</span>
                  {i.email && <span className="inline-flex items-center gap-1 break-all"><Mail size={11} />{i.email}</span>}
                  {i.city && <span className="inline-flex items-center gap-1"><MapPin size={11} />{i.city}</span>}
                </div>
              </div>
              <div className="shrink-0 flex flex-wrap items-center gap-2">
                <AcoesDoConvite
                  inscricao={i}
                  convites={convites.convites}
                  onConvidar={(temValido) => setModal({ entrada: i, temValido })}
                />
                <a
                  href={`https://wa.me/${i.phone}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  <MessageSquare size={12} />
                  Chamar no WhatsApp
                </a>
                <button
                  type="button"
                  onClick={() => remover(i)}
                  disabled={removendo === i.id}
                  title="Remover da lista"
                  aria-label={`Remover ${i.lab_name} da lista`}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border text-muted-foreground hover:text-red-600 hover:border-red-500/40 disabled:opacity-50"
                >
                  {removendo === i.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* F11 — convites: fora do erro/carregando/vazio da lista de espera */}
      <SecaoConvites
        convites={convites.convites}
        erro={convites.erro}
        criacaoLiberada={chaves.estado?.criacao_liberada}
        cadastroAberto={chaves.estado?.aberto}
        revogando={convites.revogando}
        onNovo={() => setModal({ temValido: false })}
        onRevogar={(c) => { void convites.revogar(c); }}
        onRecarregar={() => { void convites.carregar(); }}
      />
      {modal && (
        <ModalConvite
          entrada={modal.entrada ?? null}
          temValido={modal.temValido}
          criacaoLiberada={chaves.estado?.criacao_liberada}
          onCriar={criarConvite}
          onFechar={() => setModal(null)}
        />
      )}
    </div>
  );
}

/**
 * Convite da inscrição: "Convidar" | selo "Convidado · vale até" + "Convidar de novo" |
 * selo "Conta criada" + "Ver conta". Só aparece depois que os convites carregam.
 */
function AcoesDoConvite({
  inscricao, convites, onConvidar,
}: {
  inscricao: Inscricao;
  convites: ConviteLaboratorio[] | null;
  onConvidar: (temValido: boolean) => void;
}) {
  if (!convites) return null;
  const convite = conviteDaInscricao(convites, inscricao.id);
  const situacao = convite ? situacaoDe(convite) : null;

  if (convite && situacao === 'USADO') {
    return (
      <>
        <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-md border border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300 whitespace-nowrap">
          <CheckCircle2 size={11} />
          {LAB_CONVITES_ADMIN.inscricao.seloContaCriada}
        </span>
        {convite.tenant_id && (
          <Link
            href={`/admin/tenants/${convite.tenant_id}`}
            className="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-2 rounded-lg border border-border hover:bg-accent/40 text-foreground"
          >
            <ExternalLink size={11} />
            {LAB_CONVITES_ADMIN.inscricao.verConta}
          </Link>
        )}
      </>
    );
  }

  const valido = !!convite && situacao === 'VALIDO';
  return (
    <>
      {valido && convite && (
        <span className="inline-flex items-center text-[11px] font-bold px-2 py-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 whitespace-nowrap">
          {LAB_CONVITES_ADMIN.inscricao.seloConvidado(dataCurta(convite.expires_at))}
        </span>
      )}
      <button
        type="button"
        onClick={() => onConvidar(valido)}
        className={`inline-flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg ${
          valido
            ? 'border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20 text-violet-700 dark:text-violet-300'
            : 'bg-violet-600 text-white hover:bg-violet-700'
        }`}
      >
        <Send size={12} />
        {valido ? LAB_CONVITES_ADMIN.inscricao.convidarDeNovo : LAB_CONVITES_ADMIN.inscricao.convidar}
      </button>
    </>
  );
}
