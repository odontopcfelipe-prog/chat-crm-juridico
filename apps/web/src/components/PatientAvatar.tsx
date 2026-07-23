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
import { useState } from 'react';
import { useAuthedImage } from '@/lib/use-authed-image';
import { API_BASE_URL } from '@/lib/api';

interface Props {
  patientId: string;
  patientName: string;
  /** patient.avatar_url do banco. Se null, mostra iniciais sem nem tentar request. */
  avatarUrl: string | null | undefined;
  /** Foto do WhatsApp (lead.profile_picture_url) — usada como fallback SÓ quando o
   *  paciente ainda não salvou uma foto própria. URL direta; some pras iniciais se falhar. */
  fallbackPhotoUrl?: string | null;
  /** Tamanho em px (largura = altura). Default 48. */
  size?: number;
  /** Classe Tailwind adicional pra container. */
  className?: string;
  /** Forma do avatar. 'rounded' (default) = quadrado com bordas arredondadas
      (rounded-xl); 'circle' = redondo (rounded-full). */
  shape?: 'rounded' | 'circle';
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
  fallbackPhotoUrl,
  size = 48,
  className = '',
  shape = 'rounded',
}: Props) {
  // Só dispara fetch se backend confirmou que existe avatar — evita 404 em
  // pacientes sem foto. ?t=<id> serve só pra invalidar cache se o id mudar.
  const url = avatarUrl ? `${API_BASE_URL}/patients/${patientId}/avatar` : null;
  const { src, loading } = useAuthedImage(url);
  const [waError, setWaError] = useState(false);
  // Foto do WhatsApp entra SÓ quando o paciente não tem foto própria (nem carregando)
  // e a URL não falhou. Assim que salvarem uma foto, o avatar_url ganha prioridade.
  const waPhoto = !avatarUrl && !waError ? (fallbackPhotoUrl || null) : null;

  const initials = getInitials(patientName);
  const bgColor = colorFor(patientName || patientId);
  const fontSize = Math.max(11, Math.round(size * 0.36));
  const shapeCls = shape === 'circle' ? 'rounded-full' : 'rounded-xl';

  return (
    <div
      data-component="patient-avatar"
      data-has-photo={src ? 'yes' : 'no'}
      className={`${shapeCls} overflow-hidden shrink-0 flex items-center justify-center select-none ${
        src || waPhoto ? 'bg-muted' : bgColor + ' text-white'
      } ${className}`}
      style={{ width: size, height: size, fontSize: `${fontSize}px` }}
      title={patientName}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={patientName} className="w-full h-full object-cover" />
      ) : waPhoto ? (
        // Foto do WhatsApp (URL direta). Se falhar/expirar, cai pras iniciais.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={waPhoto}
          alt={patientName}
          className="w-full h-full object-cover"
          onError={() => setWaError(true)}
        />
      ) : loading && avatarUrl ? (
        // Enquanto baixa, mantém iniciais pra evitar flash em branco
        <span className="font-semibold opacity-60 leading-none">{initials}</span>
      ) : (
        <span className="font-semibold leading-none">{initials}</span>
      )}
    </div>
  );
}
