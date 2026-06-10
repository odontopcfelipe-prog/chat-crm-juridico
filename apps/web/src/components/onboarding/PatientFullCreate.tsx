'use client';

/**
 * Onda 17.32.148 — Form completo de cadastro de paciente no Onboarding Wizard.
 *
 * Inspirado no NewPatientModal (apps/web/src/app/atendimento/pacientes/components/),
 * mas leve o suficiente pra viver inline no wizard. Seções:
 *
 *   1. Identificação  (sempre aberta) — nome, CPF, RG, nasc, gênero, estado civil
 *   2. Contato        (sempre aberta) — telefone, e-mail
 *   3. Endereço       (colapsável)    — CEP (auto-fill via ViaCEP), rua, número, etc
 *   4. Adicionais     (colapsável)    — tipo sanguíneo, contato emergência, queixa, notas
 *
 * Banner verde de sucesso e form reseta após salvar pra cadastrar outro.
 */
import { useState, useCallback } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronUp, Loader2, UserPlus, AlertCircle,
  Home, Heart, Phone,
} from 'lucide-react';
import api from '@/lib/api';

interface Props {
  alreadyDone?: boolean;
  onCreated: () => Promise<void>;
}

const MARITAL_OPTIONS = [
  { v: '', l: '—' },
  { v: 'SOLTEIRO',      l: 'Solteiro(a)' },
  { v: 'CASADO',        l: 'Casado(a)' },
  { v: 'UNIAO_ESTAVEL', l: 'União estável' },
  { v: 'DIVORCIADO',    l: 'Divorciado(a)' },
  { v: 'VIUVO',         l: 'Viúvo(a)' },
];

const STATES = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
  'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
];

const BLOOD_TYPES = ['A+','A-','B+','B-','AB+','AB-','O+','O-'];

const EMPTY = {
  name: '', cpf: '', rg: '', birthDate: '', gender: '', maritalStatus: '',
  phone: '', email: '',
  zipCode: '', address: '', addressNumber: '', addressComplement: '',
  neighborhood: '', city: '', state: '',
  bloodType: '',
  emergencyName: '', emergencyPhone: '',
  chiefComplaint: '', notes: '',
};

// Onda 17.32.167 — tokens dark da skill design-odonto-system (acento blue)
const inputCls =
  'w-full px-3 py-2 rounded-lg bg-white/[0.04] text-sm text-zinc-100 ring-1 ring-white/10 placeholder:text-zinc-600 transition focus:outline-none focus:ring-2 focus:ring-blue-400/40 [color-scheme:dark]';
const labelCls = 'block text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-1';

