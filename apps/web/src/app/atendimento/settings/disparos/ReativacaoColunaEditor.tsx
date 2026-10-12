'use client';

// Editor de um card de COLUNA da régua de reativação de leads (follow-up do chip
// Comercial): uma aba por toque ("1º toque (D0)", "2º toque (D+3)"…), cada uma com o
// MensagemEditor apontando pra /reactivation/template/<coluna>/<toque>.
// O texto é um MODELO: a IA reescreve pra cada contato com o histórico da conversa
// (nunca sai igual pra todos), mantendo o objetivo do toque — por isso o preview diz
// "Modelo — a IA adapta…" e não "como o paciente vai receber".
import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import api from '@/lib/api';
import { MensagemEditor } from './MensagemEditor';
import {
  REATIVACAO_COLUNA_LABEL, REATIVACAO_GANCHO_GENERICO, REATIVACAO_MIN_DIAS_PARADO, REATIVACAO_OFFSETS,
  REATIVACAO_TEXTO_MAX, defaultReativacaoModelo, reativacaoToqueLabel, type ReativacaoColuna,
} from '@/lib/reativacao';

interface Props {
  coluna: ReativacaoColuna;
  /** Nome do card (título). */
  nome: string;
  /** Chave geral do ENVIO ligada? (muda o aviso do topo) */
  envioOn: boolean;
  /** Esta coluna ligada? */
  colunaOn: boolean;
}

/** Quem entra na régua desta coluna (explicação do topo do editor). */
function quemEntra(coluna: ReativacaoColuna): string {
  if (coluna === 'agendado') {
    return 'Entra quem FALTOU na avaliação (marcada como "faltou" na agenda) e não remarcou — a partir do dia seguinte à falta.';
  }
  const n = REATIVACAO_MIN_DIAS_PARADO[coluna];
  return `Entra quem está nesta coluna do "Geral — Leads" com a conversa parada há ${n}+ dia${n === 1 ? '' : 's'}: a clínica falou por último e o contato não respondeu. (Se quem falou por último foi o contato, é a clínica que deve responder — não entra.)`;
}

