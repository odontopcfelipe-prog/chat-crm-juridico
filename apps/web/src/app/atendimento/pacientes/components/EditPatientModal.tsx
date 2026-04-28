'use client';

/**
 * EditPatientModal — formulário completo de edição de paciente.
 *
 * Cobre TODOS os campos editáveis do schema Patient: identificação, endereço
 * com autocomplete via ViaCEP, dados clínicos básicos, contato de emergência,
 * responsável legal (menor de idade) e estado civil.
 *
 * Diferencia-se do NewPatientModal por ser comprehensive — usado quando
 * a recepção precisa preencher tudo (cadastro completo, atualização de dados).
 */
import { useState, FormEvent, useEffect } from 'react';
import { X, Loader2, Save, MapPin, User, Heart, Shield } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface PatientFull {
  id: string;
  name: string;
  cpf: string | null;
  rg: string | null;
  birth_date: string | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  marital_status?: string | null;
  address: string | null;
  address_number?: string | null;
  address_complement?: string | null;
  neighborhood?: string | null;
  city: string | null;
  state: string | null;
  zip_code?: string | null;
  blood_type?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  is_minor?: boolean | null;
  guardian_name?: string | null;
  guardian_cpf?: string | null;
  guardian_phone?: string | null;
  primary_dentist_id?: string | null;
  referred_by?: string | null;
  referred_by_id?: string | null;
  notes?: string | null;
}

interface Props {
  patient: PatientFull;
  onClose: () => void;
  onUpdated: () => void;
}

const MARITAL_OPTIONS = [
  { v: '', l: '—' },
  { v: 'SOLTEIRO', l: 'Solteiro(a)' },
  { v: 'CASADO', l: 'Casado(a)' },
  { v: 'UNIAO_ESTAVEL', l: 'União estável' },
  { v: 'DIVORCIADO', l: 'Divorciado(a)' },
  { v: 'VIUVO', l: 'Viúvo(a)' },
];

const STATES = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