export default function PatientFullCreate({ alreadyDone = false, onCreated }: Props) {
  const [form, setForm] = useState({ ...EMPTY });
  const [submitting, setSubmitting] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successName, setSuccessName] = useState<string | null>(null);

  // Sections colapsadas por default (exceto Identificacao+Contato sempre abertas)
  const [openAddress, setOpenAddress] = useState(false);
  const [openExtra, setOpenExtra] = useState(false);

  const set = (k: keyof typeof EMPTY, v: any) =>
    setForm((f) => ({ ...f, [k]: v }));

  // ─── CEP auto-fill via ViaCEP ─────────────────────────────────────
  const handleCepBlur = useCallback(async () => {
    const cep = form.zipCode.replace(/\D/g, '');
    if (cep.length !== 8) return;
    setCepLoading(true);
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const data = await res.json();
      if (data?.erro) return;
      setForm((f) => ({
        ...f,
        address: data.logradouro || f.address,
        neighborhood: data.bairro || f.neighborhood,
        city: data.localidade || f.city,
        state: data.uf || f.state,
      }));
    } catch { /* ignora */ }
    finally { setCepLoading(false); }
  }, [form.zipCode]);

  // ─── Submit ───────────────────────────────────────────────────────
  const submit = async () => {
    setError(null);
    if (!form.name.trim()) {
      setError('Nome é obrigatório.');
      return;
    }
    setSubmitting(true);
    try {
      const payload: any = { name: form.name.trim() };
      if (form.cpf.trim())             payload.cpf = form.cpf.trim();
      if (form.rg.trim())              payload.rg = form.rg.trim();
      if (form.birthDate)              payload.birth_date = form.birthDate;
      if (form.gender)                 payload.gender = form.gender;
      if (form.maritalStatus)          payload.marital_status = form.maritalStatus;
      if (form.phone.trim())           payload.phone = form.phone.trim();
      if (form.email.trim())           payload.email = form.email.trim();
      if (form.zipCode.trim())         payload.zip_code = form.zipCode.trim();
      if (form.address.trim())         payload.address = form.address.trim();
      if (form.addressNumber.trim())   payload.address_number = form.addressNumber.trim();
      if (form.addressComplement.trim()) payload.address_complement = form.addressComplement.trim();
      if (form.neighborhood.trim())    payload.neighborhood = form.neighborhood.trim();
      if (form.city.trim())            payload.city = form.city.trim();
      if (form.state)                  payload.state = form.state;
      if (form.bloodType)              payload.blood_type = form.bloodType;
      if (form.emergencyName.trim())   payload.emergency_contact_name = form.emergencyName.trim();
      if (form.emergencyPhone.trim())  payload.emergency_contact_phone = form.emergencyPhone.trim();
      if (form.chiefComplaint.trim())  payload.chief_complaint = form.chiefComplaint.trim();
      if (form.notes.trim())           payload.notes = form.notes.trim();

      await api.post('/patients', payload);

      const savedName = form.name.trim();
      setSuccessName(savedName);
      setForm({ ...EMPTY });
      await onCreated();
      setTimeout(() => setSuccessName(null), 5000);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      if (typeof raw === 'string' && raw.startsWith('Cannot')) {
        setError('Servidor ainda não reconhece — deploy em andamento?');
      } else if (Array.isArray(raw)) {
        setError(raw.join(', '));
      } else {
        setError(raw || 'Não foi possível criar o paciente.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = form.name.trim().length >= 2 && !submitting;

  return (
    <div className="rounded-2xl border border-white/5 bg-black/30 p-5 max-h-[55vh] overflow-y-auto">
      {/* Banner de sucesso */}
      {successName && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-emerald-400/30 bg-emerald-500/15 p-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-emerald-950">
            <CheckCircle2 size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-emerald-300">
              Paciente cadastrado com sucesso!
            </p>
            <p className="truncate text-xs text-emerald-300/80">
              "{successName}" foi salvo. Cadastre outro ou clique em "Continuar".
            </p>
          </div>
        </div>
      )}
      {alreadyDone && !successName && (
        <p className="mb-4 flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 size={12} />
          Você já tem pacientes cadastrados. Quer adicionar mais um agora?
        </p>
      )}

      {/* ─── Identificação ──────────────────────────────────────── */}
      <SectionTitle icon={<UserPlus size={14} />}>Identificação</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <label className={labelCls}>Nome completo *</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Ex: Maria da Silva"
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>CPF</label>
          <input
            type="text"
            value={form.cpf}
            onChange={(e) => set('cpf', e.target.value)}
            placeholder="000.000.000-00"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>RG</label>
          <input
            type="text"
            value={form.rg}
            onChange={(e) => set('rg', e.target.value)}
            placeholder="00.000.000-0"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Data de nascimento</label>
          <input
            type="date"
            value={form.birthDate}
            onChange={(e) => set('birthDate', e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Gênero</label>
          <select
            value={form.gender}
            onChange={(e) => set('gender', e.target.value)}
            className={`${inputCls} cursor-pointer`}
          >
            <option value="" className="bg-zinc-900">—</option>
            <option value="M" className="bg-zinc-900">Masculino</option>
            <option value="F" className="bg-zinc-900">Feminino</option>
            <option value="OTHER" className="bg-zinc-900">Outro</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className={labelCls}>Estado civil</label>
          <select
            value={form.maritalStatus}
            onChange={(e) => set('maritalStatus', e.target.value)}
            className={`${inputCls} cursor-pointer`}
          >
            {MARITAL_OPTIONS.map((o) => (
              <option key={o.v} value={o.v} className="bg-zinc-900">{o.l}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ─── Contato ─────────────────────────────────────────────── */}
      <SectionTitle icon={<Phone size={14} />}>Contato</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Telefone</label>
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            placeholder="(11) 99999-8888"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>E-mail</label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            placeholder="paciente@email.com"
            className={inputCls}
          />
        </div>
      </div>

      {/* ─── Endereço (colapsável) ──────────────────────────────── */}
      <Toggle
        icon={<Home size={14} />}
        label="Endereço"
        open={openAddress}
        onToggle={() => setOpenAddress((v) => !v)}
      />
      {openAddress && (
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
          <div className="md:col-span-2">
            <label className={labelCls}>CEP</label>
            <div className="relative">
              <input
                type="text"
                value={form.zipCode}
                onChange={(e) => set('zipCode', e.target.value)}
                onBlur={handleCepBlur}
                placeholder="00000-000"
                className={inputCls}
              />
              {cepLoading && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-blue-400" size={14} />
              )}
            </div>
          </div>
          <div className="md:col-span-4">
            <label className={labelCls}>Rua / Logradouro</label>
            <input
              type="text"
              value={form.address}
              onChange={(e) => set('address', e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>Número</label>
            <input
              type="text"
              value={form.addressNumber}
              onChange={(e) => set('addressNumber', e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="md:col-span-4">
            <label className={labelCls}>Complemento</label>
            <input
              type="text"
              value={form.addressComplement}
              onChange={(e) => set('addressComplement', e.target.value)}
              placeholder="Apto, bloco, etc"
              className={inputCls}
            />
          </div>
          <div className="md:col-span-3">
            <label className={labelCls}>Bairro</label>
            <input
              type="text"
              value={form.neighborhood}
              onChange={(e) => set('neighborhood', e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>Cidade</label>
            <input
              type="text"
              value={form.city}
              onChange={(e) => set('city', e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="md:col-span-1">
            <label className={labelCls}>UF</label>
            <select
              value={form.state}
              onChange={(e) => set('state', e.target.value)}
              className={`${inputCls} cursor-pointer`}
            >
              <option value="" className="bg-zinc-900">—</option>
              {STATES.map((s) => <option key={s} value={s} className="bg-zinc-900">{s}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* ─── Adicionais (colapsável) ────────────────────────────── */}
      <Toggle
        icon={<Heart size={14} />}
        label="Adicionais (tipo sanguíneo, emergência, queixa, notas)"
        open={openExtra}
        onToggle={() => setOpenExtra((v) => !v)}
      />
      {openExtra && (
        <div className="space-y-3 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Tipo sanguíneo</label>
              <select
                value={form.bloodType}
                onChange={(e) => set('bloodType', e.target.value)}
                className={`${inputCls} cursor-pointer`}
              >
                <option value="" className="bg-zinc-900">—</option>
                {BLOOD_TYPES.map((b) => <option key={b} value={b} className="bg-zinc-900">{b}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Contato emergência (nome)</label>
              <input
                type="text"
                value={form.emergencyName}
                onChange={(e) => set('emergencyName', e.target.value)}
                placeholder="Familiar / responsável"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Telefone emergência</label>
              <input
                type="tel"
                value={form.emergencyPhone}
                onChange={(e) => set('emergencyPhone', e.target.value)}
                placeholder="(11) 99999-8888"
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className={labelCls}>Queixa principal</label>
            <input
              type="text"
              value={form.chiefComplaint}
              onChange={(e) => set('chiefComplaint', e.target.value)}
              placeholder="Ex: Dor no dente do siso, vontade de implante"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Notas internas</label>
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              placeholder="Observações internas — visíveis só pela equipe"
              className={inputCls}
            />
          </div>
        </div>
      )}

      {/* Botão salvar */}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 px-5 py-2.5 text-sm font-semibold text-blue-950 shadow-lg transition hover:bg-blue-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
      >
        {submitting ? <Loader2 className="animate-spin" size={16} /> : <UserPlus size={16} />}
        {submitting ? 'Salvando…' : 'Cadastrar paciente'}
      </button>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-rose-400">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

// ─── Helpers visuais ──────────────────────────────────────────────

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-4 mb-2 flex items-center gap-1.5 text-xs font-semibold text-blue-400">
      {icon}
      <span className="uppercase tracking-wider">{children}</span>
    </div>
  );
}

function Toggle({
  icon, label, open, onToggle,
}: {
  icon: React.ReactNode; label: string; open: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-4 mb-2 flex w-full items-center justify-between rounded-lg bg-white/[0.03] p-2 text-left ring-1 ring-white/5 transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-blue-400">
        {icon}
        {label}
      </span>
      {open ? <ChevronUp size={14} className="text-zinc-500" />
            : <ChevronDown size={14} className="text-zinc-500" />}
    </button>
  );
}
