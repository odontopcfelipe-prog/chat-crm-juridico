'use client';

/**
 * F4 do laboratório — Início da conta de LABORATÓRIO.
 *
 * Fica separado do painel da clínica (PainelSetor / HomeBySector), que não muda.
 * Aqui só entram os atalhos das telas que estão na lista de rotas do laboratório
 * (canAccessRouteBt com BT_LABORATORIO), com os textos do laboratório
 * (lab-casca-textos e LAB_SECTOR_TEXT), mais o nome da pessoa e o da conta.
 *
 * Rede: só /users/me (permissões), /tenants/me (nome, logo e cor da conta) e
 * /ponto/status (equipe do ponto). Nada de agenda, contadores de módulo ou
 * procedimentos: essas telas ainda não fazem parte do laboratório.
 *
 * O admin troca o setor visto ("Ver como"): os atalhos passam a ser os do setor
 * escolhido, sem os ajustes individuais e sem os do ponto (que são da pessoa).
 */
import { useEffect, useMemo, useState, type ComponentType, type CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowRight, Clock, LayoutGrid, MessageSquare, Settings, Wallet, type LucideIcon } from 'lucide-react';
import {
  BT_LABORATORIO,
  LAB_SECTOR_TEXT,
  PONTO_ADM_BALAO,
  PONTO_BALAO,
  SECTORS,
  canAccessRouteBt,
  resolveHomeActions,
  type HomeAction,
  type Permission,
  type Sector,
} from '@crm/shared';
import { useTenant } from '@/lib/useTenant';
import { tenantAccent } from '@/lib/tenant-accent';
import { usePontoStatus } from '@/lib/usePontoStatus';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { LAB_BALOES, LAB_INICIO } from '@/lib/lab-casca-textos';
import { AccountMenu } from '@/app/atendimento/components/AccountMenu';
import { ChatArt, ClockArt, GearArt, MoneyArt } from './dentist-illustrations';
import './dentist-home.css';

interface Props {
  /** Setor real da pessoa. */
  sector: Sector;
  userName: string | null;
  /** Ajustes individuais de permissão (valem só no setor real). */
  extraGrants: Permission[];
  extraRevokes: Permission[];
  /** Admin: pode trocar o setor visto. */
  allowSwitch: boolean;
}

type ChaveBalao = keyof typeof LAB_BALOES;

/** Tela liberada para o laboratório → texto do atalho. Atalho sem texto aqui não aparece. */
const BALAO_DA_ROTA: Readonly<Record<string, ChaveBalao>> = Object.freeze({
  '/atendimento': 'whatsapp',
  '/atendimento/caixa': 'caixa',
  '/atendimento/settings': 'configuracoes',
  '/atendimento/ponto': 'ponto',
  '/atendimento/ponto/equipe': 'pontoEquipe',
});

/** Ícone pelo nome do lucide do balão (HomeAction.lucide). */
const ICONES: Readonly<Record<string, LucideIcon>> = Object.freeze({ MessageSquare, Wallet, Settings, Clock });

/** Ilustração de cada atalho (as mesmas do painel, sem as de clínica). */
const ARTE: Readonly<Record<ChaveBalao, ComponentType>> = Object.freeze({
  whatsapp: ChatArt,
  caixa: MoneyArt,
  configuracoes: GearArt,
  ponto: ClockArt,
  pontoEquipe: ClockArt,
});

function saudacao(hora: number): string {
  if (hora >= 5 && hora < 12) return LAB_INICIO.bomDia;
  if (hora >= 12 && hora < 18) return LAB_INICIO.boaTarde;
  return LAB_INICIO.boaNoite;
}

interface Atalho {
  href: string;
  chave: ChaveBalao;
  lucide?: string;
}

