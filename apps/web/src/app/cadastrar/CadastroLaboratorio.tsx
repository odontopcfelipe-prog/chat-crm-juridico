'use client';

/**
 * F11 do laboratório — cadastro do LABORATÓRIO no /cadastrar.
 *
 * O caminho "Laboratório de prótese" tem 3 estados, decididos pela API
 * (POST /signup/laboratorio/situacao, com o código do convite no CORPO):
 *   - CONVITE: convite válido → formulário, com e-mail e nome do convite;
 *   - ABERTO: cadastro aberto ligado → formulário;
 *   - LISTA_ESPERA: senão → a lista de espera de sempre (CadastroPage.tsx).
 *
 * O código do convite chega pelo link (/cadastrar?tipo=laboratorio&convite=...),
 * vai para o sessionStorage e sai do endereço na hora (history.replaceState).
 * Recarregar a aba consulta de novo com o código guardado.
 *
 * Todo texto visível vem de lab-cadastro-textos.ts (consts LAB_*). Este arquivo
 * não declara const LAB_* nem usa pickBt: a clínica não monta nada daqui.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Loader2, FlaskConical, IdCard, Phone, User, Mail, Lock, ArrowRight,
  CheckCircle2, AlertTriangle, BadgeCheck, UserCheck,
} from 'lucide-react';
import { formatCpfCnpj, soDocumento, vCpfCnpj } from '@crm/shared';
import api, { clearSessionTraces } from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import {
  LAB_CADASTRO_BOAS_VINDAS,
  LAB_CADASTRO_ERROS,
  LAB_CADASTRO_FORM,
  LAB_CADASTRO_TOPO,
  type ModoLiberado,
} from './lab-cadastro-textos';

// ---------------------------------------------------------------- estado

export type ModoCadastroLab = ModoLiberado | 'LISTA_ESPERA';
export type AvisoConviteLabTipo = 'RECUSADO' | 'ERRO';

/** 'CONVITE' | 'ABERTO' quando o formulário pode aparecer; senão null (lista de espera). */
export function modoLiberado(m: ModoCadastroLab): ModoLiberado | null {
  return m === 'CONVITE' || m === 'ABERTO' ? m : null;
}

export interface EstadoCadastroLab {
  modo: ModoCadastroLab;
  /** Consultando a API com um código de convite (mostra o carregando no lugar do cartão). */
  conferindo: boolean;
  /** Aviso acima da lista de espera: convite recusado ou erro ao conferir. */
  aviso: AvisoConviteLabTipo | null;
  convite: string | null;
  /** E-mail e nome do laboratório vindos do convite (só no modo CONVITE). */
  email: string | null;
  labName: string | null;
  /** Consulta de novo. Com true, descarta o convite e trata o próximo resultado como recusado. */
  reconferir: (descartarConvite: boolean) => void;
  /** Apaga o código do convite (estado e sessionStorage). */
  esquecerConvite: () => void;
}

interface SituacaoCadastroLab {
  modo?: string;
  convite?: string;
  email?: string | null;
  lab_name?: string | null;
}

/** Onde o código do convite fica até a conta ser criada (sobrevive ao F5 da aba). */
const CHAVE_CONVITE = 'cadastro_lab_convite';
/** O carregando do convite não pode ficar preso nos 120 s padrão do cliente. */
const TEMPO_MAX_CONSULTA_MS = 15000;

const codigoLimpo = (v: string | null | undefined): string | null => {
  const t = typeof v === 'string' ? v.trim().slice(0, 128) : '';
  return t || null;
};
const textoOuNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Estado do caminho Laboratório. Só consulta a API com o caminho Laboratório
 * ativo (no caminho Clínica só lê o sessionStorage ao montar) e uma vez por
 * rodada; reconferir() abre uma rodada nova.
 */
