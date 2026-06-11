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
import { X, Loader2, Save, MapPin, User, Heart, Shield, HandCoins, Tag } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { maskCPFInput, maskPhoneInput, maskCEPInput } from '@/lib/utils';
import TagChipsSelector from './TagChipsSelector';

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
  // Programa de Afiliado — paciente que indica e ganha comissao/beneficio
  is_affiliate?: boolean | null;
  affiliate_code?: string | null;
  affiliate_commission_pct?: number | null;
  affiliate_notes?: string | null;
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
  // Onda 17.32.184 — ficha/prontuario fisico da clinica
  const [recordNumber, setRecordNumber] = useState((patient as any).record_number || '');
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
  const [referredById, setReferredById] = useState(patient.referred_by_id || '');
  const [notes, setNotes] = useState(patient.notes || '');

  // Etiquetas (Onda 17.35) — carrega as atuais do paciente; salva junto com o
  // PATCH via PUT /patients/:id/tags (idempotente). tagsLoaded protege contra
  // apagar as etiquetas se o GET inicial falhar (PUT [] zeraria tudo).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagsLoaded, setTagsLoaded] = useState(false);
  useEffect(() => {
    api.get<Array<{ tag_id: string }>>(`/patients/${patient.id}/tags`)
      .then((r) => {
        setSelectedTagIds((r.data || []).map((a) => a.tag_id));
        setTagsLoaded(true);
      })
      .catch(() => {}); // sem tags carregadas, seção fica visível mas não salva
  }, [patient.id]);

  // Programa de Afiliado — comissao fixa 3% (regra do programa, nao editavel
  // por paciente). Saldo pode acumular ou ser sacado.
  const [isAffiliate, setIsAffiliate] = useState(!!patient.is_affiliate);
  const [affiliateCode, setAffiliateCode] = useState(patient.affiliate_code || '');
  const [affiliateNotes, setAffiliateNotes] = useState(patient.affiliate_notes || '');
  const AFFILIATE_COMMISSION_PCT = 3;

  // Picker de paciente indicador (lazy-loaded)
  const [patientsList, setPatientsList] = useState<Array<{ id: string; name: string | null; phone: string }>>([]);
  const [referredSearch, setReferredSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    if (!pickerOpen || patientsList.length > 0) return;
    api.get('/patients?limit=100&status=ACTIVE')
      .then((r) => setPatientsList((r.data?.data || []).map((p: any) => ({ id: p.id, name: p.name, phone: p.phone }))))
      .catch(() => {});
  }, [pickerOpen, patientsList.length]);
  const selectedReferrer = patientsList.find((p) => p.id === referredById);
  const filteredReferrers = referredSearch.trim()
    ? patientsList.filter((p) =>
        p.name?.toLowerCase().includes(referredSearch.toLowerCase()) ||
        p.phone?.includes(referredSearch)
      ).slice(0, 10)
    : [];

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
        record_number: recordNumber.trim() || null,
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
        referred_by_id: referredById || null,
        notes: notes.trim() || null,
        // Programa de Afiliado — 3% sobre tratamentos fechados por indicacao.
        // affiliate_commission_pct e Decimal NAO-NULL no schema (default 3),
        // entao quando NAO e afiliado, omite o campo (em vez de mandar null)
        // pra Prisma nao tentar setar null e jogar exceção (500).
        is_affiliate: isAffiliate,
        ...(isAffiliate
          ? {
              affiliate_code: affiliateCode.trim() || null,
              affiliate_commission_pct: AFFILIATE_COMMISSION_PCT,
              affiliate_notes: affiliateNotes.trim() || null,
            }
          : {
              affiliate_code: null,
              affiliate_notes: null,
              // affiliate_commission_pct omitido: schema e Decimal NOT NULL.
            }),
      };

      // Remove campos vazios pra evitar validação chata em strings vazias com @IsEmail/etc
      Object.keys(payload).forEach((k) => {
        if (payload[k] === '' || payload[k] === undefined) payload[k] = null;
      });

      await api.patch(`/patients/${patient.id}`, payload);

      // Etiquetas: PUT idempotente substitui o conjunto. Só salva se o GET
      // inicial carregou (senão PUT [] apagaria as tags existentes).
      if (tagsLoaded) {
        try {
          await api.put(`/patients/${patient.id}/tags`, { tag_ids: selectedTagIds });
        } catch (err: any) {
          showError(
            `Dados salvos, mas as etiquetas falharam: ${err?.response?.data?.message || 'tente de novo pela ficha'}`,
          );
        }
      }

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
            <div className="grid grid-cols-3 gap-3">
              <Field label="CPF">
                <input value={cpf} onChange={(e) => setCpf(maskCPFInput(e.target.value))} placeholder="000.000.000-00" className={inputCls} />
              </Field>
              <Field label="RG">
                <input value={rg} onChange={(e) => setRg(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Ficha (nº)">
                <input value={recordNumber} onChange={(e) => setRecordNumber(e.target.value)} placeholder="ex: 0482" className={inputCls} />
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
                <input type="tel" value={phone} onChange={(e) => setPhone(maskPhoneInput(e.target.value))} placeholder="(82) 99999-9999" className={inputCls} />
              </Field>
              <Field label="E-mail">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
              </Field>
            </div>
          </Section>

          {/* ── Etiquetas (Onda 17.35 — mesma UI do cadastro) ── */}
          <Section icon={<Tag size={14} />} title="Etiquetas">
            <TagChipsSelector
              selectedTagIds={selectedTagIds}
              onChange={(ids) => setSelectedTagIds(ids)}
            />
          </Section>

          {/* ── Endereço com ViaCEP ───────────────────────── */}
          <Section icon={<MapPin size={14} />} title="Endereço">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label={`CEP ${cepLoading ? '(buscando...)' : ''}`}>
                <input
                  value={zipCode}
                  onChange={(e) => setZipCode(maskCEPInput(e.target.value))}
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
                  {/* Onda 17.32.185 — !w-* forca a largura: o w-full do inputCls
                      vencia o w-16 no Tailwind v4 e a UF esmagava a Cidade */}
                  <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Cidade" className={`${inputCls} flex-1`} />
                  <select value={state} onChange={(e) => setState(e.target.value)} className={`${inputCls} !w-20 shrink-0`}>
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
                <input type="tel" value={emergencyPhone} onChange={(e) => setEmergencyPhone(maskPhoneInput(e.target.value))} placeholder="(82) 99999-9999" className={inputCls} />
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
                  <input value={guardianCpf} onChange={(e) => setGuardianCpf(maskCPFInput(e.target.value))} placeholder="000.000.000-00" className={inputCls} />
                </Field>
                <Field label="Telefone do responsável">
                  <input type="tel" value={guardianPhone} onChange={(e) => setGuardianPhone(maskPhoneInput(e.target.value))} placeholder="(82) 99999-9999" className={inputCls} />
                </Field>
              </div>
            )}
          </Section>

          {/* ── Indicação + Observações ───────────────────────── */}
          <Section icon={<User size={14} />} title="Indicação e observações">
            <Field label="Indicado por outro paciente">
              {selectedReferrer ? (
                <div className="flex items-center justify-between gap-2 p-2 rounded-lg border border-border bg-background">
                  <div className="text-sm">
                    <div className="font-medium">{selectedReferrer.name || 'Sem nome'}</div>
                    <div className="text-xs text-muted-foreground">{selectedReferrer.phone}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setReferredById(''); setReferredSearch(''); }}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Trocar
                  </button>
                </div>
              ) : (
                <>
                  <input
                    value={referredSearch}
                    onChange={(e) => { setReferredSearch(e.target.value); if (!pickerOpen) setPickerOpen(true); }}
                    onFocus={() => setPickerOpen(true)}
                    placeholder="Buscar paciente por nome ou telefone..."
                    className={inputCls}
                  />
                  {referredSearch && (
                    <div className="mt-1 max-h-32 overflow-y-auto border border-border rounded-lg bg-background">
                      {filteredReferrers.length === 0 ? (
                        <div className="p-2 text-xs text-muted-foreground">Nenhum encontrado</div>
                      ) : (
                        filteredReferrers.map((p) => (
                          <button
                            type="button"
                            key={p.id}
                            onClick={() => { setReferredById(p.id); setReferredSearch(''); }}
                            className="w-full px-3 py-2 text-left text-sm hover:bg-accent border-b border-border last:border-0"
                          >
                            <div className="font-medium">{p.name || 'Sem nome'}</div>
                            <div className="text-xs text-muted-foreground">{p.phone}</div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}
            </Field>
            <Field label="Indicação (texto livre)">
              <input
                value={referredBy}
                onChange={(e) => setReferredBy(e.target.value)}
                placeholder="Ex: Google, Instagram, indicação de fora da base, etc"
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

          {/* ─── Programa de Afiliado ───────────────────────────────
              Paciente vira parceiro de indicacao — recebe % por cada
              tratamento fechado de quem ele indicar. Campos extras so
              aparecem se o toggle estiver ON. */}
          <Section icon={<HandCoins size={14} />} title="Programa de Afiliado">
            <Field label="Tornar Afiliado">
              <label className="inline-flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isAffiliate}
                  onChange={(e) => setIsAffiliate(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="relative w-11 h-6 bg-muted peer-focus:ring-2 peer-focus:ring-emerald-500/40 rounded-full peer peer-checked:bg-emerald-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border after:border-border after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
                <span className="text-sm text-foreground">
                  {isAffiliate ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-emerald-600 font-bold">Ativo</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900">
                        Afiliado
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Inativo — paciente regular</span>
                  )}
                </span>
              </label>
            </Field>

            {/* Banner com a regra do programa — sempre visivel pra dar contexto */}
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/20 p-3 text-xs leading-relaxed text-emerald-900 dark:text-emerald-200 space-y-1.5">
              <p className="font-bold flex items-center gap-1.5">
                <HandCoins size={13} /> Como funciona o programa
              </p>
              <p>
                Afiliado recebe <strong>3% do valor total</strong> de cada tratamento fechado
                por indicação dele.
              </p>
              <p>
                O saldo <strong>acumula automaticamente</strong> a cada venda fechada. O
                afiliado pode <strong>acumular</strong> pra usar como crédito em
                tratamentos próprios, ou <strong>sacar</strong> em dinheiro a qualquer
                momento.
              </p>
            </div>

            {isAffiliate && (
              <>
                <Field label="Código de Afiliado">
                  <input
                    value={affiliateCode}
                    onChange={(e) => setAffiliateCode(e.target.value.toUpperCase().replace(/\s/g, ''))}
                    placeholder="Ex: ANDRELUSTOSA"
                    className={inputCls}
                    maxLength={32}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Código que o afiliado divulga (link, post, panfleto). Indicações
                    entram pela busca + esse código no cadastro do paciente novo.
                  </p>
                </Field>
                <Field label="Observações do afiliado">
                  <textarea
                    value={affiliateNotes}
                    onChange={(e) => setAffiliateNotes(e.target.value)}
                    rows={2}
                    placeholder="Ex: pagar via PIX no CPF, prefere acumular trimestralmente, etc"
                    className={`${inputCls} resize-none`}
                  />
                </Field>
                <div className="text-[11px] text-muted-foreground bg-muted/40 rounded-lg p-2.5">
                  💡 O saldo acumulado, histórico de indicações e botão de saque
                  ficam na <strong>aba &quot;Afiliado&quot;</strong> da ficha do paciente
                  (visível só quando este toggle está ativo).
                </div>
              </>
            )}
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
