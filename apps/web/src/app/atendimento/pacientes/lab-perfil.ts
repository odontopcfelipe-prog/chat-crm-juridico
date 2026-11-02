/**
 * F8 do laboratório — ficha do CLIENTE do laboratório (PatientLabProfile) no web:
 * tipo (dentista ou clínica), CRO, razão social ou clínica onde atende, dentistas que
 * pedem trabalhos, contato e observações de entrega.
 *
 * Leitura e gravação pelo GET/PUT /patients/:id/lab-profile (LabFichasController, só
 * do laboratório) e o corpo do PUT montado a partir do formulário do cadastro
 * (LabClienteModal). A ficha (LabPerfilNaFicha) só lê. Só telas do laboratório
 * importam daqui; os textos ficam em lab-dentistas-textos.ts.
 *
 * O PUT é parcial na API (chave ausente mantém, null limpa), mas o cadastro manda
 * sempre as chaves do formulário inteiro, com null no vazio e [] na lista. Nunca vai
 * chave fora de CAMPOS_DO_PERFIL (gravado, patient_id, updated_at...): o
 * ValidationPipe responde 400. Quem não vê contato não manda contact_phone: o GET
 * devolve null para ele, e reenviar esse null apagaria o telefone gravado.
 */
import {
  CAMPOS_DO_PERFIL,
  CRO_MAX_DIGITOS,
  normalizarCro,
  normalizarDentistas,
  tipoDoCliente,
  type PerfilDoClienteLab,
  type PerfilDoClienteLabResposta,
  type TipoCliente,
} from '@crm/shared';
import api from '@/lib/api';

/** Campos do perfil no formulário do cadastro (texto como está na tela). */
export interface FormDoPerfil {
  cro: string;
  croUf: string;
  razaoSocial: string;
  clinicaOndeAtende: string;
  contatoNome: string;
  contatoTel: string;
  entrega: string;
  dentistas: string[];
  /** Nome digitado no campo do dentista e ainda não adicionado: vai junto no salvar. */
  novoDentista?: string;
}

/** Texto aparado; vazio vira null. */
function textoOuNulo(v: string | null | undefined): string | null {
  const t = String(v ?? '').trim();
  return t ? t : null;
}

/** Fica só com as chaves que o PUT aceita (CAMPOS_DO_PERFIL). */
export function escolherChaves(obj: unknown): Partial<PerfilDoClienteLab> {
  const saida: Record<string, unknown> = {};
  if (!obj || typeof obj !== 'object') return saida as Partial<PerfilDoClienteLab>;
  const origem = obj as Record<string, unknown>;
  for (const chave of CAMPOS_DO_PERFIL) {
    if (Object.prototype.hasOwnProperty.call(origem, chave)) saida[chave] = origem[chave];
  }
  return saida as Partial<PerfilDoClienteLab>;
}

/** Resposta do GET/PUT com as chaves de sempre (lista nunca nula, tipo sempre válido). */
function comoResposta(data: unknown, patientId: string, cpf: string | null | undefined): PerfilDoClienteLabResposta {
  if (!data || typeof data !== 'object') throw new TypeError();
  const d = data as Partial<PerfilDoClienteLabResposta>;
  const texto = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    patient_id: texto(d.patient_id) ?? patientId,
    gravado: d.gravado === true,
    updated_at: texto(d.updated_at),
    kind: tipoDoCliente(d.kind, cpf),
    cro_number: texto(d.cro_number),
    cro_uf: texto(d.cro_uf),
    legal_name: texto(d.legal_name),
    clinic_name: texto(d.clinic_name),
    contact_name: texto(d.contact_name),
    contact_phone: texto(d.contact_phone),
    requesting_dentists: Array.isArray(d.requesting_dentists)
      ? d.requesting_dentists.filter((n): n is string => typeof n === 'string')
      : [],
    delivery_notes: texto(d.delivery_notes),
  };
}

/** GET /patients/:id/lab-profile. Sem ficha gravada, a API devolve gravado=false e o tipo pelo documento. */
export async function carregarPerfil(patientId: string, cpf?: string | null): Promise<PerfilDoClienteLabResposta> {
  const { data } = await api.get(`/patients/${patientId}/lab-profile`);
  return comoResposta(data, patientId, cpf);
}

/** PUT /patients/:id/lab-profile com as chaves aceitas. Devolve a ficha gravada (null se a resposta vier vazia). */
export async function salvarPerfil(
  patientId: string,
  corpo: Partial<PerfilDoClienteLab>,
): Promise<PerfilDoClienteLabResposta | null> {
  const { data } = await api.put(`/patients/${patientId}/lab-profile`, escolherChaves(corpo));
  return data && typeof data === 'object' ? comoResposta(data, patientId, null) : null;
}

/**
 * Corpo do PUT a partir do formulário: as chaves do perfil, com null no vazio e [] na lista.
 * - CRO só com dígitos (normalizarCro); UF só quando há número.
 * - Razão social só para clínica; clínica onde atende só para dentista.
 * - Dentistas que pedem trabalhos só para clínica (com o nome digitado e não adicionado).
 * - contact_phone só para quem vê contato (podeVerContato).
 */
export function corpoDoPerfil(form: FormDoPerfil, tipo: TipoCliente, podeVerContato: boolean): Partial<PerfilDoClienteLab> {
  const ehClinica = tipo === 'CLINICA';
  const cro_number = normalizarCro(form.cro);
  const corpo: Partial<PerfilDoClienteLab> = {
    kind: tipo,
    cro_number,
    cro_uf: cro_number ? textoOuNulo(form.croUf) : null,
    legal_name: ehClinica ? textoOuNulo(form.razaoSocial) : null,
    clinic_name: ehClinica ? null : textoOuNulo(form.clinicaOndeAtende),
    contact_name: textoOuNulo(form.contatoNome),
    requesting_dentists: ehClinica ? normalizarDentistas([...form.dentistas, form.novoDentista ?? '']) : [],
    delivery_notes: textoOuNulo(form.entrega),
  };
  if (podeVerContato) corpo.contact_phone = textoOuNulo(form.contatoTel);
  return corpo;
}

/** Campo do CRO conforme digita: só dígitos, até CRO_MAX_DIGITOS. */
export function soDigitosDoCro(v: string): string {
  return v.replace(/\D/g, '').slice(0, CRO_MAX_DIGITOS);
}

/** Telefone do contato: vazio ou 10/11 dígitos (DDD + número; pode ser fixo). */
export function telefoneDoContatoOk(v: string): boolean {
  const d = v.replace(/\D/g, '');
  return d.length === 0 || d.length === 10 || d.length === 11;
}
