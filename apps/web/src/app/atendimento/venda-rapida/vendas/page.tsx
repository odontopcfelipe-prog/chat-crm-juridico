'use client';

/**
 * Lista de vendas da Venda Rápida, no jeito das listas do admin da Nuvemshop: busca, tabela
 * com o número em azul e o estado em etiqueta. Uma linha por venda (GET /venda-rapida/vendas).
 */
import '../venda-skin.css';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, Plus, Search } from 'lucide-react';
import { isLab, labAllowsRoute } from '@crm/shared';
import api from '@/lib/api';
import { useBusinessType } from '@/lib/useBusinessType';

type Estado = 'RECEBIDA' | 'PENDENTE' | 'VENCIDA' | 'CANCELADA' | 'SEM_COBRANCA';

interface Venda {
  id: string;
  numero: number;
  data: string;
  cliente: { id: string; name: string; phone?: string | null };
  itens: string[];
  qtd_itens: number;
  forma: string | null;
  total: number;
  estado: Estado;
  a_validar: boolean;
}

interface Resposta {
  data: Venda[];
  total: number;
  soma: number;
  page: number;
  totalPages: number;
}

const FUSO = 'America/Maceio';
const PERIODOS = [
  { chave: 'todas', rotulo: 'Todas' },
  { chave: 'hoje', rotulo: 'Hoje' },
  { chave: 'semana', rotulo: '7 dias' },
  { chave: 'mes', rotulo: 'Este mês' },
] as const;
type Periodo = (typeof PERIODOS)[number]['chave'];

const ETIQUETA: Record<Estado, { texto: string; classe: string }> = {
  RECEBIDA: { texto: 'Recebida', classe: 'bg-[#00a650]/10 text-[#00753a]' },
  PENDENTE: { texto: 'Pendente', classe: 'bg-amber-500/15 text-amber-800' },
  VENCIDA: { texto: 'Vencida', classe: 'bg-red-500/10 text-red-700' },
  CANCELADA: { texto: 'Cancelada', classe: 'bg-muted text-muted-foreground' },
  SEM_COBRANCA: { texto: 'Sem cobrança', classe: 'bg-muted text-muted-foreground' },
};

const fmtBRL = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtData(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: FUSO }).replace('.', '');
}

/** Começo do dia em Maceió, N dias atrás, com o fuso explícito. */
function inicioDoDia(diasAtras: number): string {
  const dia = new Date(Date.now() - diasAtras * 86_400_000).toLocaleDateString('en-CA', { timeZone: FUSO });
  return `${dia}T00:00:00-03:00`;
}

function inicioDoMes(): string {
  const dia = new Date().toLocaleDateString('en-CA', { timeZone: FUSO });
  return `${dia.slice(0, 8)}01T00:00:00-03:00`;
}

