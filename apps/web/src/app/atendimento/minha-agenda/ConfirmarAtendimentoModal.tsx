'use client';

/**
 * Out/2026 — "Confirmar atendimento" (Minha agenda do dentista).
 *
 * Agenda + validação num passo só: ao marcar "Atendido", o dentista escreve o
 * que fez e marca os procedimentos do plano que executou. Ao salvar:
 *   1. procedimentos marcados → POST /treatment-plan-items/:id/execute (vira
 *      "feito", gera pontuação/retorno — mesmo caminho da aba Tratamento);
 *   2. evolução no PRONTUÁRIO → POST /patients/:id/clinical-notes (campo P —
 *      conduta, ligada à consulta e aos itens executados);
 *   3. atendimento validado → POST /calendar/events/:id/validate (CONCLUIDO +
 *      validado). Sem dentista atribuído, cai no PATCH de status.
 * Só aparecem procedimentos de plano JÁ LIBERADO pelo Financeiro (mesma regra
 * da aba Tratamento). Lead sem ficha: valida primeiro (o sistema cria a ficha).
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Stethoscope, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useRole } from '@/lib/useRole';

export interface ConfirmEvent {
  id: string;
  type: string;
  status: string;
  start_at: string;
  validated_at?: string | null;
  assigned_user_id?: string | null;
  patient?: { id: string; name: string } | null;
  lead?: { id: string; name: string | null } | null;
  appointment_type?: { name?: string | null } | null;
}

interface PlanItemRow {
  plan_id: string;
  plan_validated_by_financial_at: string | null;
  quote_title: string | null;
  item: {
    id: string;
    procedure_name: string;
    tooth_fdi: string | null;
    quantity: number;
    status: string;
    /** Out/2026 — dentista responsável pelo item (cada área o seu). */
    dentist?: { id: string; name: string } | null;
  };
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function ddmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const itemLabel = (r: PlanItemRow) =>
  `${r.item.procedure_name}${r.item.tooth_fdi ? ` (dente ${r.item.tooth_fdi})` : ''}${r.item.quantity > 1 ? ` ×${r.item.quantity}` : ''}`;

