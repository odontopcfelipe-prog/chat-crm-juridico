'use client';

/**
 * NewPatientModal — formulário de criação de paciente.
 *
 * Dois modos via abas:
 *  - "Cadastro simples": só os essenciais (nome + telefone + CPF + email + nasc + sexo)
 *    pra recepção registrar rápido em situação de urgência ou alta demanda.
 *  - "Cadastro completo": tudo do simples + endereço com ViaCEP, estado civil,
 *    contato emergência, responsável legal, indicação. Mesmo conjunto que o
 *    EditPatientModal.
 *
 * Botão "Salvar e cadastrar novo" mantém o modal aberto e zera o form pra
 * cadastro em lote (ex: feirão de avaliação, pós-evento de marketing).
 */
import { useState, FormEvent, useEffect } from 'react';
import {
  X, Loader2, UserPlus, Save, MapPin, User, Heart, Shield, HandCoins,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Props {
  onClose: () => void;
  onCreated: (patient: any) => void;
}

interface PatientLite { id: string; name: string | null; phone: string }

const MARITAL_OPTIONS = [
  { v: '', l: '—' },
  { v: 'SOLTEIRO', l: 'Solteiro(a)' },
  { v: 'CASADO', l: 'Casado(a)' },
  { v: 'UNIAO_ESTAVEL', l: 'União estável' },
  { v: 'DIVORCIADO', l: 'Divorciado(a)' },
  { v: 'VIUVO', l: 'Viúvo(a)' },
];

const STATES = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

const inputCls = 'w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30';

const EMPTY_FORM = {
  name: '', cpf: '', rg: '', birthDate: '', gender: '', maritalStatus: '',
  phone: '', email: '',
  zipCode: '', address: '', addressNumber: '', addressComplement: '',
  neighborhood: '', city: '', state: '',
  bloodType: '', emergencyName: '', emergencyPhone: '',
  isMinor: false, guardianName: '', guardianCpf: '', guardianPhone: '',
  referredBy: '', referredById: '', notes: '',
  // Programa de Afiliado — comissao fixa 3% (regra do programa)
  isAffiliate: false, affiliateCode: '', affiliateNotes: '',
};

const AFFILIATE_COMMISSION_PCT = 3;

export default function NewPatientModal({ onClose, onCreated }: Props) {
  const [mode, setMode] = useState<'simple' | 'full'>('simple');
  const [loading, setLoading] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  // Lista de pacientes pra picker de indicação (lazy load no modo full)
  const [patientsList, setPatientsList] = useState<PatientLite[]>([]);
  const [referredSearch, setReferredSearch] = useState('');

  const set = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Carrega lista de pacientes quando opera no modo completo
  useEffect(() => {
    if (mode !== 'full' || patientsList.length > 0) return;
    api.get('/patients?limit=100&status=ACTIVE')
      .then((r) => setPatientsList((r.data?.data || []).map((p: any) => ({ id: p.id, name: p.name, phone: p.phone }))))
      .catch(() => {});
  }, [mode, patientsList.length]);

  // ViaCEP autocomplete
  useEffect(() => {
    const cleanZip = form.zipCode.replace(/\D/g, '');
    if (cleanZip.length !== 8) return;
    let cancelled = false;
    setCepLoading(true);
    fetch(`https://viacep.com.br/ws/${cleanZip}/json/`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || data?.erro) return;
        setForm((f) => ({
          ...f,
          address: f.address || data.logradouro || '',
          neighborhood: f.neighborhood || data.bairro || '',
          city: f.city || data.localidade || '',
          state: f.state || data.uf || '',
        }));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCepLoading(false); });
    return () => { cancelled = true; };
  }, [form.zipCode]);

  const buildPayload = () => {
    const base: any = { name: form.name.trim() };
    if (form.phone.trim()) base.phone = form.phone.trim();
    if (form.cpf.trim()) base.cpf = form.cpf.trim();
    if (form.email.trim()) base.email = form.email.trim();
    if (form.birthDate) base.birth_date = form.birthDate;
    if (form.gender) base.gender = form.gender;
    if (form.rg.trim()) base.rg = form.rg.trim();

    if (mode === 'full') {
      if (form.maritalStatus) base.marital_status = form.maritalStatus;
      if (form.zipCode.trim()) base.zip_code = form.zipCode.trim();
      if (form.address.trim()) base.address = form.address.trim();
      if (form.addressNumber.trim()) base.address_number = form.addressNumber.trim();
      if (form.addressComplement.trim()) base.address_complement = form.addressComplement.trim();
      if (form.neighborhood.trim()) base.neighborhood = form.neighborhood.trim();
      if (form.city.trim()) base.city = form.city.trim();
      if (form.state) base.state = form.state;
      if (form.bloodType) base.blood_type = form.bloodType;
      if (form.emergencyName.trim()) base.emergency_contact_name = form.emergencyName.trim();
      if (form.emergencyPhone.trim()) base.emergency_contact_phone = form.emergencyPhone.trim();
      base.is_minor = form.isMinor;
      if (form.isMinor) {
        if (form.guardianName.trim()) base.guardian_name = form.guardianName.trim();
        if (form.guardianCpf.trim()) base.guardian_cpf = form.guardianCpf.trim();
        if (form.guardianPhone.trim()) base.guardian_phone = form.guardianPhone.trim();
      }
      if (form.referredBy.trim()) base.referred_by = form.referredBy.trim();
      if (form.referredById) base.referred_by_id = form.referredById;
      if (form.notes.trim()) base.notes = form.notes.trim();

      // Programa de Afiliado — 3% sobre tratamentos indicados/fechados
      base.is_affiliate = form.isAffiliate;
      if (form.isAffiliate) {
        if (form.affiliateCode.trim()) base.affiliate_code = form.affiliateCode.trim();
        base.affiliate_commission_pct = AFFILIATE_COMMISSION_PCT;
        if (form.affiliateNotes.trim()) base.affiliate_notes = form.affiliateNotes.trim();
      }
    }
    return base;
  };

  const submitInner = async (andCreateNext: boolean): Promise<boolean> => {
    if (!form.name.trim()) {
      showError('Nome é obrigatório');
      return false;
    }
    setLoading(true);
    try {
      const { data } = await api.post('/patients', buildPayload());
      showSuccess('Paciente cadastrado');
      if (andCreateNext) {
        // mantém modo, zera form, mantém modal aberto
        setForm({ ...EMPTY_FORM });
        setReferredSearch('');
      } else {
        onCreated(data);
      }
      return true;
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao cadastrar paciente');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await submitInner(false);
  };

  const filteredPatients = referredSearch.trim()
    ? patientsList.filter((p) =>
        p.name?.toLowerCase().includes(referredSearch.toLowerCase()) ||
        p.phone?.includes(referredSearch)
      ).slice(0, 10)
    : [];
  const selectedReferrer = patientsList.find((p) => p.id === form.referredById);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className={`bg-card border border-border rounded-xl w-full shadow-2xl max-h-[90vh] overflow-y-auto ${mode === 'full' ? 'max-w-3xl' : 'max-w-lg'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header sticky */}
        <div className="sticky top-0 bg-card z-10 border-b border-border">
          <div className="flex items-center justify-between p-4">
            <div className="flex items-center gap-2">
              <UserPlus size={20} className="text-primary" />
              <h2 className="text-lg font-semibold">Novo paciente</h2>
            </div>
            <button onClick={onClose} className="p-1 hover:bg-accent rounded">
              <X size={18} />
            </button>
          </div>
          {/* Tabs simples / completo */}
          <div className="flex gap-1 px-4 pb-2">
            {(['simple', 'full'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  mode === m
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                {m === 'simple' ? 'Cadastro simples' : 'Cadastro completo'}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={submit} className="p-4 space-y-4">
          {/* ── Identificação (sempre visível) ── */}
          <Section icon={<User size={14} />} title="Identificação">
            <div>
              <label className="block text-xs font-medium mb-1">Nome completo *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                required
                autoFocus
                className={inputCls}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Telefone</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set('phone', e.target.value)}
                  placeholder="82 99999-9999"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">CPF</label>
                <input
                  type="text"
                  value={form.cpf}
                  onChange={(e) => set('cpf', e.target.value)}
                  placeholder="000.000.000-00"
                  className={inputCls}
                />
              </div>
            </div>

            {mode === 'full' && (
              <div>
                <label className="block text-xs font-medium mb-1">RG</label>
                <input
                  type="text"
                  value={form.rg}
                  onChange={(e) => set('rg', e.target.value)}
                  className={inputCls}
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                className={inputCls}
              />
            </div>

            <div className={`grid ${mode === 'full' ? 'grid-cols-3' : 'grid-cols-2'} gap-3`}>
              <div>
                <label className="block text-xs font-medium mb-1">Data de nascimento</label>
                <input
                  type="date"
                  value={form.birthDate}
                  onChange={(e) => set('birthDate', e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Sexo</label>
                <select value={form.gender} onChange={(e) => set('gender', e.target.value)} className={inputCls}>
                  <option value="">—</option>
                  <option value="F">Feminino</option>
                  <option value="M">Masculino</option>
                  <option value="OTHER">Outro</option>
                </select>
              </div>
              {mode === 'full' && (
                <div>
                  <label className="block text-xs font-medium mb-1">Estado civil</label>
                  <select value={form.maritalStatus} onChange={(e) => set('maritalStatus', e.target.value)} className={inputCls}>
                    {MARITAL_OPTIONS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                  </select>
                </div>
              )}
            </div>
          </Section>

          {/* ── Endereço (modo completo) ── */}
          {mode === 'full' && (
            <Section icon={<MapPin size={14} />} title="Endereço">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">CEP {cepLoading && <span className="text-muted-foreground">(buscando...)</span>}</label>
                  <input
                    value={form.zipCode}
                    onChange={(e) => set('zipCode', e.target.value)}
                    placeholder="00000-000"
                    maxLength={9}
                    className={inputCls}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium mb-1">Logradouro</label>
                  <input value={form.address} onChange={(e) => set('address', e.target.value)} className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Número</label>
                  <input value={form.addressNumber} onChange={(e) => set('addressNumber', e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Complemento</label>
                  <input value={form.addressComplement} onChange={(e) => set('addressComplement', e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Bairro</label>
                  <input value={form.neighborhood} onChange={(e) => set('neighborhood', e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Cidade / UF</label>
                  <div className="flex gap-1">
                    <input value={form.city} onChange={(e) => set('city', e.target.value)} className={`${inputCls} flex-1`} />
                    <select value={form.state} onChange={(e) => set('state', e.target.value)} className={`${inputCls} w-16`}>
                      <option value="">—</option>
                      {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </Section>
          )}

          {/* ── Saúde + emergência (modo completo) ── */}
          {mode === 'full' && (
            <Section icon={<Heart size={14} />} title="Saúde e emergência">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Tipo sanguíneo</label>
                  <select value={form.bloodType} onChange={(e) => set('bloodType', e.target.value)} className={inputCls}>
                    <option value="">—</option>
                    {['A+','A-','B+','B-','AB+','AB-','O+','O-'].map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Emergência (nome)</label>
                  <input value={form.emergencyName} onChange={(e) => set('emergencyName', e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Emergência (telefone)</label>
                  <input type="tel" value={form.emergencyPhone} onChange={(e) => set('emergencyPhone', e.target.value)} className={inputCls} />
                </div>
              </div>
            </Section>
          )}

          {/* ── Responsável legal (modo completo) ── */}
          {mode === 'full' && (
            <Section icon={<Shield size={14} />} title="Responsável legal">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isMinor}
                  onChange={(e) => set('isMinor', e.target.checked)}
                  className="w-4 h-4 rounded border-border"
                />
                Paciente é menor de idade ou tem responsável legal
              </label>
              {form.isMinor && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">Nome do responsável</label>
                    <input value={form.guardianName} onChange={(e) => set('guardianName', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">CPF do responsável</label>
                    <input value={form.guardianCpf} onChange={(e) => set('guardianCpf', e.target.value)} placeholder="000.000.000-00" className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Telefone do responsável</label>
                    <input type="tel" value={form.guardianPhone} onChange={(e) => set('guardianPhone', e.target.value)} className={inputCls} />
                  </div>
                </div>
              )}
            </Section>
          )}

          {/* ── Indicação + Observações (modo completo) ── */}
          {mode === 'full' && (
            <Section icon={<User size={14} />} title="Indicação e observações">
              <div>
                <label className="block text-xs font-medium mb-1">Indicado por outro paciente</label>
                {selectedReferrer ? (
                  <div className="flex items-center justify-between gap-2 p-2 rounded-lg border border-border bg-background">
                    <div className="text-sm">
                      <div className="font-medium">{selectedReferrer.name || 'Sem nome'}</div>
                      <div className="text-xs text-muted-foreground">{selectedReferrer.phone}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { set('referredById', ''); setReferredSearch(''); }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Trocar
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      value={referredSearch}
                      onChange={(e) => setReferredSearch(e.target.value)}
                      placeholder="Buscar paciente por nome ou telefone..."
                      className={inputCls}
                    />
                    {referredSearch && (
                      <div className="mt-1 max-h-32 overflow-y-auto border border-border rounded-lg bg-background">
                        {filteredPatients.length === 0 ? (
                          <div className="p-2 text-xs text-muted-foreground">Nenhum encontrado</div>
                        ) : (
                          filteredPatients.map((p) => (
                            <button
                              type="button"
                              key={p.id}
                              onClick={() => { set('referredById', p.id); setReferredSearch(''); }}
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
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Indicação (texto livre)</label>
                <input
                  value={form.referredBy}
                  onChange={(e) => set('referredBy', e.target.value)}
                  placeholder="Ex: Google, Instagram, indicação fora da base, etc"
                  className={inputCls}
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Observações</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                  rows={2}
                  placeholder="Ex: prefere atendimento manhã, tem medo de agulha, etc"
                  className={`${inputCls} resize-none`}
                />
              </div>
            </Section>
          )}

          {/* ─── Programa de Afiliado (modo completo) ─── */}
          {mode === 'full' && (
            <Section icon={<HandCoins size={14} />} title="Programa de Afiliado">
              <div>
                <label className="block text-xs font-medium mb-1">Tornar Afiliado</label>
                <label className="inline-flex items-center gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.isAffiliate}
                    onChange={(e) => set('isAffiliate', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="relative w-11 h-6 bg-muted peer-focus:ring-2 peer-focus:ring-emerald-500/40 rounded-full peer peer-checked:bg-emerald-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border after:border-border after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
                  <span className="text-sm text-foreground">
                    {form.isAffiliate ? (
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
              </div>

              {/* Banner com a regra */}
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/20 p-3 text-xs leading-relaxed text-emerald-900 dark:text-emerald-200 space-y-1.5">
                <p className="font-bold flex items-center gap-1.5">
                  <HandCoins size={13} /> Como funciona o programa
                </p>
                <p>
                  Afiliado recebe <strong>3% do valor total</strong> de cada tratamento
                  fechado por indicação dele.
                </p>
                <p>
                  O saldo <strong>acumula</strong> a cada venda fechada — pode ser usado
                  como crédito em tratamentos próprios ou <strong>sacado</strong> em
                  dinheiro a qualquer momento.
                </p>
              </div>

              {form.isAffiliate && (
                <>
                  <div>
                    <label className="block text-xs font-medium mb-1">Código de Afiliado</label>
                    <input
                      value={form.affiliateCode}
                      onChange={(e) => set('affiliateCode', e.target.value.toUpperCase().replace(/\s/g, ''))}
                      placeholder="Ex: ANDRELUSTOSA"
                      className={inputCls}
                      maxLength={32}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Observações do afiliado</label>
                    <textarea
                      value={form.affiliateNotes}
                      onChange={(e) => set('affiliateNotes', e.target.value)}
                      rows={2}
                      placeholder="Ex: pagar via PIX no CPF, prefere acumular trimestralmente, etc"
                      className={`${inputCls} resize-none`}
                    />
                  </div>
                </>
              )}
            </Section>
          )}

          {/* Footer sticky */}
          <div className="flex justify-between gap-2 pt-2 border-t border-border sticky bottom-0 bg-card -mx-4 px-4 py-3 -mb-4 flex-wrap">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={async () => { await submitInner(true); }}
                disabled={loading}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 text-sm font-medium disabled:opacity-50"
                title="Salva e mantém o modal aberto pra cadastrar o próximo"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Salvar e cadastrar novo
              </button>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium disabled:opacity-50"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                Cadastrar
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

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
