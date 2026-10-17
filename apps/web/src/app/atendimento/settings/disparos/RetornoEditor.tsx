'use client';

// Retorno de manutenção — editor de UM toque (tipo × antes/no dia/depois): como funciona,
// quem está na janela hoje (e por que alguém não vai receber), o texto e o histórico.
import { useEffect, useState } from 'react';
import { Loader2, Info, Users } from 'lucide-react';
import api from '@/lib/api';
import {
  DEFAULT_RETORNO_TEMPLATES,
  RETORNO_ETAPA_LABEL,
  RETORNO_FAMILIA_LABEL,
  RETORNO_FAMILIA_TEXTO,
  RETORNO_INTERVALO_PACIENTE_DIAS,
  RETORNO_JANELAS,
  RETORNO_TETO_DIA,
  RETORNO_VARIAVEIS,
  parseRetornoDisparoId,
  type RetornoDisparoId,
} from '@crm/shared';
import { MensagemEditor } from './MensagemEditor';
import { DisparoResumo } from './DisparoResumo';

interface Previsto {
  nome: string | null;
  telefone: string | null;
  data_ultima: string;
  data_prevista: string;
  situacao: 'na_fila' | 'agendado' | 'sem_telefone' | 'nao_recebe' | 'recente' | 'ja_recebeu';
}

const SITUACAO: Record<Previsto['situacao'], { label: string; cls: string }> = {
  na_fila: { label: 'vai receber', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  ja_recebeu: { label: 'já recebeu', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-400' },
  agendado: { label: 'tem consulta marcada · suspenso', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  recente: { label: `recebeu aviso há < ${RETORNO_INTERVALO_PACIENTE_DIAS} dias · espera`, cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  sem_telefone: { label: 'sem telefone', cls: 'bg-muted text-muted-foreground' },
  nao_recebe: { label: 'pediu pra não receber / arquivado', cls: 'bg-muted text-muted-foreground' },
};

const br = (iso: string) => iso.split('-').reverse().join('/');

function janelaTexto(id: RetornoDisparoId): string {
  const { etapa } = parseRetornoDisparoId(id);
  const j = RETORNO_JANELAS[etapa];
  if (etapa === 'antes') return `de ${-j.de} dias antes até a véspera da data prevista`;
  if (etapa === 'no_dia') return `da data prevista até ${j.ate} dias depois`;
  return `de ${j.de} a ${j.ate} dias depois da data prevista`;
}

export function RetornoEditor({ id, onCurrentTextChange }: { id: RetornoDisparoId; onCurrentTextChange?: (t: string) => void }) {
  const { familia, etapa } = parseRetornoDisparoId(id);
  const [previstos, setPrevistos] = useState<Previsto[] | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    let vivo = true;
    setPrevistos(null);
    setErro(false);
    api.get<Previsto[]>(`/return-alerts/disparos/${id}/previstos`, { timeout: 20000 })
      .then((r) => { if (vivo) setPrevistos(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (vivo) { setPrevistos([]); setErro(true); } });
    return () => { vivo = false; };
  }, [id]);

  const vaoReceber = previstos?.filter((p) => p.situacao === 'na_fila').length ?? 0;

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-2xl p-5 text-[12px] text-muted-foreground space-y-1.5">
        <div className="flex items-center gap-2 text-foreground font-bold text-sm mb-1">
          <Info size={15} className="text-primary" /> Como funciona
        </div>
        <p>
          <b className="text-foreground">Quem entra:</b> quem está na aba <b>{RETORNO_FAMILIA_LABEL[familia]}</b> do quadro
          Retornos — a data prevista é a mesma de lá (feito por último + os meses do procedimento em Configurações → Retornos).
          Sem o procedimento ligado lá, ninguém entra.
        </p>
        <p>
          <b className="text-foreground">Quando:</b> {RETORNO_ETAPA_LABEL[etapa]} — sai uma vez, {janelaTexto(id)}. Os 3 toques
          (15 dias antes · no dia · 15 dias depois) são independentes: ligue os que quiser. Depois de 45 dias de atraso o paciente
          sai da régua e fica no “RETORNO ATRASADO” do quadro, pra contato manual.
        </p>
        <p>
          <b className="text-foreground">Suspende sozinho:</b> se o paciente tiver consulta marcada (os avisos do agendamento
          assumem), se pediu pra não receber, ou se recebeu outro aviso de retorno/recall nos últimos {RETORNO_INTERVALO_PACIENTE_DIAS} dias.
          Fez o procedimento de novo → nova data → recomeça.
        </p>
        <p>
          <b className="text-foreground">Anti-bloqueio:</b> só pelo chip da Clínica, seg–sáb 9h–18h, fora de feriado, 1 mensagem a
          cada 3–7 min no chip (o mesmo ritmo dos outros disparos automáticos), no máximo {RETORNO_TETO_DIA} por dia.
        </p>
      </div>

      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        <div className="border-b border-border px-5 py-3 flex items-center gap-2">
          <Users size={15} className="text-primary" />
          <h3 className="text-sm font-bold">Na janela deste toque hoje</h3>
          {previstos && <span className="text-[11px] text-muted-foreground ml-auto">{vaoReceber} vão receber · {previstos.length} na janela</span>}
        </div>
        {previstos === null ? (
          <div className="py-6 flex items-center justify-center text-muted-foreground"><Loader2 size={16} className="animate-spin" /></div>
        ) : erro ? (
          <div className="px-5 py-4 text-[12px] text-muted-foreground">Não foi possível carregar a lista agora.</div>
        ) : previstos.length === 0 ? (
          <div className="px-5 py-4 text-[12px] text-muted-foreground">Ninguém na janela deste toque hoje.</div>
        ) : (
          <div className="max-h-72 overflow-y-auto divide-y divide-border">
            {previstos.map((p, i) => (
              <div key={i} className="px-5 py-2 flex items-center gap-3 text-[12px]">
                <span className="font-semibold truncate min-w-0 flex-1">{p.nome || '(sem nome)'}</span>
                <span className="text-muted-foreground tabular-nums hidden sm:inline">feito {br(p.data_ultima)}</span>
                <span className="text-muted-foreground tabular-nums">prevista {br(p.data_prevista)}</span>
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${SITUACAO[p.situacao].cls}`}>
                  {SITUACAO[p.situacao].label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <MensagemEditor
        titulo={`${RETORNO_FAMILIA_LABEL[familia]} · ${RETORNO_ETAPA_LABEL[etapa]}`}
        descricao="Sai pelo chip da Clínica. Informe há quanto tempo foi feito, explique por que cuidar agora e termine num convite simples — a resposta do paciente cai na conversa da Clínica. Edite e Salve; deixe em branco pra voltar ao padrão."
        endpoint={`/return-alerts/disparos/${id}/template`}
        variaveis={RETORNO_VARIAVEIS}
        preview={{
          nome: 'Felipe',
          tempo: '6 meses',
          data_ultima: '13/07/2026',
          data_prevista: '13/01/2027',
          procedimento: RETORNO_FAMILIA_TEXTO[familia],
          clinica: 'sua clínica',
        }}
        defaultText={DEFAULT_RETORNO_TEMPLATES[id]}
        onCurrentTextChange={onCurrentTextChange}
      />

      <DisparoResumo disparoId={id} />
    </div>
  );
}
