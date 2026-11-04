'use client';

/**
 * Tela 2 da venda rápida: "como vai pagar?", uma pergunta por vez, no jeito de checkout
 * do Mercado Livre. Lista de formas, o detalhe só aparece na forma escolhida e dividir é
 * um passo a mais (quanto vai na primeira → o resto vai para a segunda). As regras ficam
 * em pagamento-balcao.ts; aqui é só a tela. O botão que avança fica no resumo, ao lado.
 */
import { AlertCircle, ArrowLeft, Banknote, CheckCircle2, Circle, CreditCard, QrCode, Split } from 'lucide-react';
import { LAB_VENDA_RAPIDA } from './lab-venda-textos';
import {
  MAX_PARCELAS,
  PAGAMENTO_VAZIO,
  analisar,
  escolherForma,
  fmtCentavos,
  formasDaSegunda,
  ligarDuasFormas,
  paraCentavos,
  rotuloLinha,
  trocarPrimeira,
  type EstadoPagamento,
  type Forma,
  type LocalPix,
} from './pagamento-balcao';

const FORMAS: Forma[] = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO'];
const PARCELAS = Array.from({ length: MAX_PARCELAS }, (_, i) => i + 1);

function dadosDaForma(forma: Forma, lab?: boolean) {
  if (forma === 'DINHEIRO') return { Icon: Banknote, titulo: 'Dinheiro', sub: 'Recebido em mãos, entra no caixa' };
  if (forma === 'PIX') {
    return { Icon: QrCode, titulo: 'PIX', sub: lab ? LAB_VENDA_RAPIDA.pagamento.pixSub : 'Na chave da clínica ou na maquineta' };
  }
  if (forma === 'DEBITO') return { Icon: CreditCard, titulo: 'Cartão de débito', sub: 'Passado na maquineta' };
  return { Icon: CreditCard, titulo: 'Cartão de crédito', sub: `À vista ou parcelado em até ${MAX_PARCELAS}x` };
}

const OPCAO = 'rounded-lg border px-2 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const OPCAO_ON = 'border-primary bg-primary/10 text-primary';
const OPCAO_OFF = 'border-border bg-card text-foreground hover:bg-accent/40';

