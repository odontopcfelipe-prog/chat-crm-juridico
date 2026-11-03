'use client';

/**
 * Admin SaaS → Ver clínicas (só o dono do sistema).
 *
 * 1. Entrar numa conta sem ter usuário nela: "Só ver" (nada é salvo nem enviado)
 *    ou "Ver e mexer" (como administrador de lá). Ver lib/acesso-clinica.ts.
 * 2. Comparar as contas marcadas num mês, lado a lado — cada número é da conta
 *    da coluna, nunca somado (GET /admin/contas/comparativo).
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Eye, FlaskConical, Loader2, PencilLine, Search, BarChart3, AlertCircle } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { contaDoToken, trocarDeConta, type ModoDeAcesso } from '@/lib/acesso-clinica';

interface Conta {
  id: string;
  name: string;
  status: string;
  plan: string;
  business_profile?: { business_type?: string | null } | null;
  _count?: { users?: number; patients?: number; leads?: number };
}

interface ColunaComparativo {
  id: string;
  nome: string;
  tipo: 'CLINICA' | 'LABORATORIO';
  status: string;
  plano: string;
  usuarios: number | null;
  pacientes: number | null;
  pacientes_novos: number | null;
  leads_novos: number | null;
  consultas: { marcadas: number | null; compareceram: number | null; faltaram: number | null };
  financeiro: { recebido: number; a_receber: number; atrasado: number; atrasado_qtd: number } | null;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: 'Ativo', cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' },
  TRIAL: { label: 'Em avaliação', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  SUSPENDED: { label: 'Suspenso', cls: 'bg-red-500/15 text-red-700 border-red-500/30' },
  DELETED: { label: 'Excluído', cls: 'bg-muted text-muted-foreground border-border' },
};

const ehLab = (c: Conta) => c.business_profile?.business_type === 'LABORATORIO';
const brl = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('pt-BR'));

/** Mês corrente de Maceió (UTC-3), 'AAAA-MM'. */
const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);

const LINHAS: { rotulo: string; valor: (c: ColunaComparativo) => string; grupo?: string }[] = [
  { grupo: 'Conta', rotulo: 'Tipo', valor: (c) => (c.tipo === 'LABORATORIO' ? 'Laboratório' : 'Clínica') },
  { rotulo: 'Situação', valor: (c) => STATUS[c.status]?.label ?? c.status },
  { rotulo: 'Usuários', valor: (c) => num(c.usuarios) },
  { grupo: 'Pacientes e contatos', rotulo: 'Pacientes (total)', valor: (c) => num(c.pacientes) },
  { rotulo: 'Pacientes novos no mês', valor: (c) => num(c.pacientes_novos) },
  { rotulo: 'Contatos (leads) novos no mês', valor: (c) => num(c.leads_novos) },
  { grupo: 'Agenda do mês', rotulo: 'Consultas marcadas', valor: (c) => num(c.consultas.marcadas) },
  { rotulo: 'Compareceram', valor: (c) => num(c.consultas.compareceram) },
  { rotulo: 'Faltaram', valor: (c) => num(c.consultas.faltaram) },
  { grupo: 'Financeiro', rotulo: 'Recebido no mês', valor: (c) => brl(c.financeiro?.recebido) },
  { rotulo: 'A receber (hoje)', valor: (c) => brl(c.financeiro?.a_receber) },
  {
    rotulo: 'Atrasado (hoje)',
    valor: (c) => (c.financeiro ? `${brl(c.financeiro.atrasado)} · ${num(c.financeiro.atrasado_qtd)}` : '—'),
  },
];