export default function ListaDeVendasPage() {
  const lab = isLab(useBusinessType());
  const [busca, setBusca] = useState('');
  const [buscaFirme, setBuscaFirme] = useState('');
  const [periodo, setPeriodo] = useState<Periodo>('todas');
  const [pagina, setPagina] = useState(1);
  const [resposta, setResposta] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setBuscaFirme(busca.trim());
      setPagina(1);
    }, 300);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    let cancelado = false;
    setCarregando(true);
    setErro(false);
    const from = periodo === 'hoje' ? inicioDoDia(0) : periodo === 'semana' ? inicioDoDia(6) : periodo === 'mes' ? inicioDoMes() : undefined;
    api.get<Resposta>('/venda-rapida/vendas', { params: { page: pagina, perPage: 50, search: buscaFirme || undefined, from } })
      .then(({ data }) => { if (!cancelado) setResposta(data); })
      .catch(() => { if (!cancelado) setErro(true); })
      .finally(() => { if (!cancelado) setCarregando(false); });
    return () => { cancelado = true; };
  }, [pagina, buscaFirme, periodo, tentativa]);

  const podeVerFicha = !lab || labAllowsRoute('/atendimento/pacientes');
  const vendas = resposta?.data ?? [];

  return (
    <div className="vr-skin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-foreground">Lista de vendas</h1>
          <Link href="/atendimento/venda-rapida" className="vr-botao inline-flex items-center gap-1.5 px-3 py-2 text-sm">
            <Plus size={15} /> Nova venda
          </Link>
        </div>

        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por cliente, telefone, CPF ou número da venda"
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {PERIODOS.map((p) => (
            <button
              key={p.chave}
              type="button"
              aria-pressed={periodo === p.chave}
              onClick={() => { setPeriodo(p.chave); setPagina(1); }}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                periodo === p.chave ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-foreground hover:bg-accent/40'
              }`}
            >
              {p.rotulo}
            </button>
          ))}
          {resposta && !erro && (
            <span className="ml-auto text-muted-foreground">
              {resposta.total} {resposta.total === 1 ? 'venda' : 'vendas'} · <strong className="font-semibold text-foreground">R$ {fmtBRL(resposta.soma)}</strong>
            </span>
          )}
        </div>

        <div className="vr-card overflow-x-auto">
          {erro ? (
            <div role="alert" className="flex flex-col items-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground">
              <AlertCircle size={22} className="text-amber-600" />
              Não foi possível carregar as vendas.
              <button type="button" onClick={() => setTentativa((n) => n + 1)} className="vr-link font-semibold">Tentar de novo</button>
            </div>
          ) : carregando && !resposta ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" /> Carregando vendas...
            </div>
          ) : vendas.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground">
              {buscaFirme || periodo !== 'todas' ? 'Nenhuma venda com esses filtros.' : 'Nenhuma venda rápida ainda.'}
            </div>
          ) : (
            <table className={`w-full min-w-[720px] text-sm transition-opacity ${carregando ? 'opacity-60' : ''}`}>
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs font-semibold text-foreground">
                  <th className="px-4 py-2.5">Venda</th>
                  <th className="px-4 py-2.5">Data</th>
                  <th className="px-4 py-2.5">Cliente</th>
                  <th className="px-4 py-2.5">Forma de pagamento</th>
                  <th className="px-4 py-2.5 text-right">Valor</th>
                  <th className="px-4 py-2.5">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {vendas.map((v) => {
                  const etiqueta = ETIQUETA[v.estado];
                  const resto = v.qtd_itens - v.itens.length;
                  return (
                    <tr key={v.id} className="align-top hover:bg-muted/60">
                      <td className="whitespace-nowrap px-4 py-3">
                        {podeVerFicha ? (
                          <Link href={`/atendimento/pacientes/${v.cliente.id}?tab=financial`} className="vr-link font-medium">#{v.numero}</Link>
                        ) : (
                          <span className="font-medium">#{v.numero}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{fmtData(v.data)}</td>
                      <td className="px-4 py-3">
                        <span className="block text-foreground">{v.cliente.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {v.itens.join(', ')}{resto > 0 ? ` +${resto}` : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-foreground">{v.forma ?? '—'}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-foreground">R$ {fmtBRL(v.total)}</td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1">
                          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${etiqueta.classe}`}>{etiqueta.texto}</span>
                          {v.a_validar && (
                            <span title="Passa pelo Validar do Financeiro" className="whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-800">A validar</span>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {resposta && resposta.totalPages > 1 && !erro && (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <button
              type="button"
              aria-label="Página anterior"
              disabled={pagina <= 1 || carregando}
              onClick={() => setPagina((n) => n - 1)}
              className="rounded-md border border-border bg-card p-1.5 disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-muted-foreground">Página {resposta.page} de {resposta.totalPages}</span>
            <button
              type="button"
              aria-label="Próxima página"
              disabled={pagina >= resposta.totalPages || carregando}
              onClick={() => setPagina((n) => n + 1)}
              className="rounded-md border border-border bg-card p-1.5 disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
