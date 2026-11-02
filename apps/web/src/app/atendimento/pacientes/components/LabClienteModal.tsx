'use client';

/**
 * F5 do laboratório — cadastro e edição do CLIENTE do laboratório (um dentista ou uma
 * clínica). Só o laboratório monta este modal: o NewPatientModal e o EditPatientModal
 * escolhem entre ele e o cadastro de hoje pelo tipo de negócio da sessão, com as mesmas
 * props (quem abre o modal não muda).
 *
 * Campos: tipo (Dentista ou Clínica), nome, WhatsApp (com DDI), CPF (dentista,
 * opcional) ou CNPJ (clínica, obrigatório, aceita o formato alfanumérico), e-mail,
 * endereço com a busca do CEP, observações e, no cadastro novo, a foto (enviada depois
 * de criar o cadastro, como no cadastro de hoje).
 *
 * Na criação, o tipo sai do tamanho do documento (11 posições = dentista, 14 = clínica)
 * e o documento é gravado com a máscara. O corpo do cadastro leva só nome, telefone,
 * documento, e-mail, endereço e observações; no editar vão as mesmas chaves, com null
 * no campo apagado. Sem etiquetas: elas ficam na ficha.
 *
 * F8 — a ficha do cliente (lab-perfil.ts, PUT /patients/:id/lab-profile): o tipo
 * gravado, CRO e UF (obrigatórios para dentista, opcionais e em par para clínica),
 * razão social (clínica) ou clínica onde atende (dentista), os dentistas que pedem
 * trabalhos (clínica), contato e observações de entrega. É gravada DEPOIS do cadastro
 * (como a foto): no novo, depois do POST; no editar, depois do PATCH. No editar, os
 * campos da ficha e o Salvar esperam a ficha carregar; se a carga falhar, o resto é
 * salvo e a ficha fica como está (sem PUT). Também avisa, sem bloquear, quando o
 * WhatsApp digitado já é de outro cliente (GET /leads/check-phone e
 * /patients/by-lead/:id, só para quem vê contato).
 *
 * Todo texto visível vem de lab-dentistas-textos.ts.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Camera, Loader2, MapPin, Save, Trash2, Truck, Upload, User, UserPlus, Users, X } from 'lucide-react';
import {
  CRO_MAX_DIGITOS,
  LIMITES_DO_PERFIL,
  MAX_DENTISTAS_SOLICITANTES,
  maskCpfCnpjInput,
  normalizarCro,
  normalizarDentistas,
  tipoDoDocumento,
  vCpfCnpj,
  type TipoCliente,
} from '@crm/shared';
import api from '@/lib/api';
import { showError, showInfo, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { maskCEPInput, maskPhoneInput, vCEP, vPhone } from '@/lib/utils';
import { LAB_CADASTRO } from '../lab-dentistas-textos';
import { carregarPerfil, corpoDoPerfil, salvarPerfil, soDigitosDoCro, telefoneDoContatoOk } from '../lab-perfil';

/** O que o editar recebe da ficha (o mesmo objeto que vai ao modal de hoje). */
interface ClienteDoLab {
  id: string;
  name: string | null;
  phone: string | null;
  cpf: string | null;
  email: string | null;
  zip_code?: string | null;
  address: string | null;
  address_number?: string | null;
  address_complement?: string | null;
  neighborhood?: string | null;
  city: string | null;
  state: string | null;
  notes?: string | null;
}

type Props =
  | { modo: 'novo'; onClose: () => void; onCreated: (patient: unknown) => void }
  | { modo: 'editar'; patient: ClienteDoLab; onClose: () => void; onUpdated: () => void };

interface Formulario {
  nome: string;
  tel: string;
  doc: string;
  email: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  notas: string;
  // F8 — ficha do cliente
  cro: string;
  croUf: string;
  razaoSocial: string;
  clinicaOndeAtende: string;
  contatoNome: string;
  contatoTel: string;
  entrega: string;
  dentistas: string[];
}

type CampoComErro = 'tel' | 'doc' | 'cep' | 'email' | 'cro' | 'contatoTel';

/** Carga da ficha do cliente no editar (no novo já começa pronta). */
type EstadoDoPerfil = 'carregando' | 'pronto' | 'falhou';

const TIPOS: readonly TipoCliente[] = ['DENTISTA', 'CLINICA'];

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const inputCls = 'w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30';
/** Campos da ficha do cliente: travados enquanto ela carrega (ou se não carregou). */
const perfilCls = `${inputCls} disabled:opacity-60 disabled:cursor-not-allowed`;

