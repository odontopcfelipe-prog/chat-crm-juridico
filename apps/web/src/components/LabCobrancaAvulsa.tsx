'use client';

/**
 * Paridade clínica → laboratório — seção "Cobranças avulsas" do painel do contato
 * (LabClientPanel). É o mesmo fluxo da seção de honorários negociados do painel da
 * clínica (ClientPanel), com os nomes do laboratório: o valor combinado com o cliente,
 * dividido em parcelas, em que cada parcela vira um boleto próprio na conta Asaas DO
 * PRÓPRIO laboratório. O pagamento de um boleto baixa só aquela parcela.
 *
 * Só o laboratório monta este componente, então todo texto visível vem de
 * lab-cobranca-avulsa-textos.ts. Rotas: as mesmas do painel da clínica, filtradas pela
 * conta do login no servidor.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, CreditCard, ExternalLink, Handshake, Loader2, Plus, Trash2, X } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { LAB_COBRANCA_AVULSA as T } from '@/app/atendimento/components/lab-cobranca-avulsa-textos';

interface CobrancaDaParcela {
  status: string;
  received_in_cash?: boolean | null;
  boleto_url?: string | null;
  invoice_url?: string | null;
}

interface Parcela {
  id: string;
  amount: number | string;
  due_date?: string | null;
  status: string;
  gateway_charge?: CobrancaDaParcela | null;
}

interface CobrancaAvulsa {
  id: string;
  type: string;
  status: string;
  total_value: number | string;
  notes?: string | null;
  payments?: Parcela[];
}

interface ResultadoDaGeracao {
  criadas?: number;
  erro?: string | null;
}

/** Em que pé está a cobrança da parcela (mesma regra do servidor). */
function situacaoDaCobranca(c: CobrancaDaParcela): 'PAGA' | 'ENCERRADA' | 'ABERTA' {
  if (c.received_in_cash || c.status === 'RECEIVED' || c.status === 'CONFIRMED') return 'PAGA';
  if (c.status === 'DELETED' || c.status === 'CANCELLED' || c.status === 'REFUNDED') return 'ENCERRADA';
  return 'ABERTA';
}

const temBoletoEmAberto = (p: Parcela) => !!p.gateway_charge && situacaoDaCobranca(p.gateway_charge) === 'ABERTA';
/** A parcela ainda precisa de boleto: não paga e sem cobrança viva. */
const precisaDeBoleto = (p: Parcela) => p.status !== 'PAGO' && (!p.gateway_charge || situacaoDaCobranca(p.gateway_charge) === 'ENCERRADA');

const brl = (v: number | string) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
const dataBr = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

const CORES_SITUACAO: Record<string, string> = {
  NEGOCIANDO: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  ACEITO: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  RECUSADO: 'bg-red-500/15 text-red-400 border-red-500/30',
  CONVERTIDO: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
};
const PROXIMA_SITUACAO: Record<string, string> = { NEGOCIANDO: 'ACEITO', ACEITO: 'RECUSADO', RECUSADO: 'NEGOCIANDO' };

function mensagemDoServidor(e: unknown): string | null {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (Array.isArray(m)) {
    const texto = m.filter((x): x is string => typeof x === 'string').join(', ');
    return texto || null;
  }
  return null;
}