export function useEstadoCadastroLab(ativo: boolean, conviteInicial: string | null | undefined): EstadoCadastroLab {
  const inicial = codigoLimpo(conviteInicial);
  const [modo, setModo] = useState<ModoCadastroLab>('LISTA_ESPERA');
  const [conferindo, setConferindo] = useState<boolean>(!!inicial);
  const [aviso, setAviso] = useState<AvisoConviteLabTipo | null>(null);
  const [convite, setConvite] = useState<string | null>(inicial);
  const [email, setEmail] = useState<string | null>(null);
  const [labName, setLabName] = useState<string | null>(null);
  const [pronto, setPronto] = useState(false);
  const [rodada, setRodada] = useState(0);

  // O código em uso fica também num ref: a consulta lê dele sem depender do
  // render, e esquecer o convite não dispara outra consulta.
  const conviteAtual = useRef<string | null>(inicial);
  const rodadaConsultada = useRef<number | null>(null);
  const ultimoPedido = useRef(0);
  const recusarNaProxima = useRef(false);

  const esquecerConvite = useCallback(() => {
    conviteAtual.current = null;
    setConvite(null);
    try {
      window.sessionStorage.removeItem(CHAVE_CONVITE);
    } catch {
      /* sem sessionStorage: segue */
    }
  }, []);

  const reconferir = useCallback(
    (descartarConvite: boolean) => {
      if (descartarConvite) {
        esquecerConvite();
        recusarNaProxima.current = true;
      }
      setRodada((r) => r + 1);
    },
    [esquecerConvite],
  );

  // Ao montar: guarda o código do link e tira SÓ o ?convite= do endereço
  // (o ?tipo= fica; sem ele, entra o ?tipo=laboratorio, para o F5 abrir no
  // Laboratório); sem código no link, usa o guardado na aba (recarga).
  useEffect(() => {
    if (inicial) {
      try {
        window.sessionStorage.setItem(CHAVE_CONVITE, inicial);
      } catch {
        /* sem sessionStorage: o código vale só nesta visita */
      }
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('convite')) {
          url.searchParams.delete('convite');
          if (!url.searchParams.has('tipo')) url.searchParams.set('tipo', 'laboratorio');
          window.history.replaceState(null, '', url.toString());
        }
      } catch {
        /* endereço fica como está */
      }
    } else {
      let salvo: string | null = null;
      try {
        salvo = codigoLimpo(window.sessionStorage.getItem(CHAVE_CONVITE));
      } catch {
        salvo = null;
      }
      if (salvo) {
        conviteAtual.current = salvo;
        setConvite(salvo);
        setConferindo(true);
      }
    }
    setPronto(true);
    // Só ao montar: o código do link é lido uma vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Consulta. Sem flag de "vivo" no cleanup: no StrictMode o effect roda duas
  // vezes e a tela ficaria presa no carregando. O ref da rodada evita o pedido
  // repetido e só a resposta do último pedido vale.
  useEffect(() => {
    if (!pronto || !ativo) return;
    if (rodadaConsultada.current === rodada) return;
    rodadaConsultada.current = rodada;
    const pedido = ++ultimoPedido.current;
    const codigo = conviteAtual.current;
    const recusar = recusarNaProxima.current;
    recusarNaProxima.current = false;

    api
      .post<SituacaoCadastroLab>(
        '/signup/laboratorio/situacao',
        codigo ? { convite: codigo } : {},
        { timeout: TEMPO_MAX_CONSULTA_MS },
      )
      .then(({ data }) => {
        if (pedido !== ultimoPedido.current) return;
        const valido = !!codigo && data?.convite === 'VALIDO';
        const novo: ModoCadastroLab =
          data?.modo === 'CONVITE' && valido ? 'CONVITE' : data?.modo === 'ABERTO' ? 'ABERTO' : 'LISTA_ESPERA';
        if (codigo && !valido) esquecerConvite();
        const recusado = recusar || (!!codigo && !valido);
        setModo(novo);
        // No ABERTO o formulário já resolve: o aviso só aparece na lista de espera.
        setAviso(recusado && novo === 'LISTA_ESPERA' ? 'RECUSADO' : null);
        setEmail(novo === 'CONVITE' ? textoOuNull(data?.email) : null);
        setLabName(novo === 'CONVITE' ? textoOuNull(data?.lab_name) : null);
      })
      .catch(() => {
        // 404 (web antes da API), 429, 5xx ou rede: a lista de espera de hoje.
        // O código fica guardado: recarregar a página confere de novo.
        if (pedido !== ultimoPedido.current) return;
        setModo('LISTA_ESPERA');
        setAviso(codigo ? 'ERRO' : recusar ? 'RECUSADO' : null);
        setEmail(null);
        setLabName(null);
      })
      .finally(() => {
        if (pedido === ultimoPedido.current) setConferindo(false);
      });
  }, [pronto, ativo, rodada, esquecerConvite]);

  return { modo, conferindo, aviso, convite, email, labName, reconferir, esquecerConvite };
}

// ---------------------------------------------------------------- envio

type RespostaDeErro = { response?: { status?: number; data?: { code?: unknown; message?: unknown } } };

