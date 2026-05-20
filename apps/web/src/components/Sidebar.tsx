'use client';

import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import {
  LogOut, Users, Briefcase, Settings, Palette, Check,
  MessageSquare, BarChart2, Calendar,
  LayoutDashboard, Wallet, HelpCircle,
  ChevronRight, ChevronDown, Sparkles, HeartPulse,
  Camera, Loader2, Trash2, Package, Bell, Banknote, Target, BarChart3, Network,
  Hourglass, Trophy, ShieldCheck, FileText, UserPlus, Handshake, Smartphone,
  Megaphone, HandCoins,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { API_BASE_URL } from '@/lib/api';
import { useAuthedImage } from '@/lib/use-authed-image';
import { NotificationCenter } from '@/app/atendimento/components/NotificationCenter';
// Onda 5c (Fase 25) — NotificationToggle removido da sidebar (duplicava o
// NotificationCenter). Toggle DND continua disponivel dentro do popover do
// Center quando user clica no sininho.
// import { NotificationToggle } from '@/components/NotificationToggle';
import { useRole } from '@/lib/useRole';
import { THEMES } from '@/components/ThemeSwitcher';

// ─── Tooltip Styles (shared) ──────────────────────────────────────
const TOOLTIP_CLS =
  'px-3 py-2 bg-card text-foreground text-[13px] font-semibold rounded-lg whitespace-nowrap shadow-xl border border-border flex items-center pointer-events-none';

/** Gera cor de fundo determinística para o avatar de iniciais */
function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
    '#f97316', '#eab308', '#22c55e', '#14b8a6',
    '#0ea5e9', '#3b82f6',
  ];
  return colors[Math.abs(hash) % colors.length];
}

