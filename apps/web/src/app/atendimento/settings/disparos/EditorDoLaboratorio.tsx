'use client';

// F7 do laboratório — editor de cada card da Central de Disparos na conta de
// laboratório. Reaproveita os editores da Central (MensagemEditor, AniversarioEditor,
// ResumoDiarioEditor, VendaFeitaEditor) com os textos do laboratório, e o
// LabLembreteEditor para os lembretes de 48 h e 24 h. Chama só os endpoints que a
// Central do laboratório tem liberados (configuração de confirmação, remarcação,
// lembretes, resumo do dia, aniversário e os textos de cobrança editáveis). O
// "Enviar agora" do resumo não existe aqui: o teste é o TesteEnvio da página.
// Só a conta de laboratório monta este editor.
import { LAB_AGENDA_TEXTOS, padraoFinDoLaboratorio } from '@crm/shared';
import type { DisparoItem } from './disparos.config';
import { MensagemEditor } from './MensagemEditor';
import { AniversarioEditor } from './AniversarioEditor';
import { ResumoDiarioEditor } from './ResumoDiarioEditor';
import { VendaFeitaEditor } from './VendaFeitaEditor';
import { LabLembreteEditor } from './LabLembreteEditor';
import { LAB_CENTRAL, LAB_EDITORES } from './lab-disparos-textos';

type TextosDoEditor = (typeof LAB_EDITORES)[keyof typeof LAB_EDITORES];

/** Variáveis do editor no formato do MensagemEditor ({key, desc}). */
function variaveis(t: TextosDoEditor): { key: string; desc: string }[] {
  return Object.entries(t.variaveis).map(([key, desc]) => ({ key, desc }));
}

/** Props comuns do MensagemEditor a partir dos textos do laboratório. */
function doTexto(t: TextosDoEditor) {
  return {
    titulo: t.titulo,
    descricao: t.descricao,
    variaveis: variaveis(t),
    preview: { ...t.preview } as Record<string, string>,
    previewLabel: t.previewLabel,
  };
}

/** Selo dos cards da régua de cobrança no laboratório (o liga/desliga fica travado). */
export function SeloDaReguaDoLaboratorio() {
  return (
    <span
      className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400"
      title={LAB_CENTRAL.reguaTitulo}
    >
      {LAB_CENTRAL.reguaBadge}
    </span>
  );
}

export function EditorDoLaboratorio({ item, onCurrentTextChange }: { item: DisparoItem; onCurrentTextChange: (t: string) => void }) {
  switch (item.id) {
    case 'confirmacao':
      return (
        <MensagemEditor
          key={item.id}
          {...doTexto(LAB_EDITORES.confirmacao)}
          endpoint="/calendar/appointment-confirmation/config"
          usaLocal
          enderecoExemplo={LAB_EDITORES.confirmacao.enderecoExemplo}
          onCurrentTextChange={onCurrentTextChange}
          defaultText={LAB_AGENDA_TEXTOS.confirmacao24h}
        />
      );
    case 'reagendamento':
      return (
        <MensagemEditor
          key={item.id}
          {...doTexto(LAB_EDITORES.remarcacao)}
          endpoint="/calendar/appointment-rescheduled/config"
          usaLocal
          enderecoExemplo={LAB_EDITORES.remarcacao.enderecoExemplo}
          onCurrentTextChange={onCurrentTextChange}
          defaultText={LAB_AGENDA_TEXTOS.remarcacao}
        />
      );
    case 'confirmacao_48h':
    case 'lembrete_1dia':
      return item.antecedenciaMin != null ? (
        <LabLembreteEditor key={item.id} minutos={item.antecedenciaMin} onCurrentTextChange={onCurrentTextChange} />
      ) : null;
    case 'negociacao_aprovada':
    case 'negociacao_aprovada_avista':
    case 'confirmacao_pagamento': {
      const textos =
        item.id === 'negociacao_aprovada'
          ? LAB_EDITORES.negociacao
          : item.id === 'negociacao_aprovada_avista'
            ? LAB_EDITORES.negociacaoAvista
            : LAB_EDITORES.confirmacaoPagamento;
      return (
        <MensagemEditor
          key={item.id}
          {...doTexto(textos)}
          endpoint={`/followup/cobranca-template/${item.id}`}
          onCurrentTextChange={onCurrentTextChange}
          defaultText={padraoFinDoLaboratorio(item.id) ?? undefined}
        />
      );
    }
    case 'resumo_dentista':
      return (
        <MensagemEditor
          key={item.id}
          {...doTexto(LAB_EDITORES.resumoProtetico)}
          endpoint="/calendar/dentist-daily-summary/config"
          maxLen={2000}
          onCurrentTextChange={onCurrentTextChange}
          defaultText={LAB_AGENDA_TEXTOS.resumoProtetico}
        />
      );
    case 'aniversario_classica':
      return <AniversarioEditor key={item.id} which={1} onCurrentTextChange={onCurrentTextChange} />;
    case 'resumo_diario':
      return <ResumoDiarioEditor key={item.id} />;
    case 'venda_feita':
      return <VendaFeitaEditor key={item.id} />;
    default:
      // Card sem editor no laboratório (régua de cobrança, bloqueio, aviso aos ADMs).
      return null;
  }
}
