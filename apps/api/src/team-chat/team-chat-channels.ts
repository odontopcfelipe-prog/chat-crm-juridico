// Conversa da equipe — canais. Regras puras (sem banco) pra caber num teste.
//  - 'geral': a clínica toda.
//  - um canal por setor: qualquer pessoa entra e escreve (é assim que a recepção
//    fala com o Financeiro); quem é do setor acompanha o seu por padrão.
//  - 'dm:<idA>:<idB>': conversa direta, ids em ordem alfabética. Só os dois leem —
//    nem o admin abre.

export const TEAM_SECTOR_CHANNELS = ['recepcao', 'dentista', 'acd_asb', 'crc', 'financeiro', 'admin'] as const;
export const TEAM_CHANNELS = ['geral', ...TEAM_SECTOR_CHANNELS] as const;

export type TeamChannel =
  | { kind: 'geral'; id: 'geral' }
  | { kind: 'setor'; id: string }
  | { kind: 'dm'; id: string; users: [string, string] };

const USER_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Chave da conversa direta entre duas pessoas (mesma chave dos dois lados). */
export function dmChannel(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `dm:${x}:${y}`;
}

/** Lê o nome do canal; null = inválido (setor que não existe, dm torta, consigo mesmo). */
export function parseChannel(raw: unknown): TeamChannel | null {
  if (typeof raw !== 'string') return null;
  if (raw === 'geral') return { kind: 'geral', id: 'geral' };
  if ((TEAM_SECTOR_CHANNELS as readonly string[]).includes(raw)) return { kind: 'setor', id: raw };
  const m = /^dm:([^:]+):([^:]+)$/.exec(raw);
  if (!m) return null;
  const [, a, b] = m;
  if (!USER_ID.test(a) || !USER_ID.test(b) || a >= b) return null;
  return { kind: 'dm', id: raw, users: [a, b] };
}

/** Pode ler/escrever no canal? Canais abertos pra todos da clínica; dm só os dois. */
export function canUseChannel(channel: TeamChannel, userId: string): boolean {
  return channel.kind !== 'dm' || channel.users.includes(userId);
}

/** Na dm, quem é o outro. */
export function dmPeer(channel: TeamChannel, userId: string): string | null {
  if (channel.kind !== 'dm') return null;
  return channel.users[0] === userId ? channel.users[1] : channel.users[0];
}