interface NavSubItem {
  label: string;
  href: string;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  match: (p: string) => boolean;
  badge?: number;
  show: boolean;
  /**
   * Sub-itens mostrados em indent abaixo do item pai quando ele está ativo
   * E o sidebar está expandido. Não substitui a navegação do pai — clica no
   * pai pra ir pra raiz, clica no sub-item pra ir pra rota específica.
   */
  subItems?: NavSubItem[];
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
  /** Onda 5c (Fase 25) — se grupo comeca expandido por default. localStorage
      persiste preferencia do usuario apos primeiro click no header. */
  defaultExpanded?: boolean;
  /** Onda 5e v5 (Fase 25) — icone do grupo no header (Lucide React).
      Renderizado a esquerda do label uppercase pra dar contexto visual. */
  icon?: React.ReactNode;
}

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const perms = useRole();

  const [expanded, setExpanded] = useState(false);
  // Onda 5c (Fase 25) — estado de cada grupo (expandido/colapsado).
  // Persistido em localStorage. null = ainda nao carregou (ssr-safe).
  const [groupState, setGroupState] = useState<Record<string, boolean> | null>(null);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [dbStatus, setDbStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [unreadTotal, setUnreadTotal] = useState<number>(0);
  const [overdueCount, setOverdueCount] = useState<number>(0);
  const [pendingValidationCount, setPendingValidationCount] = useState<number>(0);
  const [quotesExpiringSoon, setQuotesExpiringSoon] = useState<number>(0);
  const [djenUnread, setDjenUnread] = useState<number>(0);
  const [mounted, setMounted] = useState(false);

  // ─── Foto de perfil ──────────────────────────────────────────
  const [userName, setUserName] = useState<string>('');
  const [userEmail, setUserEmail] = useState<string>('');
  const [avatarVersion, setAvatarVersion] = useState<number>(Date.now());
  const [hasAvatar, setHasAvatar] = useState<boolean>(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement>(null);
  const avatarMenuRef = useRef<HTMLDivElement>(null);
  const avatarBtnRef = useRef<HTMLButtonElement>(null);

  // Carrega avatar do user via fetch autenticado (tag <img> nao envia JWT).
  // userId pode ser null durante boot — hook trata null retornando src=null.
  const userAvatarSrc = useAuthedImage(
    hasAvatar && perms.userId
      ? `${API_BASE_URL}/users/${perms.userId}/avatar?v=${avatarVersion}`
      : null,
  ).src;

  // Fixed-position tooltip state
  const [navTooltip, setNavTooltip] = useState<{ label: React.ReactNode; y: number } | null>(null);

  // Fixed-position menu states
  const [themeMenuPos, setThemeMenuPos] = useState<{ top: number; left: number } | null>(null);

  const themePopupRef = useRef<HTMLDivElement>(null);
  const themeButtonRef = useRef<HTMLButtonElement>(null);

  // Load expanded state + mount
  useEffect(() => {
    const saved = localStorage.getItem('sidebar_expanded');
    if (saved === '1') setExpanded(true);
    // Onda 5c — carrega estado dos grupos
    try {
      const savedGroups = localStorage.getItem('sidebar_groups_state');
      if (savedGroups) {
        setGroupState(JSON.parse(savedGroups));
      } else {
        setGroupState({}); // vazio = usa defaultExpanded de cada grupo
      }
    } catch {
      setGroupState({});
    }
    setMounted(true);
  }, []);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem('sidebar_expanded', next ? '1' : '0');
    setNavTooltip(null);
  };

  // Onda 5c — toggle de grupo individual
  const toggleGroup = (groupId: string, defaultExp: boolean) => {
    setGroupState((prev) => {
      const current = prev || {};
      const isExpanded = current[groupId] !== undefined ? current[groupId] : defaultExp;
      const next = { ...current, [groupId]: !isExpanded };
      try {
        localStorage.setItem('sidebar_groups_state', JSON.stringify(next));
      } catch { /* localStorage cheio — silente */ }
      return next;
    });
  };

  // Helper: estado atual do grupo (com fallback no defaultExpanded)
  const isGroupExpanded = (groupId: string, defaultExp: boolean): boolean => {
    if (!groupState) return defaultExp;
    return groupState[groupId] !== undefined ? groupState[groupId] : defaultExp;
  };

  // Click outside → close menus
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        themePopupRef.current && !themePopupRef.current.contains(target) &&
        themeButtonRef.current && !themeButtonRef.current.contains(target)
      ) {
        setShowThemeMenu(false);
        setThemeMenuPos(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // DB health check
  useEffect(() => {
    let retries = 0;
    const MAX_RETRIES = 10;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const checkDb = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${API_BASE_URL}/health/db`, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (data.status === 'ok') {
          setDbStatus('online');
          retries = 0;
        } else {
          throw new Error('not ok');
        }
      } catch {
        clearTimeout(timeoutId);
        if (retries < MAX_RETRIES) {
          retries++;
          retryTimer = setTimeout(checkDb, 3000);
        } else {
          setDbStatus('offline');
        }
      }
    };

    checkDb();
    const interval = setInterval(() => { retries = 0; checkDb(); }, 30000);
    return () => {
      clearInterval(interval);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  // Unread badge
  useEffect(() => {
    const handler = (e: Event) => {
      setUnreadTotal((e as CustomEvent).detail?.total ?? 0);
    };
    window.addEventListener('unread_count_update', handler);
    return () => window.removeEventListener('unread_count_update', handler);
  }, []);

  // ─── Busca dados do usuário logado (nome + avatar) ────────────
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data) return;
        setUserName(data.name || '');
        setUserEmail(data.email || '');
        setHasAvatar(!!data.profile_picture_url);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [avatarVersion]);

  // Fecha menu de avatar ao clicar fora
  useEffect(() => {
    if (!showAvatarMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        avatarMenuRef.current && !avatarMenuRef.current.contains(target) &&
        avatarBtnRef.current && !avatarBtnRef.current.contains(target)
      ) {
        setShowAvatarMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAvatarMenu]);

  // Upload de foto de perfil
  const handleAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setShowAvatarMenu(false);

    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
      alert('Tipo de arquivo não suportado. Use JPEG, PNG, GIF ou WebP.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      alert('Imagem muito grande. Máximo 2 MB.');
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) return;
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const userId = perms.userId;
      const res = await fetch(`${API_BASE_URL}/users/${userId}/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());
      setHasAvatar(true);
      setAvatarVersion(Date.now()); // quebra o cache da imagem
    } catch (err: any) {
      alert('Erro ao enviar foto: ' + (err.message || 'tente novamente'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  // Remove a foto de perfil
  const handleRemoveAvatar = async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setShowAvatarMenu(false);
    setUploadingAvatar(true);
    try {
      const userId = perms.userId;
      const res = await fetch(`${API_BASE_URL}/users/${userId}/avatar`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      setHasAvatar(false);
      setAvatarVersion(Date.now());
    } catch (err: any) {
      alert('Erro ao remover foto: ' + (err.message || 'tente novamente'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  // DJEN unread badge (a cada 5 min)
  useEffect(() => {
    const fetchDjenUnread = async () => {
      const token = localStorage.getItem('token');
      if (!token) return;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${API_BASE_URL}/djen/all?viewed=false&archived=false&limit=1`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) return;
        const data = await res.json();
        setDjenUnread(data?.unreadCount ?? 0);
      } catch { /* silencioso */ }
    };
    fetchDjenUnread();
    const interval = setInterval(fetchDjenUnread, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Overdue tasks badge (a cada 5 min)
  useEffect(() => {
    const fetchOverdue = async () => {
      const token = localStorage.getItem('token');
      if (!token) return;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${API_BASE_URL}/tasks?limit=500`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) return;
        const data = await res.json();
        const tasks: any[] = data?.data || data || [];
        const now = new Date();
        const count = tasks.filter((t: any) =>
          t.due_at &&
          new Date(t.due_at) < now &&
          (t.status === 'A_FAZER' || t.status === 'EM_PROGRESSO')
        ).length;
        setOverdueCount(count);
      } catch { /* silencioso */ }
    };
    fetchOverdue();
    const interval = setInterval(fetchOverdue, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Badge "Atendimentos a validar" (Fase 23 PR2) — só pra dentista/admin
  // Mostra count de atendimentos clinicos passados nao validados (last 30 days)
  useEffect(() => {
    if (!perms.isDentist && !perms.isAdmin) return;
    const fetchPending = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/calendar/events/pending-validation?onlyMine=true&daysBack=30`, {
          headers: { Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('token') : ''}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        setPendingValidationCount(Array.isArray(data) ? data.length : 0);
      } catch { /* silencioso */ }
    };
    fetchPending();
    const interval = setInterval(fetchPending, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [perms.isDentist, perms.isAdmin]);

  // Badge "Orcamentos expirando" (Fase 24 Onda 1) — todos os usuarios veem
  // (recepcao + dentista + admin todos beneficiam de saber)
  useEffect(() => {
    const fetchExpiring = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/quotes/dashboard`, {
          headers: { Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('token') : ''}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        setQuotesExpiringSoon(data?.expiring_soon || 0);
      } catch { /* silencioso */ }
    };
    fetchExpiring();
    const interval = setInterval(fetchExpiring, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Badge para petições devolvidas (estagiário)
  const [internBadge, setInternBadge] = useState(0);
  useEffect(() => {
    if (!perms.isEstagiario) return;
    const fetchBadge = async () => {
      try {
        const res = await fetch('/api/intern/badge-count', {
          headers: { Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('token') : ''}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        setInternBadge(data.corrections || 0);
      } catch { /* silencioso */ }
    };
    fetchBadge();
    const interval = setInterval(fetchBadge, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [perms.isEstagiario]);

  // ─── Itens por grupo ──────────────────────────────────────────────
  const allItems: Record<string, NavItem> = {
    dashboard: {
      label: 'Dashboard',
      href: '/atendimento/dashboard',
      icon: <LayoutDashboard size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/dashboard'),
      show: perms.canViewDashboard,
    },
    inbox: {
      // Onda 5e v8 (Fase 25) — encurtado de "Inbox (WhatsApp)" pra "WhatsApp"
      // (label do canal direto, sem prefixo redundante)
      label: 'WhatsApp',
      href: '/atendimento',
      icon: <MessageSquare size={20} strokeWidth={2} />,
      match: (p) => p === '/atendimento' || p.startsWith('/atendimento/chat'),
      badge: unreadTotal,
      show: true,
    },
    crm: {
      // Onda 5e v8 — encurtado de "Leads & CRM" pra "CRM"
      label: 'CRM',
      href: '/atendimento/crm',
      icon: <Briefcase size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/crm'),
      show: true,
    },
    pacientes: {
      // Onda 5c (Fase 25) — renomeado pra "Lista de pacientes" (mais claro)
      // e sub-items removidos (cada um virou item separado no grupo PACIENTES)
      label: 'Lista de pacientes',
      href: '/atendimento/pacientes',
      icon: <HeartPulse size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/pacientes') && !p.includes('?new'),
      show: true,
    },
    novoPaciente: {
      // Onda 5c — antes era subItem de Pacientes; agora item top-level
      label: 'Novo paciente',
      href: '/atendimento/pacientes?new=1',
      icon: <UserPlus size={20} strokeWidth={2} />,
      match: () => false, // nunca fica "ativo" — eh acao, nao destino persistente
      show: true,
    },
    contacts: {
      label: 'Contatos',
      href: '/atendimento/contacts',
      icon: <Users size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/contacts'),
      show: true,
    },
    portalPaciente: {
      label: 'Portal do paciente',
      href: '/atendimento/portal-paciente',
      icon: <Smartphone size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/portal-paciente'),
      show: true,
    },
    agenda: {
      // Onda 5e v8 — encurtado de "Agenda & Tarefas" pra "Agenda" (tarefas
      // sao acessadas via tab interna ?tab=tasks, nao precisa virar label)
      label: 'Agenda',
      href: '/atendimento/agenda',
      icon: <Calendar size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/agenda') || p.startsWith('/atendimento/tasks'),
      badge: overdueCount,
      show: true,
    },
    waitlist: {
      label: 'Lista de espera',
      href: '/atendimento/waitlist',
      icon: <Hourglass size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/waitlist'),
      show: true,
    },
    orcamentos: {
      label: 'Orçamentos',
      href: '/atendimento/orcamentos',
      icon: <FileText size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/orcamentos'),
      // Badge mostra orcamentos enviados que expiram em ate 7 dias —
      // ajuda recepcao/dentista a cobrar resposta antes de perder a venda
      badge: quotesExpiringSoon,
      show: true,
    },
    fechamentos: {
      // Kanban dedicado à fase de fechamento (orçamentos SENT) agrupados por
      // procedimento principal. Complementa /orcamentos (lista plana) com
      // visão por procedimento + ações inline (reenviar, marcar aceito).
      label: 'Fechamentos',
      href: '/atendimento/fechamentos',
      icon: <Handshake size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/fechamentos'),
      show: true,
    },
    validacoes: {
      label: 'Atendimentos a validar',
      href: '/atendimento/validacoes',
      icon: <ShieldCheck size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/validacoes'),
      badge: pendingValidationCount,
      // So aparece pra dentista ou admin (recepcao nao valida)
      show: perms.isDentist || perms.isAdmin,
    },
    referrals: {
      label: 'Indicação Premiada',
      href: '/atendimento/referrals',
      icon: <Trophy size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/referrals'),
      show: true,
    },
    estoque: {
      label: 'Estoque',
      href: '/atendimento/estoque',
      icon: <Package size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/estoque'),
      show: true,
    },
    returnAlerts: {
      label: 'Retornos',
      href: '/atendimento/return-alerts',
      icon: <Bell size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/return-alerts'),
      show: true,
    },
    comissoes: {
      label: 'Comissões',
      href: '/atendimento/comissoes',
      icon: <Banknote size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/comissoes'),
      show: true,
    },
    metas: {
      label: 'Metas',
      href: '/atendimento/metas',
      icon: <Target size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/metas'),
      show: true,
    },
    relatorios: {
      label: 'Relatórios',
      href: '/atendimento/relatorios',
      icon: <BarChart3 size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/relatorios'),
      show: true,
    },
    minhaRede: {
      label: 'Minha rede',
      href: '/atendimento/minha-rede',
      icon: <Network size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/minha-rede'),
      show: true,
    },
    parcelas: {
      label: 'Parcelas',
      href: '/atendimento/financeiro/parcelas',
      icon: <Wallet size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/financeiro/parcelas'),
      show: true,
    },
    followup: {
      label: 'Follow-up IA',
      href: '/atendimento/followup',
      icon: <Sparkles size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/followup'),
      show: perms.isAdmin,
    },
    financeiro: {
      label: 'Financeiro',
      href: '/atendimento/financeiro',
      icon: <Wallet size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/financeiro'),
      show: perms.canViewFinanceiro,
    },
    analytics: {
      label: 'Analytics',
      href: '/atendimento/marketing/analytics',
      icon: <BarChart2 size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/marketing'),
      show: perms.canViewAnalytics,
    },
    influencers: {
      label: 'Influenciadores',
      href: '/atendimento/influenciadores',
      icon: <Megaphone size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/influenciadores'),
      show: perms.isAdmin,
    },
    afiliados: {
      label: 'Afiliados',
      href: '/atendimento/afiliados',
      icon: <HandCoins size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/afiliados'),
      show: perms.isAdmin,
    },
    manual: {
      label: 'Manual',
      href: '/atendimento/manual',
      icon: <HelpCircle size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/manual'),
      show: true,
    },
    settings: {
      label: 'Configurações',
      href: '/atendimento/settings',
      icon: <Settings size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/settings'),
      show: perms.canManageSettings,
    },
  };

  // Onda 5c (Fase 25) — Reorganizacao em 6 grupos contextualizados.
  // ATENDIMENTO/PACIENTES/COMERCIAL/FINANCEIRO comecam expandidos (uso diario).
  // GESTAO/SISTEMA comecam colapsados (uso eventual).
  // Estado salvo em localStorage apos primeiro click no header.
  //
  // Items omitidos do menu (preservados em allItems pra reativar facil):
  //   waitlist (Lista de espera), referrals (Indicacao Premiada),
  //   parcelas (Parcelas — vai estar dentro de Financeiro)
  // Pra reativar: adicionar de volta no array do grupo desejado.
  const groups: NavGroup[] = [
    {
      id: 'atendimento',
      label: 'Atendimento',
      defaultExpanded: true,
      icon: <HeartPulse size={14} strokeWidth={2.5} />,
      items: [
        allItems.dashboard,    // Dashboard (canViewDashboard only)
        allItems.inbox,        // WhatsApp
        allItems.agenda,       // Agenda
        allItems.crm,          // CRM (movido pra ATENDIMENTO)
        allItems.validacoes,   // Atendimentos a validar (dentist/admin)
      ].filter(i => i.show),
    },
    {
      id: 'pacientes',
      label: 'Pacientes',
      defaultExpanded: true,
      icon: <Users size={14} strokeWidth={2.5} />,
      items: [
        allItems.novoPaciente,    // + Novo paciente (top-level agora)
        allItems.pacientes,       // Lista de pacientes
        allItems.contacts,        // Contatos
        allItems.portalPaciente,  // Portal do paciente
      ].filter(i => i.show),
    },
    {
      id: 'comercial',
      label: 'Comercial',
      defaultExpanded: true,
      icon: <Briefcase size={14} strokeWidth={2.5} />,
      items: [
        allItems.orcamentos,   // Orcamentos (lista plana, todos os status)
        allItems.fechamentos,  // Fechamentos (kanban SENT por procedimento)
        allItems.returnAlerts, // Retornos (movido pra COMERCIAL)
        allItems.followup,     // Follow-up IA (admin)
      ].filter(i => i.show),
    },
    {
      id: 'marketing',
      label: 'Marketing',
      defaultExpanded: false, // grupo novo — comeca colapsado pra nao poluir
      icon: <Megaphone size={14} strokeWidth={2.5} />,
      items: [
        allItems.influencers,  // Cadastro de influenciadores (admin only)
        allItems.afiliados,    // Onda 5e v36 — dashboard global de afiliados
      ].filter(i => i.show),
    },
    {
      id: 'financeiro',
      label: 'Financeiro',
      defaultExpanded: true,
      icon: <Wallet size={14} strokeWidth={2.5} />,
      items: [
        allItems.financeiro,   // Visao financeira
        allItems.comissoes,    // Comissoes
        allItems.metas,        // Metas
      ].filter(i => i.show),
    },
    {
      id: 'gestao',
      label: 'Gestão',
      defaultExpanded: false, // colapsado por default
      icon: <BarChart3 size={14} strokeWidth={2.5} />,
      items: [
        allItems.analytics,    // Analytics
        allItems.estoque,      // Estoque
        allItems.relatorios,   // Relatorios
        allItems.minhaRede,    // Minha rede
      ].filter(i => i.show),
    },
    {
      id: 'sistema',
      label: 'Sistema',
      defaultExpanded: false, // colapsado por default
      icon: <Settings size={14} strokeWidth={2.5} />,
      items: [
        allItems.settings,     // Configuracoes
        allItems.manual,       // Manual
      ].filter(i => i.show),
    },
  ].filter(g => g.items.length > 0);

  // ─── Tooltip helpers (somente quando recolhido) ───────────────────
  const showTooltip = (e: React.MouseEvent, label: React.ReactNode) => {
    if (expanded) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setNavTooltip({ label, y: rect.top + rect.height / 2 });
  };
  const hideTooltip = () => setNavTooltip(null);

  // ─── Theme button toggle ──────────────────────────────────────────
  const toggleThemeMenu = (e: React.MouseEvent) => {
    if (showThemeMenu) {
      setShowThemeMenu(false);
      setThemeMenuPos(null);
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      const MENU_HEIGHT = 248;
      const MENU_MARGIN = 8;
      const rawTop = rect.top;
      const top = rawTop + MENU_HEIGHT + MENU_MARGIN > window.innerHeight
        ? window.innerHeight - MENU_HEIGHT - MENU_MARGIN
        : rawTop;
      setThemeMenuPos({ top, left: rect.right + 8 });
      setShowThemeMenu(true);
    }
    hideTooltip();
  };

  // ─── DB status label helper ───────────────────────────────────────
  const dbLabel =
    dbStatus === 'online' ? (
      <span className="text-emerald-500">Online</span>
    ) : dbStatus === 'offline' ? (
      <span className="text-red-500">Offline</span>
    ) : (
      <span className="text-sky-400">Verificando</span>
    );

  return (
    <aside
      className={`${expanded ? 'w-[190px]' : 'w-[64px]'} flex flex-col items-center py-3 bg-primary text-primary-foreground border-r border-primary/20 relative z-50 shrink-0 h-full overflow-y-auto no-scrollbar transition-[width] duration-200 ease-in-out`}
    >
      {/* ─── Logo + Toggle ─────────────────────────────────────────── */}
      <div className={`flex items-center w-full px-3 mb-3 gap-2 ${expanded ? 'justify-between' : 'flex-col'}`}>
        {/* Onda 5e v8 (Fase 25): logo redondo aumentado pra w-12 (48px) — assim
            a foto cabe inteira (texto ODONTO PASSOS legivel) sem cropar pelo
            object-cover. Bg do mesmo tom escuro caso a PNG tenha transparencia.
            Ring claro destaca o circulo contra o bg-primary do tema. */}
        <div
          className="w-12 h-12 rounded-full bg-[#111] flex items-center justify-center shadow-lg ring-2 ring-primary-foreground/30 shrink-0 cursor-pointer overflow-hidden"
          onClick={() => router.push('/atendimento/dashboard')}
          onMouseEnter={(e) => showTooltip(e, 'Página Inicial')}
          onMouseLeave={hideTooltip}
        >
          {/* object-contain (em vez de object-cover) garante que o circulo
              mostre o LOGO INTEIRO sem cortar a parte de baixo (PASSOS).
              Como a PNG ja eh quadrada, contain dentro de um circulo nao
              deixa whitespace visivel — fica colado nas bordas. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/odonto-passos-icon.png" alt="Instituto Odonto Passos" className="w-full h-full object-contain rounded-full" draggable={false} />
        </div>
        <button
          onClick={toggleExpanded}
          onMouseEnter={(e) => showTooltip(e, expanded ? 'Recolher menu' : 'Expandir menu')}
          onMouseLeave={hideTooltip}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-primary-foreground/80 hover:bg-primary-foreground/15 hover:text-primary-foreground transition-colors shrink-0"
          aria-label={expanded ? 'Recolher menu' : 'Expandir menu'}
        >
          <ChevronRight
            size={15}
            strokeWidth={2.5}
            className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {/* ─── Navigation Groups (Onda 5c — colapsaveis individualmente) ─── */}
      <nav className="flex-1 flex flex-col gap-0 w-full px-3 overflow-y-auto no-scrollbar">
        {groups.map((group, gi) => {
          const defaultExp = group.defaultExpanded ?? true;
          const isExpanded = isGroupExpanded(group.id, defaultExp);
          // Em modo recolhido (sidebar 72px) ignora group collapse — mostra todos
          const showItems = !expanded || isExpanded;

          return (
            <div key={group.id} className={gi > 0 ? 'mt-2' : ''}>
              {/* Header de grupo (Onda 5e — Fase 25): EVIDENCIADO
                    - Sidebar EXPANDIDA: botao clicavel com bg sutil + texto
                      mais contrastado + chevron sempre visivel + barra
                      vertical colorida na esquerda quando expandido
                    - Sidebar COLAPSADA: divisor discreto entre grupos */}
              {expanded ? (
                <button
                  onClick={() => toggleGroup(group.id, defaultExp)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 mb-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all
                    ${isExpanded
                      ? 'bg-primary-foreground/15 text-primary-foreground'
                      : 'text-primary-foreground/80 hover:bg-primary-foreground/10 hover:text-primary-foreground'}`}
                  aria-expanded={isExpanded}
                  aria-controls={`group-${group.id}-items`}
                >
                  {/* Onda 5e v5: icone do grupo a esquerda do label (HeartPulse,
                      Users, Briefcase, Wallet, BarChart3, Settings).
                      Da contexto visual rapido pra identificar grupo de relance. */}
                  {group.icon && (
                    <span className="shrink-0 text-primary-foreground/90">{group.icon}</span>
                  )}
                  <span className="flex-1 text-left">{group.label}</span>
                  <ChevronDown
                    size={12}
                    className={`shrink-0 transition-transform duration-150 text-primary-foreground ${
                      isExpanded ? '' : '-rotate-90 opacity-70'
                    }`}
                    strokeWidth={2.5}
                  />
                </button>
              ) : gi > 0 ? (
                <div className="h-px bg-primary-foreground/20 mx-1 mb-2" />
              ) : null}

              {showItems && (
              <div id={`group-${group.id}-items`} className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const isActive = item.match(pathname);
                const badge = (item as any).badge as number | undefined;
                return (
                  <div key={item.href}>
                    <button
                      onClick={() => { if (!isActive) router.push(item.href); }}
                      onMouseEnter={(e) => showTooltip(e, item.label)}
                      onMouseLeave={hideTooltip}
                      className={`w-full rounded-lg flex items-center relative transition-colors ${
                        expanded ? 'gap-2 px-3 py-1.5 pl-7' : 'aspect-square justify-center'
                      } ${
                        isActive
                          ? 'bg-primary-foreground/20 text-primary-foreground font-semibold'
                          : 'text-primary-foreground/85 hover:bg-primary-foreground/10 hover:text-primary-foreground'
                      }`}
                    >
                      {/* Onda 5e v5 (Fase 25): em modo EXPANDIDO esconde icone
                          (sub-menu so com texto, indentado pra mostrar hierarquia).
                          Em modo COLAPSADO mantem icone — eh o unico elemento
                          visivel, precisa pra clicar. */}
                      {!expanded && (
                        <span className="shrink-0">{item.icon}</span>
                      )}

                      {expanded && (
                        <span className="text-[11px] font-medium truncate flex-1 text-left">
                          {item.label}
                        </span>
                      )}

                      {badge != null && badge > 0 && (
                        <span
                          className={`min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-[16px] text-center shadow-md shrink-0 ${
                            expanded ? 'ml-auto' : 'absolute -top-1.5 -right-1.5'
                          }`}
                        >
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}

                      {isActive && (
                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary-foreground rounded-r-md" />
                      )}
                    </button>

                    {/* Sub-itens (Onda 5c — preservados pra compat se algum item ainda usar)
                        Atualmente nenhum item da nova estrutura usa subItems —
                        Pacientes virou items separados (Lista + Novo). */}
                    {expanded && isActive && item.subItems && item.subItems.length > 0 && (
                      <div className="ml-7 mt-0.5 mb-1 flex flex-col gap-0.5 border-l border-border/60 pl-2">
                        {item.subItems.map((sub) => {
                          const subPath = sub.href.split('?')[0];
                          const subQuery = sub.href.includes('?');
                          const currentMatchesSub = subQuery
                            ? typeof window !== 'undefined' && window.location.search.includes(sub.href.split('?')[1])
                            : pathname === subPath;
                          return (
                            <button
                              key={sub.href}
                              onClick={() => router.push(sub.href)}
                              className={`text-left text-[12px] py-1 px-2 rounded-md transition-colors ${
                                currentMatchesSub
                                  ? 'text-primary font-medium'
                                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
                              }`}
                            >
                              {sub.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* ─── Bottom: Avatar + DB + Notificações + Tema + Sair ─────── */}
      {/* Onda 5e v13 (Fase 25): cards compactados — padding menor, texto menor,
          avatar menor. Ocupa ~40% menos espaco vertical que a v2 sem perder
          legibilidade ou usabilidade do toque. */}
      <div className="mt-auto flex flex-col gap-0.5 w-full px-2 pt-2 border-t border-primary-foreground/20">

        {/* ─── Avatar do usuário (card branco) ─── */}
        <div className={`w-full flex items-center gap-2 rounded-lg px-1.5 py-1 bg-card text-foreground ${expanded ? '' : 'justify-center'}`}>
          {/* Input de arquivo oculto */}
          <input
            ref={avatarFileRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={handleAvatarFileChange}
          />

          {/* Botão do avatar */}
          <button
            ref={avatarBtnRef}
            onClick={() => perms.isAdmin ? setShowAvatarMenu(v => !v) : undefined}
            onMouseEnter={(e) => {
              if (perms.isAdmin) {
                showTooltip(e, 'Alterar foto de perfil');
              } else if (userName) {
                showTooltip(e, userName);
              }
            }}
            onMouseLeave={hideTooltip}
            className={`relative shrink-0 rounded-full overflow-hidden focus:outline-none group ${perms.isAdmin ? 'cursor-pointer' : 'cursor-default'}`}
            style={{ width: 26, height: 26 }}
          >
            {uploadingAvatar ? (
              <div className="w-full h-full flex items-center justify-center bg-muted rounded-full">
                <Loader2 size={12} className="animate-spin text-muted-foreground" />
              </div>
            ) : hasAvatar && userAvatarSrc ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={userAvatarSrc}
                  alt={userName}
                  className="w-full h-full object-cover rounded-full"
                  onError={() => setHasAvatar(false)}
                />
                {perms.isAdmin && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full">
                    <Camera size={10} className="text-white" />
                  </div>
                )}
              </>
            ) : (
              <>
                <div
                  className="w-full h-full rounded-full flex items-center justify-center text-[10px] font-bold text-white select-none"
                  style={{ background: stringToColor(userName || userEmail || 'U') }}
                >
                  {(userName || userEmail || 'U').charAt(0).toUpperCase()}
                </div>
                {perms.isAdmin && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full">
                    <Camera size={10} className="text-white" />
                  </div>
                )}
              </>
            )}
          </button>

          {expanded && (
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-[11px] font-semibold text-foreground truncate leading-tight">
                {userName || 'Usuário'}
              </span>
              <span className="text-[9px] text-muted-foreground truncate leading-tight">
                {userEmail}
              </span>
            </div>
          )}
          {/* Onda 5c (Fase 25) — DB status compacto inline ao lado do avatar
              (antes era linha propria com texto "Banco: Online" — ocupava espaço).
              Agora bolinha de 6px com tooltip discreto. */}
          {expanded && (
            <div
              className="shrink-0"
              onMouseEnter={(e) =>
                showTooltip(e,
                  <span className="text-[11px] font-bold uppercase tracking-widest">
                    Banco: {dbLabel}
                  </span>
                )
              }
              onMouseLeave={hideTooltip}
            >
              <div
                className={`w-1.5 h-1.5 rounded-full transition-all duration-500 ${
                  dbStatus === 'online'
                    ? 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]'
                    : dbStatus === 'offline'
                    ? 'bg-red-500 animate-pulse'
                    : 'bg-sky-500 animate-pulse'
                }`}
                aria-label={`Banco ${dbLabel}`}
              />
            </div>
          )}
        </div>

        {/* Notificacoes — card branco (Onda 5e v13: compactado) */}
        <div
          className={`w-full flex items-center bg-card text-foreground rounded-lg ${expanded ? 'gap-2 px-1.5 py-1' : 'justify-center py-1'}`}
          onMouseEnter={(e) => showTooltip(e, 'Notificações')}
          onMouseLeave={hideTooltip}
        >
          <NotificationCenter />
          {expanded && (
            <span className="text-[11px] font-medium">Notificações</span>
          )}
        </div>

        {/* Theme picker — card branco */}
        <button
          ref={themeButtonRef}
          onClick={toggleThemeMenu}
          onMouseEnter={(e) => { if (!showThemeMenu) showTooltip(e, 'Aparência'); }}
          onMouseLeave={hideTooltip}
          className={`w-full rounded-lg flex items-center gap-2 transition-colors bg-card text-foreground hover:bg-accent ${
            expanded ? 'px-2 py-1.5' : 'aspect-square justify-center'
          } ${showThemeMenu ? 'ring-2 ring-primary-foreground/30' : ''}`}
        >
          <Palette size={14} strokeWidth={2} className="shrink-0 text-primary" />
          {expanded && <span className="text-[11px] font-medium">Aparência</span>}
        </button>

        {/* Logout — card branco */}
        <button
          onClick={() => { localStorage.removeItem('token'); router.push('/atendimento/login'); }}
          onMouseEnter={(e) => showTooltip(e, 'Sair')}
          onMouseLeave={hideTooltip}
          className={`w-full rounded-lg flex items-center gap-2 transition-colors bg-card text-foreground hover:bg-destructive/10 hover:text-destructive ${
            expanded ? 'px-2 py-1.5' : 'aspect-square justify-center'
          }`}
        >
          <LogOut size={14} strokeWidth={2} className="shrink-0" />
          {expanded && <span className="text-[11px] font-medium">Sair</span>}
        </button>
      </div>

      {/* ─── Fixed tooltip portal ────────────────────────────────────── */}
      {mounted && navTooltip && createPortal(
        <div
          style={{ position: 'fixed', top: navTooltip.y, left: 76, transform: 'translateY(-50%)', zIndex: 9999 }}
          className={TOOLTIP_CLS}
        >
          <span className="absolute -left-[5px] top-1/2 -translate-y-1/2 border-y-[5px] border-y-transparent border-r-[5px] border-r-border" />
          {navTooltip.label}
        </div>,
        document.body
      )}

      {/* ─── Fixed theme popup portal ────────────────────────────────── */}
      {mounted && showThemeMenu && themeMenuPos && createPortal(
        <div
          ref={themePopupRef}
          style={{ position: 'fixed', top: themeMenuPos.top, left: themeMenuPos.left, zIndex: 9999, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}
          className="bg-card border border-border rounded-xl p-3 flex flex-col gap-2 w-48 shadow-2xl"
        >
          <p className="text-[11px] font-bold text-muted-foreground uppercase ml-1 mb-1 tracking-wider">Temas</p>
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTheme(t.id); setShowThemeMenu(false); setThemeMenuPos(null); }}
              className={`flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm text-foreground transition-colors hover:bg-accent ${theme === t.id ? 'bg-accent' : 'bg-transparent'}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-3.5 h-3.5 rounded-full border border-border shadow-inner" style={{ background: t.color }} />
                {t.name}
              </div>
              {theme === t.id && <Check size={14} className="text-primary" />}
            </button>
          ))}
        </div>,
        document.body
      )}

      {/* ─── Menu de avatar (portal) ─────────────────────────────────── */}
      {mounted && showAvatarMenu && perms.isAdmin && avatarBtnRef.current && createPortal(
        <div
          ref={avatarMenuRef}
          style={{
            position: 'fixed',
            bottom: (() => {
              const rect = avatarBtnRef.current?.getBoundingClientRect();
              return rect ? window.innerHeight - rect.top + 8 : 80;
            })(),
            left: 12,
            zIndex: 9999,
          }}
          className="bg-card border border-border rounded-xl p-2 flex flex-col gap-0.5 min-w-[180px] shadow-2xl"
        >
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-2 pb-1 pt-0.5">
            Foto de perfil
          </p>
          <button
            onClick={() => { setShowAvatarMenu(false); avatarFileRef.current?.click(); }}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[13px] font-medium text-foreground hover:bg-accent transition-colors text-left"
          >
            <Camera size={14} className="text-muted-foreground shrink-0" />
            {hasAvatar ? 'Alterar foto' : 'Adicionar foto'}
          </button>
          {hasAvatar && (
            <button
              onClick={handleRemoveAvatar}
              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[13px] font-medium text-destructive hover:bg-destructive/10 transition-colors text-left"
            >
              <Trash2 size={14} className="shrink-0" />
              Remover foto
            </button>
          )}
        </div>,
        document.body
      )}
    </aside>
  );
}
