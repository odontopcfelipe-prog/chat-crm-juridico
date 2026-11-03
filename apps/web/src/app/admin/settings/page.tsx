'use client';

/**
 * Onda 17.32.180 — Configurações da PLATAFORMA (somente SUPER_ADMIN).
 *
 * E-mail do sistema (SMTP global do SaaS): usado em TODOS os tenants
 * pra confirmação de equipe, redefinição de senha, boas-vindas e
 * lembretes. Saiu da tela de settings da clínica (qualquer admin de
 * tenant podia sobrescrever) e agora usa GET/PUT /settings/smtp,
 * trancados no backend pra SUPER_ADMIN.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Loader2, Mail, Save, ShieldCheck } from 'lucide-react';
import api from '@/lib/api';

interface SmtpForm {
  host: string;
  port: string;
  user: string;
  pass: string; // vazio = manter a atual
  from: string;
}

export default function AdminSettingsPage() {
  const router = useRouter();
  const [form, setForm] = useState<SmtpForm>({ host: '', port: '587', user: '', pass: '', from: '' });
  const [hasPass, setHasPass] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/atendimento/login');
      return;
    }
    api.get<{ host: string; port: number; user: string; from: string; has_pass: boolean }>('/settings/smtp')
      .then((res) => {
        setForm({
          host: res.data.host || '',
          port: String(res.data.port || 587),
          user: res.data.user || '',
          pass: '',
          from: res.data.from || '',
        });
        setHasPass(!!res.data.has_pass);
      })
      .catch((e) => {
        if (e?.response?.status === 403) {
          setError('Acesso restrito ao administrador do SaaS.');
        } else {
          setError('Não foi possível carregar a configuração.');
        }
      })
      .finally(() => setLoading(false));
  }, [router]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put('/settings/smtp', {
        host: form.host,
        port: form.port,
        user: form.user,
        // vazio = backend mantem a senha atual
        pass: form.pass || undefined,
        from: form.from,
      });
      if (form.pass.trim()) setHasPass(true);
      setForm((f) => ({ ...f, pass: '' }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm bg-muted/30 border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors';

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/admin/tenants"
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={13} />
          Voltar pros tenants
        </Link>

        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
          <ShieldCheck size={22} className="text-violet-500" />
          Configurações da Plataforma
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Valem pro SaaS inteiro — todos os tenants. Somente o administrador do sistema vê esta tela.
        </p>

        {/* ─── E-mail do sistema (SMTP global) ─── */}
        <div className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mail size={16} className="text-violet-500" />
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                E-mail do sistema (SMTP)
              </h2>
            </div>
            <div className="flex items-center gap-2">
              {saved && (
                <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600">
                  <CheckCircle2 size={12} /> Salvo
                </span>
              )}
              <button
                onClick={save}
                disabled={saving || loading}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" /> Carregando…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-muted-foreground">Servidor SMTP</label>
                  <input
                    type="text"
                    placeholder="smtp.gmail.com"
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-muted-foreground">Porta</label>
                  <input
                    type="text"
                    placeholder="587"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-muted-foreground">Usuário</label>
                  <input
                    type="text"
                    placeholder="email@dominio.com"
                    value={form.user}
                    onChange={(e) => setForm({ ...form, user: e.target.value })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                    Senha {hasPass && <span className="font-normal normal-case text-emerald-600">(configurada — deixe em branco pra manter)</span>}
                  </label>
                  <input
                    type="password"
                    placeholder={hasPass ? '••••••••  (manter atual)' : 'senha de app'}
                    value={form.pass}
                    onChange={(e) => setForm({ ...form, pass: e.target.value })}
                    autoComplete="new-password"
                    className={inputCls}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="mb-1 block text-xs font-semibold text-muted-foreground">E-mail remetente</label>
                  <input
                    type="email"
                    placeholder="noreply@odontosystem.com.br"
                    value={form.from}
                    onChange={(e) => setForm({ ...form, from: e.target.value })}
                    className={inputCls}
                  />
                </div>
              </div>

              <p className="mt-4 text-[11px] text-muted-foreground">
                Este remetente envia <b>todos</b> os e-mails do sistema, de todas as clínicas:
                confirmação de equipe, redefinição de senha, boas-vindas e lembretes de consulta.
                O corpo das mensagens é personalizado com o nome de cada clínica automaticamente.
              </p>
            </>
          )}

          {error && <p className="mt-3 text-xs font-semibold text-rose-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}
