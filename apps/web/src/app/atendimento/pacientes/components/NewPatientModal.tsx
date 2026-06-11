'use client';

/**
 * NewPatientModal — formulário de criação de paciente.
 *
 * Onda 17.32.183 — Modo UNICO (completo). O "cadastro simples" foi
 * REMOVIDO a pedido do dono do produto: o atalho induzia a recepcao a
 * cadastrar pacientes pela metade ("descaso de quem for cadastrar").
 * Campos: identificacao + contato + endereco com ViaCEP, estado civil,
 * saude/emergencia, responsavel legal, indicacao, afiliado — mesmo
 * conjunto do EditPatientModal. So o NOME e obrigatorio; os demais
 * ficam visiveis pra incentivar o preenchimento.
 *
 * Botão "Salvar e cadastrar novo" mantém o modal aberto e zera o form pra
 * cadastro em lote (ex: feirão de avaliação, pós-evento de marketing).
 */
import { useState, FormEvent, useEffect, useRef } from 'react';
import {
  X, Loader2, UserPlus, Save, MapPin, User, Heart, Shield, HandCoins,
  Camera, Trash2, Upload, RefreshCw, Check, Tag,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { maskCPFInput, maskPhoneInput, maskCEPInput } from '@/lib/utils';
import TagChipsSelector from './TagChipsSelector';

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
  name: '', cpf: '', recordNumber: '', rg: '', birthDate: '', gender: '', maritalStatus: '',
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
  const [loading, setLoading] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  // Lista de pacientes pra picker de indicação (lazy load no modo full)
  const [patientsList, setPatientsList] = useState<PatientLite[]>([]);
  const [referredSearch, setReferredSearch] = useState('');

  // Foto de perfil — escolhida agora, upload acontece DEPOIS do POST /patients
  // (precisamos do id do paciente recém-criado pra acertar /patients/:id/avatar)
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Captura por câmera (getUserMedia) — overlay independente do file picker
  const [cameraOpen, setCameraOpen] = useState(false);

  // Etiquetas (Onda 17.33/17.35 — UI compartilhada no TagChipsSelector).
  // Selecionadas individualmente por paciente: o "Salvar e cadastrar novo"
  // zera junto com o form (pedido do dono do produto — sem carregar tags
  // pro proximo cadastro). antigoSelected libera CPF/CEP na validacao.
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [antigoSelected, setAntigoSelected] = useState(false);

  const set = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Cria/limpa preview da foto. Revoga blob URL antiga pra não vazar memória.
  const handlePickPhoto = (file: File) => {
    if (!file.type.startsWith('image/')) {
      showError('Apenas imagens (JPG, PNG, WebP)');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showError('Máximo 2 MB');
      return;
    }
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handleRemovePhoto = () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview(null);
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  // Cleanup do blob URL ao desmontar
  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
    // photoPreview muda quando trocamos foto — revogar a anterior já foi feito
    // no handler. Aqui só pegamos o desmonte do modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Carrega lista de pacientes pro picker de indicacao
  useEffect(() => {
    if (patientsList.length > 0) return;
    api.get('/patients?limit=100&status=ACTIVE')
      .then((r) => setPatientsList((r.data?.data || []).map((p: any) => ({ id: p.id, name: p.name, phone: p.phone }))))
      .catch(() => {});
  }, [patientsList.length]);

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
    if (form.recordNumber.trim()) base.record_number = form.recordNumber.trim();
    if (form.email.trim()) base.email = form.email.trim();
    if (form.birthDate) base.birth_date = form.birthDate;
    if (form.gender) base.gender = form.gender;
    if (form.rg.trim()) base.rg = form.rg.trim();

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

      // Etiquetas escolhidas (ex: "Paciente Antigo") — aplicadas na criação
      if (selectedTagIds.length > 0) base.tag_ids = selectedTagIds;
    return base;
  };

  const submitInner = async (andCreateNext: boolean): Promise<boolean> => {
    // Onda 17.33 — campos obrigatórios. Nome e Data de nascimento (idade) são
    // SEMPRE exigidos; CPF e CEP são exigidos no cadastro normal, mas LIBERADOS
    // quando "Paciente Antigo" está marcado (fichas de papel podem não ter).
    const faltando: string[] = [];
    if (!form.name.trim()) faltando.push('Nome');
    if (!form.birthDate) faltando.push('Data de nascimento');
    if (!antigoSelected) {
      if (!form.cpf.trim()) faltando.push('CPF');
      if (!form.zipCode.trim()) faltando.push('CEP');
    }
    if (faltando.length > 0) {
      const semDoc = !antigoSelected && (faltando.includes('CPF') || faltando.includes('CEP'));
      showError(
        `Preencha: ${faltando.join(', ')}.` +
          (semDoc ? ' Ficha antiga sem CPF/CEP? Marque a etiqueta “Paciente Antigo”.' : ''),
      );
      return false;
    }
    setLoading(true);
    try {
      const { data } = await api.post('/patients', buildPayload());

      // Foto: upload best-effort após criar o paciente. Se falhar, o paciente
      // já foi criado — avisamos o admin mas não desfazemos.
      if (photoFile && data?.id) {
        try {
          const fd = new FormData();
          fd.append('file', photoFile);
          await api.post(`/patients/${data.id}/avatar`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
        } catch (err: any) {
          showError(
            `Paciente cadastrado, mas a foto falhou: ${err?.response?.data?.message || 'tente reenviar pela ficha do paciente'}`,
          );
        }
      }

      showSuccess('Paciente cadastrado');
      if (andCreateNext) {
        // zera form + foto + etiquetas, mantém modal aberto. Etiquetas zeram
        // TAMBÉM (Onda 17.35.2): cada paciente escolhe as suas individualmente.
        setForm({ ...EMPTY_FORM });
        setReferredSearch('');
        handleRemovePhoto();
        setSelectedTagIds([]);
        setAntigoSelected(false);
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
        className="bg-card border border-border rounded-xl w-full shadow-2xl max-h-[90vh] overflow-y-auto max-w-3xl"
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
        </div>

        <form onSubmit={submit} className="p-4 space-y-4">
          {/* ── Foto de perfil (opcional, sempre visível) ── */}
          <div className="flex items-center gap-4">
            <input
              ref={photoInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handlePickPhoto(f);
                e.target.value = ''; // permite re-selecionar mesmo arquivo
              }}
            />
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              className="relative w-20 h-20 rounded-full bg-primary/10 hover:bg-primary/15 flex items-center justify-center overflow-hidden group shrink-0 border-2 border-dashed border-primary/30"
              title={photoPreview ? 'Trocar foto' : 'Adicionar foto'}
            >
              {photoPreview ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoPreview} alt="Foto do paciente" className="w-full h-full object-cover" />
                  <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Camera size={20} className="text-white" />
                  </span>
                </>
              ) : (
                <Camera size={22} className="text-primary/70" />
              )}
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground mb-0.5">
                {photoPreview ? 'Foto selecionada' : 'Foto do paciente'}
              </p>
              <p className="text-[11px] text-muted-foreground mb-1.5">
                Opcional · JPG, PNG ou WebP · máx 2 MB
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCameraOpen(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary text-[11px] font-medium"
                >
                  <Camera size={11} /> Tirar agora
                </button>
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent hover:bg-accent/80 text-accent-foreground text-[11px] font-medium"
                >
                  <Upload size={11} /> Da galeria
                </button>
                {photoPreview && (
                  <button
                    type="button"
                    onClick={handleRemovePhoto}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-destructive hover:bg-destructive/10 text-[11px] font-medium"
                  >
                    <Trash2 size={11} /> Remover
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Overlay de câmera ao vivo (getUserMedia) */}
          {cameraOpen && (
            <CameraCaptureOverlay
              onCapture={(file) => {
                handlePickPhoto(file);
                setCameraOpen(false);
              }}
              onCancel={() => setCameraOpen(false)}
            />
          )}

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

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Telefone</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set('phone', maskPhoneInput(e.target.value))}
                  placeholder="(82) 99999-9999"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">CPF{!antigoSelected && ' *'}</label>
                <input
                  type="text"
                  value={form.cpf}
                  onChange={(e) => set('cpf', maskCPFInput(e.target.value))}
                  placeholder="000.000.000-00"
                  className={inputCls}
                />
              </div>
              {/* Onda 17.32.184 — ficha/prontuario fisico; pesquisavel na busca */}
              <div>
                <label className="block text-xs font-medium mb-1">Ficha (nº)</label>
                <input
                  type="text"
                  value={form.recordNumber}
                  onChange={(e) => set('recordNumber', e.target.value)}
                  placeholder="ex: 0482"
                  className={inputCls}
                />
              </div>
            </div>

            {(
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

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Data de nascimento *</label>
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
              {(
                <div>
                  <label className="block text-xs font-medium mb-1">Estado civil</label>
                  <select value={form.maritalStatus} onChange={(e) => set('maritalStatus', e.target.value)} className={inputCls}>
                    {MARITAL_OPTIONS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                  </select>
                </div>
              )}
            </div>
          </Section>

          {/* ── Etiquetas (Onda 17.33/17.35) ── */}
          <Section icon={<Tag size={14} />} title="Etiquetas">
            <TagChipsSelector
              selectedTagIds={selectedTagIds}
              onChange={(ids, antigo) => { setSelectedTagIds(ids); setAntigoSelected(antigo); }}
            />

            <p className="text-[11px] text-muted-foreground">
              <a
                href="/atendimento/settings/patient-tags"
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                Gerenciar etiquetas
              </a>
            </p>
          </Section>

          {/* ── Endereço (modo completo) ── */}
          {(
            <Section icon={<MapPin size={14} />} title="Endereço">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">CEP{!antigoSelected && ' *'} {cepLoading && <span className="text-muted-foreground">(buscando...)</span>}</label>
                  <input
                    value={form.zipCode}
                    onChange={(e) => set('zipCode', maskCEPInput(e.target.value))}
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
                    {/* Onda 17.32.185 — !w-* forca a largura: o w-full do inputCls
                        vencia o w-16 no Tailwind v4 e a UF esmagava a Cidade */}
                    <input value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Cidade" className={`${inputCls} flex-1`} />
                    <select value={form.state} onChange={(e) => set('state', e.target.value)} className={`${inputCls} !w-20 shrink-0`}>
                      <option value="">UF</option>
                      {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </Section>
          )}

          {/* ── Saúde + emergência (modo completo) ── */}
          {(
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
                  <input type="tel" value={form.emergencyPhone} onChange={(e) => set('emergencyPhone', maskPhoneInput(e.target.value))} placeholder="(82) 99999-9999" className={inputCls} />
                </div>
              </div>
            </Section>
          )}

          {/* ── Responsável legal (modo completo) ── */}
          {(
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
                    <input value={form.guardianCpf} onChange={(e) => set('guardianCpf', maskCPFInput(e.target.value))} placeholder="000.000.000-00" className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Telefone do responsável</label>
                    <input type="tel" value={form.guardianPhone} onChange={(e) => set('guardianPhone', maskPhoneInput(e.target.value))} placeholder="(82) 99999-9999" className={inputCls} />
                  </div>
                </div>
              )}
            </Section>
          )}

          {/* ── Indicação + Observações (modo completo) ── */}
          {(
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
          {(
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

// ─── Captura por câmera (live preview via getUserMedia) ───────────────
//
// Funciona em qualquer dispositivo com câmera + HTTPS:
//   - Mobile: usa câmera traseira por default (facingMode: 'environment'),
//     mas dá pra alternar pra frontal com o botão de virar.
//   - Desktop: usa webcam padrão; botão de virar fica desabilitado quando
//     só existe uma câmera.
//
// O frame capturado vira File JPEG (qualidade 0.92), entra no fluxo normal
// de photoFile do modal pai e segue pra POST /patients/:id/avatar no submit.
//
// Cleanup: para todos os tracks ao desmontar/cancelar — sem isso a câmera
// fica "acesa" (LED do laptop / indicador no mobile).
function CameraCaptureOverlay({
  onCapture,
  onCancel,
}: {
  onCapture: (file: File) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);

  // Pega/troca o stream da câmera. Se permissão negada ou sem câmera, seta erro.
  useEffect(() => {
    let cancelled = false;
    setStarting(true);
    setError(null);

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Câmera não suportada neste navegador');
        }
        // Para tracks antigos antes de pegar novo stream (evita LED ligado em paralelo)
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        // Detecta se vale a pena mostrar botão "Virar câmera" (só se houver 2+)
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cams = devices.filter((d) => d.kind === 'videoinput');
          if (!cancelled) setHasMultipleCameras(cams.length > 1);
        } catch {
          /* enumerate pode falhar sem permissão prévia — ignora */
        }
      } catch (e: any) {
        if (cancelled) return;
        const msg = e?.name === 'NotAllowedError'
          ? 'Permissão de câmera negada. Libere o acesso e tente de novo.'
          : e?.name === 'NotFoundError'
          ? 'Nenhuma câmera encontrada neste dispositivo.'
          : e?.message || 'Não foi possível acessar a câmera';
        setError(msg);
      } finally {
        if (!cancelled) setStarting(false);
      }
    };
    start();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [facing]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      showError('Câmera ainda carregando — aguarde um instante');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      showError('Não foi possível capturar o frame');
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          showError('Falha ao gerar a imagem');
          return;
        }
        const file = new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' });
        onCapture(file);
      },
      'image/jpeg',
      0.92,
    );
  };

  return (
    <div
      className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Camera size={18} className="text-primary" />
            <h3 className="text-sm font-semibold">Tirar foto</h3>
          </div>
          <button onClick={onCancel} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <div className="relative bg-black aspect-video flex items-center justify-center">
          {error ? (
            <div className="p-6 text-center text-sm text-white max-w-md">
              <p className="mb-3">⚠️ {error}</p>
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium"
              >
                Voltar
              </button>
            </div>
          ) : (
            <>
              {starting && (
                <div className="absolute inset-0 flex items-center justify-center text-white text-xs">
                  <Loader2 size={20} className="animate-spin mr-2" /> Iniciando câmera...
                </div>
              )}
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                // facingMode user (frontal) é espelhado pra parecer espelho real;
                // environment (traseira) fica normal porque é "ver pro outro lado".
                className={`w-full h-full object-contain ${facing === 'user' ? 'scale-x-[-1]' : ''}`}
              />
            </>
          )}
        </div>

        {!error && (
          <div className="flex items-center justify-between gap-2 p-3 border-t border-border">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={capture}
              disabled={starting}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-semibold disabled:opacity-50"
            >
              <Check size={16} /> Capturar foto
            </button>

            <button
              type="button"
              onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
              disabled={starting || !hasMultipleCameras}
              title={hasMultipleCameras ? 'Trocar câmera' : 'Só uma câmera disponível'}
              className="p-2 rounded-lg border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
