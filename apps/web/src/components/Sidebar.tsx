'use client';

import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  LogOut, Users, Briefcase, Settings, Palette, Check,
  MessageSquare, BarChart2, Calendar,
  LayoutDashboard, Wallet, HelpCircle,
  ChevronRight, ChevronDown, Sparkles, HeartPulse,
  Camera, Loader2, Trash2, Package, Bell, Banknote, Target, BarChart3, Network,
  Hourglass, Trophy, ShieldCheck, FileText, UserPlus, Handshake, Smartphone,
  Megaphone, HandCoins, Square, CircleDashed, Layers, Zap, CreditCard,
  User, UserCog, Route,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { API_BASE_URL, clearSessionTraces } from '@/lib/api';
import { useAuthedImage } from '@/lib/use-authed-image';
import { NotificationCenter } from '@/app/atendimento/components/NotificationCenter';
// Onda 5c (Fase 25) — NotificationToggle removido da sidebar (duplicava o
// NotificationCenter). Toggle DND continua disponivel dentro do popover do
// Center quando user clica no sininho.
// import { NotificationToggle } from '@/components/NotificationToggle';
import { useRole } from '@/lib/useRole';
// Onda 17.32.120 — Filtra sidebar pelas permissoes do setor + overrides
import { useUserPermissions } from '@/lib/useUserPermissions';
// Onda 17.32.78 — White-label: nome + logo + cor por tenant
import { useTenant, applyTenantTheme } from '@/lib/useTenant';
import { THEMES } from '@/components/ThemeSwitcher';
import { useVisualMode } from '@/components/VisualModeProvider';

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
  match: (p: string, _h?: undefined, searchString?: string) => boolean;
  badge?: number | string;
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
  /** Onda 15.7 — grupo FIXO: sempre expandido, sem chevron, nao clicavel.
      Usado para os 2 primeiros grupos (Visao Geral, Jornada do Paciente)
      que devem ficar sempre visiveis pra acesso rapido aos modulos
      principais. */
  fixed?: boolean;
  /** Onda 16.7 — esconde o header (label uppercase) do grupo. Util pra
      grupos com 1 item soh, onde o label do grupo duplicaria o do item.
      Items continuam renderizando normal. */
  hideLabel?: boolean;
}

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  // Onda 17.32.41 — search params disponivel pra match de items que dependem
  // do query string (ex: "Propostas" = /orcamentos?status=SENT).
  const searchParams = useSearchParams();
  const searchString = searchParams?.toString() || '';
  const { theme, setTheme } = useTheme();
  const { mode: fxMode, setMode: setFxMode } = useVisualMode();
  const perms = useRole();
  // Onda 17.32.120 — Permissoes por setor (resolvidas async, fallback otimista)
  const { hasPermission } = useUserPermissions();
  // Onda 17.32.78 — Branding por tenant (white-label).
  // Aplica theme_color como CSS var no <html> e disponibiliza nome+logo.
  const tenant = useTenant();
  useEffect(() => { applyTenantTheme(tenant); }, [tenant]);

  // Onda 15.8 — Mapeia o role principal pra label legivel exibida embaixo do
  // nome no rodape da sidebar (estilo LUMEN "Cirurgia-Dentista"). Fallback
  // pro role bruto se nao houver mapping.
  const ROLE_LABELS: Record<string, string> = {
    ADMIN: 'Administrador',
    DENTIST: 'Dentista',
    OPERADOR: 'Atendimento',
    ASSISTANT: 'Assistente',
    FINANCEIRO: 'Financeiro',
  };
  const userCargo = perms.role ? (ROLE_LABELS[perms.role] ?? perms.role) : '';

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
  // Onda 17.32.100 — Menu de USUARIO (Sair, Trocar usuario, Meu perfil).
  // Separado do menu de FOTO. Antes "Sair" ficava no menu da foto, o que
  // nao fazia sentido pro usuario (semantica errada).
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userBtnRef = useRef<HTMLButtonElement>(null);

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

  // Fecha menu de USUARIO ao clicar fora (Onda 17.32.100)
  useEffect(() => {
    if (!showUserMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        userMenuRef.current && !userMenuRef.current.contains(target) &&
        userBtnRef.current && !userBtnRef.current.contains(target)
      ) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUserMenu]);

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
      // Onda 16.3 — renomeado pra "Visao geral" (pt-BR, alinhado com odonto)
      // Onda 16.6 — virou "Menu inicial" (porta de entrada do sistema)
      // Onda 17.50 — "Inicio" (alinhado ao mockup de baloes por papel)
      label: 'Início',
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
      // Onda 17.32.120 — Filtra por permissao de chat
      show: hasPermission('view_chat'),
    },
    vendaRapida: {
      // Onda 17.32.68 — Atalho pra venda balcao (procedimentos prontos
      // sem precisar passar pelo fluxo de avaliacao)
      label: 'Venda rápida',
      href: '/atendimento/venda-rapida',
      icon: <Zap size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/venda-rapida'),
      badge: 'novo',
      // Onda 17.65 — venda rápida usa manage_proposals: só com permissão.
      show: hasPermission('manage_proposals'),
    },
    // Onda 18.x — Caixa do dia (recepção opera; admin/financeiro validam).
    caixa: {
      label: 'Caixa',
      href: '/atendimento/caixa',
      icon: <Wallet size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/caixa'),
      show: hasPermission('operate_cash'),
    },
    // Onda 17.32.88 — Atalho pro admin SaaS. So aparece se SUPER_ADMIN.
    adminTenants: {
      label: 'Admin SaaS',
      href: '/admin/tenants',
      icon: <ShieldCheck size={20} strokeWidth={2} />,
      match: (p) => p === '/admin/tenants' || p.startsWith('/admin/tenants/'),
      show: perms.isSuperAdmin,
    },
    // Onda 17.32.112 — Anamnese MASTER do SaaS (controlada por SUPER_ADMIN)
    anamneseMaster: {
      label: 'Anamnese master',
      href: '/admin/anamnese-master',
      icon: <FileText size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/admin/anamnese-master'),
      show: perms.isSuperAdmin,
    },
    billing: {
      // Onda 17.32.88 — Atalho pra pagina de assinatura (mensalidade)
      // visivel pra ADMIN do tenant gerenciar seu plano.
      label: 'Assinatura',
      href: '/atendimento/billing',
      icon: <CreditCard size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/billing'),
      show: perms.isAdmin,
    },
    crm: {
      // Onda 5e v8 — encurtado de "Leads & CRM" pra "CRM"
      label: 'CRC',
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
    progresso: {
      // Jornada do paciente pós-venda: pipeline "central de vendas" por etapa
      // (a agendar / agendado / em tratamento / concluído). Fecha o buraco de
      // "fechei e esqueci de agendar". Mesma permissão de Propostas/Orçamentos.
      label: 'Progresso',
      href: '/atendimento/progresso',
      icon: <Route size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/progresso'),
      show: hasPermission('manage_proposals'),
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
      label: 'Avaliação',
      href: '/atendimento/orcamentos',
      icon: <FileText size={20} strokeWidth={2} />,
      // Onda 17.32.41 — Nao destaca quando query string e status=SENT
      // (esse caso e do atalho "Propostas").
      match: (p, _h, search) => p.startsWith('/atendimento/orcamentos') && !(search || '').includes('status=SENT'),
      // Badge mostra orcamentos enviados que expiram em ate 7 dias —
      // ajuda recepcao/dentista a cobrar resposta antes de perder a venda
      badge: quotesExpiringSoon,
      // Onda 17.65 — Orçamentos/Propostas só com manage_proposals.
      show: hasPermission('manage_proposals'),
    },
    propostas: {
      // Onda 17.32.41 — Atalho rapido pra "propostas em aberto" = orcamentos
      // enviados aguardando decisao do paciente. Reaproveita pagina Orcamentos
      // com filtro inicial SENT.
      label: 'Propostas',
      href: '/atendimento/orcamentos?status=SENT',
      icon: <Layers size={20} strokeWidth={2} />,
      // Match exato pra "?status=SENT" pra nao competir com Orcamentos no highlight.
      match: (p, _h, search) => p.startsWith('/atendimento/orcamentos') && (search || '').includes('status=SENT'),
      show: hasPermission('manage_proposals'),
    },
    fechamentos: {
      // Kanban dedicado à fase de fechamento (orçamentos SENT) agrupados por
      // procedimento principal. Complementa /orcamentos (lista plana) com
      // visão por procedimento + ações inline (reenviar, marcar aceito).
      label: 'Fechamentos',
      href: '/atendimento/fechamentos',
      icon: <Handshake size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/fechamentos'),
      show: hasPermission('manage_proposals'),
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
      // Onda 17.32.120 — Filtra pela permissao
      show: hasPermission('view_reports'),
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
    financeiroVisaoGeral: {
      // Onda 17.1 — KPIs + graficos do financeiro (RevenueTrend +
      // FinancialAging + Top atrasos + Entrada do dia). Pagina dedicada
      // pra visualizacao gerencial, separada da pagina /financeiro que
      // foca em tabelas e CRUD.
      label: 'Visão Geral',
      href: '/atendimento/financeiro/dashboard',
      icon: <BarChart3 size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/financeiro/dashboard'),
      // Onda 17.32.120 — Filtra pela permissao (financeiro/admin veem)
      show: hasPermission('view_financial') && perms.canViewFinanceiro,
    },
    financeiro: {
      label: 'Financeiro',
      href: '/atendimento/financeiro',
      icon: <Wallet size={20} strokeWidth={2} />,
      // Match restrito: nao casa com /financeiro/dashboard nem /financeiro/parcelas
      match: (p) => p === '/atendimento/financeiro' || p.startsWith('/atendimento/financeiro?'),
      // Onda 17.32.120
      show: hasPermission('view_financial') && perms.canViewFinanceiro,
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
      // Onda 17.32.120 — Marketing/CRM ve, admin tambem
      show: hasPermission('view_marketing'),
    },
    afiliados: {
      label: 'Afiliados',
      href: '/atendimento/afiliados',
      icon: <HandCoins size={20} strokeWidth={2} />,
      match: (p) => p.startsWith('/atendimento/afiliados'),
      // Onda 17.32.120
      show: hasPermission('view_marketing'),
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
  // Onda 15.7 — Reorganizacao do menu lateral seguindo referencia do usuario.
  // Os 2 primeiros grupos sao FIXOS (sem chevron, sempre visiveis). Os demais
  // sao colapsaveis. Items duplicados (Orcamentos e Financeiro aparecendo em
  // 2 grupos) apontam pra mesma rota provisoriamente — pra serem paginas
  // distintas precisa decidir o conteudo de cada variacao em PR separado.
  // Items REMOVIDOS do menu (rotas continuam acessiveis via URL direta):
  // Atendimentos a validar, Lista de espera, Indicacao Premiada, Contatos,
  // Portal do paciente, Prontuario.
  const groups: NavGroup[] = [
    {
      // Onda 16.7 — Grupo "Menu inicial" sem header (hideLabel) pra
      // nao duplicar o nome com o item unico. Resultado: item solto
      // no topo do sidebar, sem secao "MENU INICIAL" acima.
      id: 'home',
      label: 'Menu inicial',
      fixed: true,
      hideLabel: true,
      icon: <LayoutDashboard size={14} strokeWidth={2.5} />,
      items: [
        allItems.dashboard,    // Menu inicial (rota /atendimento/dashboard)
      ].filter(i => i.show),
    },
    {
      // Atendimento: canais ativos (agenda + comunicacao com o paciente).
      id: 'atendimento',
      label: 'Atendimento',
      fixed: true,
      icon: <LayoutDashboard size={14} strokeWidth={2.5} />,
      items: [
        allItems.vendaRapida,  // Venda rápida (balcão)
        allItems.caixa,        // Onda 18.x — Caixa do dia
        allItems.agenda,       // Agenda
        allItems.inbox,        // WhatsApp
      ].filter(i => i.show),
    },
    {
      id: 'jornada',
      label: 'Jornada do paciente',
      fixed: true,
      icon: <Users size={14} strokeWidth={2.5} />,
      items: [
        allItems.pacientes,    // Pacientes (lista)
        allItems.progresso,    // Progresso (pipeline pós-venda por etapa)
        // Onda 15 (etapa 18) — Orcamentos e Financeiro moveram pro
        // grupo "Financeiro" abaixo (operador preferiu agrupar la).
        // Orcamentos continua duplicado no CRM como atalho.
      ].filter(i => i.show),
    },
    {
      id: 'crm',
      label: 'CRC',
      defaultExpanded: true,
      icon: <Network size={14} strokeWidth={2.5} />,
      items: [
        allItems.crm,          // Kanban CRM (movido pra dentro do grupo)
        // Onda 15 (etapa 20) — Orcamentos removido do CRM (era duplicado
        // com o grupo Financeiro). Fica so em Financeiro pra evitar
        // confusao. Pra restaurar: descomenta a linha abaixo.
        // allItems.orcamentos,   // Orcamentos
        allItems.fechamentos,  // Fechamentos (kanban SENT por procedimento)
        allItems.returnAlerts, // Retornos
        allItems.followup,     // Follow-up IA (admin)
      ].filter(i => i.show),
    },
    {
      // Onda 15 (etapa 18) — Grupo "Financeiro" reativado, agora hospedando
      // Orcamentos + Financeiro (visao geral) que estavam em Jornada.
      // Onda 16.4 — Visao geral voltou pro grupo Atendimento.
      // Parcelas continua oculta — descomentar quando o modulo estiver maduro.
      id: 'financeiro',
      label: 'Financeiro',
      defaultExpanded: true,
      icon: <Wallet size={14} strokeWidth={2.5} />,
      items: [
        allItems.financeiroVisaoGeral, // Onda 17.1 — Visão Geral (KPIs + graficos)
        allItems.orcamentos,           // Orçamentos
        allItems.propostas,            // Onda 17.32.41 — Propostas (orcamentos SENT)
        allItems.financeiro,           // Financeiro (tabela detalhada)
        // allItems.parcelas,          // Parcelas — oculto ate o modulo estar maduro
      ].filter(i => i.show),
    },
    {
      id: 'gestao',
      label: 'Gestão',
      defaultExpanded: false,
      icon: <BarChart3 size={14} strokeWidth={2.5} />,
      items: [
        allItems.comissoes,    // Comissões (movido do antigo Financeiro)
        allItems.metas,        // Metas (movido do antigo Financeiro)
        allItems.analytics,    // Analytics
        allItems.estoque,      // Estoque
        allItems.relatorios,   // Relatórios
        allItems.minhaRede,    // Minha rede
      ].filter(i => i.show),
    },
    {
      id: 'marketing',
      label: 'Marketing',
      defaultExpanded: false,
      icon: <Megaphone size={14} strokeWidth={2.5} />,
      items: [
        allItems.influencers,  // Cadastro de influenciadores
        allItems.afiliados,    // Dashboard de afiliados
      ].filter(i => i.show),
    },
    {
      id: 'sistema',
      label: 'Sistema',
      defaultExpanded: false,
      icon: <Settings size={14} strokeWidth={2.5} />,
      items: [
        allItems.billing,        // Assinatura (Onda 17.32.88 — só pra ADMIN)
        allItems.adminTenants,   // Admin SaaS (Onda 17.32.88 — só SUPER_ADMIN)
        allItems.anamneseMaster, // Anamnese master (Onda 17.32.112 — só SUPER_ADMIN)
        allItems.settings,       // Configuracoes
        allItems.manual,         // Manual
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
      // Onda 15.1 — popup tem TEMAS (4 botões) + divider + ESTILO (2 botões).
      // Medindo na DOM: padding p-3 (24px) + header (24px) + 4×44px (176px) +
      // 3 gaps×8 (24px) + divider (10px) + header (24px) + 2×44px (88px) +
      // 1 gap (8px) ≈ 378px. Margem de seguranca: 410px.
      const MENU_HEIGHT = 410;
      const MENU_MARGIN = 8;
      const rawTop = rect.top;
      const top = rawTop + MENU_HEIGHT + MENU_MARGIN > window.innerHeight
        ? Math.max(MENU_MARGIN, window.innerHeight - MENU_HEIGHT - MENU_MARGIN)
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
      data-glass="sidebar"
      className={`${expanded ? 'w-[260px]' : 'w-[72px]'} flex flex-col items-center py-4 bg-primary text-primary-foreground border-r border-primary/20 relative z-50 shrink-0 h-full overflow-y-auto no-scrollbar transition-[width] duration-200 ease-in-out`}
    >
      {/* ─── Logo + Toggle ─────────────────────────────────────────── */}
      <div className={`flex items-center w-full px-4 mb-4 gap-3 ${expanded ? 'justify-between' : 'flex-col'}`}>
        {/* Onda 15.9 — Header tipo LUMEN: box quadrado pequeno com ícone +
            texto "ODONTO" / "SYSTEM" empilhado ao lado. Substitui logo redonda. */}
        <button
          onClick={() => router.push('/atendimento/dashboard')}
          onMouseEnter={(e) => showTooltip(e, 'Página Inicial')}
          onMouseLeave={hideTooltip}
          className={`flex items-center gap-2.5 shrink-0 cursor-pointer focus:outline-none ${expanded ? '' : 'flex-col'}`}
          aria-label="Página Inicial"
        >
          {/* Onda 17.32.78 — White-label: usa logo do tenant se houver,
              senao mantem o icone de dente padrao da plataforma. */}
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-lg ring-1 ring-primary-foreground/20 overflow-hidden bg-card"
            style={tenant?.logo_url ? undefined : { background: 'var(--gradient-accent)' }}
          >
            {tenant?.logo_url ? (
              <img
                src={tenant.logo_url}
                alt={tenant.name || 'Logo'}
                className="w-full h-full object-cover"
              />
            ) : (
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-white drop-shadow"
              >
                <path d="M12 2C8.5 2 6 4 6 7c0 1.5.5 3 1 4.5.5 1.5.5 3 .5 4.5 0 2 .5 6 2 6 1 0 1.5-2 2-4 .3-1.3.5-2 .5-2s.2.7.5 2c.5 2 1 4 2 4 1.5 0 2-4 2-6 0-1.5 0-3 .5-4.5.5-1.5 1-3 1-4.5 0-3-2.5-5-6-5z" />
              </svg>
            )}
          </div>
          {expanded && (
            // Onda 17.32.78 — White-label: usa nome do tenant se disponivel.
            // Fallback: "ODONTO SYSTEM" (default da plataforma).
            <div className="flex flex-col items-start leading-none min-w-0">
              {tenant?.name ? (
                <>
                  <span className="text-[15px] font-extrabold tracking-tight text-primary-foreground truncate max-w-[140px]">
                    {tenant.name.split(' ')[0].toUpperCase()}
                  </span>
                  {tenant.name.split(' ').length > 1 && (
                    <span className="text-[9px] font-bold tracking-[0.18em] text-primary-foreground/70 mt-0.5 truncate max-w-[140px]">
                      {tenant.name.split(' ').slice(1).join(' ').toUpperCase()}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="text-[15px] font-extrabold tracking-tight text-primary-foreground">
                    ODONTO
                  </span>
                  <span className="text-[9px] font-bold tracking-[0.18em] text-primary-foreground/70 mt-0.5">
                    SYSTEM
                  </span>
                </>
              )}
            </div>
          )}
        </button>
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
      <nav className="flex-1 flex flex-col gap-0 w-full px-4 overflow-y-auto no-scrollbar">
        {groups.map((group, gi) => {
          const defaultExp = group.defaultExpanded ?? true;
          const isExpanded = isGroupExpanded(group.id, defaultExp);
          // Em modo recolhido (sidebar 72px) ignora group collapse — mostra todos
          // Onda 15.7: grupos `fixed` (Visao Geral, Jornada do Paciente) sempre
          // mostram seus items, independente do estado de expansao.
          const showItems = !expanded || isExpanded || group.fixed;

          return (
            <div key={group.id} className={gi > 0 ? 'mt-4' : ''}>
              {/* Header de grupo (Onda 5e — Fase 25): EVIDENCIADO
                    - Sidebar EXPANDIDA: botao clicavel com bg sutil + texto
                      mais contrastado + chevron sempre visivel + barra
                      vertical colorida na esquerda quando expandido
                    - Sidebar COLAPSADA: divisor discreto entre grupos */}
              {expanded ? (
                group.hideLabel ? (
                  // Onda 16.7: grupo sem header. Pula direto pra renderizar
                  // os items. Util quando o grupo tem 1 item soh e o label
                  // duplicaria o nome (ex: "Menu inicial > Menu inicial").
                  null
                ) : group.fixed ? (
                  // Onda 15.7: grupo FIXO — header como section label nao
                  // clicavel, sem chevron. Sempre expandido (showItems abaixo
                  // forca ignorando isExpanded pra grupos fixed).
                  <div
                    className="w-full flex items-center gap-2 px-2 pt-3 pb-1.5 mb-0.5 text-[11px] font-bold uppercase tracking-wider text-primary-foreground/70 cursor-default select-none"
                  >
                    {group.icon && (
                      <span className="shrink-0 opacity-80">{group.icon}</span>
                    )}
                    <span className="flex-1 text-left">{group.label}</span>
                  </div>
                ) : (
                  <button
                    onClick={() => toggleGroup(group.id, defaultExp)}
                    className={`w-full flex items-center gap-2 px-2 pt-3 pb-1.5 mb-0.5 text-[11px] font-bold uppercase tracking-wider transition-all
                      ${isExpanded
                        ? 'text-primary-foreground/70 hover:text-primary-foreground'
                        : 'text-primary-foreground/50 hover:text-primary-foreground/80'}`}
                    aria-expanded={isExpanded}
                    aria-controls={`group-${group.id}-items`}
                  >
                    {/* Onda 15.6 (LUMEN-style): header de grupo discreto, sem
                        background. Icone do grupo + label uppercase pequeno +
                        chevron sutil. Estilo "section header" em vez de "button". */}
                    {group.icon && (
                      <span className="shrink-0 opacity-80">{group.icon}</span>
                    )}
                    <span className="flex-1 text-left">{group.label}</span>
                    <ChevronDown
                      size={12}
                      className={`shrink-0 transition-transform duration-150 opacity-60 ${
                        isExpanded ? '' : '-rotate-90'
                      }`}
                      strokeWidth={2.5}
                    />
                  </button>
                )
              ) : gi > 0 ? (
                <div className="h-px bg-primary-foreground/20 mx-1 mb-2" />
              ) : null}

              {showItems && (
              <div id={`group-${group.id}-items`} className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const isActive = item.match(pathname, undefined, searchString);
                const badge = (item as any).badge as number | undefined;
                return (
                  <div key={item.href}>
                    <button
                      onClick={() => { if (!isActive) router.push(item.href); }}
                      onMouseEnter={(e) => showTooltip(e, item.label)}
                      onMouseLeave={hideTooltip}
                      style={
                        isActive && expanded
                          ? {
                              background: 'var(--gradient-accent)',
                              boxShadow: '0 0 14px rgba(var(--accent-glow), 0.45), 0 0 28px rgba(var(--accent-glow), 0.20)',
                            }
                          : undefined
                      }
                      className={`w-full rounded-xl flex items-center relative transition-all ${
                        expanded ? 'gap-3 px-3 py-2.5' : 'aspect-square justify-center'
                      } ${
                        isActive
                          ? expanded
                            ? 'text-white font-semibold'
                            : 'bg-primary-foreground/20 text-primary-foreground font-semibold'
                          : 'text-primary-foreground/85 hover:bg-primary-foreground/10 hover:text-primary-foreground'
                      }`}
                    >
                      {/* Onda 15.6 (LUMEN-style): icone SEMPRE visivel (mesmo
                          em modo expanded). Antes escondia pra mostrar texto
                          indentado, mas o LUMEN/AURA usam icone + texto sempre. */}
                      <span className="shrink-0">{item.icon}</span>

                      {expanded && (
                        <span className="text-sm font-medium truncate flex-1 text-left">
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
        <div className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 bg-card text-foreground ${expanded ? '' : 'justify-center'}`}>
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
            onClick={() => setShowAvatarMenu(v => !v)}
            onMouseEnter={(e) => {
              if (perms.isAdmin) {
                showTooltip(e, 'Alterar foto de perfil');
              } else if (userName) {
                showTooltip(e, userName);
              }
            }}
            onMouseLeave={hideTooltip}
            className="relative shrink-0 rounded-full overflow-hidden focus:outline-none group cursor-pointer"
            style={{ width: 32, height: 32 }}
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
            // Onda 17.32.100 — Botao do menu de USUARIO (Sair / Trocar / Perfil).
            // Antes era um <div> nao-clicavel; "Sair" ficava no menu da foto, o
            // que nao fazia sentido. Agora o card de nome+cargo eh o trigger
            // proprio do menu de conta.
            <button
              ref={userBtnRef}
              type="button"
              onClick={() => setShowUserMenu(v => !v)}
              className="flex flex-col items-start min-w-0 flex-1 text-left rounded-md px-1 -mx-1 py-0.5 hover:bg-accent/40 transition-colors cursor-pointer focus:outline-none focus:bg-accent/40 group"
              aria-label="Menu da conta"
              aria-expanded={showUserMenu}
            >
              <span className="text-[13px] font-semibold text-foreground truncate leading-tight w-full inline-flex items-center gap-1">
                {userName || 'Usuário'}
                <ChevronDown
                  size={11}
                  className={`text-muted-foreground transition-transform ${showUserMenu ? 'rotate-180' : ''} group-hover:text-foreground`}
                />
              </span>
              <span className="text-[11px] text-muted-foreground truncate leading-tight w-full">
                {userCargo || userEmail}
              </span>
            </button>
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

        {/* Onda 15.8 — Notificacoes / Aparencia / Sair removidos do rodape
            da sidebar. Notificacoes e Aparencia agora vivem no header global
            (atendimento/layout.tsx). Sair foi movido pro menu dropdown que
            abre ao clicar no avatar (logo acima). */}
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

      {/* Onda 15.8 — Popup de tema removido da Sidebar.
          Onda 14.55 — Estilo "Massinha" (claymorphism) agora vive no
          ThemeMenuButton renderizado no header global (atendimento/layout).
          Aqui não há mais UI de tema. */}

      {/* ─── Menu de avatar (portal) ─────────────────────────────────── */}
      {mounted && showAvatarMenu && avatarBtnRef.current && createPortal(
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
          className="bg-card border border-border rounded-xl p-2 flex flex-col gap-0.5 min-w-[200px] shadow-2xl"
        >
          {/* Foto — so admin pode trocar (precisa do upload endpoint) */}
          {perms.isAdmin && (
            <>
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
            </>
          )}
          {/* Onda 17.32.100 — Sair foi movido pro menu de USUARIO
            (no botao do nome+cargo), nao mais aqui no menu da FOTO. */}
        </div>,
        document.body
      )}

      {/* ─── Onda 17.32.100 — Menu de USUARIO (Sair / Trocar / Perfil) ─── */}
      {mounted && showUserMenu && userBtnRef.current && createPortal(
        <div
          ref={userMenuRef}
          style={{
            position: 'fixed',
            bottom: (() => {
              const rect = userBtnRef.current?.getBoundingClientRect();
              return rect ? window.innerHeight - rect.top + 8 : 80;
            })(),
            left: 12,
            zIndex: 9999,
          }}
          className="bg-card border border-border rounded-xl p-2 flex flex-col gap-0.5 min-w-[220px] shadow-2xl"
        >
          {/* Header com nome + email */}
          <div className="px-3 py-2 border-b border-border mb-1">
            <p className="text-[13px] font-bold text-foreground truncate">{userName || 'Usuário'}</p>
            <p className="text-[11px] text-muted-foreground truncate">{userEmail}</p>
          </div>

          {/* Meu perfil */}
          <button
            onClick={() => {
              setShowUserMenu(false);
              router.push('/atendimento/settings/users');
            }}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[13px] font-medium text-foreground hover:bg-accent transition-colors text-left"
          >
            <User size={14} className="text-muted-foreground shrink-0" />
            Meu perfil
          </button>

          {/* Trocar usuario — limpa remembered_email tambem pra abrir
            o login com email em branco */}
          <button
            onClick={() => {
              setShowUserMenu(false);
              localStorage.removeItem('token');
              localStorage.removeItem('remembered_email');
              clearSessionTraces();
              router.push('/atendimento/login');
            }}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[13px] font-medium text-foreground hover:bg-accent transition-colors text-left"
          >
            <UserCog size={14} className="text-muted-foreground shrink-0" />
            Trocar de usuário
          </button>

          <div className="h-px bg-border my-1" />

          {/* Sair — mantem remembered_email pra facilitar voltar */}
          <button
            onClick={() => {
              setShowUserMenu(false);
              localStorage.removeItem('token');
              clearSessionTraces();
              router.push('/atendimento/login');
            }}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[13px] font-medium text-destructive hover:bg-destructive/10 transition-colors text-left"
          >
            <LogOut size={14} className="shrink-0" />
            Sair
          </button>
        </div>,
        document.body
      )}
    </aside>
  );
}
