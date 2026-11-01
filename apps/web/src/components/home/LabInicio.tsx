'use client';

/**
 * F4 do laboratório — Início da conta de LABORATÓRIO.
 *
 * Fica separado do painel da clínica (PainelSetor / HomeBySector), que não muda.
 * Aqui só entram os atalhos das telas que estão na lista de rotas do laboratório
 * (canAccessRouteBt com BT_LABORATORIO), com os textos do laboratório
 * (lab-casca-textos e LAB_SECTOR_TEXT), mais o nome da pessoa e o da conta.
 *
 * Rede: /users/me (permissões), /tenants/me (nome, logo e cor da conta),
 * /ponto/status (equipe do ponto) e, para quem abre a agenda, UMA leitura de
 * /calendar/events (a mesma listagem da agenda) para o quadro das próximas coletas,
 * provas e entregas. Nada de contadores de módulo, jogo ou procedimentos.
 *
 * F7 — atalho da Agenda pelos balões do setor, atalho da Central de Disparos para
 * quem abre a Central e o quadro das próximas visitas (7 dias, só os tipos do
 * laboratório). O quadro some se a leitura falhar.
 *
 * O admin troca o setor visto ("Ver como"): os atalhos passam a ser os do setor
 * escolhido, sem os ajustes individuais e sem os do ponto (que são da pessoa).
 */
import { useEffect, useMemo, useState, type ComponentType, type CSSProperties } from 'react';
import Link from 'next/link';
import {
  ArrowRight, Calendar, Clock, FileText, Layers, LayoutGrid, MessageSquare, Receipt, ReceiptText, Send, Settings, UserCog, Users,
  Wallet, Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  BT_LABORATORIO,
  LAB_SECTOR_TEXT,
  PONTO_ADM_BALAO,
  PONTO_BALAO,
  SECTORS,
  canAccessRouteBt,
  dataCurtaNaive,
  horaCurtaNaive,
  isLab,
  resolveHomeActions,
  rotuloTipoDoLaboratorio,
  tipoSoDoLaboratorio,
  type HomeAction,
  type Permission,
  type Sector,
} from '@crm/shared';
import api from '@/lib/api';
import { btAgora } from '@/lib/useBusinessType';
import { useTenant } from '@/lib/useTenant';
import { tenantAccent } from '@/lib/tenant-accent';
import { usePontoStatus } from '@/lib/usePontoStatus';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { LAB_BALOES, LAB_INICIO, LAB_PROXIMAS } from '@/lib/lab-casca-textos';
import { AccountMenu } from '@/app/atendimento/components/AccountMenu';
import { BoletoArt, CalendarArt, ChatArt, ClockArt, DocArt, GearArt, MoneyArt, PatientCardsArt } from './dentist-illustrations';
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

/**
 * Tela do laboratório → texto do atalho. Atalho sem texto aqui não aparece.
 * Ter a rota aqui não abre nada: o atalho só aparece quando a rota está na lista
 * de rotas do laboratório (filtro canAccessRouteBt abaixo).
 */
const BALAO_DA_ROTA: Readonly<Record<string, ChaveBalao>> = Object.freeze({
  '/atendimento': 'whatsapp',
  '/atendimento/caixa': 'caixa',
  '/atendimento/settings': 'configuracoes',
  '/atendimento/ponto': 'ponto',
  '/atendimento/ponto/equipe': 'pontoEquipe',
  '/atendimento/pacientes': 'dentistas',
  '/atendimento/venda-rapida': 'vendaRapida',
  '/atendimento/financeiro/contas-a-pagar': 'financeiro',
  '/atendimento/financeiro/boletos': 'cobrancas',
  '/atendimento/settings/users': 'equipe',
  '/atendimento/orcamentos': 'orcamentos',
  '/atendimento/orcamentos?status=SENT': 'propostas',
  '/atendimento/agenda': 'agenda',
});

/** Agenda e Central de Disparos (F7). */
const AGENDA = '/atendimento/agenda';
const CENTRAL = '/atendimento/settings/disparos';

/**
 * Atalho que pede uma permissão a mais que a da rota. O painel de orçamentos abre
 * pela rota com manage_proposals ou view_proposals, mas a lista (GET /quotes) pede
 * manage_proposals: sem ela o atalho não aparece (como o item do menu).
 */
const PERMISSAO_DO_ATALHO: Readonly<Partial<Record<ChaveBalao, Permission>>> = Object.freeze({
  orcamentos: 'manage_proposals',
  propostas: 'manage_proposals',
});

/** Ícone pelo nome do lucide do balão (HomeAction.lucide). */
const ICONES: Readonly<Record<string, LucideIcon>> = Object.freeze({
  MessageSquare, Wallet, Settings, Clock, Users, Zap, Receipt, ReceiptText, UserCog, FileText, Layers, Calendar, Send,
});

/**
 * Ícone fixo pela chave do atalho (vale mais que o do balão). O da lista de
 * dentistas é sempre Users: no setor Comercial o balão que leva à lista é o dos
 * aniversariantes (Cake).
 */
const ICONE_DA_CHAVE: Readonly<Partial<Record<ChaveBalao, LucideIcon>>> = Object.freeze({ dentistas: Users });

