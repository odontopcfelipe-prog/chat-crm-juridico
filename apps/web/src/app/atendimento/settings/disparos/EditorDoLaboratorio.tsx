'use client';

// F7 do laboratório — editor de cada card da Central de Disparos na conta de
// laboratório. Reaproveita os editores da Central (MensagemEditor, AniversarioEditor,
// ResumoDiarioEditor, VendaFeitaEditor) com os textos do laboratório, e o
// LabLembreteEditor para os lembretes de 48 h e 24 h. Chama só os endpoints que a
// Central do laboratório tem liberados (configuração de confirmação, remarcação,
// lembretes, resumo do dia, aniversário e os textos de cobrança editáveis). O
// "Enviar agora" do resumo não existe aqui: o teste é o TesteEnvio da página.
// Só a conta de laboratório monta este editor.
import { useState } from 'react';
import { COBRANCA_TIPOS, COBRANCA_TIPO_LABEL, LAB_AGENDA_TEXTOS, isCobrancaStage, padraoFinDoLaboratorio, type CobrancaTipo } from '@crm/shared';
import type { DisparoItem } from './disparos.config';
import { MensagemEditor } from './MensagemEditor';
import { AniversarioEditor } from './AniversarioEditor';
import { ResumoDiarioEditor } from './ResumoDiarioEditor';
import { VendaFeitaEditor } from './VendaFeitaEditor';
import { LabLembreteEditor } from './LabLembreteEditor';
import { LAB_EDITORES } from './lab-disparos-textos';

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

/** Marco da régua de cobrança: um texto por tipo de pagamento (as mesmas abas da clínica). */
function EditorDoMarco({ item, onCurrentTextChange }: { item: DisparoItem; onCurrentTextChange: (t: string) => void }) {
  const [tipo, setTipo] = useState<CobrancaTipo>('parcelado');
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-semibold text-muted-foreground mr-1">{LAB_EDITORES.regua.tipoDePagamento}</span>
        {COBRANCA_TIPOS.map((tp) => (
          <button
            key={tp}
            type="button"
            onClick={() => setTipo(tp)}
            className={`px-3 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
              tipo === tp
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            {COBRANCA_TIPO_LABEL[tp]}
          </button>
        ))}
      </div>
      <MensagemEditor
        key={`${item.id}-${tipo}`}
        {...doTexto(LAB_EDITORES.regua)}
        titulo={`${item.nome} — ${COBRANCA_TIPO_LABEL[tipo]}`}
        endpoint={`/followup/cobranca-template/${item.id}?tipo=${tipo}`}
        onCurrentTextChange={onCurrentTextChange}
        defaultText={padraoFinDoLaboratorio(item.id, tipo) ?? undefined}
        simulateBoleto
      />
    </div>
  );
}

export function EditorDoLaboratorio({ item, onCurrentTextChange }: { item: DisparoItem; onCurrentTextChange: (t: string) => void }) {
  if (isCobrancaStage(item.id)) {
    return <EditorDoMarco key={item.id} item={item} onCurrentTextChange={onCurrentTextChange} />;
  }
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
    case 'confirmacao_pagamento':
    case 'boleto_intro':
    case 'boleto_delivery': {
      const textos =
        item.id === 'negociacao_aprovada'
          ? LAB_EDITORES.negociacao
          : item.id === 'negociacao_aprovada_avista'
            ? LAB_EDITORES.negociacaoAvista
            : item.id === 'boleto_intro'
              ? LAB_EDITORES.apresentacao
              : item.id === 'boleto_delivery'
                ? LAB_EDITORES.entregaDosBoletos
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
      // Card sem editor no laboratório (bloqueio, aviso aos ADMs).
      return null;
  }
}