/** Mensagem que a API devolveu num erro (o servidor já manda o texto do laboratório). */
function mensagemDaApi(err: unknown): string | undefined {
  const msg = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  if (typeof msg === 'string') return msg || undefined;
  // Validação do corpo: lista de mensagens.
  if (Array.isArray(msg)) return msg.filter((m): m is string => typeof m === 'string' && !!m).join(' · ') || undefined;
  return undefined;
}

/**
 * Telefone gravado → DDI + número com máscara. O cadastro grava "+DDI (DDD) número"
 * e isso volta separado; número sem DDI (ou com o 55 colado) fica com DDI 55.
 */
function separarTelefone(gravado: string | null | undefined): { ddi: string; tel: string } {
  const t = String(gravado ?? '').trim();
  if (!t) return { ddi: '55', tel: '' };
  const comDdi = /^\+(\d{1,3})\s+(.+)$/.exec(t);
  if (comDdi) return { ddi: comDdi[1], tel: maskPhoneInput(comDdi[2]) };
  return { ddi: '55', tel: maskPhoneInput(t) };
}

/** Telefone digitado no formato que o cadastro grava: "+DDI (DDD) número". */
function telefoneComDdi(ddi: string, tel: string): string {
  return `+${ddi || '55'} ${tel.trim()}`;
}

