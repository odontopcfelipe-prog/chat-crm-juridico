'use client';

/**
 * Conta Asaas da PLATAFORMA — onde os laboratórios pagam a mensalidade (separada
 * das contas das clínicas). GET/PUT /plataforma/mensalidade-laboratorio e
 * POST .../testar, só para o SUPER_ADMIN. A chave nunca volta do servidor: a tela
 * só sabe se ela está configurada.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, CreditCard, Loader2, PlugZap, Save } from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';

interface Resumo {
  configurada: boolean;
  sandbox: boolean;
  atualizado_em: string | null;
}

/** Mensagem do servidor (texto ou lista) ou o padrão. */
function mensagem(e: any, padrao: string): string {
  const m = e?.response?.data?.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (Array.isArray(m) && m.length) return m.filter((x) => typeof x === 'string').join(', ') || padrao;
  return padrao;
}

export function ContaAsaasDaPlataforma() {
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [chave, setChave] = useState('');
  const [sandbox, setSandbox] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [testando, setTestando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  useEffect(() => {
    api
      .get<Resumo>('/plataforma/mensalidade-laboratorio')
      .then((r) => {
        setResumo(r.data);
        setSandbox(!!r.data.sandbox);
      })
      .catch((e) => setAviso({ ok: false, texto: mensagem(e, 'Não foi possível carregar a conta da mensalidade.') }))
      .finally(() => setCarregando(false));
  }, []);

  const salvar = async () => {
    setSalvando(true);
    setAviso(null);
    try {
      const { data } = await api.put<Resumo>('/plataforma/mensalidade-laboratorio', {
        // vazio = o servidor mantém a chave atual
        ...(chave.trim() ? { api_key: chave.trim() } : {}),
        sandbox,
      });
      setResumo(data);
      setChave('');
      setAviso({ ok: true, texto: 'Salvo.' });
    } catch (e) {
      setAviso({ ok: false, texto: mensagem(e, 'Falha ao salvar.') });
    } finally {
      setSalvando(false);
    }
  };

  const testar = async () => {
    setTestando(true);
    setAviso(null);
    try {
      const { data } = await api.post<{ ok: boolean; sandbox: boolean }>('/plataforma/mensalidade-laboratorio/testar');
      setAviso({ ok: true, texto: `Conexão ok com o Asaas (${data.sandbox ? 'sandbox' : 'produção'}).` });
    } catch (e) {
      setAviso({ ok: false, texto: mensagem(e, 'O teste falhou.') });
    } finally {
      setTestando(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm bg-muted/30 border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors';
  const webhook = `${API_BASE_URL.replace(/\/+$/, '')}/billing/webhook/asaas`;

  return (
    <div className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CreditCard size={16} className="text-violet-500" />
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Mensalidade dos laboratórios (conta Asaas da plataforma)
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={testar}
            disabled={testando || carregando || !resumo?.configurada}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent/40 disabled:opacity-50"
          >
            {testando ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}
            Testar
          </button>
          <button
            onClick={salvar}
            disabled={salvando || carregando}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
          >
            {salvando ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {salvando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>

      {carregando ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> Carregando…
        </div>
      ) : (
        <>
          <p className="mb-4 text-xs">
            Situação:{' '}
            {resumo?.configurada ? (
              <b className="text-emerald-600">configurada ({resumo.sandbox ? 'sandbox' : 'produção'})</b>
            ) : (
              <b className="text-amber-600">não configurada</b>
            )}
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                Chave da API{' '}
                {resumo?.configurada && (
                  <span className="font-normal normal-case text-emerald-600">(configurada — deixe em branco pra manter)</span>
                )}
              </label>
              <input
                type="password"
                placeholder={resumo?.configurada ? '••••••••  (manter atual)' : '$aact_...'}
                value={chave}
                onChange={(e) => setChave(e.target.value)}
                autoComplete="new-password"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted-foreground">Ambiente</label>
              <select value={sandbox ? 'sandbox' : 'producao'} onChange={(e) => setSandbox(e.target.value === 'sandbox')} className={inputCls}>
                <option value="producao">Produção</option>
                <option value="sandbox">Sandbox (teste)</option>
              </select>
            </div>
          </div>

          <div className="mt-4 space-y-2 text-[11px] text-muted-foreground">
            <p>
              Os laboratórios pagam a mensalidade <b>nesta</b> conta, separada das contas das clínicas. Sem ela, o
              laboratório não consegue assinar e o “Cadastro aberto ao público” não liga. As clínicas não mudam.
            </p>
            <p>
              Opcional: no painel do Asaas desta conta, cadastre o webhook de cobranças para{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-foreground">{webhook}</code>. Com ele, o pagamento é
              reconhecido na hora; sem ele, em até 1 hora.
            </p>
          </div>
        </>
      )}

      {aviso && (
        <p className={`mt-3 flex items-center gap-1 text-xs font-semibold ${aviso.ok ? 'text-emerald-600' : 'text-rose-500'}`}>
          {aviso.ok && <CheckCircle2 size={12} />}
          {aviso.texto}
        </p>
      )}
    </div>
  );
}