/** Mensagem de erro do envio, na ordem combinada com a API. */
function tratarErroDoCadastro(err: unknown, estado: EstadoCadastroLab) {
  const resp = (err as RespostaDeErro)?.response;
  const status = resp?.status;
  const code = resp?.data?.code;
  if (code === 'CONVITE_INVALIDO') {
    showError(LAB_CADASTRO_ERROS.conviteRecusado);
    estado.reconferir(true);
    return;
  }
  // A mensagem do 409 da chave mestra fala do painel do administrador: nunca vai para a tela.
  if (code === 'CADASTRO_LABORATORIO_FECHADO' || code === 'CRIACAO_LABORATORIO_DESLIGADA') {
    showError(LAB_CADASTRO_ERROS.cadastroFechado);
    estado.reconferir(false);
    return;
  }
  if (code === 'CADASTRO_LABORATORIO_TETO') {
    showError(LAB_CADASTRO_ERROS.tetoDiario);
    return;
  }
  if (status === 429) {
    showError(LAB_CADASTRO_ERROS.muitasTentativas);
    return;
  }
  if (status === 400 || status === 409) {
    const msg = resp?.data?.message;
    const texto =
      typeof msg === 'string'
        ? msg.trim()
        : Array.isArray(msg)
          ? msg.filter((m): m is string => typeof m === 'string' && !!m.trim()).join(', ')
          : '';
    showError(texto || LAB_CADASTRO_ERROS.generico);
    return;
  }
  showError(LAB_CADASTRO_ERROS.generico);
}

// ---------------------------------------------------------------- formulário