/** Ilustração de cada atalho (as mesmas do painel, sem as de clínica). */
const ARTE: Readonly<Record<ChaveBalao, ComponentType>> = Object.freeze({
  whatsapp: ChatArt,
  caixa: MoneyArt,
  configuracoes: GearArt,
  ponto: ClockArt,
  pontoEquipe: ClockArt,
  dentistas: PatientCardsArt,
  vendaRapida: MoneyArt,
  financeiro: MoneyArt,
  cobrancas: BoletoArt,
  equipe: PatientCardsArt,
  orcamentos: DocArt,
  propostas: DocArt,
  agenda: CalendarArt,
  avisos: GearArt,
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

/** O que o quadro das próximas visitas lê de cada evento (GET /calendar/events). */
interface EventoDaAgenda {
  id: string;
  type: string;
  status?: string | null;
  start_at: string;
  patient?: { name?: string | null } | null;
  lead?: { name?: string | null } | null;
}

/** Agenda naive-UTC: a hora de Maceió fica gravada como UTC (agora = Date.now() − 3 h). */
const TRES_HORAS_MS = 3 * 60 * 60 * 1000;
const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
const MAXIMO_DE_PROXIMAS = 5;
/** Desmarcado, não realizado e feito saem do quadro (só o que ainda vai acontecer). */
const FORA_DAS_PROXIMAS = new Set(['CANCELADO', 'NO_SHOW', 'CONCLUIDO']);

function proximasDaLista(lista: unknown): EventoDaAgenda[] {
  if (!Array.isArray(lista)) return [];
  return (lista as EventoDaAgenda[])
    .filter((e) => e && tipoSoDoLaboratorio(e.type) && !FORA_DAS_PROXIMAS.has(e.status ?? ''))
    .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)))
    .slice(0, MAXIMO_DE_PROXIMAS);
}

/** A agenda abre o evento guardado aqui (o mesmo caminho da busca do topo). */
function abrirNaAgenda(id: string): void {
  try {
    sessionStorage.setItem('open_event_id', id);
  } catch {
    // sem sessionStorage a agenda abre sem o evento
  }
}

export default function LabInicio({ sector, userName, extraGrants, extraRevokes, allowSwitch }: Props) {
  const tenant = useTenant();
  const ponto = usePontoStatus();
  const { hasPermission, ready: permissoesProntas } = useUserPermissions();

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
    // A lista do protético (/minha-agenda) é fechada no laboratório: o balão leva à agenda,
    // que o servidor já filtra pelos eventos dele. O link com ?validar=1 não muda.
    const href = a.href === '/atendimento/minha-agenda' ? AGENDA : a.href;
    if (hrefsVistos.has(href)) continue;
    hrefsVistos.add(href);
    if (!canAccessRouteBt(href, hasPermission, BT_LABORATORIO)) continue;
    const chave = BALAO_DA_ROTA[href];
    if (!chave) continue;
    const permissaoExtra = PERMISSAO_DO_ATALHO[chave];
    if (permissaoExtra && !hasPermission(permissaoExtra)) continue;
    atalhos.push({ href, chave, lucide: a.lucide });
  }
  // Central de Disparos: atalho da pessoa (não do setor visto), só para quem abre a tela.
  if (proprio && !atalhos.some((x) => x.href === CENTRAL) && canAccessRouteBt(CENTRAL, hasPermission, BT_LABORATORIO)) {
    atalhos.push({ href: CENTRAL, chave: 'avisos', lucide: 'Send' });
  }

  // Próximas coletas, provas e entregas: só para quem abre a agenda (o protético vê
  // as dele, porque o servidor filtra), com as permissões reais já carregadas.
  const verProximas = proprio && permissoesProntas && canAccessRouteBt(AGENDA, hasPermission, BT_LABORATORIO);
  const [proximas, setProximas] = useState<EventoDaAgenda[] | null>(null);
  useEffect(() => {
    if (!verProximas || !isLab(btAgora())) {
      setProximas(null);
      return;
    }
    let cancelado = false;
    const agora = Date.now() - TRES_HORAS_MS;
    api
      .get<EventoDaAgenda[]>('/calendar/events', {
        params: { start: new Date(agora).toISOString(), end: new Date(agora + SETE_DIAS_MS).toISOString() },
      })
      .then(({ data }) => {
        if (!cancelado) setProximas(proximasDaLista(data));
      })
      .catch(() => {
        // erro: o quadro some
        if (!cancelado) setProximas(null);
      });
    return () => {
      cancelado = true;
    };
  }, [verProximas]);

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
              const Icone = ICONE_DA_CHAVE[chave] || (lucide && ICONES[lucide]) || LayoutGrid;
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

        {verProximas && proximas && (
          <section className="dh-panel" aria-label={LAB_PROXIMAS.titulo}>
            <div className="dh-panel-head">
              <h2>
                <span className="dh-panel-ico"><Calendar size={15} /></span>
                {LAB_PROXIMAS.titulo}
              </h2>
              <Link href={AGENDA} className="dh-panel-link">
                {LAB_PROXIMAS.abrir} <ArrowRight size={13} />
              </Link>
            </div>
            {proximas.length > 0 ? (
              <ul className="dh-tasks">
                {proximas.map((ev) => (
                  <li key={ev.id}>
                    <Link href={AGENDA} className="dh-task" onClick={() => abrirNaAgenda(ev.id)}>
                      <span className="dh-task-time">{dataCurtaNaive(ev.start_at)}</span>
                      <span className="dh-task-time">{horaCurtaNaive(ev.start_at)}</span>
                      <span className="dh-task-time">{rotuloTipoDoLaboratorio(ev.type)}</span>
                      <span className="dh-task-title">{ev.patient?.name || ev.lead?.name || LAB_PROXIMAS.semCliente}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dh-empty">{LAB_PROXIMAS.vazio}</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