export default function VerClinicasPage() {
  const [contas, setContas] = useState<Conta[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erroLista, setErroLista] = useState('');
  const [busca, setBusca] = useState('');
  const [marcadas, setMarcadas] = useState<string[]>([]);
  const [mes, setMes] = useState(mesAtual);
  const [comparativo, setComparativo] = useState<ColunaComparativo[] | null>(null);
  const [comparando, setComparando] = useState(false);
  const [entrando, setEntrando] = useState<string | null>(null);
  const [contaAtual, setContaAtual] = useState<string | null>(null);

  useEffect(() => {
    setContaAtual(contaDoToken(localStorage.getItem('token')));
    api
      .get('/tenants')
      .then(({ data }) => setContas(Array.isArray(data) ? data.filter((c: Conta) => c.status !== 'DELETED') : []))
      .catch((e) =>
        setErroLista(
          e?.response?.status === 403
            ? 'Daqui de dentro desta conta a lista não abre. Use "Voltar para a minha" na faixa do topo e abra de novo.'
            : 'Não deu para carregar as contas.',
        ),
      )
      .finally(() => setCarregando(false));
  }, []);

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return q ? contas.filter((c) => c.name.toLowerCase().includes(q)) : contas;
  }, [contas, busca]);

  const alternar = (id: string) =>
    setMarcadas((m) => (m.includes(id) ? m.filter((x) => x !== id) : m.length >= 20 ? m : [...m, id]));

  const comparar = useCallback(async () => {
    if (marcadas.length === 0) return;
    setComparando(true);
    try {
      const { data } = await api.get('/admin/contas/comparativo', { params: { ids: marcadas.join(','), mes } });
      setComparativo(Array.isArray(data?.contas) ? data.contas : []);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não deu para comparar.');
    } finally {
      setComparando(false);
    }
  }, [marcadas, mes]);

  const entrar = async (c: Conta, modo: ModoDeAcesso) => {
    if (
      modo === 'mexer' &&
      !window.confirm(`Entrar em "${c.name}" para VER E MEXER?\n\nVocê vai poder salvar, enviar mensagens pelo WhatsApp de lá e cobrar. Tudo fica no seu nome.`)
    ) {
      return;
    }
    setEntrando(`${c.id}:${modo}`);
    try {
      await trocarDeConta(c.id, modo);
    } catch (e: any) {
      setEntrando(null);
      showError(e?.response?.data?.message || 'Não deu para entrar nesta conta.');
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold text-foreground flex items-center gap-2">
          <Eye size={24} />
          Ver clínicas
        </h1>
        <p className="text-sm text-muted-foreground">
          Entre em qualquer clínica ou laboratório sem precisar de usuário lá, ou marque várias e compare.
        </p>
      </div>

      {/* Comparativo */}
      <div className="bg-card border border-border rounded-xl p-4 mb-6">
        <div className="flex items-center gap-2 flex-wrap">
          <BarChart3 size={16} className="text-violet-600" />
          <span className="text-sm font-bold text-foreground">Comparar as marcadas</span>
          <span className="text-xs text-muted-foreground">({marcadas.length} de até 20)</span>
          <div className="flex-1" />
          <label className="text-xs text-muted-foreground flex items-center gap-1.5">
            Mês
            <input
              type="month"
              value={mes}
              onChange={(e) => setMes(e.target.value || mesAtual())}
              className="px-2 py-1 text-sm border border-border rounded-md bg-background text-foreground"
            />
          </label>
          {marcadas.length > 0 && (
            <button
              type="button"
              onClick={() => { setMarcadas([]); setComparativo(null); }}
              className="text-xs font-semibold px-3 py-1.5 rounded-md border border-border hover:bg-accent/40"
            >
              Limpar
            </button>
          )}
          <button
            type="button"
            onClick={comparar}
            disabled={marcadas.length === 0 || comparando}
            className="text-sm font-bold px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {comparando && <Loader2 size={14} className="animate-spin" />}
            Comparar
          </button>
        </div>

        {comparativo && comparativo.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-[11px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-2 sticky left-0 bg-card" />
                  {comparativo.map((c) => (
                    <th key={c.id} className="text-right px-3 py-2 font-bold text-foreground whitespace-nowrap">
                      {c.nome}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {LINHAS.map((l) => (
                  <Fragment key={l.rotulo}>
                    {l.grupo && (
                      <tr>
                        <td
                          colSpan={comparativo.length + 1}
                          className="pt-3 pb-1 px-3 text-[10px] font-extrabold uppercase tracking-wider text-violet-700"
                        >
                          {l.grupo}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t border-border/60">
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap sticky left-0 bg-card">{l.rotulo}</td>
                      {comparativo.map((c) => (
                        <td key={c.id} className="px-3 py-1.5 text-right font-semibold text-foreground tabular-nums whitespace-nowrap">
                          {l.valor(c)}
                        </td>
                      ))}
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Cada coluna é só daquela conta. Financeiro igual à tela Financeiro de cada uma: recebido no mês escolhido;
              a receber e atrasado de hoje. Agenda: só consultas (canceladas fora).
            </p>
          </div>
        )}
        {comparativo && comparativo.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">Nenhuma das contas marcadas foi encontrada.</p>
        )}
      </div>

      {/* Lista */}
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar clínica ou laboratório..."
          className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
        />
      </div>

      {carregando ? (
        <div className="py-16 flex items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin mr-2" />
          Carregando contas...
        </div>
      ) : erroLista ? (
        <div className="py-10 px-4 text-center bg-card border border-dashed border-border rounded-xl">
          <AlertCircle size={28} className="mx-auto mb-2 text-amber-600" />
          <p className="text-sm font-semibold">{erroLista}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visiveis.map((c) => {
            const st = STATUS[c.status] ?? STATUS.ACTIVE;
            const marcada = marcadas.includes(c.id);
            const aqui = contaAtual === c.id;
            return (
              <div
                key={c.id}
                className={`bg-card border rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap ${marcada ? 'border-violet-500/60' : 'border-border'}`}
              >
                <input
                  type="checkbox"
                  checked={marcada}
                  onChange={() => alternar(c.id)}
                  aria-label={`Marcar ${c.name} para comparar`}
                  className="w-4 h-4 accent-violet-600"
                />
                <div className="w-9 h-9 rounded-lg bg-violet-500/10 text-violet-700 flex items-center justify-center shrink-0">
                  {ehLab(c) ? <FlaskConical size={16} /> : <Building2 size={16} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-foreground truncate">{c.name}</span>
                    <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                    {ehLab(c) && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-sky-500/15 text-sky-700">
                        Laboratório
                      </span>
                    )}
                    {aqui && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-foreground text-background">
                        Você está aqui
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {num(c._count?.users ?? null)} usuários · {num(c._count?.patients ?? null)} pacientes
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => entrar(c, 'ver')}
                    disabled={!!entrando}
                    className="text-xs font-bold px-3 py-1.5 rounded-lg border border-amber-500/50 bg-amber-400/15 text-amber-800 dark:text-amber-300 hover:bg-amber-400/25 inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {entrando === `${c.id}:ver` ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
                    Só ver
                  </button>
                  <button
                    type="button"
                    onClick={() => entrar(c, 'mexer')}
                    disabled={!!entrando}
                    className="text-xs font-bold px-3 py-1.5 rounded-lg border border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20 inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {entrando === `${c.id}:mexer` ? <Loader2 size={12} className="animate-spin" /> : <PencilLine size={12} />}
                    Ver e mexer
                  </button>
                </div>
              </div>
            );
          })}
          {visiveis.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">Nenhuma conta encontrada.</p>
          )}
        </div>
      )}
    </div>
  );
}
