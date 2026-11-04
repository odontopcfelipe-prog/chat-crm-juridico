'use client';

/**
 * Passos CAD — só a conta de laboratório abre. O visor 3D carrega só nesta tela: as outras
 * telas não baixam o three.js.
 */
import dynamic from 'next/dynamic';
import { isLab } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';
import { TEXTOS } from './textos';

const PassosCadApp = dynamic(() => import('./PassosCadApp'), { ssr: false });

export default function PassosCadPage() {
  const lab = isLab(useBusinessType());
  if (!lab) {
    return <div className="p-8 text-sm text-muted-foreground">{TEXTOS.telaFechada}</div>;
  }
  return <PassosCadApp />;
}
