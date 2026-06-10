'use client';

/**
 * Onda 17.32.165 — Carrossel de vantagens do Odonto System.
 *
 * Fase 2 do primeiro acesso (skill design-odonto-system): depois de
 * configurar, o admin VE o que o sistema faz por ele — 6 cards, um
 * acento por diferencial, cada um com um mini-preview realista da
 * funcionalidade (nao icone generico).
 *
 * Adaptado do componente canonico assets/primeiro-acesso.jsx da skill.
 * Navegacao por teclado (setas), barrinhas de progresso, anim por card.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  MessagesSquare, Bot, BellRing, HeartPulse, FileSignature, Wallet,
  Sparkles, Star, PenLine, Check, CheckCheck, ArrowRight, ArrowLeft,
} from 'lucide-react';

// ─── Acentos (strings literais — Tailwind nao compila classe dinamica) ─
export const ACCENTS = {
  emerald: { text: 'text-emerald-400', glow: 'bg-emerald-500/20', dot: 'bg-emerald-400', btn: 'bg-emerald-500 hover:bg-emerald-400 text-emerald-950', iconBg: 'bg-emerald-500/15 ring-emerald-400/30' },
  cyan:    { text: 'text-cyan-400',    glow: 'bg-cyan-500/20',    dot: 'bg-cyan-400',    btn: 'bg-cyan-500 hover:bg-cyan-400 text-cyan-950',       iconBg: 'bg-cyan-500/15 ring-cyan-400/30' },
  blue:    { text: 'text-blue-400',    glow: 'bg-blue-500/20',    dot: 'bg-blue-400',    btn: 'bg-blue-500 hover:bg-blue-400 text-blue-950',       iconBg: 'bg-blue-500/15 ring-blue-400/30' },
  violet:  { text: 'text-violet-400',  glow: 'bg-violet-500/20',  dot: 'bg-violet-400',  btn: 'bg-violet-500 hover:bg-violet-400 text-violet-950', iconBg: 'bg-violet-500/15 ring-violet-400/30' },
  amber:   { text: 'text-amber-400',   glow: 'bg-amber-500/20',   dot: 'bg-amber-400',   btn: 'bg-amber-400 hover:bg-amber-300 text-amber-950',    iconBg: 'bg-amber-500/15 ring-amber-400/30' },
  rose:    { text: 'text-rose-400',    glow: 'bg-rose-500/20',    dot: 'bg-rose-400',    btn: 'bg-rose-500 hover:bg-rose-400 text-rose-950',       iconBg: 'bg-rose-500/15 ring-rose-400/30' },
} as const;

export type AccentKey = keyof typeof ACCENTS;

// Onda 17.32.171 — variantes CLARAS por acento (card branco). O ACCENTS
// dark acima continua exportado: o shell usa o glow dele no fundo roxo.
const LIGHT: Record<AccentKey, { text: string; tile: string; btn: string; dot: string }> = {
  emerald: { text: 'text-emerald-600', tile: 'bg-emerald-100 ring-emerald-200', btn: 'bg-emerald-600 hover:bg-emerald-500 text-white', dot: 'bg-emerald-500' },
  cyan:    { text: 'text-cyan-600',    tile: 'bg-cyan-100 ring-cyan-200',       btn: 'bg-cyan-600 hover:bg-cyan-500 text-white',       dot: 'bg-cyan-500' },
  blue:    { text: 'text-blue-600',    tile: 'bg-blue-100 ring-blue-200',       btn: 'bg-blue-600 hover:bg-blue-500 text-white',       dot: 'bg-blue-500' },
  violet:  { text: 'text-violet-600',  tile: 'bg-violet-100 ring-violet-200',   btn: 'bg-violet-600 hover:bg-violet-500 text-white',   dot: 'bg-violet-500' },
  amber:   { text: 'text-amber-600',   tile: 'bg-amber-100 ring-amber-200',     btn: 'bg-amber-500 hover:bg-amber-400 text-white',     dot: 'bg-amber-500' },
  rose:    { text: 'text-rose-600',    tile: 'bg-rose-100 ring-rose-200',       btn: 'bg-rose-600 hover:bg-rose-500 text-white',       dot: 'bg-rose-500' },
};

// ─── Mini-previews (miniaturas realistas das funcionalidades) ──────

function PreviewWhatsMulti() {
  const convos = [
    { name: 'Maria S.', msg: 'Pode ser quinta?' },
    { name: 'João L.', msg: 'Quanto fica o clareamento?' },
    { name: 'Ana R.', msg: 'Confirmado 👍' },
    { name: 'Pedro M.', msg: 'Recebi o boleto' },
    { name: 'Lúcia F.', msg: 'Tem horário sábado?' },
    { name: 'Carla T.', msg: 'Obrigada!' },
  ];
  return (
    <div className="text-left">
      <div className="grid grid-cols-3 gap-1.5">
        {convos.map((c) => (
          <div key={c.name} className="rounded-lg bg-white p-2 ring-1 ring-zinc-200">
            <div className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              <span className="truncate text-[10px] font-medium text-zinc-700">{c.name}</span>
            </div>
            <p className="mt-1 truncate text-[9px] text-zinc-500">{c.msg}</p>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-emerald-600">
        <MessagesSquare className="h-3 w-3" /> 6 conversas abertas ao mesmo tempo
      </div>
    </div>
  );
}

function PreviewIA() {
  return (
    <div className="grid grid-cols-2 gap-2 text-left">
      <div className="rounded-xl bg-white p-2.5 ring-1 ring-zinc-200">
        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-600">
          <Sparkles className="h-3 w-3" /> Leads
        </div>
        <p className="rounded-lg rounded-tl-sm bg-cyan-50 px-2 py-1.5 text-[11px] leading-snug text-cyan-900 ring-1 ring-cyan-200">
          Vi seu interesse em clareamento. Te passo os valores?
        </p>
      </div>
      <div className="rounded-xl bg-white p-2.5 ring-1 ring-zinc-200">
        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-600">
          <Sparkles className="h-3 w-3" /> Pacientes
        </div>
        <p className="rounded-lg rounded-tl-sm bg-cyan-50 px-2 py-1.5 text-[11px] leading-snug text-cyan-900 ring-1 ring-cyan-200">
          Seu retorno está chegando. Quer já agendar?
        </p>
      </div>
    </div>
  );
}

function PreviewLembrete() {
  return (
    <div className="space-y-2 text-left">
      <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-white px-3 py-2 text-[13px] leading-snug text-zinc-700 ring-1 ring-zinc-200">
        Lembrete: sua consulta é amanhã, 14h, com Dr. Costa.
      </div>
      <div className="flex gap-2">
        <span className="flex-1 rounded-lg bg-blue-100 py-1.5 text-center text-[12px] font-medium text-blue-700 ring-1 ring-blue-200">Confirmar</span>
        <span className="flex-1 rounded-lg bg-white py-1.5 text-center text-[12px] font-medium text-zinc-500 ring-1 ring-zinc-200">Remarcar</span>
      </div>
      <div className="flex items-center gap-1.5 pt-0.5 text-[11px] text-blue-600">
        <CheckCheck className="h-3 w-3" /> Confirmada — agenda atualizada sozinha
      </div>
    </div>
  );
}

function PreviewRecuperacao() {
  const fila = [
    { name: 'Maria Silva', motivo: 'Sumiu há 4 meses', st: 'IA em contato', done: false },
    { name: 'João Lima', motivo: 'Orçamento parado', st: 'Recuperado', done: true },
    { name: 'Ana Reis', motivo: 'Faltou ao retorno', st: 'IA em contato', done: false },
  ];
  return (
    <div className="space-y-1.5 text-left">
      {fila.map((p) => (
        <div key={p.name} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 ring-1 ring-zinc-200">
          <div className="min-w-0">
            <p className="truncate text-[12px] font-medium text-zinc-700">{p.name}</p>
            <p className="truncate text-[10px] text-zinc-500">{p.motivo}</p>
          </div>
          <span
            className={
              'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ' +
              (p.done ? 'bg-violet-100 text-violet-700 ring-violet-200' : 'bg-zinc-100 text-zinc-600 ring-zinc-200')
            }
          >
            {p.done ? <Check className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
            {p.st}
          </span>
        </div>
      ))}
    </div>
  );
}

function PreviewPropostaContrato() {
  return (
    <div className="space-y-2 text-left">
      <div className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200">
        <div className="flex items-center gap-2">
          <Star className="h-4 w-4 text-amber-500" fill="currentColor" />
          <div>
            <p className="text-[12px] font-semibold text-amber-900">Plano Completo</p>
            <p className="text-[10px] text-amber-700/70">Recomendado</p>
          </div>
        </div>
        <span className="text-[13px] font-bold tabular-nums text-amber-900">R$ 4.800</span>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-white px-3 py-2 ring-1 ring-zinc-200">
        <span className="flex items-center gap-1.5 text-[12px] text-zinc-600">
          <PenLine className="h-3.5 w-3.5 text-zinc-400" /> Contrato · ClickSign
        </span>
        <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
          <Check className="h-3 w-3" /> Assinado
        </span>
      </div>
      <div className="flex items-center gap-1.5 pt-0.5 text-[11px] text-amber-600">
        <Sparkles className="h-3 w-3" /> Fechou e já assinou — sem sair da tela
      </div>
    </div>
  );
}

function PreviewCobranca() {
  const rows = [
    { label: 'PIX', value: 'R$ 180', state: 'Pago' },
    { label: 'Boleto #1842', value: 'R$ 350', state: 'Pago' },
    { label: 'Cartão 3x', value: 'R$ 600', state: 'Em dia' },
  ];
  return (
    <div className="space-y-1.5 text-left">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-[13px] ring-1 ring-zinc-200">
          <span className="text-zinc-600">{r.label}</span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-zinc-500">{r.value}</span>
            <span className="flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-rose-200">
              <Check className="h-3 w-3" /> {r.state}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── As 6 vantagens (copy voltada ao dono da clinica) ──────────────

const ADVANTAGES: Array<{
  id: string;
  icon: typeof MessagesSquare;
  accent: AccentKey;
  eyebrow: string;
  title: string;
  description: string;
  Preview: () => React.ReactNode;
}> = [
  { id: 'whats-multi', icon: MessagesSquare, accent: 'emerald', eyebrow: 'WhatsApp multiatendimento', title: 'Atenda 4 a 6 conversas de uma vez', description: 'Várias conversas lado a lado na mesma tela. A equipe inteira atende ao mesmo tempo, sem trocar de aparelho e sem deixar ninguém esperando.', Preview: PreviewWhatsMulti },
  { id: 'ia', icon: Bot, accent: 'cyan', eyebrow: 'IA para leads e pacientes', title: 'Uma IA que responde por você', description: 'Ela qualifica e responde leads novos na hora e cuida do follow-up dos pacientes. Ninguém fica sem resposta, de dia ou de madrugada.', Preview: PreviewIA },
  { id: 'lembrete', icon: BellRing, accent: 'blue', eyebrow: 'Lembrete e confirmação', title: 'Menos faltas na agenda', description: 'Lembrete e confirmação de consulta automáticos pelo WhatsApp. O paciente confirma com um toque e a agenda se atualiza sozinha.', Preview: PreviewLembrete },
  { id: 'recuperacao', icon: HeartPulse, accent: 'violet', eyebrow: 'Central de Recuperação', title: 'Pacientes parados voltam sozinhos', description: 'Outros sistemas só mostram quem sumiu. O seu traz de volta: a IA reativa quem faltou, parou no orçamento ou está há meses sem voltar.', Preview: PreviewRecuperacao },
  { id: 'proposta', icon: FileSignature, accent: 'amber', eyebrow: 'Fechamento com assinatura', title: 'Fechou? Já assina na hora', description: 'Orçamento com o plano certo em destaque e o contrato com assinatura eletrônica (ClickSign) dentro do próprio fechamento. Sem papel, sem voltar depois.', Preview: PreviewPropostaContrato },
  { id: 'cobranca', icon: Wallet, accent: 'rose', eyebrow: 'Cobrança integrada', title: 'O dinheiro entra no automático', description: 'PIX, boleto e cartão com régua de cobrança automática via Asaas. A clínica para de correr atrás de inadimplente e o caixa fica previsível.', Preview: PreviewCobranca },
];

interface Props {
  /** Ultimo card -> "Começar a usar" */
  onFinish: () => void;
  /** Botao "Pular" do header */
  onSkip: () => void;
  /** Notifica o shell pra trocar a cor do glow conforme o card */
  onAccentChange?: (glowClass: string) => void;
}