export default function EditPatientModal({ patient, onClose, onUpdated }: Props) {
  const [saving, setSaving] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);

  // Form state
  const [name, setName] = useState(patient.name || '');
  const [cpf, setCpf] = useState(patient.cpf || '');
  const [rg, setRg] = useState(patient.rg || '');
  const [birthDate, setBirthDate] = useState(patient.birth_date?.slice(0, 10) || '');
  const [gender, setGender] = useState(patient.gender || '');
  const [maritalStatus, setMaritalStatus] = useState(patient.marital_status || '');
  const [phone, setPhone] = useState(patient.phone || '');
  const [email, setEmail] = useState(patient.email || '');

  const [zipCode, setZipCode] = useState(patient.zip_code || '');
  const [address, setAddress] = useState(patient.address || '');
  const [addressNumber, setAddressNumber] = useState(patient.address_number || '');
  const [addressComplement, setAddressComplement] = useState(patient.address_complement || '');
  const [neighborhood, setNeighborhood] = useState(patient.neighborhood || '');
  const [city, setCity] = useState(patient.city || '');
  const [state, setState] = useState(patient.state || '');

  const [bloodType, setBloodType] = useState(patient.blood_type || '');
  const [emergencyName, setEmergencyName] = useState(patient.emergency_contact_name || '');
  const [emergencyPhone, setEmergencyPhone] = useState(patient.emergency_contact_phone || '');

  const [isMinor, setIsMinor] = useState(!!patient.is_minor);
  const [guardianName, setGuardianName] = useState(patient.guardian_name || '');
  const [guardianCpf, setGuardianCpf] = useState(patient.guardian_cpf || '');
  const [guardianPhone, setGuardianPhone] = useState(patient.guardian_phone || '');

  const [referredBy, setReferredBy] = useState(patient.referred_by || '');
  const [notes, setNotes] = useState(patient.notes || '');

  // ─── ViaCEP autocomplete ───────────────────────────────────────
  // Quando o operador digita 8 dígitos no CEP, dispara fetch pra ViaCEP
  // (API pública, gratuita) e preenche endereço/bairro/cidade/estado.
  useEffect(() => {
    const cleanZip = zipCode.replace(/\D/g, '');
    if (cleanZip.length !== 8) return;

    let cancelled = false;
    setCepLoading(true);
    fetch(`https://viacep.com.br/ws/${cleanZip}/json/`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || data?.erro) return;
        if (data.logradouro && !address) setAddress(data.logradouro);
        if (data.bairro && !neighborhood) setNeighborhood(data.bairro);
        if (data.localidade && !city) setCity(data.localidade);
        if (data.uf && !state) setState(data.uf);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCepLoading(false);
      });

    return () => { cancelled = true; };
  }, [zipCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showError('Nome é obrigatório');
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        name: name.trim(),
        cpf: cpf.trim() || null,
        rg: rg.trim() || null,
        birth_date: birthDate || null,
        gender: gender || null,
        marital_status: maritalStatus || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        zip_code: zipCode.trim() || null,
        address: address.trim() || null,
        address_number: addressNumber.trim() || null,
        address_complement: addressComplement.trim() || null,
        neighborhood: neighborhood.trim() || null,
        city: city.trim() || null,
        state: state || null,
        blood_type: bloodType || null,
        emergency_contact_name: emergencyName.trim() || null,
        emergency_contact_phone: emergencyPhone.trim() || null,
        is_minor: isMinor,
        guardian_name: isMinor ? (guardianName.trim() || null) : null,
        guardian_cpf: isMinor ? (guardianCpf.trim() || null) : null,
        guardian_phone: isMinor ? (guardianPhone.trim() || null) : null,
        referred_by: referredBy.trim() || null,
        notes: notes.trim() || null,
      };

      // Remove campos vazios pra evitar validação chata em strings vazias com @IsEmail/etc
      Object.keys(payload).forEach((k) => {
        if (payload[k] === '' || payload[k] === undefined) payload[k] = null;
      });

      await api.patch(`/patients/${patient.id}`, payload);
      showSuccess('Dados atualizados');
      onUpdated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header sticky */}
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <div className="flex items-center gap-2">
            <User size={20} className="text-primary" />
            <h2 className="text-lg font-semibold">Editar dados do paciente</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-5">
          {/* ── Identificação ───────────────────────── */}
          <Section icon={<User size={14} />} title="Identificação">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Nome completo *" full>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="CPF">
                <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="000.000.000-00" className={inputCls} />
              </Field>
              <Field label="RG">
                <input value={rg} onChange={(e) => setRg(e.target.value)} className={inputCls} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Data de nascimento">
                <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Sexo">
                <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputCls}>
                  <option value="">—</option>
                  <option value="F">Feminino</option>
                  <option value="M">Masculino</option>
                  <option value="OTHER">Outro</option>
                </select>
              </Field>
              <Field label="Estado civil">
                <select value={maritalStatus} onChange={(e) => setMaritalStatus(e.target.value)} className={inputCls}>
                  {MARITAL_OPTIONS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Telefone / Celular">
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="82 99999-9999" className={inputCls} />
              </Field>
              <Field label="E-mail">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
              </Field>
            </div>
          </Section>

          {/* ── Endereço com ViaCEP ───────────────────────── */}
          <Section icon={<MapPin size={14} />} title="Endereço">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label={`CEP ${cepLoading ? '(buscando...)' : ''}`}>
                <input
                  value={zipCode}
                  onChange={(e) => setZipCode(e.target.value)}
                  placeholder="00000-000"
                  maxLength={9}
                  className={inputCls}
                />
              </Field>
              <Field label="Logradouro" className="md:col-span-2">
                <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputCls} />
              </Field>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Field label="Número">
                <input value={addressNumber} onChange={(e) => setAddressNumber(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Complemento">
                <input value={addressComplement} onChange={(e) => setAddressComplement(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Bairro">
                <input value={neighborhood} onChange={(e) => setNeighborhood(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Cidade / UF">
                <div className="flex gap-1">
                  <input value={city} onChange={(e) => setCity(e.target.value)} className={`${inputCls} flex-1`} />
                  <select value={state} onChange={(e) => setState(e.target.value)} className={`${inputCls} w-16`}>
                    <option value="">—</option>
                    {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </Field>
            </div>
          </Section>

          {/* ── Saúde básica + emergência ───────────────────────── */}
          <Section icon={<Heart size={14} />} title="Saúde e contato de emergência">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Tipo sanguíneo">
                <select value={bloodType} onChange={(e) => setBloodType(e.target.value)} className={inputCls}>
                  <option value="">—</option>
                  {['A+','A-','B+','B-','AB+','AB-','O+','O-'].map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="Contato de emergência (nome)">
                <input value={emergencyName} onChange={(e) => setEmergencyName(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Contato de emergência (telefone)">
                <input type="tel" value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value)} className={inputCls} />
              </Field>
            </div>
          </Section>

          {/* ── Responsável legal ───────────────────────── */}
          <Section icon={<Shield size={14} />} title="Responsável legal">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isMinor}
                onChange={(e) => setIsMinor(e.target.checked)}
                className="w-4 h-4 rounded border-border"
              />
              Paciente é menor de idade ou tem responsável legal
            </label>
            {isMinor && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                <Field label="Nome do responsável">
                  <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} className={inputCls} />
                </Field>
                <Field label="CPF do responsável">
                  <input value={guardianCpf} onChange={(e) => setGuardianCpf(e.target.value)} placeholder="000.000.000-00" className={inputCls} />
                </Field>
                <Field label="Telefone do responsável">
                  <input type="tel" value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} className={inputCls} />
                </Field>
              </div>
            )}
          </Section>

          {/* ── Indicação + Observações ───────────────────────── */}
          <Section icon={<User size={14} />} title="Outros">
            <Field label="Indicação (quem indicou)">
              <input
                value={referredBy}
                onChange={(e) => setReferredBy(e.target.value)}
                placeholder="Nome de quem indicou, anúncio, Google, etc"
                className={inputCls}
              />
            </Field>
            <Field label="Observações administrativas">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Ex: paciente prefere atendimento manhã, tem medo de agulha, etc"
                className={`${inputCls} resize-none`}
              />
            </Field>
          </Section>

          {/* Footer sticky */}
          <div className="flex justify-end gap-2 pt-2 border-t border-border sticky bottom-0 bg-card -mx-4 px-4 py-3 -mb-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              Salvar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Helpers de UI ───────────────────────────────────────

const inputCls = 'w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30';

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        {icon} {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({
  label, children, full, className,
}: { label: string; children: React.ReactNode; full?: boolean; className?: string }) {
  return (
    <div className={`${full ? 'col-span-full' : ''} ${className || ''}`}>
      <label className="block text-xs font-medium mb-1 text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