export function ConfirmarAtendimentoModal({
  event, onClose, onConfirmed,
}: {
  event: ConfirmEvent;
  onClose: () => void;
  onConfirmed: (patch: { status: string; validated_at: string | null }) => void;
}) {
  const role = useRole();
  const nome = event.patient?.name || event.lead?.name || 'Paciente';
  const what = event.appointment_type?.name || event.type;
  const [texto, setTexto] = useState('');
  const [items, setItems] = useState<PlanItemRow[]>([]);
  const [loadingItems, setLoadingItems] = useState(!!event.patient?.id);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [executados, setExecutados] = useState<Set<string>>(new Set()); // já gravados (retry não repete)
  // Etapas já gravadas numa tentativa anterior (retry não repete validação/evolução).
  const [feito, setFeito] = useState<{ validado: boolean; nota: boolean; patientId: string | null }>({
    validado: !!event.validated_at, nota: false, patientId: event.patient?.id ?? null,
  });
  const [saving, setSaving] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!event.patient?.id) return;
    let alive = true;
    api.get<{ items: PlanItemRow[] }>(`/patients/${event.patient.id}/treatment-items`)
      .then((r) => {
        if (!alive) return;
        // Plano liberado, item pendente e que é DESTE dentista (ou ainda sem dentista):
        // o canal do endodontista não aparece pra ortodontista confirmar.
        // Fase 0 — mesmo critério do backend: quem confirma é QUEM ESTÁ LOGADO (o admin
        // vê pelo dentista da consulta); o servidor recusa item de outro dentista.
        const meu = (role.isAdmin || role.isSuperAdmin)
          ? (event.assigned_user_id ?? null)
          : (role.userId ?? event.assigned_user_id ?? null);
        const rows = (r.data?.items ?? []).filter(
          (x) => x.plan_validated_by_financial_at
            && !['DONE', 'CANCELLED'].includes(x.item.status)
            && (!x.item.dentist || !meu || x.item.dentist.id === meu),
        );
        setItems(rows);
      })
      .catch(() => { if (alive) setItems([]); })
      .finally(() => { if (alive) setLoadingItems(false); });
    return () => { alive = false; };
  }, [event.patient?.id]);

  // Esc fecha (se não estiver salvando).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  const marcadosRows = useMemo(() => items.filter((r) => marcados.has(r.item.id)), [items, marcados]);
  const podeSalvar = texto.trim().length > 0 || marcados.size > 0;

  const toggle = (id: string) => setMarcados((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const salvar = async () => {
    if (!podeSalvar || saving) return;
    setSaving(true);
    setErro('');
    let { validado, nota, patientId } = feito;
    const marca = () => setFeito({ validado, nota, patientId });
    try {
      // Lead sem ficha: valida antes (o backend cria o paciente a partir do lead).
      if (!patientId && !validado && event.assigned_user_id) {
        await api.post(`/calendar/events/${event.id}/validate`, { notes: texto.trim() || undefined });
        validado = true; marca();
        const { data } = await api.get<{ patient?: { id: string } | null }>(`/calendar/events/${event.id}`);
        patientId = data?.patient?.id ?? null; marca();
      }

      // 1) Procedimentos executados (pula os que já foram numa tentativa anterior).
      const feitos = new Set(executados);
      for (const r of marcadosRows) {
        if (feitos.has(r.item.id)) continue;
        await api.post(`/treatment-plan-items/${r.item.id}/execute`, { appointment_id: event.id });
        feitos.add(r.item.id);
        setExecutados(new Set(feitos));
      }

      // 2) Evolução no prontuário (P — conduta), ligada à consulta e aos itens.
      if (patientId && !nota) {
        const procs = marcadosRows.map(itemLabel);
        const conduta = [
          procs.length ? `Procedimentos realizados: ${procs.join('; ')}.` : '',
          texto.trim(),
        ].filter(Boolean).join('\n');
        await api.post(`/patients/${patientId}/clinical-notes`, {
          appointment_id: event.id,
          plan: conduta,
          executed_items: Array.from(feitos),
        });
        nota = true; marca();
      }

      // 3) Confirma o atendimento.
      if (!validado) {
        if (event.assigned_user_id) {
          try {
            await api.post(`/calendar/events/${event.id}/validate`, { notes: texto.trim() || undefined });
          } catch {
            await api.patch(`/calendar/events/${event.id}/status`, { status: 'CONCLUIDO' });
          }
        } else {
          await api.patch(`/calendar/events/${event.id}/status`, { status: 'CONCLUIDO' });
        }
        validado = true; marca();
      }

      toast.success(patientId ? 'Atendimento confirmado e salvo no prontuário ✓' : 'Atendimento confirmado ✓');
      onConfirmed({ status: 'CONCLUIDO', validated_at: new Date().toISOString() });
    } catch (e: any) {
      setErro(e?.response?.data?.message || 'Não consegui salvar tudo. Confira e tente de novo — o que já foi gravado não se repete.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Confirmar atendimento de ${nome}`}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground flex items-center gap-2">
              <Stethoscope size={18} className="text-[#15803d]" /> Confirmar atendimento
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {nome} · {ddmm(event.start_at)} às {hhmm(event.start_at)} · {what}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <div>
            <label className="text-sm font-semibold text-foreground" htmlFor="o-que-foi-feito">O que foi feito</label>
            <textarea
              id="o-que-foi-feito"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={4}
              autoFocus
              placeholder="Ex.: Raspagem e polimento. Orientei higiene. Próxima etapa: restauração do 26."
              className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-[11px] text-muted-foreground mt-1">Vai pro prontuário do paciente como evolução (P — conduta).</p>
          </div>

          {event.patient?.id && (
            <div>
              <p className="text-sm font-semibold text-foreground">Procedimentos do plano feitos hoje</p>
              {loadingItems ? (
                <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 size={14} className="animate-spin" /> Carregando o plano...
                </div>
              ) : items.length === 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">Nenhum procedimento pendente no plano liberado deste paciente.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {items.map((r) => {
                    const on = marcados.has(r.item.id);
                    const ja = executados.has(r.item.id);
                    return (
                      <li key={r.item.id}>
                        <label
                          className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border cursor-pointer transition-colors ${
                            on ? 'border-[#15803d]/50 bg-[#15803d]/5' : 'border-border hover:bg-accent/40'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={ja || saving}
                            onChange={() => toggle(r.item.id)}
                            className="w-4 h-4 accent-[#15803d] shrink-0"
                          />
                          <span className="text-sm text-foreground flex-1 min-w-0 truncate">{itemLabel(r)}</span>
                          {ja && <span className="text-[10px] font-bold text-[#15803d]">feito ✓</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {erro && (
            <div className="text-sm text-red-700 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">{erro}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-10 px-4 rounded-xl text-sm font-semibold text-muted-foreground hover:bg-accent"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={salvar}
            disabled={!podeSalvar || saving}
            title={podeSalvar ? '' : 'Escreva o que foi feito ou marque um procedimento'}
            className="h-10 px-4 rounded-xl text-sm font-semibold text-white inline-flex items-center gap-1.5 disabled:opacity-50"
            style={{ background: '#15803d' }}
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Confirmar atendimento
          </button>
        </div>
      </div>
    </div>
  );
}