export function ReativacaoColunaEditor({ coluna, nome, envioOn, colunaOn }: Props) {
  const offsets = REATIVACAO_OFFSETS[coluna] || [0];
  const [toque, setToque] = useState(1);
  // Nome REAL da clínica no preview (nunca o de outra clínica); exemplo genérico até carregar.
  const [clinica, setClinica] = useState('sua clínica');

  useEffect(() => {
    let cancelled = false;
    api.get('/tenants/me', { timeout: 10000 })
      .then((r) => { if (!cancelled && r.data?.name) setClinica(String(r.data.name)); })
      .catch(() => { /* preview fica com o genérico */ });
    return () => { cancelled = true; };
  }, []);

  const variaveis = [
    { key: 'nome', desc: 'Primeiro nome do contato' },
    { key: 'clinica', desc: 'Nome da clínica' },
    // Mesmo formato do worker (dentistaDoModelo): o modelo já traz o artigo ("com a {dentista}").
    { key: 'dentista', desc: '"Dra. <nome>" da avaliadora do contato (sem avaliadora definida: "doutora"; avaliador homem: "equipe de avaliação")' },
    { key: 'interesse', desc: 'Funil do contato em minúsculas (ex.: implantes) — ou "seu atendimento"' },
    { key: 'assunto', desc: 'O que o contato conversou — a IA tira do histórico' },
    { key: 'gancho', desc: 'Frase de valor do funil do contato (implante, limpeza, ortodontia…)' },
    { key: 'horario1', desc: '1º horário LIVRE de verdade na agenda (ex.: quinta 16/10 às 14:00)' },
    { key: 'horario2', desc: '2º horário livre, em outro dia' },
    { key: 'valor_avaliacao', desc: 'Valor da AVALIAÇÃO na tabela de valores da clínica (Ajustes › IA) — sem ele, a frase sai do texto' },
    { key: 'valor_limpeza', desc: 'Valor da LIMPEZA na tabela de valores da clínica — sem ele, a frase sai do texto' },
    ...(coluna === 'agendado'
      ? [
          { key: 'data', desc: 'Data da avaliação em que faltou (DD/MM)' },
          { key: 'hora', desc: 'Hora da avaliação em que faltou' },
        ]
      : []),
  ];

  const preview: Record<string, string> = {
    nome: 'Felipe',
    clinica,
    dentista: 'Dra. Ana',
    interesse: 'implantes',
    assunto: 'o implante do dente da frente',
    gancho: REATIVACAO_GANCHO_GENERICO,
    horario1: 'quinta 16/10 às 14:00',
    horario2: 'sexta 17/10 às 9:00',
    valor_avaliacao: 'R$ 150',
    valor_limpeza: 'R$ 350',
    data: '10/10',
    hora: '14:00',
  };

  const off = offsets[toque - 1] ?? 0;
  const quando = off === 0
    ? 'no dia em que o contato entra na régua'
    : `${off} dias depois do 1º toque (se ele não respondeu)`;

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-foreground">{nome}</h2>
        <p className="text-sm text-muted-foreground mt-1">{quemEntra(coluna)}</p>
      </div>

      {/* Coluna ligada com o Envio desligado = só prévia. Deixa isso explícito. */}
      <div
        className={`flex items-start gap-2 p-3 rounded-xl border text-[12px] ${
          envioOn
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
        }`}
      >
        <Info size={14} className="shrink-0 mt-0.5" />
        <span>
          {!colunaOn
            ? <>Coluna <b>desligada</b> — ninguém de “{REATIVACAO_COLUNA_LABEL[coluna]}” entra na régua. Ligue no botão do card.</>
            : envioOn
              ? <>Coluna ligada e <b>Envio ligado</b>: os toques desta coluna saem de verdade pelo chip Comercial.</>
              : <>Coluna ligada, mas o <b>Envio está desligado</b>: os contatos só aparecem nos <b>Previstos</b> (CRC › Disparos) — nada é enviado.</>}
        </span>
      </div>

      {/* Abas por toque — cada toque tem o seu texto. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-semibold text-muted-foreground mr-1">Toque:</span>
        {offsets.map((_, i) => {
          const t = i + 1;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setToque(t)}
              className={`px-3 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
                toque === t
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:text-foreground'
              }`}
            >
              {reativacaoToqueLabel(coluna, t)}
            </button>
          );
        })}
      </div>

      <MensagemEditor
        key={`${coluna}-${toque}`}
        titulo={`${REATIVACAO_COLUNA_LABEL[coluna]} — ${reativacaoToqueLabel(coluna, toque)}`}
        descricao={
          `Toque ${toque} de ${offsets.length} — sai ${quando}. É um MODELO: a IA reescreve pra cada contato com o histórico da conversa, mantendo o objetivo e a estrutura (nunca sai igual pra todos). ` +
          'Separe os balões com uma LINHA EM BRANCO. Trecho entre [colchetes] é instrução pra IA escrever (ex.: a resposta à dúvida que ficou em aberto) — os colchetes nunca saem. ' +
          'Preço: use {valor_avaliacao}/{valor_limpeza} — vêm da tabela de valores da clínica (Ajustes › IA › Valores); sem o valor lá, a frase sai do texto. Valor (R$) escrito à mão só sai se estiver na tabela. Nunca inventa horário: {horario1}/{horario2} viram horários livres reais da agenda. ' +
          `Máximo ${REATIVACAO_TEXTO_MAX} caracteres. Edite e Salve; deixe em branco pra voltar ao padrão.`
        }
        endpoint={`/reactivation/template/${coluna}/${toque}`}
        variaveis={variaveis}
        preview={preview}
        // Mesmo teto da API e do worker: modelo maior era aceito aqui e o toque
        // morria calado no worker ("sem texto válido").
        maxLen={REATIVACAO_TEXTO_MAX}
        defaultText={defaultReativacaoModelo(coluna, toque)}
        previewLabel="Modelo — a IA adapta ao histórico de cada contato"
      />
    </div>
  );
}
