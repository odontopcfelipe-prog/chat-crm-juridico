'use client';

/**
 * Avatar de paciente reutilizável.
 *
 * - Se patient tem avatar_url: carrega a foto via useAuthedImage (fetch
 *   autenticado + blob URL — necessário porque tag <img> nao envia JWT).
 * - Senão: mostra iniciais do nome com cor de fundo determinística.
 *
 * Usar em listas, cards, kanban — qualquer lugar que precise mostrar avatar
 * sem upload (pra upload, usa o AvatarUploader na ficha do paciente).
 */
import { useAuthedImage } from '@/lib/use-authed-image';
import { API_BASE_URL } from '@/lib/api';

interface Props {
  patientId: string;
  patientName: string;
  /** patient.avatar_url do banco. Se null, mostra iniciais sem nem tentar request. */
  avatarUrl: string | null | undefined;
  /** Tamanho em px (largura = altura). Default 40. */
  size?: number;
  /** Classe Tailwind adicional pra container. */
  className?: string;
}

// Paleta determinística pelas iniciais — mesma pessoa sempre vê a mesma cor
const BG_COLORS = [
  'bg-indigo-500', 'bg-violet-500', 'bg-pink-500', 'bg-rose-500',
  'bg-orange-500', 'bg-amber-500', 'bg-emerald-500', 'bg-teal-500',
  'bg-sky-500', 'bg-blue-500',
];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return BG_COLORS[Math.abs(hash) % BG_COLORS.length];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function PatientAvatar({
  patientId,
  patientName,
  avatarUrl,
  size = 40,
  className = '',
}: Props) {
  // Só dispara fetch se backend confirmou que existe avatar — evita 404 em
  // pacientes sem foto. ?t=<id> serve só pra invalidar cache se o id mudar.
  const url = avatarUrl ? `${API_BASE_URL}/patients/${patientId}/avatar` : null;
  const { src, loading } = useAuthedImage(url);

  const initials = getInitials(patientName);
  const bgColor = colorFor(patientName || patientId);
  const fontSize = Math.max(11, Math.round(size * 0.36));

  return (
    <div
      className={`rounded-full overflow-hidden shrink-0 flex items-center justify-center ${
        src ? 'bg-muted' : bgColor + ' text-white'
      } ${className}`}
      style={{ width: size, height: size, fontSize: `${fontSize}px` }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={patientName} className="w-full h-full object-cover" />
      ) : loading && avatarUrl ? (
        // Enquanto baixa, mantém iniciais pra evitar flash em branco
        <span className="font-semibold opacity-60">{initials}</span>
      ) : (
        <span className="font-semibold">{initials}</span>
      )}
    </div>
  );
}