export function LabCobrancaAvulsa({ leadId }: { leadId: string }) {
  const [aberta, setAberta] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [lista, setLista] = useState<CobrancaAvulsa[]>([]);
  const [asaasProprio, setAsaasProprio] = useState<boolean | null>(null);
  const [formAberto, setFormAberto] = useState(false);
  const [tipo, setTipo] = useState('CONTRATUAL');
  const [valor, setValor] = useState('');
  const [obs, setObs] = useState('');
  const [parcelas, setParcelas] = useState<Array<{ amount: string; due_date: string }>>([{ amount: '', due_date: '' }]);
  const [salvando, setSalvando] = useState(false);
  const [gerandoId, setGerandoId] = useState<string | null>(null);
  // Trava síncrona: o clique duplo chega antes de o estado desabilitar o botão.
  const gerandoAgora = useRef(false);

  const carregar = () => {
    setCarregando(true);
    return api
      .get<CobrancaAvulsa[]>(`/leads/${leadId}/honorarios-negociados`)
      .then((r) => setLista(Array.isArray(r.data) ? r.data : []))
      .catch(() => setLista([]))
      .finally(() => setCarregando(false));
  };

  useEffect(() => {
    setAberta(false);
    setLista([]);
    setFormAberto(false);
  }, [leadId]);

  useEffect(() => {
    if (!aberta) return;
    carregar();
    api
      .get<{ own_account?: boolean }>('/payment-gateway/settings')
      .then(({ data }) => setAsaasProprio(data?.own_account ?? false))
      .catch(() => setAsaasProprio(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberta, leadId]);

  const reiniciarForm = () => {
    setTipo('CONTRATUAL');
    setValor('');
    setObs('');
    setParcelas([{ amount: '', due_date: '' }]);
  };

  const dividirIgual = () => {
    const total = parseFloat(valor);
    const n = parcelas.length;
    if (!total || n === 0) return;
    const base = Math.floor((total * 100) / n) / 100;
    const ultima = Math.round((total - base * (n - 1)) * 100) / 100;
    const hoje = new Date();
    setParcelas(
      parcelas.map((p, i) => {
        const dt = new Date(hoje);
        dt.setMonth(dt.getMonth() + i);
        return { amount: String(i === n - 1 ? ultima : base), due_date: p.due_date || dt.toISOString().slice(0, 10) };
      }),
    );
  };

  const salvar = async () => {
    const total = parseFloat(valor);
    if (!total || total <= 0) return;
    const pagamentos = parcelas.map((p) => ({ amount: parseFloat(p.amount) || 0, due_date: p.due_date || undefined }));
    if (pagamentos.some((p) => !p.amount)) { showError(T.preenchaParcelas); return; }
    const soma = pagamentos.reduce((s, p) => s + p.amount, 0);
    if (Math.abs(soma - total) > 0.02) { showError(T.somaDiferente); return; }
    setSalvando(true);
    try {
      const { data } = await api.post<CobrancaAvulsa>(`/leads/${leadId}/honorarios-negociados`, {
        type: tipo,
        total_value: total,
        notes: obs || undefined,
        payments: pagamentos,
      });
      setLista((prev) => [data, ...prev]);
      setFormAberto(false);
      reiniciarForm();
      showSuccess(T.salva);
    } catch (e) {
      showError(mensagemDoServidor(e) ?? T.erroSalvar);
    } finally {
      setSalvando(false);
    }
  };

  const trocarSituacao = async (id: string, nova: string) => {
    try {
      const { data } = await api.patch<CobrancaAvulsa>(`/leads/${leadId}/honorarios-negociados/${id}`, { status: nova });
      setLista((prev) => prev.map((h) => (h.id === id ? data : h)));
    } catch (e) {
      showError(mensagemDoServidor(e) ?? T.erroAtualizar);
    }
  };

  const excluir = async (h: CobrancaAvulsa) => {
    const comBoleto = (h.payments ?? []).some(temBoletoEmAberto);
    const id = h.id;
    if (!window.confirm(comBoleto ? T.confirmarExcluirComBoleto : T.confirmarExcluirCobranca)) return;
    try {
      await api.delete(`/leads/${leadId}/honorarios-negociados/${id}`);
      setLista((prev) => prev.filter((h) => h.id !== id));
    } catch (e) {
      showError(mensagemDoServidor(e) ?? T.erroExcluir);
    }
  };

  const marcarPaga = async (p: Parcela) => {
    if (temBoletoEmAberto(p) && !window.confirm(T.confirmarPagoComBoleto)) return;
    try {
      await api.patch(`/leads/honorarios-negociados/payments/${p.id}/mark-paid`, {});
      await carregar();
      showSuccess(T.paga);
    } catch (e) {
      showError(mensagemDoServidor(e) ?? T.erroPagar);
    }
  };

  const excluirParcela = async (p: Parcela) => {
    if (!window.confirm(temBoletoEmAberto(p) ? T.confirmarExcluirComBoleto : T.confirmarExcluirParcela)) return;
    try {
      await api.delete(`/leads/honorarios-negociados/payments/${p.id}`);
      await carregar();
    } catch (e) {
      showError(mensagemDoServidor(e) ?? T.erroExcluir);
    }
  };

  const gerarBoleto = async (h: CobrancaAvulsa) => {
    if (gerandoAgora.current) return;
    gerandoAgora.current = true;
    setGerandoId(h.id);
    try {
      const { data } = await api.post<ResultadoDaGeracao>('/payment-gateway/charges/installment', {
        leadHonorarioId: h.id,
        billingType: 'BOLETO',
      });
      const criadas = data?.criadas ?? 0;
      if (data?.erro) showError(T.geradosEmParte(criadas, data.erro));
      else showSuccess(criadas ? T.boletosGerados(criadas) : T.boletosEmDia);
    } catch (e) {
      showError(mensagemDoServidor(e) ?? T.erroGerar);
    } finally {
      gerandoAgora.current = false;
      setGerandoId(null);
      await carregar();
    }
  };

  return (
    <div className="border-t border-border">
      <button
        type="button"
        aria-expanded={aberta}
        onClick={() => setAberta((v) => !v)}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-accent/30 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Handshake size={15} className="text-sky-400" />
          <span className="text-[13px] font-bold text-foreground">{T.titulo}</span>
          {lista.length > 0 && (
            <span className="text-[11px] text-muted-foreground bg-foreground/[0.06] px-2 py-0.5 rounded-full font-mono">{lista.length}</span>
          )}
        </div>
        {aberta ? <ChevronUp size={15} className="text-muted-foreground" /> : <ChevronDown size={15} className="text-muted-foreground" />}
      </button>

      {aberta && (
        <div className="px-6 pb-5 space-y-3">
          {asaasProprio === false && (
            <p className="text-[11px] text-amber-600 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 leading-snug">{T.semAsaasProprio}</p>
          )}

          {carregando ? (
            <div className="text-center py-4"><Loader2 size={16} className="animate-spin text-muted-foreground mx-auto" /></div>
          ) : (
            <>
              {lista.length === 0 && !formAberto && (
                <p className="text-xs text-muted-foreground text-center py-2">{T.vazio}</p>
              )}

              {lista.map((h) => {
                const pagamentos = h.payments ?? [];
                const semBoleto = pagamentos.filter(precisaDeBoleto).length;
                const convertida = h.status === 'CONVERTIDO';
                return (
                  <div key={h.id} className="bg-accent/30 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase font-semibold bg-foreground/[0.06] px-2 py-0.5 rounded text-muted-foreground">
                          {T.tipos[h.type] ?? h.type}
                        </span>
                        <button
                          type="button"
                          disabled={convertida}
                          onClick={() => trocarSituacao(h.id, PROXIMA_SITUACAO[h.status] ?? 'NEGOCIANDO')}
                          title={convertida ? T.convertidaDica : T.trocarSituacao}
                          className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded border ${CORES_SITUACAO[h.status] ?? 'bg-gray-500/15 text-gray-400'} ${convertida ? 'cursor-default' : 'cursor-pointer hover:opacity-80'}`}
                        >
                          {T.situacoes[h.status] ?? h.status}
                        </button>
                      </div>
                      {!convertida && (
                        <button type="button" onClick={() => excluir(h)} title={T.excluirCobranca} aria-label={T.excluirCobranca} className="text-muted-foreground hover:text-red-400 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <div className="flex items-baseline gap-3">
                      <span className="text-sm font-bold text-foreground">{brl(h.total_value)}</span>
                      {pagamentos.length > 1 && <span className="text-[11px] text-muted-foreground">{pagamentos.length}x</span>}
                    </div>
                    {h.notes && <p className="text-[11px] text-muted-foreground leading-relaxed">{h.notes}</p>}

                    {pagamentos.length > 0 && (
                      <div className="space-y-1.5 pt-1 border-t border-border/40">
                        {pagamentos.map((p, i) => (
                          <div key={p.id} className="text-[11px]">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-4">{i + 1}.</span>
                                <span className="font-medium text-foreground">{brl(p.amount)}</span>
                                <span className="text-muted-foreground">
                                  {p.due_date ? dataBr(p.due_date) : <span className="italic text-muted-foreground/50">{T.aoFinal}</span>}
                                </span>
                                <span
                                  className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${
                                    p.status === 'PAGO'
                                      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20'
                                      : p.status === 'ATRASADO'
                                        ? 'bg-red-500/15 text-red-400 border-red-500/20'
                                        : 'bg-sky-500/15 text-sky-400 border-sky-500/20'
                                  }`}
                                >
                                  {T.parcelas[p.status] ?? p.status}
                                </span>
                              </div>
                              {p.status !== 'PAGO' && !convertida && (
                                <div className="flex items-center gap-1">
                                  <button type="button" onClick={() => marcarPaga(p)} className="text-emerald-400 hover:text-emerald-300" title={T.marcarPago} aria-label={T.marcarPago}>
                                    <Check size={12} />
                                  </button>
                                  <button type="button" onClick={() => excluirParcela(p)} className="text-muted-foreground hover:text-red-400" title={T.excluirParcela} aria-label={T.excluirParcela}>
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                              )}
                            </div>
                            {p.gateway_charge && (
                              <div className="flex items-center gap-2 pl-6 pt-0.5 text-[10px] text-muted-foreground">
                                <span>{p.gateway_charge.status === 'OVERDUE' ? T.boletos.OVERDUE : T.boletos[situacaoDaCobranca(p.gateway_charge)]}</span>
                                {situacaoDaCobranca(p.gateway_charge) === 'ABERTA' && p.gateway_charge.boleto_url && (
                                  <a href={p.gateway_charge.boleto_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                                    <ExternalLink size={9} /> {T.abrirBoleto}
                                  </a>
                                )}
                                {situacaoDaCobranca(p.gateway_charge) === 'ABERTA' && p.gateway_charge.invoice_url && (
                                  <a href={p.gateway_charge.invoice_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                                    <ExternalLink size={9} /> {T.verFatura}
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {!convertida && semBoleto > 0 && (
                      <div className="pt-2 border-t border-border/40">
                        <button
                          type="button"
                          onClick={() => gerarBoleto(h)}
                          disabled={gerandoId !== null}
                          className="w-full text-[11px] py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          {gerandoId === h.id ? <Loader2 size={11} className="animate-spin" /> : <CreditCard size={11} />}
                          {gerandoId === h.id ? T.gerando : T.gerarBoleto(semBoleto)}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {formAberto ? (
                <div className="bg-accent/30 rounded-lg p-3 space-y-2.5">
                  <select
                    value={tipo}
                    onChange={(e) => setTipo(e.target.value)}
                    className="w-full text-xs bg-background border border-border rounded-md px-3 py-2 text-foreground"
                  >
                    {Object.entries(T.tipos).map(([chave, rotulo]) => (
                      <option key={chave} value={chave}>{rotulo}</option>
                    ))}
                  </select>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase">{T.valorTotal}</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={valor}
                      onChange={(e) => setValor(e.target.value)}
                      placeholder={T.valorPlaceholder}
                      className="w-full text-xs bg-background border border-border rounded-md px-3 py-2 text-foreground mt-0.5"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] text-muted-foreground uppercase">{T.parcelasRotulo}</label>
                      <button type="button" onClick={dividirIgual} disabled={!valor} className="text-[10px] text-sky-400 hover:text-sky-300 disabled:opacity-30">
                        {T.dividirIgual}
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {parcelas.map((p, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="text-[10px] text-muted-foreground w-4">{i + 1}.</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={p.amount}
                            onChange={(e) => setParcelas((cur) => cur.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                            placeholder={T.valorDaParcela}
                            aria-label={T.valorDaParcela}
                            className="flex-1 min-w-0 text-xs bg-background border border-border rounded-md px-2 py-1.5 text-foreground"
                          />
                          <input
                            type="date"
                            value={p.due_date}
                            onChange={(e) => setParcelas((cur) => cur.map((x, j) => (j === i ? { ...x, due_date: e.target.value } : x)))}
                            aria-label={T.vencimento}
                            className="text-xs bg-background border border-border rounded-md px-2 py-1.5 text-foreground"
                          />
                          {parcelas.length > 1 && (
                            <button type="button" onClick={() => setParcelas((cur) => cur.filter((_, j) => j !== i))} title={T.removerParcela} aria-label={T.removerParcela} className="text-muted-foreground hover:text-red-400">
                              <X size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    {parcelas.length < 24 && (
                      <button type="button" onClick={() => setParcelas((cur) => [...cur, { amount: '', due_date: '' }])} className="mt-1.5 text-[11px] text-sky-400 hover:text-sky-300 inline-flex items-center gap-1">
                        <Plus size={11} /> {T.adicionarParcela}
                      </button>
                    )}
                  </div>
                  <textarea
                    value={obs}
                    onChange={(e) => setObs(e.target.value)}
                    placeholder={T.observacoes}
                    rows={2}
                    className="w-full resize-none text-xs bg-background border border-border rounded-md px-3 py-2 text-foreground"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={salvar}
                      disabled={salvando || !parseFloat(valor)}
                      className="flex-1 text-[12px] py-2 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {salvando && <Loader2 size={12} className="animate-spin" />}
                      {salvando ? T.salvando : T.salvar}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setFormAberto(false); reiniciarForm(); }}
                      className="px-4 py-2 text-[12px] text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
                    >
                      {T.cancelar}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setFormAberto(true)}
                  className="w-full text-[12px] py-2 rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Plus size={13} /> {T.nova}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
