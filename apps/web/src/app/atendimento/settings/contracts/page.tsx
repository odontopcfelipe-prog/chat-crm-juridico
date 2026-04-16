'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  FileSignature,
  KeyRound,
  Building2,
  RefreshCw,
  CheckCircle2,
  Eye,
  EyeOff,
  Globe,
  Webhook,
  Scale,
  MapPin,
  Link,
  AlertCircle,
} from 'lucide-react';
import api from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClicksignConfig {
  baseUrl: string;
  apiToken: string | null;
  webhookToken: string | null;
  isConfigured: boolean;
}

interface ContractConfig {
  advogado1_nome: string;
  advogado1_oab: string;
  advogado2_nome: string;
  advogado2_oab: string;
  escritorio_logradouro: string;
  escritorio_cidade: string;
  escritorio_cep: string;
  foro: string;
  publicApiUrl: string;
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const SANDBOX_URL = 'https://sandbox.clicksign.com';
const PROD_URL    = 'https://app.clicksign.com';

const DEFAULT_CONTRACT: ContractConfig = {
  advogado1_nome: '',
  advogado1_oab: '',
  advogado2_nome: '',
  advogado2_oab: '',
  escritorio_logradouro: '',
  escritorio_cidade: '',
  escritorio_cep: '',
  foro: '',
  publicApiUrl: '',
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ContractsSettingsPage() {
  // ── Clicksign state
  const [csConfig, setCsConfig] = useState<ClicksignConfig>({
    baseUrl: SANDBOX_URL,
    apiToken: null,
    webhookToken: null,
    isConfigured: false,
  });
  const [csEnv, setCsEnv]           = useState<'sandbox' | 'prod'>('sandbox');
  const [csToken, setCsToken]       = useState('');
  const [csWebhook, setCsWebhook]   = useState('');
  const [showToken, setShowToken]   = useState(false);
  const [showWebhook, setShowWebhook] = useState(false);
  const [editToken, setEditToken]   = useState(false);
  const [editWebhook, setEditWebhook] = useState(false);
  const [savingCs, setSavingCs]     = useState(false);
  const [savedCs, setSavedCs]       = useState(false);

  // ── Contract state
  const [contract, setContract]     = useState<ContractConfig>(DEFAULT_CONTRACT);
  const [savingCt, setSavingCt]     = useState(false);
  const [savedCt, setSavedCt]       = useState(false);

  // ── Loading
  const [loading, setLoading]       = useState(true);

  // ─── Fetch ────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [csRes, ctRes] = await Promise.all([
        api.get<ClicksignConfig>('/settings/clicksign'),
        api.get<ContractConfig>('/settings/contract'),
      ]);
      setCsConfig(csRes.data);
      setCsEnv(csRes.data.baseUrl?.includes('sandbox') ? 'sandbox' : 'prod');
      setContract(ctRes.data);
    } catch (e) {
      console.error('[ContractsSettings] fetchData error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ─── Save Clicksign ───────────────────────────────────────────────────────

  const handleSaveClicksign = async () => {
    setSavingCs(true);
    try {
      const payload: Record<string, string> = {
        baseUrl: csEnv === 'sandbox' ? SANDBOX_URL : PROD_URL,
      };
      if (csToken.trim())   payload.apiToken     = csToken.trim();
      if (csWebhook.trim()) payload.webhookToken = csWebhook.trim();

      await api.patch('/settings/clicksign', payload);

      // reset edit fields
      setCsToken('');
      setCsWebhook('');
      setEditToken(false);
      setEditWebhook(false);
      setSavedCs(true);
      setTimeout(() => setSavedCs(false), 3000);
      await fetchData();
    } catch (e) {
      console.error('[ContractsSettings] saveClicksign error:', e);
      alert('Erro ao salvar configurações do Clicksign. Verifique se você é administrador.');
    } finally {
      setSavingCs(false);
    }
  };

  // ─── Save Contract ────────────────────────────────────────────────────────

  const handleSaveContract = async () => {
    setSavingCt(true);
    try {
      await api.patch('/settings/contract', contract);
      setSavedCt(true);
      setTimeout(() => setSavedCt(false), 3000);
    } catch (e) {
      console.error('[ContractsSettings] saveContract error:', e);
      alert('Erro ao salvar configurações do contrato. Verifique se você é administrador.');
    } finally {
      setSavingCt(false);
    }
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const ct = (field: keyof ContractConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setContract((prev) => ({ ...prev, [field]: e.target.value }));

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col pt-8 overflow-hidden bg-background">
      {/* Header */}
      <header className="px-8 mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-foreground tracking-tight">Contratos & Assinatura Digital</h1>
        <p className="text-[13px] text-muted-foreground mt-1">
          Configure a integração com o Clicksign e os dados fixos do contrato trabalhista.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-8 pb-8 flex flex-col gap-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="animate-spin text-muted-foreground" size={24} />
          </div>
        ) : (
          <>
            {/* ── Seção Clicksign ────────────────────────────────────────── */}
            <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
              {/* Card header */}
              <div className="p-4 border-b border-border flex items-center gap-3 bg-violet-500/5">
                <div className="w-8 h-8 rounded-full bg-violet-500/10 text-violet-400 flex items-center justify-center shrink-0">
                  <FileSignature size={16} />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-foreground">Integração Clicksign</h4>
                  <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
                    Assinatura digital com validade jurídica (Lei 14.063/2020)
                  </p>
                </div>
                {csConfig.isConfigured && (
                  <span className="ml-auto flex items-center gap-1.5 text-[11px] font-bold text-emerald-500">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    CONFIGURADO
                  </span>
                )}
              </div>

              <div className="p-5 space-y-5">
                {/* Ambiente */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                    <Globe size={12} /> Ambiente
                  </label>
                  <div className="flex gap-2">
                    {(['sandbox', 'prod'] as const).map((env) => (
                      <button
                        key={env}
                        onClick={() => setCsEnv(env)}
                        className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-bold border transition-all ${
                          csEnv === env
                            ? env === 'sandbox'
                              ? 'bg-amber-500/10 border-amber-500/40 text-amber-400'
                              : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                            : 'border-border text-muted-foreground hover:bg-muted/50'
                        }`}
                      >
                        {env === 'sandbox' ? '🧪 Sandbox (testes)' : '🚀 Produção'}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    URL: <code className="font-mono text-violet-400">{csEnv === 'sandbox' ? SANDBOX_URL : PROD_URL}</code>
                  </p>
                </div>

                {/* API Token */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                      <KeyRound size={12} /> API Token
                    </label>
                    <button
                      onClick={() => { setEditToken(!editToken); setCsToken(''); setShowToken(false); }}
                      className="text-xs font-bold text-primary hover:underline"
                    >
                      {editToken ? 'Cancelar' : csConfig.isConfigured ? 'Trocar' : 'Configurar'}
                    </button>
                  </div>
                  {editToken ? (
                    <div className="relative">
                      <input
                        type={showToken ? 'text' : 'password'}
                        value={csToken}
                        onChange={(e) => setCsToken(e.target.value)}
                        placeholder="Token da API Clicksign..."
                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-2.5 pr-10 text-sm outline-none focus:border-primary/50 transition-all font-mono"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between text-xs bg-muted/30 rounded-xl px-4 py-2.5">
                      <span className="font-mono text-muted-foreground">
                        {csConfig.apiToken ? csConfig.apiToken : 'Não configurado'}
                      </span>
                      {csConfig.isConfigured ? (
                        <span className="flex items-center gap-1.5 text-emerald-500 font-bold shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> ATIVO
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-amber-500 font-bold shrink-0">
                          <AlertCircle size={12} /> PENDENTE
                        </span>
                      )}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Encontre em: <code className="font-mono text-violet-400">sandbox.clicksign.com</code> → Conta → API
                  </p>
                </div>

                {/* Webhook Token */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                      <Webhook size={12} /> Token do Webhook (HMAC)
                    </label>
                    <button
                      onClick={() => { setEditWebhook(!editWebhook); setCsWebhook(''); setShowWebhook(false); }}
                      className="text-xs font-bold text-primary hover:underline"
                    >
                      {editWebhook ? 'Cancelar' : csConfig.webhookToken ? 'Trocar' : 'Configurar'}
                    </button>
                  </div>
                  {editWebhook ? (
                    <div className="relative">
                      <input
                        type={showWebhook ? 'text' : 'password'}
                        value={csWebhook}
                        onChange={(e) => setCsWebhook(e.target.value)}
                        placeholder="Token HMAC do webhook Clicksign..."
                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-2.5 pr-10 text-sm outline-none focus:border-primary/50 transition-all font-mono"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => setShowWebhook(!showWebhook)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showWebhook ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between text-xs bg-muted/30 rounded-xl px-4 py-2.5">
                      <span className="font-mono text-muted-foreground">
                        {csConfig.webhookToken ? csConfig.webhookToken : 'Não configurado (optional)'}
                      </span>
                      {csConfig.webhookToken ? (
                        <span className="flex items-center gap-1.5 text-emerald-500 font-bold shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> ATIVO
                        </span>
                      ) : (
                        <span className="text-muted-foreground font-bold shrink-0 text-[10px]">OPCIONAL</span>
                      )}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Valida a autenticidade dos eventos recebidos via webhook. Configure no painel Clicksign → Webhooks.
                  </p>
                </div>

                {/* Webhook URL info */}
                <div className="bg-violet-500/5 border border-violet-500/20 rounded-xl p-4 space-y-1">
                  <p className="text-xs font-bold text-violet-400 flex items-center gap-2">
                    <Webhook size={13} /> URL do Webhook (registre no Clicksign)
                  </p>
                  <code className="text-[11px] font-mono text-muted-foreground break-all block">
                    {contract.publicApiUrl
                      ? `${contract.publicApiUrl}/webhooks/clicksign`
                      : '<configure a URL pública da API abaixo>'}
                  </code>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    onClick={handleSaveClicksign}
                    disabled={savingCs}
                    className="bg-primary text-primary-foreground px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-primary/90 transition-all disabled:opacity-50 shadow-lg shadow-primary/20"
                  >
                    {savingCs ? (
                      <RefreshCw className="animate-spin" size={15} />
                    ) : savedCs ? (
                      <CheckCircle2 size={15} />
                    ) : (
                      <FileSignature size={15} />
                    )}
                    {savedCs ? 'Salvo!' : 'Salvar Clicksign'}
                  </button>
                </div>
              </div>
            </div>

            {/* ── Seção Dados do Contrato ─────────────────────────────────── */}
            <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border flex items-center gap-3 bg-primary/5">
                <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Scale size={16} />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-foreground">Dados Fixos do Contrato Trabalhista</h4>
                  <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
                    Preenchidos automaticamente em todo contrato gerado
                  </p>
                </div>
              </div>

              <div className="p-5 space-y-5">

                {/* Advogado 1 */}
                <div>
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Scale size={12} /> Advogado 1
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-muted-foreground">Nome completo</label>
                      <input
                        value={contract.advogado1_nome}
                        onChange={ct('advogado1_nome')}
                        placeholder="Ex: André Freire Lustosa"
                        className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-muted-foreground">OAB</label>
                      <input
                        value={contract.advogado1_oab}
                        onChange={ct('advogado1_oab')}
                        placeholder="Ex: OAB/AL 14.209"
                        className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
                      />
                    </div>
                  </div>
                </div>

                {/* Advogado 2 */}
                <div>
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Scale size={12} /> Advogado 2
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-muted-foreground">Nome completo</label>
                      <input
                        value={contract.advogado2_nome}
                        onChange={ct('advogado2_nome')}
                        placeholder="Ex: Gianny Karla Oliveira Silva"
                        className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-muted-foreground">OAB</label>
                      <input
                        value={contract.advogado2_oab}
                        onChange={ct('advogado2_oab')}
                        placeholder="Ex: OAB/AL 21.897"
                        className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
                      />
                    </div>
                  </div>
                </div>

                {/* Escritório */}
                <div>
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Building2 size={12} /> Endereço do Escritório
                  </p>
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-muted-foreground">Logradouro</label>
                      <input
                        value={contract.escritorio_logradouro}
                        onChange={ct('escritorio_logradouro')}
                        placeholder="Ex: Rua Francisco Rodrigues Viana, nº 242, bairro Baixa Grande"
                        className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-muted-foreground">Cidade/UF</label>
                        <input
                          value={contract.escritorio_cidade}
                          onChange={ct('escritorio_cidade')}
                          placeholder="Ex: Arapiraca/AL"
                          className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-muted-foreground">CEP</label>
                        <input
                          value={contract.escritorio_cep}
                          onChange={ct('escritorio_cep')}
                          placeholder="Ex: 57307-260"
                          className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Foro */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                    <MapPin size={12} /> Foro (cláusula de eleição de foro)
                  </label>
                  <input
                    value={contract.foro}
                    onChange={ct('foro')}
                    placeholder="Ex: Arapiraca/AL"
                    className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
                  />
                  <p className="text-[11px] text-muted-foreground">Cidade que constará na cláusula de eleição de foro do contrato.</p>
                </div>

                {/* URL Pública da API */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                    <Link size={12} /> URL Pública da API
                  </label>
                  <input
                    value={contract.publicApiUrl}
                    onChange={ct('publicApiUrl')}
                    placeholder="Ex: https://api.meuescritorio.com.br"
                    className="w-full bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary/50 transition-all font-mono"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Usada para gerar links de download do contrato DOCX no WhatsApp e registrar o webhook no Clicksign.
                    Deve ser acessível pela internet (ex: via Nginx reverse proxy ou Ngrok em dev).
                  </p>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    onClick={handleSaveContract}
                    disabled={savingCt}
                    className="bg-primary text-primary-foreground px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-primary/90 transition-all disabled:opacity-50 shadow-lg shadow-primary/20"
                  >
                    {savingCt ? (
                      <RefreshCw className="animate-spin" size={15} />
                    ) : savedCt ? (
                      <CheckCircle2 size={15} />
                    ) : (
                      <Building2 size={15} />
                    )}
                    {savedCt ? 'Salvo!' : 'Salvar Dados do Contrato'}
                  </button>
                </div>
              </div>
            </div>

            {/* ── Dica de integração ──────────────────────────────────────── */}
            <div className="bg-violet-500/5 border border-violet-500/20 rounded-2xl p-5 space-y-2">
              <h4 className="text-xs font-bold text-violet-400 uppercase tracking-wide flex items-center gap-2">
                <FileSignature size={13} /> Como funciona a assinatura digital
              </h4>
              <ol className="space-y-1.5 text-[12px] text-muted-foreground list-none">
                {[
                  'O atendente abre o modal do contrato, preenche os dados e clica em "Solicitar Assinatura".',
                  'O sistema gera o PDF, faz upload no Clicksign e cria um link de assinatura.',
                  'O link é enviado ao cliente via WhatsApp. O cliente assina com SMS + Selfie.',
                  'O Clicksign notifica via webhook quando o documento é assinado.',
                  'O sistema envia o PDF assinado ao cliente via WhatsApp e notifica o atendente.',
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full bg-violet-500/20 text-violet-400 flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