export default function PagamentoBalcao({
  valor,
  onChange,
  totalCentavos,
  valorMudou,
  bloqueado,
  lab,
}: {
  valor: EstadoPagamento;
  onChange: (p: EstadoPagamento) => void;
  totalCentavos: number;
  /** O carrinho mudou depois de escolher: a forma foi limpa e a tela avisa. */
  valorMudou?: boolean;
  /** Durante o envio nada muda (mudar geraria outra chave e duplicaria a venda). */
  bloqueado?: boolean;
  lab?: boolean;
}) {
  const a = analisar(valor, totalCentavos);
  const digitandoPrimeira = valor.duasFormas && !valor.primeira;
  const parteDigitada = paraCentavos(valor.valorPrimeira);
  const valorRuim = digitandoPrimeira && valor.valorPrimeira.trim() !== '' && !(parteDigitada !== null && parteDigitada > 0 && parteDigitada < totalCentavos);
  const formas = formasDaSegunda(valor, FORMAS);

  const titulo = valor.primeira
    ? `Como paga os R$ ${fmtCentavos(a.baseCentavos)} que faltam?`
    : digitandoPrimeira
      ? 'Quanto vai na primeira forma?'
      : lab
        ? LAB_VENDA_RAPIDA.pagamento.titulo
        : 'Como o paciente vai pagar?';

  return (
    <fieldset disabled={bloqueado} className="min-w-0 border-0 p-0 m-0 disabled:opacity-70">
      {valorMudou && (
        <p className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-800">
          <AlertCircle size={14} className="mt-px shrink-0" />
          O valor da venda mudou. Escolha a forma de pagamento de novo.
        </p>
      )}

      {valor.primeira && (
        <div className="mb-3 flex items-center gap-3 vr-card px-4 py-3">
          <CheckCircle2 size={18} className="vr-verde shrink-0" />
          <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">
            {rotuloLinha(valor.primeira)} · R$ {fmtCentavos(valor.primeira.centavos)}
          </span>
          <button
            type="button"
            onClick={() => onChange(trocarPrimeira(valor))}
            className="vr-link shrink-0 rounded-md px-2 py-1 text-xs font-semibold"
          >
            Trocar
          </button>
        </div>
      )}

      <h2 className="mb-3 text-xl font-semibold text-foreground">{titulo}</h2>

      {digitandoPrimeira && (
        <div className="mb-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">R$</span>
            <input
              autoFocus
              type="text"
              inputMode="decimal"
              aria-label="Valor da primeira forma"
              aria-invalid={valorRuim}
              value={valor.valorPrimeira}
              onChange={(e) => onChange({ ...valor, valorPrimeira: e.target.value })}
              placeholder="0,00"
              className="w-36 rounded-lg border border-border bg-card px-3 py-2 text-base font-semibold tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <span className="text-sm text-muted-foreground">de R$ {fmtCentavos(totalCentavos)}</span>
          </div>
          {valorRuim && (
            <p role="alert" className="mt-1.5 text-xs font-semibold text-red-600">
              O valor tem que ser maior que zero e menor que o total.
            </p>
          )}
        </div>
      )}

      <div role="radiogroup" aria-label="Forma de pagamento" className="vr-card divide-y divide-border overflow-hidden">
        {formas.map((forma) => {
          const { Icon, titulo: nome, sub } = dadosDaForma(forma, lab);
          const ativa = valor.atual.forma === forma;
          return (
            <div key={forma} className={ativa ? 'bg-primary/5' : ''}>
              <button
                type="button"
                role="radio"
                aria-checked={ativa}
                onClick={() => onChange(escolherForma(valor, forma))}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
              >
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${ativa ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-foreground">{nome}</span>
                  <span className="block text-xs text-muted-foreground">{sub}</span>
                </span>
                {ativa
                  ? <CheckCircle2 size={20} className="shrink-0 text-primary" />
                  : <Circle size={20} className="shrink-0 text-muted-foreground/40" />}
              </button>

              {ativa && forma === 'PIX' && (
                <div className="px-4 pb-4">
                  <p className="mb-2 text-xs font-semibold text-muted-foreground">Onde foi pago?</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      ['CHAVE', lab ? LAB_VENDA_RAPIDA.pagamento.pixChave : 'Chave da clínica'],
                      ['MAQUINETA', 'Na maquineta'],
                    ] as Array<[LocalPix, string]>).map(([local, texto]) => (
                      <button
                        key={local}
                        type="button"
                        aria-pressed={valor.atual.localPix === local}
                        onClick={() => onChange({ ...valor, atual: { ...valor.atual, localPix: local } })}
                        className={`${OPCAO} ${valor.atual.localPix === local ? OPCAO_ON : OPCAO_OFF}`}
                      >
                        {texto}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {ativa && forma === 'CREDITO' && (
                <div className="px-4 pb-4">
                  <p className="mb-2 text-xs font-semibold text-muted-foreground">Em quantas vezes?</p>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {PARCELAS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={valor.atual.parcelas === n}
                        onClick={() => onChange({ ...valor, atual: { ...valor.atual, parcelas: n } })}
                        className={`${OPCAO} ${valor.atual.parcelas === n ? OPCAO_ON : OPCAO_OFF}`}
                      >
                        <span className="block">{n === 1 ? 'À vista' : `${n}x`}</span>
                        <span className="block text-[11px] font-medium tabular-nums opacity-80">
                          {a.baseCentavos > 0 ? `R$ ${fmtCentavos(Math.round(a.baseCentavos / n))}` : '—'}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Parcelas são só info pra bater com o extrato da maquininha. O valor entra no caixa de hoje.
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => onChange(valor.duasFormas ? PAGAMENTO_VAZIO : ligarDuasFormas())}
        className="vr-card vr-link mt-3 inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold"
      >
        {valor.duasFormas ? <><ArrowLeft size={15} /> Voltar para 1 forma só</> : <><Split size={15} /> Pagar com 2 formas</>}
      </button>
    </fieldset>
  );
}
