'use client';

/**
 * Out/2026 — "Organizar pacientes por dentista" (dados antigos).
 *
 * Mostra a PRÉVIA (GET /dentist-links/backfill) de quantos procedimentos e
 * pacientes serão ligados a cada dentista e só grava ao confirmar
 * (POST /dentist-links/backfill). Preenche SÓ o que está vazio — nunca troca um
 * dentista já escolhido. Regras no backend (patients/dentist-backfill.ts).
 */

import { useEffect, useState } from 'react';
import { Loader2, Users, X, Check } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Preview {
  por_dentista: Array<{ dentist_id: string; nome: string; procedimentos_orcamento: number; procedimentos_plano: number; pacientes_responsavel: number }>;
  totais: { procedimentos_orcamento: number; procedimentos_plano: number; pacientes_responsavel: number };
  sem_dentista: { quoteItems: number; planItems: number; patients: number };
}

export function OrganizarPacientesModal({ onClose }: { onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [feito, setFeito] = useState<Preview['totais'] | null>(null);

  useEffect(() => {
    api.get<Preview>('/dentist-links/backfill')
      .then((r) => setPreview(r.data))
      .catch((e) => showError(e?.response?.data?.message || 'Não consegui calcular a prévia'))
      .finally(() => setLoading(false));
  }, []);

  const total = preview
    ? preview.totais.procedimentos_orcamento + preview.totais.procedimentos_plano + preview.totais.pacientes_responsavel
    : 0;

  const aplicar = async () => {
    if (!preview || applying) return;
    setApplying(true);
    try {
      const { data } = await api.post<{ gravados: Preview['totais'] }>('/dentist-links/backfill');
      setFeito(data.gravados);
      showSuccess('Pacientes organizados por dentista ✓');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não consegui gravar');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => !applying && onClose()}>
      <div className="w-full max-w-2xl bg-card border border-border rounded-2xl shadow-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <Users size={18} className="text-primary" /> Organizar pacientes por dentista
            </h2>
            <p className="text-xs text-muted-foreground mt-1 leading-snug">
              Liga os dados antigos aos dentistas: cada procedimento vai pro dentista da área (ou de quem avaliou/executou)
              e o paciente sem responsável ganha o dentista da 1ª consulta confirmada. <b>Só preenche o que está vazio.</b>
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={applying} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto">
          {loading ? (
            <div className="py-10 flex items-center justify-center text-muted-foreground text-sm">
              <Loader2 size={18} className="animate-spin mr-2" /> Calculando a prévia...
            </div>
          ) : !preview ? (
            <p className="text-sm text-muted-foreground">Sem prévia.</p>
          ) : feito ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-foreground">
              <p className="font-semibold flex items-center gap-1.5"><Check size={16} className="text-emerald-600" /> Pronto!</p>
              <p className="mt-1 text-muted-foreground">
                {feito.procedimentos_orcamento} procedimento(s) de orçamento, {feito.procedimentos_plano} do plano e{' '}
                {feito.pacientes_responsavel} paciente(s) ligados aos dentistas.
              </p>
            </div>
          ) : total === 0 ? (
            <p className="text-sm text-muted-foreground">Nada pra organizar — tudo já está ligado a um dentista.</p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-xs text-muted-foreground">
                      <th className="text-left px-3 py-2 font-medium">Dentista</th>
                      <th className="text-right px-3 py-2 font-medium">Proc. em orçamentos</th>
                      <th className="text-right px-3 py-2 font-medium">Proc. em planos</th>
                      <th className="text-right px-3 py-2 font-medium">Pacientes (responsável)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.por_dentista.map((r) => (
                      <tr key={r.dentist_id} className="border-t border-border">
                        <td className="px-3 py-2 font-medium text-foreground">{r.nome}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.procedimentos_orcamento}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.procedimentos_plano}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.pacientes_responsavel}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-border bg-muted/20 font-semibold">
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{preview.totais.procedimentos_orcamento}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{preview.totais.procedimentos_plano}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{preview.totais.pacientes_responsavel}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {(preview.sem_dentista.quoteItems + preview.sem_dentista.planItems + preview.sem_dentista.patients) > 0 && (
                <p className="text-xs text-muted-foreground mt-3 leading-snug">
                  Ficam sem dentista (nenhum da área e ninguém da clínica avaliou/executou):{' '}
                  {preview.sem_dentista.quoteItems} proc. de orçamento, {preview.sem_dentista.planItems} de plano e{' '}
                  {preview.sem_dentista.patients} paciente(s) sem consulta confirmada. Dá pra ajustar depois na Avaliação/ficha.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-3 border-t border-border">
          <button type="button" onClick={onClose} disabled={applying} className="h-10 px-4 rounded-xl text-sm font-semibold text-muted-foreground hover:bg-accent">
            {feito ? 'Fechar' : 'Cancelar'}
          </button>
          {!feito && preview && total > 0 && (
            <button
              type="button"
              onClick={aplicar}
              disabled={applying}
              className="h-10 px-4 rounded-xl text-sm font-semibold btn-primary inline-flex items-center gap-1.5 disabled:opacity-60"
            >
              {applying ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Organizar agora
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