/** Formulário de cadastro do laboratório (convite ou cadastro aberto). */
export function CadastroLaboratorio({ modo, estado }: { modo: ModoLiberado; estado: EstadoCadastroLab }) {
  const router = useRouter();
  const [nome, setNome] = useState(estado.labName ?? '');
  const [documento, setDocumento] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [croLab, setCroLab] = useState('');
  const [rtNome, setRtNome] = useState('');
  const [rtCro, setRtCro] = useState('');
  const [responsavel, setResponsavel] = useState('');
  const [email, setEmail] = useState(estado.email ?? '');
  const [senha, setSenha] = useState('');
  const [aceite, setAceite] = useState(false);
  // Campo escondido: gente não vê nem preenche; robô preenche e é ignorado no servidor.
  const [website, setWebsite] = useState('');
  const [enviando, setEnviando] = useState(false);

  const emailDoConvite =
    modo === 'CONVITE' && !!estado.email && email.trim().toLowerCase() === estado.email.trim().toLowerCase();

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    if (!aceite) {
      showError(LAB_CADASTRO_ERROS.aceite);
      return;
    }
    if (!soDocumento(documento)) {
      showError(LAB_CADASTRO_ERROS.documento);
      return;
    }
    const erroDoDocumento = vCpfCnpj(documento);
    if (erroDoDocumento) {
      showError(erroDoDocumento);
      return;
    }
    if (whatsapp.replace(/\D/g, '').length < 10) {
      showError(LAB_CADASTRO_ERROS.whatsapp);
      return;
    }
    // A API conta a senha aparada.
    if (senha.trim().length < 8) {
      showError(LAB_CADASTRO_ERROS.senhaCurta);
      return;
    }

    const emailLimpo = email.toLowerCase().trim();
    setEnviando(true);
    try {
      const { data } = await api.post<{ ok?: boolean }>('/signup/laboratorio', {
        lab_name: nome,
        cpf_cnpj: soDocumento(documento),
        phone: whatsapp,
        admin_name: responsavel,
        admin_email: emailLimpo,
        admin_password: senha,
        lab_cro_inscricao: croLab.trim() || undefined,
        rt_name: rtNome.trim() || undefined,
        rt_cro: rtCro.trim() || undefined,
        convite: modo === 'CONVITE' ? estado.convite ?? undefined : undefined,
        website: website || undefined,
      });
      if (data?.ok !== true) {
        showError(LAB_CADASTRO_ERROS.generico);
        setEnviando(false);
        return;
      }
    } catch (err) {
      tratarErroDoCadastro(err, estado);
      setEnviando(false);
      return;
    }

    // Conta criada: o convite já foi gasto. Entra pelo login normal.
    estado.esquecerConvite();
    let token: string | null = null;
    try {
      const login = await api.post<{ access_token?: string }>('/auth/login', {
        email: emailLimpo,
        password: senha,
      });
      token = textoOuNull(login.data?.access_token);
    } catch {
      token = null;
    }
    if (!token) {
      showSuccess(LAB_CADASTRO_ERROS.contaCriadaSemEntrar);
      router.push('/atendimento/login');
      return;
    }
    // Igual ao login: limpa rastros locais de outra sessão nesta máquina.
    clearSessionTraces();
    try {
      localStorage.setItem('token', token);
    } catch {
      showSuccess(LAB_CADASTRO_ERROS.contaCriadaSemEntrar);
      router.push('/atendimento/login');
      return;
    }
    showSuccess(LAB_CADASTRO_BOAS_VINDAS(nome.trim()));
    // O Início desenha o laboratório pelo bt do token.
    router.push('/atendimento/dashboard');
  };

  return (
    <form
      onSubmit={enviar}
      className="bg-card border border-border/70 rounded-2xl shadow-[0_24px_60px_-12px_rgba(0,0,0,0.12)] overflow-hidden"
    >
      <Secao numero={1} titulo={LAB_CADASTRO_FORM.secaoLaboratorio}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div className="sm:col-span-2">
            <Campo
              Icon={FlaskConical}
              rotulo={LAB_CADASTRO_FORM.nome}
              valor={nome}
              onChange={setNome}
              exemplo={LAB_CADASTRO_FORM.nomeExemplo}
              autoComplete="organization"
              maxLength={120}
              obrigatorio
            />
          </div>
          <Campo
            Icon={IdCard}
            rotulo={LAB_CADASTRO_FORM.documento}
            valor={documento}
            onChange={setDocumento}
            onBlur={() => setDocumento((d) => formatCpfCnpj(d) || d)}
            exemplo={LAB_CADASTRO_FORM.documentoExemplo}
            dica={LAB_CADASTRO_FORM.documentoDica}
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={20}
            obrigatorio
          />
          <Campo
            Icon={Phone}
            rotulo={LAB_CADASTRO_FORM.whatsapp}
            tipo="tel"
            valor={whatsapp}
            onChange={setWhatsapp}
            exemplo={LAB_CADASTRO_FORM.whatsappExemplo}
            autoComplete="tel"
            maxLength={40}
            obrigatorio
          />
        </div>
        <div aria-hidden="true" className="absolute -left-[9999px] w-px h-px overflow-hidden">
          <label>
            {LAB_CADASTRO_FORM.site}
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>
        </div>
      </Secao>

      <Secao numero={2} titulo={LAB_CADASTRO_FORM.secaoRt}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div className="sm:col-span-2">
            <Campo
              Icon={BadgeCheck}
              rotulo={LAB_CADASTRO_FORM.croLab}
              valor={croLab}
              onChange={setCroLab}
              autoComplete="off"
              maxLength={120}
            />
          </div>
          <Campo
            Icon={UserCheck}
            rotulo={LAB_CADASTRO_FORM.rtNome}
            valor={rtNome}
            onChange={setRtNome}
            autoComplete="off"
            maxLength={120}
          />
          <Campo
            Icon={BadgeCheck}
            rotulo={LAB_CADASTRO_FORM.rtCro}
            valor={rtCro}
            onChange={setRtCro}
            autoComplete="off"
            maxLength={120}
          />
        </div>
        <p className="text-[11px] text-muted-foreground mt-3">{LAB_CADASTRO_FORM.rtDica}</p>
      </Secao>

      <Secao numero={3} titulo={LAB_CADASTRO_FORM.secaoAcesso}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <Campo
            Icon={User}
            rotulo={LAB_CADASTRO_FORM.responsavel}
            valor={responsavel}
            onChange={setResponsavel}
            exemplo={LAB_CADASTRO_FORM.responsavelExemplo}
            autoComplete="name"
            maxLength={120}
            obrigatorio
          />
          <Campo
            Icon={Mail}
            rotulo={LAB_CADASTRO_FORM.email}
            tipo="email"
            valor={email}
            onChange={setEmail}
            exemplo={LAB_CADASTRO_FORM.emailExemplo}
            dica={emailDoConvite ? LAB_CADASTRO_FORM.emailDoConvite : undefined}
            autoComplete="email"
            maxLength={160}
            obrigatorio
          />
          <div className="sm:col-span-2">
            <Campo
              Icon={Lock}
              rotulo={LAB_CADASTRO_FORM.senha}
              tipo="password"
              valor={senha}
              onChange={setSenha}
              exemplo={LAB_CADASTRO_FORM.senhaExemplo}
              autoComplete="new-password"
              maxLength={128}
              obrigatorio
            />
          </div>
        </div>
        <label className="flex items-start gap-2.5 mt-4 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={aceite}
            onChange={(e) => setAceite(e.target.checked)}
            className="mt-0.5 shrink-0 w-4 h-4 accent-violet-600 cursor-pointer"
          />
          <span>
            {LAB_CADASTRO_FORM.aceiteAntes}{' '}
            <Link href="/termos" target="_blank" rel="noopener noreferrer" className="text-violet-700 font-semibold hover:underline">
              {LAB_CADASTRO_FORM.aceiteTermos}
            </Link>{' '}
            {LAB_CADASTRO_FORM.aceiteMeio}{' '}
            <Link href="/privacidade" target="_blank" rel="noopener noreferrer" className="text-violet-700 font-semibold hover:underline">
              {LAB_CADASTRO_FORM.aceitePrivacidade}
            </Link>
            {LAB_CADASTRO_FORM.aceiteFim}
          </span>
        </label>
      </Secao>

      {/* CTA */}
      <div className="p-6 sm:p-7 bg-gradient-to-br from-violet-50 to-emerald-50/50 dark:from-violet-950/30 dark:to-emerald-950/20">
        <button
          type="submit"
          disabled={enviando || !aceite}
          className="w-full h-12 sm:h-13 rounded-xl bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white text-[15px] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-[0_8px_24px_-4px_rgba(124,58,237,0.4)] hover:shadow-[0_12px_32px_-4px_rgba(124,58,237,0.5)] hover:-translate-y-0.5 disabled:transform-none disabled:shadow-none"
        >
          {enviando ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {LAB_CADASTRO_FORM.criando}
            </>
          ) : (
            <>
              {LAB_CADASTRO_FORM.botao}
              <ArrowRight size={16} />
            </>
          )}
        </button>
        <p className="text-[11px] text-center text-muted-foreground mt-3 flex items-center justify-center gap-1.5">
          <CheckCircle2 size={11} className="text-emerald-600" />
          {LAB_CADASTRO_FORM.rodape}
        </p>
      </div>
    </form>
  );
}

