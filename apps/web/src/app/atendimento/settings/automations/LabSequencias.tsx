'use client';

/**
 * Paridade do laboratório — painel "Sequências de mensagens" da tela de Automações.
 * Só é renderizado na conta de laboratório. Lista as sequências da própria conta,
 * liga/desliga cada uma e edita o texto e o prazo de cada passo. O texto do passo é
 * fixo (campo custom_prompt, aceita {{nome}}); não existe passo com IA no laboratório.
 * Nada é enviado ao servidor sem clique do usuário.
 */
import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, ChevronDown, ChevronUp, Info, Loader2 } from 'lucide-react';
import { showSuccess, showError } from '@/lib/toast';
import api from '@/lib/api';
import { LAB_SEQUENCIAS } from './lab-automacoes-textos';

export interface LabSequenceStep {
  id: string;
  position: number;
  delay_hours: number;
  channel?: string | null;
  custom_prompt?: string | null;
  auto_send?: boolean;
}

export interface LabSequence {
  id: string;
  name: string;
  description?: string | null;
  active: boolean;
  steps: LabSequenceStep[];
  _count?: { enrollments: number };
}

interface StepDraft { text: string; hours: string }

function mensagemDoErro(e: any, padrao: string): string {
  const m = e?.response?.data?.message;
  if (Array.isArray(m)) return m.join(' ');
  return typeof m === 'string' && m ? m : padrao;
}

