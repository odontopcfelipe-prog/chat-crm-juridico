'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Building2, CheckCircle2, RefreshCw, Clock, MapPin, BookOpen, Copy } from 'lucide-react';
import api from '@/lib/api';
import { maskCEPInput, maskPhoneInput } from '@/lib/utils';
import {
  apiErrorMessage,
  formatClinicHours,
  formatTenantAddress,
  normalizeClinicHours,
  SUGGESTED_CLINIC_HOURS,
  WEEK_ROWS,
  type AiProfileResponse,
  type ClinicHours,
  type WeekDayKey,
} from './clinic-hours';

// Campos da clínica que a tela edita (vêm do Tenant — os mesmos de Ajustes › Identidade).
const FIELDS = [
  'name',
  'phone',
  'zip_code',
  'address',
  'address_number',
  'address_complement',
  'neighborhood',
  'city',
  'state',
] as const;
type FieldKey = (typeof FIELDS)[number];
type ClinicForm = Record<FieldKey, string>;
type Original = Record<FieldKey, string | null>;

type DayRow = { open: boolean; from: string; to: string };
type Rows = Record<WeekDayKey, DayRow>;

const EMPTY_FORM: ClinicForm = {
  name: '', phone: '', zip_code: '', address: '', address_number: '',
  address_complement: '', neighborhood: '', city: '', state: '',
};

/** Linhas da tela a partir do horário salvo. Dia fechado guarda um horário de sugestão pra quando abrir. */
function rowsFromHours(h: ClinicHours): Rows {
  const rows = {} as Rows;
  for (const { key } of WEEK_ROWS) {
    const v = h.days[key];
    rows[key] = v
      ? { open: true, from: v.open, to: v.close }
      : { open: false, from: '08:00', to: key === '6' ? '12:00' : '18:00' };
  }
  return rows;
}

/** Só os dias abertos e válidos — o mesmo formato que a API guarda. */
function hoursFromRows(rows: Rows): ClinicHours {
  const days: ClinicHours['days'] = {};
  for (const { key } of WEEK_ROWS) {
    const r = rows[key];
    if (r.open && r.from && r.to && r.from < r.to) days[key] = { open: r.from, close: r.to };
  }
  return { days };
}

const rowInvalid = (r: DayRow) => r.open && (!r.from || !r.to || r.from >= r.to);

const inputCls =
  'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60';