export default function AdvantagesCarousel({ onFinish, onSkip, onAccentChange }: Props) {
  const [idx, setIdx] = useState(0);
  const v = ADVANTAGES[idx];
  const accent = ACCENTS[v.accent]; // dark: usado so pro glow do shell
  const L = LIGHT[v.accent];
  const isLast = idx === ADVANTAGES.length - 1;

  // Glow do shell acompanha o acento do card
  useEffect(() => {
    onAccentChange?.(accent.glow);
  }, [accent.glow, onAccentChange]);

  const next = useCallback(() => {
    setIdx((i) => {
      if (i === ADVANTAGES.length - 1) { onFinish(); return i; }
      return i + 1;
    });
  }, [onFinish]);
  const back = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  // Navegacao por teclado (skill: acessibilidade dos carrosseis)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back]);

  const VIcon = v.icon;

  return (
    <>
      {/* Header: barrinhas + Pular */}
      <div className="flex items-center justify-between px-6 pt-6">
        <div className="flex items-center gap-1.5">
          {ADVANTAGES.map((s, i) => (
            <span
              key={s.id}
              className={
                'h-1.5 rounded-full transition-all duration-300 ' +
                (i === idx ? `w-7 ${L.dot}` : i < idx ? 'w-1.5 bg-zinc-300' : 'w-1.5 bg-zinc-200')
              }
            />
          ))}
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="rounded-lg px-2 py-1 text-xs font-medium text-zinc-400 transition hover:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
        >
          Pular
        </button>
      </div>

      {/* Corpo (anim re-dispara por card via key). flex-1 +
          justify-center: preenche a altura padronizada do card */}
      <div key={v.id} className="anim-card flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-6 pb-2 pt-5">
        <div className="flex items-center gap-3">
          <div className={'flex h-11 w-11 items-center justify-center rounded-2xl ring-1 ' + L.tile}>
            <VIcon className={'h-5 w-5 ' + L.text} />
          </div>
          <span className={'text-xs font-semibold uppercase tracking-wider ' + L.text}>{v.eyebrow}</span>
        </div>

        <h2 className="mt-4 text-2xl font-bold leading-tight text-zinc-900">{v.title}</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-zinc-500">{v.description}</p>

        <div className="mt-5 flex min-h-[148px] items-center rounded-2xl bg-zinc-50 p-4 ring-1 ring-zinc-200">
          <div className="w-full">
            <v.Preview />
          </div>
        </div>
      </div>

      {/* Footer de navegacao */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 pb-6 pt-4">
        <button
          type="button"
          onClick={back}
          disabled={idx === 0}
          className="flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-400 transition enabled:hover:text-zinc-600 disabled:opacity-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
        >
          <ArrowLeft className="h-4 w-4" /> Voltar
        </button>
        <span className="text-xs tabular-nums text-zinc-400">{idx + 1} / {ADVANTAGES.length}</span>
        <button
          type="button"
          onClick={next}
          className={'flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold shadow-lg transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ' + L.btn}
        >
          {isLast ? 'Continuar' : 'Próximo'} <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </>
  );
}