export default function LabSequencias({ onChanged }: { onChanged?: () => void }) {
  const [seqs, setSeqs] = useState<LabSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, StepDraft>>({});
  const [savingStep, setSavingStep] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<LabSequence[]>('/followup/sequences');
      const list = Array.isArray(res.data) ? res.data : [];
      setSeqs(list);
      setDrafts((old) => {
        const next: Record<string, StepDraft> = {};
        for (const s of list) {
          for (const st of s.steps ?? []) {
            next[st.id] = old[st.id] ?? { text: st.custom_prompt ?? '', hours: String(st.delay_hours ?? 0) };
          }
        }
        return next;
      });
      setError('');
    } catch (e: any) {
      setError(mensagemDoErro(e, LAB_SEQUENCIAS.erroCarregar));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const criarPadrao = async () => {
    setCreating(true);
    setError('');
    try {
      const res = await api.post<{ created: string[] }>('/followup/seed-defaults');
      const n = res.data?.created?.length ?? 0;
      if (n > 0) showSuccess(`${n} ${n === 1 ? LAB_SEQUENCIAS.criadasUma : LAB_SEQUENCIAS.criadasVarias}`);
      else showSuccess(LAB_SEQUENCIAS.nenhumaCriada);
      await load();
      onChanged?.();
    } catch (e: any) {
      const msg = mensagemDoErro(e, LAB_SEQUENCIAS.erroCriar);
      setError(msg);
      showError(msg);
    } finally {
      setCreating(false);
    }
  };

  const alternar = async (seq: LabSequence) => {
    setTogglingId(seq.id);
    setError('');
    try {
      await api.patch(`/followup/sequences/${seq.id}`, { active: !seq.active });
      await load();
      onChanged?.();
    } catch (e: any) {
      const msg = mensagemDoErro(e, LAB_SEQUENCIAS.erroLigar);
      setError(msg);
      showError(msg);
    } finally {
      setTogglingId(null);
    }
  };

  const setDraft = (id: string, changes: Partial<StepDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? { text: '', hours: '0' }), ...changes } }));

  const salvarPasso = async (step: LabSequenceStep) => {
    const d = drafts[step.id] ?? { text: step.custom_prompt ?? '', hours: String(step.delay_hours ?? 0) };
    const hours = Number(d.hours);
    if (!d.text.trim()) { setError(LAB_SEQUENCIAS.textoVazio); return; }
    if (d.hours.trim() === '' || !Number.isFinite(hours) || hours < 0) { setError(LAB_SEQUENCIAS.prazoInvalido); return; }
    setSavingStep(step.id);
    setError('');
    try {
      await api.patch(`/followup/steps/${step.id}`, { custom_prompt: d.text, delay_hours: hours });
      showSuccess(LAB_SEQUENCIAS.salvo);
      // Recarrega e troca o rascunho deste passo pelo valor gravado.
      setDrafts((old) => { const n = { ...old }; delete n[step.id]; return n; });
      await load();
    } catch (e: any) {
      const msg = mensagemDoErro(e, LAB_SEQUENCIAS.erroSalvar);
      setError(msg);
      showError(msg);
    } finally {
      setSavingStep(null);
    }
  };

  const inputCls = 'w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40';

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-bold text-foreground flex items-center gap-2">
          <MessageSquare size={18} className="text-primary" />
          {LAB_SEQUENCIAS.titulo}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{LAB_SEQUENCIAS.subtitulo}</p>
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400">
        <Info size={14} className="mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">{LAB_SEQUENCIAS.avisoTextoFixo}</p>
          <p>{LAB_SEQUENCIAS.avisoNascemDesligadas}</p>
          <p>{LAB_SEQUENCIAS.variavelNome}</p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-600">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> {LAB_SEQUENCIAS.carregando}
        </div>
      ) : seqs.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <MessageSquare size={32} className="mx-auto mb-3 opacity-20" />
          <p className="font-medium text-sm">{LAB_SEQUENCIAS.vazioTitulo}</p>
          <p className="text-xs mt-1 mb-4">{LAB_SEQUENCIAS.vazioTexto}</p>
          <button
            type="button"
            onClick={criarPadrao}
            disabled={creating}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {creating ? LAB_SEQUENCIAS.criando : LAB_SEQUENCIAS.criarPadrao}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {seqs.map((seq) => {
            const open = openId === seq.id;
            const steps = [...(seq.steps ?? [])].sort((a, b) => a.position - b.position);
            const inscritos = seq._count?.enrollments ?? 0;
            return (
              <div key={seq.id} className={`bg-card border rounded-xl overflow-hidden ${seq.active ? 'border-border' : 'border-border/60'}`}>
                <div className="flex items-center gap-3 p-4">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={seq.active}
                    disabled={togglingId === seq.id}
                    onClick={() => alternar(seq)}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50 ${
                      seq.active ? 'bg-emerald-500' : 'bg-muted-foreground/25'
                    }`}
                    title={seq.active ? LAB_SEQUENCIAS.desligarTitulo : LAB_SEQUENCIAS.ligarTitulo}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
                        seq.active ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold text-foreground">{seq.name}</p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${
                          seq.active
                            ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                            : 'bg-muted text-muted-foreground border-border'
                        }`}
                      >
                        {seq.active ? LAB_SEQUENCIAS.ligada : LAB_SEQUENCIAS.desligada}
                      </span>
                    </div>
                    {seq.description ? (
                      <p className="text-[12px] text-muted-foreground mt-0.5">{seq.description}</p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {steps.length} {steps.length === 1 ? LAB_SEQUENCIAS.passoUm : LAB_SEQUENCIAS.passos}
                      {' · '}
                      {inscritos} {inscritos === 1 ? LAB_SEQUENCIAS.inscritoUm : LAB_SEQUENCIAS.inscritosVarios}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : seq.id)}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                  >
                    {open ? LAB_SEQUENCIAS.esconderPassos : LAB_SEQUENCIAS.mostrarPassos}
                    {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                </div>

                {open && (
                  <div className="border-t border-border bg-muted/10 p-4 space-y-4">
                    {steps.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{LAB_SEQUENCIAS.semPassos}</p>
                    ) : (
                      steps.map((st, idx) => {
                        const d = drafts[st.id] ?? { text: st.custom_prompt ?? '', hours: String(st.delay_hours ?? 0) };
                        return (
                          <div key={st.id} className="space-y-2 rounded-lg border border-border bg-card p-3">
                            <p className="text-[11px] font-bold text-muted-foreground uppercase">
                              {LAB_SEQUENCIAS.passoRotulo} {idx + 1}
                            </p>
                            <div>
                              <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">
                                {LAB_SEQUENCIAS.texto}
                              </label>
                              <textarea
                                value={d.text}
                                onChange={(e) => setDraft(st.id, { text: e.target.value })}
                                rows={4}
                                placeholder={LAB_SEQUENCIAS.textoExemplo}
                                className={inputCls}
                              />
                            </div>
                            <div className="flex flex-wrap items-end gap-3">
                              <div>
                                <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">
                                  {idx === 0 ? LAB_SEQUENCIAS.prazoPrimeiro : LAB_SEQUENCIAS.prazo}
                                </label>
                                <input
                                  type="number"
                                  min={0}
                                  value={d.hours}
                                  onChange={(e) => setDraft(st.id, { hours: e.target.value })}
                                  className={inputCls + ' w-32'}
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() => salvarPasso(st)}
                                disabled={savingStep === st.id}
                                className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50"
                              >
                                {savingStep === st.id ? LAB_SEQUENCIAS.salvando : LAB_SEQUENCIAS.salvar}
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
