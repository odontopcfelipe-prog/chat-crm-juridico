'use client';

/**
 * Onda 17.32.103 — Identidade da Clinica.
 *
 * Pagina onde o ADMIN do tenant edita os PROPRIOS dados da clinica
 * (nome, logo, cor, contatos). Antes so o SUPER_ADMIN do SaaS conseguia
 * isso via /admin/tenants/:id.
 *
 * O nome editado aqui aparece em todos os lugares do sistema que usam
 * o branding do tenant (sidebar, header, contratos PDF, e-mails, etc).
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Building2, Mail, Phone, IdCard, Palette, ImageIcon, Globe,
  Save, Loader2, CheckCircle2, ExternalLink, RefreshCw, AlertCircle,
  Sparkles, FileText, ClipboardList, MapPin,
} from 'lucide-react';
import api from '@/lib/api';
import { maskCEPInput } from '@/lib/utils';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import { resetTenantCache } from '@/lib/useTenant';

interface TenantData {
  id: string;
  name: string;
  slug: string | null;
  logo_url: string | null;
  theme_color: string | null;
  phone: string | null;
  email: string | null;
  cpf_cnpj: string | null;
  custom_domain: string | null;
  zip_code?: string | null;
  address?: string | null;
  address_number?: string | null;
  address_complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
}

export default function IdentidadeClinicaPage() {
  const role = useRole();
  const [tenant, setTenant] = useState<TenantData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Onda 17.32.110 — Botao "Plantar defaults" pra tenants antigos
  // que nao tinham tabela de precos e ficha de anamnese inicial.
  const [seeding, setSeeding] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [themeColor, setThemeColor] = useState('#7c3aed');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [cpfCnpj, setCpfCnpj] = useState('');
  // Onda 17.57 — endereço da clínica (entra no {local} dos disparos)
  const [zipCode, setZipCode] = useState('');
  const [address, setAddress] = useState('');
  const [addressNumber, setAddressNumber] = useState('');
  const [addressComplement, setAddressComplement] = useState('');
  const [neighborhood, setNeighborhood] = useState('');
  const [city, setCity] = useState('');
  const [uf, setUf] = useState('');

  // Onda 17.32.105 — carga dos dados extraida pra funcao reutilizavel
  // pelo botao "Tentar novamente" quando o GET /tenants/me falha.
  const loadTenant = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<TenantData>('/tenants/me');
      const t = res.data;
      if (!t) {
        setLoadError('Sua conta nao tem tenant associado. Faca logout e entre de novo.');
        return;
      }
      setTenant(t);
      setName(t.name || '');
      setLogoUrl(t.logo_url || '');
      setThemeColor(t.theme_color || '#7c3aed');
      setPhone(t.phone || '');
      setEmail(t.email || '');
      setCpfCnpj(t.cpf_cnpj || '');
      setZipCode(t.zip_code || '');
      setAddress(t.address || '');
      setAddressNumber(t.address_number || '');
      setAddressComplement(t.address_complement || '');
      setNeighborhood(t.neighborhood || '');
      setCity(t.city || '');
      setUf(t.state || '');
    } catch (err: any) {
      // Loga detalhe pro DevTools — facilita debug em prod sem expor
      // detalhe pro usuario final.
      const status = err?.response?.status;
      const apiMsg = err?.response?.data?.message;
      console.error('[identidade] GET /tenants/me falhou:', { status, apiMsg, err });
      setLoadError(
        status === 401
          ? 'Sessao expirou. Faca login novamente.'
          : status === 403
          ? 'Voce nao tem permissao pra editar a identidade.'
          : status >= 500
          ? 'Servidor indisponivel. Tente novamente em instantes.'
          : 'Nao foi possivel carregar os dados. Tente novamente.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTenant();
  }, [loadTenant]);

  if (!role?.isAdmin && !role?.isSuperAdmin) {
    return (
      <div className="p-8 max-w-md mx-auto text-center">
        <Building2 size={48} className="mx-auto mb-3 text-muted-foreground" />
        <p className="text-base font-bold mb-2">Área restrita</p>
        <p className="text-sm text-muted-foreground">
          Só o administrador da clínica pode editar a identidade.
        </p>
      </div>
    );
  }

  // Onda 17.57 — autofill do endereço pelo CEP (ViaCEP, best-effort).
  const lookupCep = async (masked: string) => {
    const d = masked.replace(/\D/g, '');
    if (d.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${d}/json/`);
      const j = await r.json();
      if (j?.erro) return;
      if (j.logradouro) setAddress(j.logradouro);
      if (j.bairro) setNeighborhood(j.bairro);
      if (j.localidade) setCity(j.localidade);
      if (j.uf) setUf(j.uf);
    } catch {
      /* sem internet ou CEP indisponível — usuário preenche manual */
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showError('Nome da clínica é obrigatório');
      return;
    }
    setSaving(true);
    try {
      await api.patch('/tenants/me', {
        name: name.trim(),
        logo_url: logoUrl.trim() || null,
        theme_color: themeColor || null,
        phone: phone.replace(/\D/g, '') || null,
        email: email.trim().toLowerCase() || null,
        cpf_cnpj: cpfCnpj.replace(/\D/g, '') || null,
        zip_code: zipCode.replace(/\D/g, '') || null,
        address: address.trim() || null,
        address_number: addressNumber.trim() || null,
        address_complement: addressComplement.trim() || null,
        neighborhood: neighborhood.trim() || null,
        city: city.trim() || null,
        state: uf.trim().toUpperCase() || null,
      });
      // Invalida cache do useTenant pra sidebar/header puxar nome novo
      resetTenantCache();
      showSuccess('Identidade da clínica atualizada!');
      // Reload pra refletir branding em todo lugar
      setTimeout(() => window.location.reload(), 600);
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro ao salvar';
      showError(typeof msg === 'string' ? msg : 'Erro');
    } finally {
      setSaving(false);
    }
  };

  // Onda 17.32.110 — Re-roda os defaults (precos + anamnese + especialidades)
  // pra tenants antigos que nao tinham. Idempotente — nao duplica nem apaga
  // procedimentos custom que a clinica ja criou.
  const handleSeedDefaults = async () => {
    if (seeding) return;
    const ok = window.confirm(
      'Plantar dados padrao no seu tenant?\n\n' +
      'Isso adiciona:\n' +
      '• 9 especialidades odontologicas\n' +
      '• Tabela com 30 procedimentos (precos sugeridos)\n' +
      '• Ficha de anamnese odontologica completa\n\n' +
      'NAO apaga nem sobrescreve procedimentos que voce ja criou — eh seguro rodar.'
    );
    if (!ok) return;
    setSeeding(true);
    try {
      const res = await api.post<{ specialties: number; procedures: number; anamnesis_template: boolean }>(
        '/tenants/me/seed-defaults',
      );
      const d = res.data;
      showSuccess(
        `Plantado: ${d.specialties} especialidades, ${d.procedures} procedimentos e ficha de anamnese.`,
      );
      // Reload pra refletir na navegacao (procedimentos / anamnese)
      setTimeout(() => window.location.reload(), 800);
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro ao plantar dados padrao';
      showError(typeof msg === 'string' ? msg : 'Erro');
    } finally {
      setSeeding(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold text-foreground tracking-tight flex items-center gap-2">
          <Building2 size={22} className="text-violet-600" />
          Identidade da clínica
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          O nome editado aqui aparece em todo o sistema — sidebar, recibos,
          contratos, e-mails e cobranças enviadas aos pacientes.
        </p>
      </div>

      {loadError && (
        <div className="mb-5 flex items-start gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
          <AlertCircle size={16} className="text-amber-700 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">
              {loadError}
            </p>
            <p className="text-xs text-amber-700/80 dark:text-amber-200/80 mt-0.5">
              Você pode preencher manualmente abaixo enquanto isso. Os dados serão salvos no clique do botão.
            </p>
          </div>
          <button
            type="button"
            onClick={loadTenant}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-900 dark:text-amber-200 text-xs font-bold transition-colors shrink-0 disabled:opacity-60"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Tentar de novo
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Identidade básica */}
        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">1</span>
            <h2 className="text-sm font-bold text-foreground">Nome e identidade</h2>
          </div>

          <Field
            Icon={Building2}
            label="Nome da clínica *"
            value={name}
            onChange={setName}
            placeholder="Clínica Odontológica Sorriso"
            help="Aparece no sidebar e nos documentos."
            required
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <Field
              Icon={IdCard}
              label="CPF/CNPJ"
              value={cpfCnpj}
              onChange={setCpfCnpj}
              placeholder="00.000.000/0001-00"
            />
            <Field
              Icon={Phone}
              label="WhatsApp / Telefone"
              value={phone}
              onChange={setPhone}
              placeholder="5582999999999"
            />
            <div className="sm:col-span-2">
              <Field
                Icon={Mail}
                label="E-mail de contato"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="contato@clinica.com.br"
                help="Usado em assinaturas, NF-e e respostas automáticas."
              />
            </div>
          </div>
        </div>

        {/* Branding visual */}
        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">2</span>
            <h2 className="text-sm font-bold text-foreground">Logo e cor</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-4 items-end">
            <Field
              Icon={ImageIcon}
              label="URL do logo (PNG/SVG)"
              value={logoUrl}
              onChange={setLogoUrl}
              placeholder="https://seu-dominio.com/logo.png"
              help="Aparece no canto superior esquerdo do sistema."
            />
            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Palette size={11} className="text-violet-500" />
                Cor de acento
              </label>
              <div className="flex items-center gap-2 h-11 px-3 border border-border rounded-xl bg-background">
                <input
                  type="color"
                  value={themeColor}
                  onChange={(e) => setThemeColor(e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer border-none bg-transparent"
                />
                <input
                  type="text"
                  value={themeColor}
                  onChange={(e) => setThemeColor(e.target.value)}
                  className="flex-1 text-sm bg-transparent outline-none font-mono"
                  placeholder="#7c3aed"
                />
              </div>
            </div>
          </div>

          {/* Preview */}
          {(logoUrl || name) && (
            <div className="mt-4 p-3 rounded-xl border border-dashed border-border bg-muted/30 flex items-center gap-3">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt="Logo preview"
                  className="w-10 h-10 rounded-lg object-contain bg-background border border-border"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-sm font-black"
                  style={{ background: themeColor }}
                >
                  {(name || 'C').charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <div className="text-xs text-muted-foreground">Preview no sidebar:</div>
                <div className="text-sm font-bold text-foreground">{name || 'Sua clínica'}</div>
              </div>
            </div>
          )}
        </div>

        {/* Onda 17.32.110 — Dados padrao da clinica.
          Pra tenants que foram criados antes do seed automatico (Onda
          17.32.109) e ficaram sem tabela de precos e ficha de anamnese
          inicial, esse botao planta tudo de uma vez. Idempotente —
          nao apaga procedimentos custom. */}
        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">3</span>
            <h2 className="text-sm font-bold text-foreground">Dados padrão da clínica</h2>
          </div>

          <p className="text-sm text-muted-foreground mb-4">
            Adiciona automaticamente uma base inicial pra você começar a usar o sistema sem cadastrar tudo do zero.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-violet-500/5 border border-violet-500/15">
              <div className="w-8 h-8 rounded-lg bg-violet-600/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                <ClipboardList size={14} className="text-violet-600" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-foreground">9 especialidades</p>
                <p className="text-[11px] text-muted-foreground leading-tight">Clínica, Orto, Endo, Implante…</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-violet-500/5 border border-violet-500/15">
              <div className="w-8 h-8 rounded-lg bg-violet-600/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                <Sparkles size={14} className="text-violet-600" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-foreground">30 procedimentos</p>
                <p className="text-[11px] text-muted-foreground leading-tight">Com preço base sugerido</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-violet-500/5 border border-violet-500/15">
              <div className="w-8 h-8 rounded-lg bg-violet-600/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                <FileText size={14} className="text-violet-600" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-foreground">Ficha de anamnese</p>
                <p className="text-[11px] text-muted-foreground leading-tight">9 seções, ~40 perguntas</p>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 mb-4">
            <CheckCircle2 size={14} className="text-emerald-700 mt-0.5 shrink-0" />
            <p className="text-xs text-emerald-900 dark:text-emerald-300 leading-relaxed">
              <strong>Seguro pra rodar:</strong> não duplica nem apaga procedimentos
              que você já criou. Quem tem tabela própria mantém intacto — só
              acrescenta o que falta.
            </p>
          </div>

          <button
            type="button"
            onClick={handleSeedDefaults}
            disabled={seeding}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-[0_4px_12px_-2px_rgba(124,58,237,0.4)]"
          >
            {seeding ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Plantando dados padrão…
              </>
            ) : (
              <>
                <Sparkles size={14} />
                Plantar dados padrão
              </>
            )}
          </button>
        </div>

        {/* Onda 17.57 — Endereço FÍSICO da clínica (entra no {local} dos disparos) */}
        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <MapPin size={16} className="text-violet-600" />
            <h2 className="text-sm font-bold text-foreground">Endereço da clínica</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Aparece nas mensagens automáticas (confirmação e lembrete) pro paciente
            saber onde é a consulta. Digite o CEP que o resto preenche sozinho.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
            <div className="sm:col-span-2">
              <Field Icon={MapPin} label="CEP" value={zipCode} placeholder="00000-000"
                onChange={(v) => { const m = maskCEPInput(v); setZipCode(m); lookupCep(m); }} />
            </div>
            <div className="sm:col-span-4">
              <Field Icon={MapPin} label="Rua / Logradouro" value={address} onChange={setAddress} placeholder="Av. Fernandes Lima" />
            </div>
            <div className="sm:col-span-2">
              <Field Icon={MapPin} label="Número" value={addressNumber} onChange={setAddressNumber} placeholder="123" />
            </div>
            <div className="sm:col-span-4">
              <Field Icon={MapPin} label="Complemento" value={addressComplement} onChange={setAddressComplement} placeholder="Sala 4 / Bloco B" />
            </div>
            <div className="sm:col-span-2">
              <Field Icon={MapPin} label="Bairro" value={neighborhood} onChange={setNeighborhood} placeholder="Farol" />
            </div>
            <div className="sm:col-span-2">
              <Field Icon={MapPin} label="Cidade" value={city} onChange={setCity} placeholder="Maceió" />
            </div>
            <div className="sm:col-span-2">
              <Field Icon={MapPin} label="UF" value={uf} onChange={(v) => setUf(v.toUpperCase().slice(0, 2))} placeholder="AL" />
            </div>
          </div>
        </div>

        {/* Custom domain — só pra Enterprise (futuro) */}
        {tenant?.custom_domain !== undefined && tenant?.slug && (
          <div className="bg-violet-500/5 border border-violet-500/20 rounded-2xl p-4 flex items-start gap-3">
            <Globe size={16} className="text-violet-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground">Seu endereço atual</p>
              <a
                href={`/`}
                className="text-xs text-violet-700 font-mono hover:underline inline-flex items-center gap-1"
              >
                /{tenant.slug}
                <ExternalLink size={10} />
              </a>
              <p className="text-[11px] text-muted-foreground mt-1">
                Domínio personalizado (sua-clinica.com.br) disponível no plano Enterprise.
              </p>
            </div>
          </div>
        )}

        {/* CTA */}
        <div className="flex items-center justify-between sticky bottom-0 bg-background/95 backdrop-blur-sm py-3 -mx-2 px-2 border-t border-border">
          <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <CheckCircle2 size={11} className="text-emerald-600" />
            Salvo: aparece em todo lugar
          </p>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="text-sm font-bold px-5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-[0_4px_12px_-2px_rgba(124,58,237,0.4)]"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Salvando...
              </>
            ) : (
              <>
                <Save size={14} />
                Salvar identidade
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Sub: campo de form padrão ────────────────────────────────────
function Field({
  Icon, label, value, onChange, placeholder, type = 'text', required, help,
}: {
  Icon: any;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  help?: string;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Icon size={11} className="text-violet-500" />
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full h-11 px-3.5 text-sm border border-border rounded-xl bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors"
      />
      {help && (
        <p className="text-[11px] text-muted-foreground mt-1">{help}</p>
      )}
    </div>
  );
}