export default function LabClienteModal(props: Props) {
  const { onClose } = props;
  const editando = props.modo === 'editar';
  const cadastro = props.modo === 'editar' ? props.patient : null;
  // Mesma regra da busca por telefone: só quem vê contato recebe o aviso e grava o telefone do contato.
  const podeVerContato = useUserPermissions().hasPermission('view_patient_contact');

  const [salvando, setSalvando] = useState(false);
  const [cepBuscando, setCepBuscando] = useState(false);
  // Na edição o tipo vem do documento gravado (até a ficha do cliente carregar); sem
  // documento (ou de outro tamanho) é dentista.
  const [tipo, setTipo] = useState<TipoCliente>(() => tipoDoDocumento(cadastro?.cpf) ?? 'DENTISTA');
  const [telInicial] = useState(() => separarTelefone(cadastro?.phone));
  const [ddi, setDdi] = useState(telInicial.ddi);
  const [form, setForm] = useState<Formulario>(() => ({
    nome: cadastro?.name ?? '',
    tel: telInicial.tel,
    // O documento gravado aparece como está (a máscara entra quando a pessoa digita).
    doc: cadastro?.cpf ?? '',
    email: cadastro?.email ?? '',
    cep: cadastro?.zip_code ?? '',
    logradouro: cadastro?.address ?? '',
    numero: cadastro?.address_number ?? '',
    complemento: cadastro?.address_complement ?? '',
    bairro: cadastro?.neighborhood ?? '',
    cidade: cadastro?.city ?? '',
    uf: cadastro?.state ?? '',
    notas: cadastro?.notes ?? '',
    cro: '',
    croUf: '',
    razaoSocial: '',
    clinicaOndeAtende: '',
    contatoNome: '',
    contatoTel: '',
    entrega: '',
    dentistas: [],
  }));
  const [erros, setErros] = useState<Partial<Record<CampoComErro, string>>>({});
  const [perfilEstado, setPerfilEstado] = useState<EstadoDoPerfil>(() => (editando ? 'carregando' : 'pronto'));
  const perfilPronto = perfilEstado === 'pronto';
  // Nome digitado no campo do dentista e ainda não adicionado (entra junto no salvar).
  const [novoDentista, setNovoDentista] = useState('');
  // Aviso de telefone de outro cliente: guardado com o telefone que foi conferido.
  const [avisoTel, setAvisoTel] = useState<{ chave: string; nome: string } | null>(null);

  // Foto: só no cadastro novo; o envio acontece depois de criar (precisa do id).
  const [foto, setFoto] = useState<File | null>(null);
  const [fotoPreview, setFotoPreview] = useState<string | null>(null);
  const fotoRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Formulario>(campo: K, valor: Formulario[K]) => setForm((f) => ({ ...f, [campo]: valor }));
  const setErro = (campo: CampoComErro, msg: string) => setErros((e) => ({ ...e, [campo]: msg }));

  // Telefone intocado não é validado nem conferido: fica o gravado (mesma regra do
  // telefoneParaGravar), como o do WhatsApp, que chega no formato 55 + DDD + 8 dígitos.
  const telIntocado = Boolean(cadastro?.phone) && ddi === telInicial.ddi && form.tel === telInicial.tel;
  const chaveDoTel = `${ddi}|${form.tel}`;
  const nomeDoOutroCliente =
    podeVerContato && !telIntocado && avisoTel && avisoTel.chave === chaveDoTel ? avisoTel.nome : null;

  const escolherFoto = (arquivo: File) => {
    if (!arquivo.type.startsWith('image/')) {
      showError(LAB_CADASTRO.fotoSoImagem);
      return;
    }
    if (arquivo.size > 2 * 1024 * 1024) {
      showError(LAB_CADASTRO.fotoMaxima);
      return;
    }
    if (fotoPreview) URL.revokeObjectURL(fotoPreview);
    setFoto(arquivo);
    setFotoPreview(URL.createObjectURL(arquivo));
  };

  const removerFoto = () => {
    if (fotoPreview) URL.revokeObjectURL(fotoPreview);
    setFoto(null);
    setFotoPreview(null);
    if (fotoRef.current) fotoRef.current.value = '';
  };

  // Ao fechar o modal, solta a prévia da foto.
  useEffect(() => {
    return () => {
      if (fotoPreview) URL.revokeObjectURL(fotoPreview);
    };
    // Só o desmonte: a troca de foto já solta a prévia anterior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F8 — editar: carrega a ficha do cliente. Até chegar, os campos dela e o Salvar ficam
  // travados (o que chega não atropela o que a pessoa digitou). Falhou: o resto é salvo
  // e a ficha fica como está (sem PUT).
  const cadastroId = cadastro?.id;
  const cadastroCpf = cadastro?.cpf;
  useEffect(() => {
    if (!cadastroId) return;
    let cancelado = false;
    carregarPerfil(cadastroId, cadastroCpf)
      .then((p) => {
        if (cancelado) return;
        // O tipo gravado vale mais que o documento (a máscara do documento não muda).
        if (p.gravado) setTipo(p.kind);
        setForm((f) => ({
          ...f,
          cro: p.cro_number ?? '',
          croUf: p.cro_uf ?? '',
          razaoSocial: p.legal_name ?? '',
          clinicaOndeAtende: p.clinic_name ?? '',
          contatoNome: p.contact_name ?? '',
          contatoTel: p.contact_phone ?? '',
          entrega: p.delivery_notes ?? '',
          dentistas: [...p.requesting_dentists],
        }));
        setPerfilEstado('pronto');
      })
      .catch(() => {
        if (cancelado) return;
        setPerfilEstado('falhou');
        showError(LAB_CADASTRO.perfilNaoCarregou);
      });
    return () => {
      cancelado = true;
    };
  }, [cadastroId, cadastroCpf]);

  // F8 — aviso (sem bloquear) quando o WhatsApp digitado já é de outro cliente da conta.
  // Só para quem vê contato, com o telefone mexido e 10 dígitos ou mais; o valor
  // conferido é o mesmo que o cadastro grava. Erro é engolido: o aviso só ajuda.
  useEffect(() => {
    if (!podeVerContato || telIntocado || form.tel.replace(/\D/g, '').length < 10) return;
    let cancelado = false;
    const chave = `${ddi}|${form.tel}`;
    const espera = setTimeout(async () => {
      try {
        const r = await api.get('/leads/check-phone', { params: { phone: telefoneComDdi(ddi, form.tel) } });
        const leadId: unknown = r?.data?.exists ? r?.data?.lead?.id : null;
        if (cancelado || typeof leadId !== 'string' || !leadId) return;
        const dono = await api.get(`/patients/by-lead/${leadId}`);
        const outro = dono?.data as { id?: unknown; name?: unknown } | null | undefined;
        if (cancelado || !outro || typeof outro.id !== 'string' || outro.id === cadastroId) return;
        const nome = typeof outro.name === 'string' ? outro.name.trim() : '';
        setAvisoTel({ chave, nome: nome || LAB_CADASTRO.semNome });
      } catch {
        // o aviso só ajuda: sem ele, o salvar segue igual
      }
    }, 500);
    return () => {
      cancelado = true;
      clearTimeout(espera);
    };
  }, [ddi, form.tel, podeVerContato, telIntocado, cadastroId]);

  // Busca do endereço pelo CEP (ViaCEP): preenche só o que estiver vazio.
  useEffect(() => {
    const limpo = form.cep.replace(/\D/g, '');
    if (limpo.length !== 8) return;
    let cancelado = false;
    setCepBuscando(true);
    fetch(`https://viacep.com.br/ws/${limpo}/json/`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelado || d?.erro) return;
        setForm((f) => ({
          ...f,
          logradouro: f.logradouro || d.logradouro || '',
          bairro: f.bairro || d.bairro || '',
          cidade: f.cidade || d.localidade || '',
          uf: f.uf || d.uf || '',
        }));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelado) setCepBuscando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [form.cep]);

  // Trocar o tipo refaz a máscara do documento (CPF só números; CNPJ aceita letra).
  const trocarTipo = (novo: TipoCliente) => {
    if (novo === tipo) return;
    setTipo(novo);
    setForm((f) => ({ ...f, doc: maskCpfCnpjInput(f.doc, novo) }));
    setErro('doc', '');
  };

  /** Telefone para gravar: sem mexer no campo, fica exatamente o que está gravado. */
  const telefoneParaGravar = (): string | null => {
    const tel = form.tel.trim();
    if (!tel) return null;
    if (cadastro?.phone && telIntocado) return cadastro.phone;
    return telefoneComDdi(ddi, tel);
  };

  // Dentistas que pedem trabalhos (só clínica): sem repetidos, no máximo MAX_DENTISTAS_SOLICITANTES.
  const listaCheia = form.dentistas.length >= MAX_DENTISTAS_SOLICITANTES;
  const adicionarDentista = () => {
    if (!novoDentista.trim()) return;
    const lista = normalizarDentistas([...form.dentistas, novoDentista]);
    if (lista.length > MAX_DENTISTAS_SOLICITANTES) return;
    set('dentistas', lista);
    setNovoDentista('');
  };
  const removerDentista = (nome: string) => set('dentistas', form.dentistas.filter((n) => n !== nome));

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (salvando || perfilEstado === 'carregando') return;

    const cro = form.cro.trim();
    const faltando: string[] = [];
    if (!form.nome.trim()) faltando.push(LAB_CADASTRO.campos.nome);
    if (!form.tel.trim()) faltando.push(LAB_CADASTRO.campos.whatsapp);
    if (tipo === 'CLINICA' && !form.doc.trim()) faltando.push(LAB_CADASTRO.campos.cnpj);
    // Ficha do cliente (só quando carregou): dentista exige CRO e UF; clínica, os dois ou nenhum.
    if (perfilPronto) {
      if (tipo === 'DENTISTA') {
        if (!cro) faltando.push(LAB_CADASTRO.campos.cro);
        if (!form.croUf) faltando.push(LAB_CADASTRO.campos.croUf);
      } else if (!cro !== !form.croUf) {
        faltando.push(cro ? LAB_CADASTRO.campos.croUf : LAB_CADASTRO.campos.cro);
      }
    }
    if (faltando.length > 0) {
      showError(LAB_CADASTRO.preencha(faltando.join(', ')));
      return;
    }

    const formato: Record<CampoComErro, string> = {
      tel: telIntocado ? '' : vPhone(form.tel),
      doc: vCpfCnpj(form.doc, tipo),
      cep: vCEP(form.cep),
      email: form.email.trim() && !EMAIL_OK.test(form.email.trim()) ? LAB_CADASTRO.emailInvalido : '',
      cro: perfilPronto && cro && normalizarCro(cro) === null ? LAB_CADASTRO.croDica : '',
      contatoTel:
        perfilPronto && podeVerContato && !telefoneDoContatoOk(form.contatoTel) ? LAB_CADASTRO.contatoTelefoneInvalido : '',
    };
    const ruins = (Object.keys(formato) as CampoComErro[]).filter((k) => formato[k]);
    if (ruins.length > 0) {
      setErros((atual) => ({ ...atual, ...formato }));
      const nomes: Record<CampoComErro, string> = {
        tel: LAB_CADASTRO.campos.whatsapp,
        doc: LAB_CADASTRO.campos.documento,
        cep: LAB_CADASTRO.campos.cep,
        email: LAB_CADASTRO.campos.email,
        cro: LAB_CADASTRO.campos.cro,
        contatoTel: LAB_CADASTRO.campos.contatoTelefone,
      };
      showError(LAB_CADASTRO.corrija(ruins.map((k) => nomes[k]).join(', ')));
      return;
    }

    // Só as chaves do cadastro que o laboratório usa. Vazio = null (no novo, nem vai).
    const campos: Record<string, string | null> = {
      name: form.nome.trim(),
      phone: telefoneParaGravar(),
      cpf: form.doc.trim() || null,
      email: form.email.trim() || null,
      zip_code: form.cep.trim() || null,
      address: form.logradouro.trim() || null,
      address_number: form.numero.trim() || null,
      address_complement: form.complemento.trim() || null,
      neighborhood: form.bairro.trim() || null,
      city: form.cidade.trim() || null,
      state: form.uf || null,
      notes: form.notas.trim() || null,
    };
    // Ficha do cliente: gravada depois do cadastro. Sem carga (falhou), não vai.
    const perfil = perfilPronto ? corpoDoPerfil({ ...form, novoDentista }, tipo, podeVerContato) : null;

    setSalvando(true);
    try {
      if (props.modo === 'editar') {
        const res = await api.patch(`/patients/${props.patient.id}`, campos);
        showSuccess(LAB_CADASTRO.atualizado);
        // Telefone trocado: o contato do WhatsApp vai junto (ou a API diz por que não foi).
        const contato: unknown = res?.data?.whatsapp_contato;
        if (typeof contato === 'string') {
          const foi: Readonly<Record<string, string>> = LAB_CADASTRO.whatsappFoiJunto;
          const ficou: Readonly<Record<string, string>> = LAB_CADASTRO.whatsappFicou;
          if (Object.prototype.hasOwnProperty.call(foi, contato)) showInfo(foi[contato]);
          else if (Object.prototype.hasOwnProperty.call(ficou, contato)) showError(ficou[contato]);
        }
        // Ficha do cliente depois do PATCH. Se falhar, o modal fica aberto: o Salvar de
        // novo regrava os dois (o PATCH repetido não muda nada).
        if (perfil) {
          try {
            await salvarPerfil(props.patient.id, perfil);
          } catch (err: unknown) {
            showError(LAB_CADASTRO.perfilFalhouEditar(mensagemDaApi(err) || LAB_CADASTRO.perfilFalhouEditarPadrao));
            return;
          }
        }
        props.onUpdated();
        return;
      }

      const corpo = Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== null));
      const { data } = await api.post('/patients', corpo);
      // Ficha do cliente: depois de criar. Se falhar, o cadastro fica (avisa e segue).
      if (perfil && data?.id) {
        try {
          await salvarPerfil(data.id, perfil);
        } catch (err: unknown) {
          showError(LAB_CADASTRO.perfilFalhouNovo(mensagemDaApi(err) || LAB_CADASTRO.perfilFalhouNovoPadrao));
        }
      }
      // Foto: envio depois de criar. Se falhar, o cadastro fica (avisa e segue).
      if (foto && data?.id) {
        try {
          const fd = new FormData();
          fd.append('file', foto);
          await api.post(`/patients/${data.id}/avatar`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
        } catch (err: unknown) {
          showError(LAB_CADASTRO.fotoFalhou(mensagemDaApi(err) || LAB_CADASTRO.fotoFalhouPadrao));
        }
      }
      showSuccess(LAB_CADASTRO.cadastrado);
      props.onCreated(data);
    } catch (err: unknown) {
      showError(mensagemDaApi(err) || (editando ? LAB_CADASTRO.erroSalvar : LAB_CADASTRO.erroCadastrar));
    } finally {
      setSalvando(false);
    }
  };

  const ehClinica = tipo === 'CLINICA';

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <div className="flex items-center gap-2">
            {editando ? <User size={20} className="text-primary" /> : <UserPlus size={20} className="text-primary" />}
            <h2 className="text-lg font-semibold">{editando ? LAB_CADASTRO.tituloEditar : LAB_CADASTRO.tituloNovo}</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1 hover:bg-accent rounded" title={LAB_CADASTRO.fechar} aria-label={LAB_CADASTRO.fechar}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={enviar} className="p-4 space-y-5">
          {!editando && (
            <div className="flex items-center gap-4">
              <input
                ref={fotoRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) escolherFoto(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fotoRef.current?.click()}
                className="relative w-16 h-16 rounded-full bg-primary/10 hover:bg-primary/15 flex items-center justify-center overflow-hidden shrink-0 border-2 border-dashed border-primary/30"
                title={fotoPreview ? LAB_CADASTRO.trocarFoto : LAB_CADASTRO.escolherFoto}
              >
                {fotoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fotoPreview} alt={LAB_CADASTRO.foto} className="w-full h-full object-cover" />
                ) : (
                  <Camera size={20} className="text-primary/70" />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground mb-0.5">
                  {fotoPreview ? LAB_CADASTRO.fotoSelecionada : LAB_CADASTRO.foto}
                </p>
                <p className="text-[11px] text-muted-foreground mb-1.5">{LAB_CADASTRO.fotoDica}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => fotoRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent hover:bg-accent/80 text-accent-foreground text-[11px] font-medium"
                  >
                    <Upload size={11} />
                    {fotoPreview ? LAB_CADASTRO.trocarFoto : LAB_CADASTRO.escolherFoto}
                  </button>
                  {fotoPreview && (
                    <button
                      type="button"
                      onClick={removerFoto}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-destructive hover:bg-destructive/10 text-[11px] font-medium"
                    >
                      <Trash2 size={11} />
                      {LAB_CADASTRO.removerFoto}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <Secao icone={<User size={14} />} titulo={LAB_CADASTRO.identificacao}>
            <div>
              <span className="block text-xs font-medium mb-1 text-muted-foreground">{LAB_CADASTRO.tipo}</span>
              <div className="inline-flex rounded-lg border border-border bg-background p-0.5" role="radiogroup" aria-label={LAB_CADASTRO.tipo}>
                {TIPOS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={tipo === t}
                    onClick={() => trocarTipo(t)}
                    disabled={perfilEstado === 'carregando'}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                      tipo === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {LAB_CADASTRO.tipos[t]}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">{LAB_CADASTRO.tipoDica}</p>
            </div>

            <Campo rotulo={LAB_CADASTRO.nome} obrigatorio>
              <input
                type="text"
                value={form.nome}
                onChange={(e) => set('nome', e.target.value)}
                placeholder={LAB_CADASTRO.nomeExemplo[tipo]}
                required
                autoFocus={!editando}
                className={inputCls}
              />
            </Campo>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Campo rotulo={LAB_CADASTRO.whatsapp} obrigatorio erro={erros.tel} aviso={nomeDoOutroCliente ? LAB_CADASTRO.telefoneDeOutroCliente(nomeDoOutroCliente) : undefined}>
                <div className="flex items-stretch gap-1.5">
                  <div className="flex items-center rounded-lg bg-background border border-border px-2 shrink-0">
                    <span className="text-sm text-muted-foreground">+</span>
                    <input
                      type="tel"
                      value={ddi}
                      onChange={(e) => setDdi(e.target.value.replace(/\D/g, '').slice(0, 3))}
                      title={LAB_CADASTRO.ddiDica}
                      aria-label={LAB_CADASTRO.ddiDica}
                      className="w-8 bg-transparent text-sm text-center focus:outline-none"
                    />
                  </div>
                  <input
                    type="tel"
                    value={form.tel}
                    onChange={(e) => {
                      const v = maskPhoneInput(e.target.value);
                      set('tel', v);
                      setErro('tel', vPhone(v));
                    }}
                    placeholder={LAB_CADASTRO.telefoneExemplo}
                    className={`${inputCls}${erros.tel ? ' !border-red-500' : ''}`}
                  />
                </div>
              </Campo>

              <Campo rotulo={ehClinica ? LAB_CADASTRO.cnpj : LAB_CADASTRO.cpf} obrigatorio={ehClinica} opcional={!ehClinica} erro={erros.doc}>
                <input
                  type="text"
                  value={form.doc}
                  onChange={(e) => {
                    const v = maskCpfCnpjInput(e.target.value, tipo);
                    set('doc', v);
                    setErro('doc', vCpfCnpj(v, tipo));
                  }}
                  placeholder={ehClinica ? LAB_CADASTRO.cnpjExemplo : LAB_CADASTRO.cpfExemplo}
                  autoCapitalize={ehClinica ? 'characters' : undefined}
                  className={`${inputCls}${erros.doc ? ' !border-red-500' : ''}`}
                />
                {ehClinica && <p className="text-[11px] text-muted-foreground mt-1">{LAB_CADASTRO.cnpjDica}</p>}
              </Campo>
            </div>

            {/* F8 — ficha do cliente: CRO e UF, razão social (clínica) ou clínica onde atende (dentista). */}
            {perfilEstado === 'carregando' && (
              <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                {LAB_CADASTRO.perfilCarregando}
              </p>
            )}
            {perfilEstado === 'falhou' && (
              <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">{LAB_CADASTRO.perfilNaoCarregou}</p>
            )}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Campo rotulo={LAB_CADASTRO.cro} obrigatorio={!ehClinica} opcional={ehClinica} erro={erros.cro}>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.cro}
                  onChange={(e) => {
                    set('cro', soDigitosDoCro(e.target.value));
                    if (erros.cro) setErro('cro', '');
                  }}
                  placeholder={LAB_CADASTRO.croExemplo}
                  maxLength={CRO_MAX_DIGITOS}
                  disabled={!perfilPronto}
                  className={`${perfilCls}${erros.cro ? ' !border-red-500' : ''}`}
                />
              </Campo>
              <Campo rotulo={LAB_CADASTRO.croUf} obrigatorio={!ehClinica} opcional={ehClinica}>
                <select
                  value={form.croUf}
                  onChange={(e) => set('croUf', e.target.value)}
                  disabled={!perfilPronto}
                  aria-label={LAB_CADASTRO.croUf}
                  className={perfilCls}
                >
                  <option value="">{LAB_CADASTRO.uf}</option>
                  {UFS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Campo>
              {ehClinica ? (
                <Campo rotulo={LAB_CADASTRO.razaoSocial} className="md:col-span-2">
                  <input
                    type="text"
                    value={form.razaoSocial}
                    onChange={(e) => set('razaoSocial', e.target.value)}
                    placeholder={LAB_CADASTRO.razaoSocialExemplo}
                    maxLength={LIMITES_DO_PERFIL.legal_name}
                    disabled={!perfilPronto}
                    className={perfilCls}
                  />
                </Campo>
              ) : (
                <Campo rotulo={LAB_CADASTRO.clinicaOndeAtende} opcional className="md:col-span-2">
                  <input
                    type="text"
                    value={form.clinicaOndeAtende}
                    onChange={(e) => set('clinicaOndeAtende', e.target.value)}
                    placeholder={LAB_CADASTRO.clinicaOndeAtendeExemplo}
                    maxLength={LIMITES_DO_PERFIL.clinic_name}
                    disabled={!perfilPronto}
                    className={perfilCls}
                  />
                </Campo>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground -mt-1">{LAB_CADASTRO.croDica}</p>

            <Campo rotulo={LAB_CADASTRO.email} erro={erros.email}>
              <input
                type="email"
                value={form.email}
                onChange={(e) => {
                  set('email', e.target.value);
                  if (erros.email) setErro('email', '');
                }}
                className={`${inputCls}${erros.email ? ' !border-red-500' : ''}`}
              />
            </Campo>
          </Secao>

          {ehClinica && (
            <Secao icone={<Users size={14} />} titulo={LAB_CADASTRO.dentistas}>
              <p className="text-[11px] text-muted-foreground -mt-1">{LAB_CADASTRO.dentistasDica}</p>
              <div className="flex items-stretch gap-1.5">
                <input
                  type="text"
                  value={novoDentista}
                  onChange={(e) => setNovoDentista(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter adiciona o nome (sem enviar o formulário).
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      adicionarDentista();
                    }
                  }}
                  placeholder={LAB_CADASTRO.dentistaExemplo}
                  maxLength={LIMITES_DO_PERFIL.dentista}
                  disabled={!perfilPronto || listaCheia}
                  aria-label={LAB_CADASTRO.dentistas}
                  className={`${perfilCls} flex-1`}
                />
                <button
                  type="button"
                  onClick={adicionarDentista}
                  disabled={!perfilPronto || listaCheia || !novoDentista.trim()}
                  className="px-3 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  {LAB_CADASTRO.adicionarDentista}
                </button>
              </div>
              {form.dentistas.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {form.dentistas.map((nome) => (
                    <span
                      key={nome}
                      className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-accent text-accent-foreground text-xs font-medium"
                    >
                      {nome}
                      <button
                        type="button"
                        onClick={() => removerDentista(nome)}
                        disabled={!perfilPronto}
                        className="p-0.5 rounded hover:bg-background/60 disabled:cursor-not-allowed"
                        title={LAB_CADASTRO.removerDentista(nome)}
                        aria-label={LAB_CADASTRO.removerDentista(nome)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">{LAB_CADASTRO.semDentistas}</p>
              )}
              {listaCheia && (
                <p className="text-[11px] text-muted-foreground">{LAB_CADASTRO.dentistasLimite(MAX_DENTISTAS_SOLICITANTES)}</p>
              )}
            </Secao>
          )}

          <Secao icone={<MapPin size={14} />} titulo={LAB_CADASTRO.endereco}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Campo rotulo={LAB_CADASTRO.cep} extra={cepBuscando ? LAB_CADASTRO.buscandoCep : undefined} erro={erros.cep}>
                <input
                  value={form.cep}
                  onChange={(e) => {
                    const v = maskCEPInput(e.target.value);
                    set('cep', v);
                    setErro('cep', vCEP(v));
                  }}
                  placeholder={LAB_CADASTRO.cepExemplo}
                  maxLength={9}
                  className={`${inputCls}${erros.cep ? ' !border-red-500' : ''}`}
                />
              </Campo>
              <Campo rotulo={LAB_CADASTRO.logradouro} className="md:col-span-2">
                <input value={form.logradouro} onChange={(e) => set('logradouro', e.target.value)} className={inputCls} />
              </Campo>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Campo rotulo={LAB_CADASTRO.numero}>
                <input value={form.numero} onChange={(e) => set('numero', e.target.value)} className={inputCls} />
              </Campo>
              <Campo rotulo={LAB_CADASTRO.complemento}>
                <input value={form.complemento} onChange={(e) => set('complemento', e.target.value)} className={inputCls} />
              </Campo>
              <Campo rotulo={LAB_CADASTRO.bairro}>
                <input value={form.bairro} onChange={(e) => set('bairro', e.target.value)} className={inputCls} />
              </Campo>
              <Campo rotulo={LAB_CADASTRO.cidadeUf}>
                <div className="flex gap-1">
                  <input
                    value={form.cidade}
                    onChange={(e) => set('cidade', e.target.value)}
                    placeholder={LAB_CADASTRO.cidade}
                    className={`${inputCls} flex-1`}
                  />
                  <select value={form.uf} onChange={(e) => set('uf', e.target.value)} className={`${inputCls} !w-20 shrink-0`} aria-label={LAB_CADASTRO.uf}>
                    <option value="">{LAB_CADASTRO.uf}</option>
                    {UFS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </Campo>
            </div>
          </Secao>

          <Secao icone={<Truck size={14} />} titulo={LAB_CADASTRO.contatoEntrega}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Campo rotulo={LAB_CADASTRO.contatoNome}>
                <input
                  type="text"
                  value={form.contatoNome}
                  onChange={(e) => set('contatoNome', e.target.value)}
                  placeholder={LAB_CADASTRO.contatoNomeExemplo}
                  maxLength={LIMITES_DO_PERFIL.contact_name}
                  disabled={!perfilPronto}
                  className={perfilCls}
                />
              </Campo>
              {podeVerContato && (
                <Campo rotulo={LAB_CADASTRO.contatoTelefone} erro={erros.contatoTel}>
                  <input
                    type="tel"
                    value={form.contatoTel}
                    onChange={(e) => {
                      set('contatoTel', maskPhoneInput(e.target.value));
                      if (erros.contatoTel) setErro('contatoTel', '');
                    }}
                    placeholder={LAB_CADASTRO.telefoneExemplo}
                    maxLength={LIMITES_DO_PERFIL.contact_phone}
                    disabled={!perfilPronto}
                    className={`${perfilCls}${erros.contatoTel ? ' !border-red-500' : ''}`}
                  />
                </Campo>
              )}
            </div>
            <Campo rotulo={LAB_CADASTRO.entrega}>
              <textarea
                value={form.entrega}
                onChange={(e) => set('entrega', e.target.value)}
                rows={2}
                placeholder={LAB_CADASTRO.entregaExemplo}
                maxLength={LIMITES_DO_PERFIL.delivery_notes}
                disabled={!perfilPronto}
                className={`${perfilCls} resize-none`}
              />
            </Campo>
          </Secao>

          <Campo rotulo={LAB_CADASTRO.observacoes}>
            <textarea
              value={form.notas}
              onChange={(e) => set('notas', e.target.value)}
              rows={2}
              placeholder={LAB_CADASTRO.observacoesExemplo}
              className={`${inputCls} resize-none`}
            />
          </Campo>

          <div className="flex justify-end gap-2 pt-2 border-t border-border sticky bottom-0 bg-card -mx-4 px-4 py-3 -mb-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              {LAB_CADASTRO.cancelar}
            </button>
            <button
              type="submit"
              disabled={salvando || perfilEstado === 'carregando'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {salvando || perfilEstado === 'carregando' ? <Loader2 size={16} className="animate-spin" /> : editando ? <Save size={16} /> : <UserPlus size={16} />}
              {editando ? LAB_CADASTRO.salvar : LAB_CADASTRO.cadastrar}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Secao({ icone, titulo, children }: { icone: ReactNode; titulo: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        {icone}
        {titulo}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Campo({
  rotulo,
  obrigatorio,
  opcional,
  extra,
  erro,
  aviso,
  className,
  children,
}: {
  rotulo: string;
  obrigatorio?: boolean;
  opcional?: boolean;
  /** Texto curto ao lado do rótulo (ex.: a busca do CEP em andamento). */
  extra?: string;
  erro?: string;
  /** Aviso que não bloqueia o salvar (ex.: telefone que já é de outro cliente). */
  aviso?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium mb-1 text-muted-foreground">
        {rotulo}
        {obrigatorio && <span className="text-red-600">{' *'}</span>}
        {opcional && <span className="font-normal">{` (${LAB_CADASTRO.opcional})`}</span>}
        {extra && <span className="font-normal">{` ${extra}`}</span>}
      </label>
      {children}
      {erro && <p className="text-[11px] font-medium text-red-600 mt-1">{erro}</p>}
      {aviso && <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400 mt-1">{aviso}</p>}
    </div>
  );
}