// Fora do componente pra não remontar (e perder o foco) a cada tecla.
function Field({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Dados da clínica que a IA usa pra responder (nome, contato, endereço, horário e
 * o resumo da clínica). Valem para TODOS os chips desta clínica — nunca de outra.
 * Nome/telefone/endereço são os mesmos de Ajustes › Identidade (mudar aqui muda lá).
 */
export function AiClinicInfoCard() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<ClinicForm>(EMPTY_FORM);
  // Valor como veio do banco: campo que ninguém mexeu volta igual (não reescreve
  // telefone salvo com outro formato, por exemplo).
  const [original, setOriginal] = useState<Original | null>(null);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});

  const [rows, setRows] = useState<Rows>(() => rowsFromHours(SUGGESTED_CLINIC_HOURS));
  // null = a clínica nunca salvou horário → os dias abaixo são só sugestão.
  const [savedHours, setSavedHours] = useState<ClinicHours | null>(null);
  const [legacyHours, setLegacyHours] = useState('');
  // O admin mexeu na grade? Sem grade salva, a sugestão só é gravada se ele mexeu
  // (ou se não há horário nenhum no cadastro) — salvar só o telefone não pode trocar
  // o horário escrito no onboarding pela sugestão.
  const [hoursTouched, setHoursTouched] = useState(false);

  const [summary, setSummary] = useState('');
  const [savedSummary, setSavedSummary] = useState('');
  const [summaryExists, setSummaryExists] = useState(false);
  const [summaryManual, setSummaryManual] = useState(false);

  const applyData = (d: Partial<AiProfileResponse> | null | undefined) => {
    const c: Partial<AiProfileResponse['clinic']> = d?.clinic ?? {};
    const orig = {} as Original;
    for (const k of FIELDS) orig[k] = c[k] == null ? null : String(c[k]);
    setOriginal(orig);
    setTouched({});
    setForm({
      name: orig.name || '',
      phone: maskPhoneInput(orig.phone || ''),
      zip_code: maskCEPInput(orig.zip_code || ''),
      address: orig.address || '',
      address_number: orig.address_number || '',
      address_complement: orig.address_complement || '',
      neighborhood: orig.neighborhood || '',
      city: orig.city || '',
      state: (orig.state || '').toUpperCase(),
    });
    const h = normalizeClinicHours(c.hours);
    setSavedHours(h);
    setRows(rowsFromHours(h ?? SUGGESTED_CLINIC_HOURS));
    setHoursTouched(false);
    setLegacyHours(String(c.business_hours || '').trim());
    const s: Partial<AiProfileResponse['summary']> = d?.summary ?? {};
    setSummary(String(s.text || ''));
    setSavedSummary(String(s.text || ''));
    setSummaryExists(!!s.exists);
    setSummaryManual(!!s.manuallyEdited);
  };

  useEffect(() => {
    api.get('/settings/ai-profile')
      .then((r) => applyData(r.data))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const setField = (k: FieldKey, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setTouched((t) => ({ ...t, [k]: true }));
  };

  // Autopreenche o endereço pelo CEP (ViaCEP, best-effort — igual Identidade).
  const lookupCep = async (masked: string) => {
    const d = masked.replace(/\D/g, '');
    if (d.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${d}/json/`);
      const j = await r.json();
      if (j?.erro) return;
      if (j.logradouro) setField('address', j.logradouro);
      if (j.bairro) setField('neighborhood', j.bairro);
      if (j.localidade) setField('city', j.localidade);
      if (j.uf) setField('state', String(j.uf).toUpperCase());
    } catch {
      /* sem internet ou CEP indisponível — preenche manual */
    }
  };

  /** Valor que vai pra API: campo não mexido volta exatamente como veio. */
  const fieldValue = (k: FieldKey): string | null => {
    if (!original) return null;
    if (!touched[k]) return original[k];
    const v = form[k].trim();
    if (k === 'phone' || k === 'zip_code') return v.replace(/\D/g, '') || null;
    if (k === 'state') return v.toUpperCase() || null;
    return v || null;
  };

  const hours = useMemo(() => hoursFromRows(rows), [rows]);
  const hoursPreview = formatClinicHours(hours);
  const addressPreview = formatTenantAddress({
    address: form.address,
    address_number: form.address_number,
    address_complement: form.address_complement,
    neighborhood: form.neighborhood,
    city: form.city,
    state: form.state,
  });
  const invalidDays = WEEK_ROWS.filter(({ key }) => rowInvalid(rows[key]));

  const fieldsDirty = FIELDS.some((k) => touched[k] && fieldValue(k) !== (original?.[k] ?? null));
  const hoursChanged = JSON.stringify(hours) !== JSON.stringify(savedHours);
  const sendHours = savedHours ? hoursChanged : hoursTouched || !legacyHours;
  const hoursDirty = savedHours ? hoursChanged : sendHours;
  const summaryDirty = summary.trim() !== savedSummary.trim();
  const dirty = fieldsDirty || hoursDirty || summaryDirty;

  const setRow = (key: WeekDayKey, patch: Partial<DayRow>) => {
    setHoursTouched(true);
    setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }));
  };

  // Repete o horário de segunda de terça a sexta (o caso mais comum).
  const copyMondayToWeek = () => {
    setHoursTouched(true);
    setRows((r) => {
      const next = { ...r };
      for (const k of ['2', '3', '4', '5'] as const) next[k] = { ...r['1'] };
      return next;
    });
  };

  const save = async () => {
    if (!original) return;
    if (!form.name.trim()) {
      setError('Preencha o nome da clínica.');
      return;
    }
    if (summaryDirty && !summary.trim()) {
      setError('O resumo não pode ficar vazio. Para refazer do zero, use "Regenerar" na Base de conhecimento.');
      return;
    }
    if (invalidDays.length) {
      setError(`Confira o horário de ${invalidDays.map((d) => d.label.toLowerCase()).join(', ')}: o fechamento precisa ser depois da abertura.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const k of FIELDS) payload[k] = fieldValue(k);
      // Só manda o que mudou: o resumo igual não pode virar "editado à mão" (isso
      // pausa a atualização noturna) e a sugestão de horário não pode sobrescrever
      // o horário do cadastro sem o admin mexer.
      if (sendHours) payload.hours = hours;
      if (summaryDirty) payload.summary = summary;
      const { data } = await api.put('/settings/ai-profile/clinic', payload);
      applyData(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(apiErrorMessage(e, 'Não consegui salvar.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border flex flex-wrap items-center justify-between gap-3 bg-primary/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Building2 size={16} />
          </div>
          <div>
            <h4 className="text-sm font-bold text-foreground">Dados da clínica para a IA</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xl">
              O que a IA responde quando o paciente pergunta endereço, telefone, horário ou sobre a clínica.
            </p>
          </div>
        </div>
        <span className="text-[11px] font-semibold rounded-lg bg-primary/10 text-primary px-2.5 py-1">
          Vale para todos os chips desta clínica
        </span>
      </div>

      <div className="p-5 space-y-4">
        {loading ? (
          <div className="flex justify-center py-4"><RefreshCw className="animate-spin text-muted-foreground" size={18} /></div>
        ) : loadError || !original ? (
          <p className="text-xs rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-2">
            Não consegui carregar os dados da clínica. Recarregue a página e tente de novo.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground">
              Comercial, Clínica e Financeiro usam estes mesmos dados. Nome, telefone e endereço são os mesmos de{' '}
              <Link href="/atendimento/settings/identidade" className="font-semibold text-primary hover:underline">Identidade da clínica</Link>
              {' '}— mudar aqui muda lá também.
            </p>

            {/* ── Contato e endereço ── */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <Field label="Nome da clínica" className="sm:col-span-8">
                <input value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="Ex.: Clínica Sorriso" className={inputCls} />
              </Field>
              <Field label="Telefone / WhatsApp" className="sm:col-span-4">
                <input
                  value={form.phone}
                  onChange={(e) => setField('phone', maskPhoneInput(e.target.value))}
                  inputMode="tel"
                  placeholder="(82) 99999-9999"
                  className={inputCls}
                />
              </Field>
              <Field label="CEP" className="sm:col-span-3">
                <input
                  value={form.zip_code}
                  onChange={(e) => { const m = maskCEPInput(e.target.value); setField('zip_code', m); lookupCep(m); }}
                  inputMode="numeric"
                  placeholder="00000-000"
                  className={inputCls}
                />
              </Field>
              <Field label="Endereço" className="sm:col-span-7">
                <input value={form.address} onChange={(e) => setField('address', e.target.value)} placeholder="Rua, avenida…" className={inputCls} />
              </Field>
              <Field label="Número" className="sm:col-span-2">
                <input value={form.address_number} onChange={(e) => setField('address_number', e.target.value)} placeholder="123" className={inputCls} />
              </Field>
              <Field label="Complemento" className="sm:col-span-3">
                <input value={form.address_complement} onChange={(e) => setField('address_complement', e.target.value)} placeholder="Sala 2, 1º andar…" className={inputCls} />
              </Field>
              <Field label="Bairro" className="sm:col-span-3">
                <input value={form.neighborhood} onChange={(e) => setField('neighborhood', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Cidade" className="sm:col-span-4">
                <input value={form.city} onChange={(e) => setField('city', e.target.value)} className={inputCls} />
              </Field>
              <Field label="UF" className="sm:col-span-2">
                <input
                  value={form.state}
                  onChange={(e) => setField('state', e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase())}
                  placeholder="AL"
                  maxLength={2}
                  className={inputCls}
                />
              </Field>
            </div>
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <MapPin size={12} className="mt-0.5 shrink-0" />
              <span>
                {addressPreview
                  ? <>A IA vai informar o endereço assim: <b className="text-foreground">{addressPreview}</b></>
                  : 'Sem endereço: a IA vai dizer que não tem essa informação.'}
              </span>
            </p>

            {/* ── Dias e horários de atendimento ── */}
            <div className="pt-2 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h5 className="text-sm font-bold text-foreground flex items-center gap-2">
                  <Clock size={14} className="text-primary" /> Dias e horários de atendimento
                </h5>
                <button
                  type="button"
                  onClick={copyMondayToWeek}
                  className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
                >
                  <Copy size={12} /> Repetir o horário de segunda até sexta
                </button>
              </div>

              {!savedHours && (
                <p className="text-xs font-semibold rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-2">
                  Ainda não salvo: estes dias são só uma sugestão. Confira e clique em Salvar.
                  {legacyHours && (
                    <span className="font-normal">
                      {' '}No cadastro da clínica está escrito: &quot;{legacyHours}&quot;. Ajuste os dias abaixo para ficar igual: a
                      grade só é salva depois que você mexer nela (até lá a IA usa o texto do cadastro).
                    </span>
                  )}
                </p>
              )}

              <div className="rounded-xl border border-border divide-y divide-border/60">
                {WEEK_ROWS.map(({ key, label }) => {
                  const r = rows[key];
                  const bad = rowInvalid(r);
                  return (
                    <div key={key} className="px-3 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <span className="w-20 text-sm font-semibold text-foreground">{label}</span>
                      <label className="flex items-center gap-2 cursor-pointer select-none w-24">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={r.open}
                          aria-label={`${label}: ${r.open ? 'aberto' : 'fechado'}`}
                          onClick={() => setRow(key, { open: !r.open })}
                          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${r.open ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${r.open ? 'translate-x-4' : ''}`} />
                        </button>
                        <span className={`text-xs font-semibold ${r.open ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {r.open ? 'Aberto' : 'Fechado'}
                        </span>
                      </label>
                      {r.open && (
                        <div className="flex items-center gap-2">
                          <input
                            type="time"
                            step={300}
                            value={r.from}
                            onChange={(e) => setRow(key, { from: e.target.value })}
                            aria-label={`${label}: abre às`}
                            className={`rounded-xl border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/60 ${bad ? 'border-red-500' : 'border-border'}`}
                          />
                          <span className="text-xs text-muted-foreground">às</span>
                          <input
                            type="time"
                            step={300}
                            value={r.to}
                            onChange={(e) => setRow(key, { to: e.target.value })}
                            aria-label={`${label}: fecha às`}
                            className={`rounded-xl border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/60 ${bad ? 'border-red-500' : 'border-border'}`}
                          />
                        </div>
                      )}
                      {bad && <span className="text-[11px] text-red-500 w-full sm:w-auto">O fechamento precisa ser depois da abertura.</span>}
                    </div>
                  );
                })}
              </div>

              <div>
                <p className="text-[11px] font-semibold text-muted-foreground mb-1">A IA vai falar assim:</p>
                <p className="rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm text-foreground">
                  {hoursPreview || 'Todos os dias fechados.'}
                </p>
              </div>
            </div>

            {/* ── Resumo da clínica ── */}
            <div className="pt-2 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h5 className="text-sm font-bold text-foreground flex items-center gap-2">
                  <BookOpen size={14} className="text-primary" /> Resumo da clínica
                </h5>
                {summaryManual && (
                  <span className="text-[11px] font-semibold rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-0.5">
                    Editado aqui · atualização automática pausada
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                É o que a IA sabe sobre a clínica: equipe, diferenciais, estrutura. Ele se atualiza sozinho toda noite com o que
                está na{' '}
                <Link href="/atendimento/settings/knowledge" className="font-semibold text-primary hover:underline">Base de conhecimento</Link>.
                {' '}Se você editar aqui, essa atualização automática da noite fica pausada.
              </p>
              {!summaryExists && !summary.trim() && (
                <p className="text-xs rounded-lg bg-muted/50 text-muted-foreground px-3 py-2">
                  Ainda não há resumo. Ele aparece aqui depois da próxima atualização da noite, ou você pode escrever agora.
                </p>
              )}
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={10}
                placeholder="Ex.: Clínica com 3 dentistas (clínico geral, ortodontia e implante), escaneamento digital, estacionamento próprio…"
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/60 resize-y"
              />
              {summaryDirty && !summaryManual && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Ao salvar, o resumo passa a ser o seu texto e a atualização automática da noite fica pausada.
                </p>
              )}
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {dirty && !saving && !saved && (
                <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">Alterações não salvas</span>
              )}
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {saved ? <><CheckCircle2 size={15} /> Salvo</> : saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
