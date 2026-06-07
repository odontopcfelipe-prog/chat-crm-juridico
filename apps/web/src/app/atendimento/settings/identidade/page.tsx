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
import { useState, useEffect } from 'react';
import {
  Building2, Mail, Phone, IdCard, Palette, ImageIcon, Globe,
  Save, Loader2, CheckCircle2, ExternalLink,
} from 'lucide-react';
import api from '@/lib/api';
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
}

export default function IdentidadeClinicaPage() {
  const role = useRole();
  const [tenant, setTenant] = useState<TenantData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [themeColor, setThemeColor] = useState('#7c3aed');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [cpfCnpj, setCpfCnpj] = useState('');

  useEffect(() => {
    api.get<TenantData>('/tenants/me')
      .then(res => {
        const t = res.data;
        if (!t) return;
        setTenant(t);
        setName(t.name || '');
        setLogoUrl(t.logo_url || '');
        setThemeColor(t.theme_color || '#7c3aed');
        setPhone(t.phone || '');
        setEmail(t.email || '');
        setCpfCnpj(t.cpf_cnpj || '');
      })
      .catch(() => showError('Não foi possível carregar os dados da clínica'))
      .finally(() => setLoading(false));
  }, []);

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
