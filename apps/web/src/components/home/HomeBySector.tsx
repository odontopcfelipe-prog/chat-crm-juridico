'use client';

/**
 * Home por papel.
 *
 * Out/2026 — a grade de "MÓDULOS" deu lugar ao painel que nasceu pro dentista
 * (PainelSetor): topo com logo + busca, boas-vindas, relógio com a fila
 * "Próximos", cards ilustrados, resumo do dia, próximos dias e tarefas — pedido
 * do dono: "deixe todas as entradas de usuário com esse padrão, cada um na sua
 * realidade". Os cards continuam 100% dirigidos por papel (resolveHomeActions +
 * badges do setor).
 *
 * O admin ganha o "Visualizando a home como" pra comparar os setores (aqui com
 * os números da clínica — no dentista, os do próprio admin).
 */
import { useEffect, useState } from 'react';
import { SECTORS, type Sector, type Permission } from '@crm/shared';
import { PainelSetor } from './DentistHome';

interface Props {
  sector: Sector;
  /** Nome do usuário (saudação e conta). */
  userName?: string;
  /** @deprecated mantido por compat — nao e mais renderizado */
  skySlot?: React.ReactNode;
  allowSwitch?: boolean;
  /** Permissões individuais do usuário — refletem nos cards (Onda 17.52) */
  extraGrants?: Permission[];
  extraRevokes?: Permission[];
}

export default function HomeBySector({ sector, userName, allowSwitch = false, extraGrants = [], extraRevokes = [] }: Props) {
  const [previewSector, setPreviewSector] = useState<Sector>(sector);
  useEffect(() => { setPreviewSector(sector); }, [sector]);

  const active = previewSector;
  const proprio = active === sector;

  const switcher = allowSwitch ? (
    <div className="dh-switch">
      <span className="dh-switch-label">Visualizando a home como:</span>
      <div className="dh-switch-tabs">
        {SECTORS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`dh-switch-tab ${active === s.id ? 'is-active' : ''}`}
            onClick={() => setPreviewSector(s.id as Sector)}
          >
            {s.name.replace(' (Atendimento)', '')}
          </button>
        ))}
      </div>
      <span className="dh-switch-hint">
        {proprio
          ? 'Cada setor vê só o que tem permissão. Troque para comparar.'
          : active === 'dentista'
            ? 'Prévia do dentista — com os seus números; cada dentista vê os dele.'
            : 'Prévia — os cards são os do setor; a agenda é a da clínica.'}
      </span>
    </div>
  ) : null;

  return (
    <PainelSetor
      // Trocar de setor remonta o painel (cada setor busca os dados dele).
      key={active}
      sector={active}
      userName={userName}
      // Ajustes individuais só valem no setor REAL; na prévia, o padrão do setor.
      extraGrants={proprio ? extraGrants : []}
      extraRevokes={proprio ? extraRevokes : []}
      acima={switcher}
    />
  );
}