function Secao({ numero, titulo, children }: { numero: number; titulo: string; children: React.ReactNode }) {
  return (
    <div className="p-6 sm:p-7 border-b border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">
          {numero}
        </span>
        <h3 className="text-sm font-bold text-foreground">{titulo}</h3>
      </div>
      {children}
    </div>
  );
}

/** Igual ao FormField do CadastroPage.tsx, com dica, onBlur e autoComplete. */
function Campo({
  Icon, rotulo, valor, onChange, onBlur, exemplo, tipo = 'text', obrigatorio, dica,
  autoComplete, autoCapitalize, maxLength,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  rotulo: string;
  valor: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  exemplo?: string;
  tipo?: string;
  obrigatorio?: boolean;
  dica?: string;
  autoComplete?: string;
  autoCapitalize?: string;
  maxLength?: number;
}) {
  const id = useId();
  const idDica = `${id}-dica`;
  return (
    <div>
      <label
        htmlFor={id}
        className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5"
      >
        <Icon size={11} className="text-violet-500" />
        {rotulo}
      </label>
      <input
        id={id}
        type={tipo}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        required={obrigatorio}
        placeholder={exemplo}
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize}
        maxLength={maxLength}
        aria-describedby={dica ? idDica : undefined}
        className="w-full h-11 px-3.5 text-sm border border-border rounded-xl bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors"
      />
      {dica && (
        <p id={idDica} className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
          {dica}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- apoio

/** Lateral (desktop) com o cadastro liberado. */
export function LateralCadastroLab() {
  return (
    <>
      <h1 className="text-4xl xl:text-5xl font-black leading-[1.1] mb-5 tracking-tight">
        {LAB_CADASTRO_TOPO.tituloLateral}{' '}
        <span className="text-emerald-300">{LAB_CADASTRO_TOPO.tituloLateralDestaque}</span>
      </h1>

      <p className="text-base text-violet-100/80 leading-relaxed mb-8 max-w-md">
        {LAB_CADASTRO_TOPO.descricaoLateral}
      </p>
    </>
  );
}

/** No lugar do cartão enquanto a API confere o convite. */
export function ConferindoConviteLab() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-card border border-border/70 rounded-2xl shadow-[0_24px_60px_-12px_rgba(0,0,0,0.12)] p-7 sm:p-8 flex items-center justify-center gap-2.5 text-sm font-semibold text-muted-foreground"
    >
      <Loader2 size={16} className="animate-spin text-violet-600 shrink-0" />
      {LAB_CADASTRO_TOPO.conferindo}
    </div>
  );
}

/** Caixa âmbar acima da lista de espera: convite recusado ou erro ao conferir. */
export function AvisoConviteLab({ tipo }: { tipo: AvisoConviteLabTipo }) {
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] leading-snug text-amber-800 dark:text-amber-200"
    >
      <AlertTriangle size={16} className="shrink-0 mt-px text-amber-600 dark:text-amber-400" />
      <span>{tipo === 'RECUSADO' ? LAB_CADASTRO_TOPO.conviteRecusado : LAB_CADASTRO_TOPO.conviteErro}</span>
    </div>
  );
}
