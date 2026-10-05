'use client';

/**
 * "Finalizar tratamento" (botão ✓ no Progresso e na Ortodontia). Lista os procedimentos
 * EM ABERTO dos planos do paciente e pede, pra cada um, QUEM FEZ (gera a comissão desse
 * dentista, igual o dentista confirmar no Tratamento) ou "Não realizado" (fica cancelado,
 * sem comissão). Com tudo decidido, conclui os planos: POST /treatment-plans/finalize.
 *
 * Ortodontia sem plano (paciente veio só pela agenda): não há procedimento pra resolver —
 * registra a ALTA de ortodontia: POST /quotes/ortho-board/alta.
 */
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ModalBase from '@/components/ModalBase';

interface PendingItem { id: string; name: string; tooth: string | null; planTitle: string | null }
interface Dentist { id: string; name: string }

const NAO_REALIZADO = '__not_done__';

export function FinalizarTratamentoModal({
  open, onClose, onDone, patientId, patientName, planIds, kind = 'geral', nextAppointmentAt,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  patientId: string;
  patientName: string;
  planIds: string[];
  kind?: 'geral' | 'orto';
  /** Próxima consulta já marcada (start_at naive de Maceió) — avisa pra desmarcar. */
  nextAppointmentAt?: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const [dentists, setDentists] = useState<Dentist[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({}); // item → dentistId | NAO_REALIZADO
  const [saving, setSaving] = useState(false);
  const planKey = planIds.join(',');
  const semPlano = planIds.length === 0;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setChoice({});
    Promise.all([
      Promise.all(
        planIds.map((id) =>
          api.get<{ status?: string; quote?: { title?: string | null } | null; items?: Array<{ id: string; status: string; tooth_fdi: string | null; procedure?: { name?: string } }> }>(`/treatment-plans/${id}`)
            .then((r) => r.data)
            .catch(() => null),
        ),
      ),
      api.get<Dentist[]>('/users/lawyers').then((r) => r.data || []).catch(() => [] as Dentist[]),
    ])
      .then(([plans, ds]) => {
        if (cancelled) return;
        const abertos: PendingItem[] = [];
        let feitos = 0;
        for (const p of plans) {
          if (!p) continue;
          for (const it of p.items || []) if (it.status === 'DONE') feitos++;
          // plano já concluído/cancelado fica como está (o backend faz igual)
          if (p.status === 'COMPLETED' || p.status === 'CANCELLED') continue;
          for (const it of p.items || []) {
            if (it.status === 'DONE' || it.status === 'CANCELLED') continue;
            abertos.push({ id: it.id, name: it.procedure?.name || 'Procedimento', tooth: it.tooth_fdi, planTitle: p.quote?.title ?? null });
          }
        }
        setPending(abertos);
        setDoneCount(feitos);
        setDentists(ds);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, planKey]);

  const faltaDecidir = pending.filter((i) => !choice[i.id]).length;
  const resumo = useMemo(() => {
    const vals = pending.map((i) => choice[i.id]).filter(Boolean);
    return { feitos: vals.filter((v) => v !== NAO_REALIZADO).length, nao: vals.filter((v) => v === NAO_REALIZADO).length };
  }, [pending, choice]);

  const applyAll = (v: string) => {
    if (!v) return;
    setChoice(Object.fromEntries(pending.map((i) => [i.id, v])));
  };

  const close = () => { if (!saving) onClose(); };

  const submit = async () => {
    setSaving(true);
    try {
      if (semPlano) {
        await api.post('/quotes/ortho-board/alta', { patient_id: patientId });
        showSuccess(`Alta de ortodontia registrada — ${patientName}`);
      } else {
        await api.post('/treatment-plans/finalize', {
          plan_ids: planIds,
          executions: pending.map((i) =>
            choice[i.id] === NAO_REALIZADO
              ? { item_id: i.id, not_done: true }
              : { item_id: i.id, executed_by_user_id: choice[i.id] },
          ),
        });
        showSuccess(`Tratamento de ${patientName} finalizado`);
      }
      onDone();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível finalizar o tratamento');
    } finally {
      setSaving(false);
    }
  };

  // start_at é naive (hora de Maceió gravada como UTC) → lê os campos UTC
  const proxima = (() => {
    if (!nextAppointmentAt) return null;
    const d = new Date(nextAppointmentAt);
    if (Number.isNaN(d.getTime())) return null;
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} às ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  })();
  const avisoConsulta = proxima && (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-sm p-3">
      Este paciente tem consulta marcada em <b>{proxima}</b>. Finalizar não desmarca a consulta —
      se ele não vai mais vir, desmarque na agenda pra os lembretes pararem de sair.
    </div>
  );

  const options = (
    <>
      <option value="">Quem fez?</option>
      {dentists.map((d) => <option key={d.id} value={d.id}>Feito por {d.name}</option>)}
      <option value={NAO_REALIZADO}>Não realizado</option>
    </>
  );

  return (
    <ModalBase
      open={open}
      onClose={close}
      size="lg"
      title={semPlano ? 'Dar alta de ortodontia' : 'Finalizar tratamento'}
      subtitle={patientName}
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {!semPlano && pending.length > 0 && (faltaDecidir > 0
              ? `Falta indicar ${faltaDecidir} de ${pending.length}`
              : `${resumo.feitos} feito(s) · ${resumo.nao} não realizado(s)`)}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={close} disabled={saving}
              className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50">
              Cancelar
            </button>
            <button type="button" onClick={submit} disabled={saving || loading || (!semPlano && faltaDecidir > 0)}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium inline-flex items-center gap-2 hover:bg-emerald-700 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {semPlano ? 'Dar alta' : 'Finalizar tratamento'}
            </button>
          </div>
        </div>
      }
    >
      {!loading && avisoConsulta}
      {loading ? (
        <div className="py-8 flex items-center justify-center text-muted-foreground text-sm">
          <Loader2 size={16} className="animate-spin mr-2" /> Carregando procedimentos…
        </div>
      ) : semPlano ? (
        <p className="text-sm text-foreground">
          {kind === 'orto'
            ? 'Este paciente não tem plano de ortodontia vinculado (veio pela agenda). A alta tira ele dos pacientes sem agendamento e manda pra "Concluídos". Se ele voltar a marcar ortodontia depois, sai de "Concluídos" sozinho.'
            : 'Este paciente não tem plano de tratamento vinculado.'}
        </p>
      ) : pending.length === 0 ? (
        <p className="text-sm text-foreground">
          Todos os procedimentos já foram feitos ({doneCount}). Confirme pra finalizar o tratamento — ele vai pra “Concluído”.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {doneCount} já feito(s), <b className="text-foreground">{pending.length} em aberto</b>. Indique quem fez cada um
            (gera a comissão desse dentista) ou marque <b className="text-foreground">Não realizado</b> (sem comissão).
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-2">
            <span className="text-xs font-medium text-foreground shrink-0">Aplicar a todos:</span>
            <select
              value=""
              onChange={(e) => applyAll(e.target.value)}
              className="flex-1 min-w-0 px-2 py-1.5 rounded-md border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary/30"
            >
              {options}
            </select>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border max-h-80 overflow-y-auto">
            {pending.map((i) => (
              <div key={i.id} className="flex items-center gap-2 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">
                    {i.name}{i.tooth ? <span className="text-muted-foreground"> · dente {i.tooth}</span> : null}
                  </div>
                  {i.planTitle && <div className="text-[11px] text-muted-foreground truncate">{i.planTitle}</div>}
                </div>
                <select
                  value={choice[i.id] || ''}
                  onChange={(e) => setChoice((c) => ({ ...c, [i.id]: e.target.value }))}
                  className={`w-48 shrink-0 px-2 py-1.5 rounded-md border text-sm outline-none focus:ring-2 focus:ring-primary/30 ${
                    !choice[i.id] ? 'border-amber-300 bg-amber-50/50' : choice[i.id] === NAO_REALIZADO ? 'border-border bg-muted text-muted-foreground' : 'border-emerald-300 bg-emerald-50/50'
                  }`}
                >
                  {options}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </ModalBase>
  );
}
