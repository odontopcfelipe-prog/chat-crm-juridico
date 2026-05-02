'use client';

/**
 * Settings → Lixeira de Orcamentos (Onda 25.6 — Fase 25).
 *
 * Tela admin pra recuperar orcamentos soft-deletados nos ultimos 30 dias.
 *
 * Backend (quotes.service):
 *   - remove() agora marca deleted_at + deleted_by_user_id (nao apaga fisicamente)
 *   - listDeleted() retorna orcamentos com deleted_at >= 30 dias atras
 *   - restore() limpa deleted_at, volta orcamento pra listagem normal
 *
 * Apos 30 dias, job futuro fara hard delete pra nao inflar o banco.
 */
import { useEffect, useState } from 'react';
import { Trash2, RotateCcw, Loader2, AlertCircle, Calendar, User } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface DeletedQuote {
  id: string;
  status: string;
  total_value: string | number;
  created_at: string;
  deleted_at: string;
  patient: { id: string; name: string };
  deleted_by: { id: string; name: string } | null;
  _count?: { items: number };
}

const formatBRL = (v: number | string) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatDateTime = (s: string) =>
  new Date(s).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

/** Quantos dias restam ate o hard delete (30 dias apos deletar) */
function daysLeftUntilPurge(deletedAt: string): number {
  const deleted = new Date(deletedAt);
  const purgeDate = new Date(deleted);
  purgeDate.setDate(purgeDate.getDate() + 30);
  const msLeft = purgeDate.getTime() - Date.now();
  return Math.max(0, Math.floor(msLeft / (1000 * 60 * 60 * 24)));
}

export default function QuotesTrashPage() {
  const [list, setList] = useState<DeletedQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get<DeletedQuote[]>('/quotes/deleted');
      setList(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar lixeira');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const restore = async (id: string) => {
    if (!confirm('Restaurar este orçamento? Ele voltará a aparecer na ficha do paciente.')) return;
    setRestoring(id);
    try {
      await api.post(`/quotes/${id}/restore`);
      showSuccess('Orçamento restaurado');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao restaurar');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 pb-8 flex flex-col gap-6">
      <div className="pt-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Trash2 size={22} className="text-destructive" />
          Lixeira de Orçamentos
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Orçamentos deletados nos últimos 30 dias podem ser restaurados aqui.
          Após 30 dias eles são removidos permanentemente.
        </p>
      </div>

      {/* Aviso */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 flex items-start gap-2 text-sm text-amber-700">
        <AlertCircle size={16} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Janela de recuperação: 30 dias</p>
          <p className="text-xs mt-0.5">
            Apenas orçamentos em status DRAFT podem ser deletados (e portanto recuperados).
            Orçamentos enviados/aceitos/rejeitados ficam no histórico permanente do paciente.
          </p>
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="py-12 text-center text-muted-foreground">
          <Loader2 size={20} className="inline animate-spin mr-2" /> Carregando...
        </div>
      ) : list.length === 0 ? (
        <div className="bg-card border border-border border-dashed rounded-xl p-12 text-center">
          <Trash2 size={32} className="mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">
            Nenhum orçamento na lixeira. Tudo limpo.
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground bg-muted/30 border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Paciente</th>
                <th className="text-right px-4 py-2.5 font-medium">Valor</th>
                <th className="text-left px-4 py-2.5 font-medium">Deletado em</th>
                <th className="text-left px-4 py-2.5 font-medium">Por</th>
                <th className="text-center px-4 py-2.5 font-medium">Restam</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((q) => {
                const daysLeft = daysLeftUntilPurge(q.deleted_at);
                const danger = daysLeft <= 3;
                return (
                  <tr key={q.id} className="hover:bg-accent/30">
                    <td className="px-4 py-3">
                      <p className="font-medium">{q.patient.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {q._count?.items || 0} {q._count?.items === 1 ? 'item' : 'itens'} ·
                        Criado em {formatDateTime(q.created_at)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {formatBRL(q.total_value)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="flex items-center gap-1">
                        <Calendar size={11} className="text-muted-foreground" />
                        {formatDateTime(q.deleted_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {q.deleted_by ? (
                        <span className="flex items-center gap-1">
                          <User size={11} className="text-muted-foreground" />
                          {q.deleted_by.name}
                        </span>
                      ) : (
                        <span className="text-muted-foreground italic">desconhecido</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-medium ${danger ? 'text-red-600' : 'text-muted-foreground'}`}>
                        {daysLeft === 0 ? 'hoje' : `${daysLeft}d`}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => restore(q.id)}
                        disabled={restoring === q.id}
                        className="text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-700 border border-emerald-500/30 hover:bg-emerald-500/20 disabled:opacity-50"
                        title="Restaurar este orçamento"
                      >
                        {restoring === q.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <RotateCcw size={12} />
                        )}
                        Restaurar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
