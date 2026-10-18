/**
 * Out/2026 — Esconde CONTATO do paciente e VALORES de quem não pode vê-los.
 *
 * Regra do dono pro Dentista: ele não pode ter o contato do paciente (telefone,
 * e-mail, endereço) nem ver orçamento/valores. Esconder só na tela não basta
 * (o JSON da API continuaria trazendo), então este interceptor global apaga
 * (null) essas chaves em QUALQUER resposta, em qualquer profundidade, quando o
 * usuário NÃO tem:
 *   - `view_patient_contact` → CONTACT_KEYS viram null
 *   - `view_values`          → VALUE_KEYS viram null
 *
 * Só afeta quem não tem a permissão (por padrão, o setor Dentista). ADMIN e
 * SUPER_ADMIN passam direto. Copia a estrutura em vez de mutar (respostas podem
 * vir de cache em memória compartilhado com outros usuários).
 *
 * Exceções: os próprios dados do usuário (/auth, /users/me) e a própria
 * comissão (/commissions/mine — o valor é dele).
 */
import {
  CallHandler, ExecutionContext, Injectable, NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PermissionsGuard } from '../../auth/decorators/requires-permission.decorator.js';
import { isAdminRole } from '../../auth/patient-scope.js';

export const CONTACT_KEYS = new Set([
  'phone', 'phone_number', 'phone2', 'mobile', 'celular', 'telefone',
  'whatsapp', 'whatsapp_number', 'contact_phone', 'remote_jid', 'remoteJid',
  'email',
  'address', 'address_number', 'address_complement', 'neighborhood', 'zip_code', 'cep',
  'emergency_contact_phone', 'guardian_phone',
]);

export const VALUE_KEYS = new Set([
  'unit_price', 'total_price', 'base_price', 'price', 'original_price', 'final_price',
  'subtotal', 'discount_percent', 'discount_value', 'total_value',
  'avista_discount_pct', 'chosen_down_payment', 'chosen_signal_value',
  'installment_value', 'amount', 'amount_paid', 'net_value', 'fee_value', 'paid_value',
]);

/** Chaves EXTRAS de valor só em rotas específicas (nome genérico demais pra global). */
const ROUTE_VALUE_KEYS: Record<string, string[]> = {
  // Selo de devedor no cabeçalho da ficha: { total } = quanto o paciente deve.
  '/calendar/patients/:patientId/block-status': ['total'],
};

const SKIP_ALL_PREFIXES = ['/auth', '/users/me'];
const SKIP_VALUES_PREFIXES = ['/commissions/mine'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Copia `data` trocando por null as chaves de `keys` (em qualquer nível). */
export function maskKeys(data: unknown, keys: Set<string>, depth = 0): unknown {
  if (depth > 25) return data;
  if (Array.isArray(data)) return data.map((v) => maskKeys(v, keys, depth + 1));
  if (!isPlainObject(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = keys.has(k) && v !== undefined ? null : maskKeys(v, keys, depth + 1);
  }
  return out;
}

@Injectable()
export class SensitiveDataInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const user = req?.user;
    if (!user?.id || isAdminRole(user.roles)) return next.handle();

    const path: string = String(req.route?.path || req.path || req.url || '').split('?')[0];
    if (SKIP_ALL_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return next.handle();

    const perms = await PermissionsGuard.permissionsFor(this.prisma, user.id, user.roles ?? []);
    const hideContact = !perms.has('view_patient_contact');
    const hideValues = !perms.has('view_values')
      && !SKIP_VALUES_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
    if (!hideContact && !hideValues) return next.handle();

    const keys = new Set<string>();
    if (hideContact) CONTACT_KEYS.forEach((k) => keys.add(k));
    if (hideValues) {
      VALUE_KEYS.forEach((k) => keys.add(k));
      (ROUTE_VALUE_KEYS[path] ?? []).forEach((k) => keys.add(k));
    }
    return next.handle().pipe(map((data) => maskKeys(data, keys)));
  }
}