export default function LabInicio({ sector, userName, extraGrants, extraRevokes, allowSwitch }: Props) {
  const tenant = useTenant();
  const ponto = usePontoStatus();
  const { hasPermission } = useUserPermissions();

  const [visto, setVisto] = useState<Sector>(sector);
  useEffect(() => { setVisto(sector); }, [sector]);
  const proprio = visto === sector;

  // Só renderiza no navegador (a página espera montar), então a hora já vale aqui.
  const [hora, setHora] = useState(() => new Date().getHours());
  useEffect(() => {
    const t = setInterval(() => setHora(new Date().getHours()), 60_000);
    return () => clearInterval(t);
  }, []);

  const baloes: HomeAction[] = [
    ...resolveHomeActions(visto, proprio ? extraGrants : [], proprio ? extraRevokes : []),
    ...(proprio && ponto.member ? [PONTO_BALAO] : []),
    ...(proprio && hasPermission('manage_users') ? [PONTO_ADM_BALAO] : []),
  ];
  const hrefsVistos = new Set<string>();
  const atalhos: Atalho[] = [];
  for (const a of baloes) {
    if (hrefsVistos.has(a.href)) continue;
    hrefsVistos.add(a.href);
    if (!canAccessRouteBt(a.href, hasPermission, BT_LABORATORIO)) continue;
    const chave = BALAO_DA_ROTA[a.href];
    if (chave) atalhos.push({ href: a.href, chave, lucide: a.lucide });
  }

  const nome = (userName || '').trim().replace(/\s+/g, ' ');
  const accent = useMemo(() => tenantAccent(tenant?.theme_color), [tenant?.theme_color]);
  const colunas = Math.min(Math.max(atalhos.length, 3), 6);

  return (
    <div className="h-full overflow-y-auto">
      <div className="dh" style={{ '--dh-accent': accent } as CSSProperties} data-sector={visto}>
        {allowSwitch && (
          <div className="dh-switch">
            <span className="dh-switch-label">{LAB_INICIO.verComo}</span>
            <div className="dh-switch-tabs" role="group" aria-label={LAB_INICIO.verComo}>
              {SECTORS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={visto === s.id}
                  className={`dh-switch-tab ${visto === s.id ? 'is-active' : ''}`}
                  onClick={() => setVisto(s.id)}
                >
                  {LAB_SECTOR_TEXT[s.id].name}
                </button>
              ))}
            </div>
          </div>
        )}

        <header className="dh-top">
          <Link href="/atendimento/dashboard" className="dh-brand" title={tenant?.name || undefined}>
            {tenant?.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tenant.logo_url} alt={tenant.name || ''} className="dh-brand-logo" />
            ) : (
              <span className="dh-brand-mark">{(tenant?.name || '').charAt(0)}</span>
            )}
            {tenant?.name && <span className="dh-brand-name">{tenant.name}</span>}
          </Link>
          <div className="dh-top-right" style={{ marginLeft: 'auto' }}>
            <AccountMenu name={userName} subtitle={LAB_SECTOR_TEXT[sector].persona} />
          </div>
        </header>

        <section className="dh-hero" data-cor="preto">
          <span className="dh-hero-glow" aria-hidden />
          <svg className="dh-hero-rings" viewBox="0 0 600 600" aria-hidden="true">
            <circle cx="300" cy="300" r="290" />
            <circle cx="300" cy="300" r="220" />
            <circle cx="300" cy="300" r="150" />
          </svg>
          <div className="dh-hero-text">
            {nome ? (
              <>
                <p className="dh-hero-hello">{saudacao(hora)},</p>
                <h1 className={`dh-hero-name ${nome.length > 20 ? 'is-long' : ''}`}>{nome}!</h1>
              </>
            ) : (
              <h1 className="dh-hero-name">{saudacao(hora)}!</h1>
            )}
            <span className="dh-hero-bar" aria-hidden />
            <p className="dh-hero-lead">{LAB_INICIO.subtitulo}</p>
            {tenant?.name && (
              <div className="dh-hero-sign">
                <p className="dh-hero-clinic">{tenant.name}</p>
              </div>
            )}
          </div>
        </section>

        {atalhos.length > 0 ? (
          <div className="dh-cards" style={{ '--dh-cols': colunas } as CSSProperties}>
            {atalhos.map(({ href, chave, lucide }) => {
              const Icone = (lucide && ICONES[lucide]) || LayoutGrid;
              const Arte = ARTE[chave];
              const texto = LAB_BALOES[chave];
              return (
                <Link key={href} href={href} className="dh-card">
                  <span className="dh-card-halo" aria-hidden />
                  <div className="dh-card-head">
                    <span className="dh-card-ico"><Icone size={20} strokeWidth={2} /></span>
                  </div>
                  <h3>{texto.label}</h3>
                  <p>{texto.desc}</p>
                  <span className="dh-card-go" aria-hidden><ArrowRight size={18} /></span>
                  <div className="dh-card-art"><Arte /></div>
                </Link>
              );
            })}
          </div>
        ) : (
          <section className="dh-panel">
            <p className="dh-empty">{LAB_INICIO.vazio}</p>
          </section>
        )}
      </div>
    </div>
  );
}
