import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'enc:';

function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('ENCRYPTION_KEY ou JWT_SECRET deve estar definido para criptografia de segredos');
  }
  return scryptSync(secret, 'crm-settings-salt', 32);
}

export function encryptValue(plaintext: string): string {
  if (plaintext.startsWith(ENCRYPTED_PREFIX)) return plaintext; // Já criptografado
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Formato: enc:<iv_hex>:<tag_hex>:<encrypted_hex>
  return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptValue(ciphertext: string): string {
  if (!ciphertext.startsWith(ENCRYPTED_PREFIX)) return ciphertext; // Plaintext legacy
  const key = getEncryptionKey();
  const parts = ciphertext.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Formato de valor criptografado inválido');
  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/** Chaves que devem ser criptografadas no banco */
export const SENSITIVE_KEYS = new Set([
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  // Gravada criptografada a partir de agora; a já guardada em texto segue lida
  // (get() da API e decryptIfNeeded do worker aceitam os dois).
  'ANTHROPIC_API_KEY',
  'EVOLUTION_GLOBAL_APIKEY',
  'SMTP_PASS',
  'GOOGLE_TTS_API_KEY',
  'asaas_api_key',
  'asaas_webhook_token',
  'nfse_api_key',
  'GDRIVE_SERVICE_ACCOUNT_B64',
  'GDRIVE_OAUTH_CLIENT_ID',
  'GDRIVE_OAUTH_CLIENT_SECRET',
  'GDRIVE_OAUTH_REFRESH_TOKEN',
]);

/**
 * Segredos guardados POR CONTA, como `<chave>_<tenantId>` (ex.: a chave da NFS-e
 * de cada clínica). O nome exato não casa com SENSITIVE_KEYS; o prefixo, sim.
 * Nenhuma chave gravada antes desta lista começa com estes prefixos (as globais
 * casam pelo nome exato acima), então o comportamento delas não muda.
 */
export const SENSITIVE_KEY_PREFIXES_POR_CONTA: readonly string[] = ['nfse_api_key_'];

export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  return SENSITIVE_KEY_PREFIXES_POR_CONTA.some((p) => key.startsWith(p) && key.length > p.length);
}
