'use client';

import React, { useState, useRef, useEffect } from 'react';
import { RouteGuard } from '@/components/RouteGuard';
import {
  BookOpen, Search, ChevronDown, ChevronRight, Users, MessageSquare,
  BarChart3, Calendar, Gavel, FileText, DollarSign, Settings, Bot,
  ArrowRight, CheckCircle2, XCircle, Clock, UserCheck, Zap,
  Bell, Send, Filter, Sparkles, Scale, Briefcase,
} from 'lucide-react';

// ─── Dados do Manual ─────────────────────────────────────────────────────────

interface Section {
  id: string;
  title: string;
  icon: any;
  content: SubSection[];
}

interface SubSection {
  id: string;
  title: string;
  body: string;
}

const MANUAL_SECTIONS: Section[] = [
  {
    id: 'visao-geral',
    title: '1. Visão Geral do Sistema',
    icon: BookOpen,
    content: [
      {
        id: 'o-que-e',
        title: 'O que é o sistema',
        body: `O sistema é um CRM jurídico completo com atendimento automatizado por IA via WhatsApp. A Sophia (assistente virtual) faz o primeiro contato, qualifica leads, coleta informações do caso e agenda reuniões — tudo de forma natural, como se fosse uma pessoa real.

Módulos principais:
• Atendimento — Chat ao vivo com leads e clientes (IA ou humano)
• CRM — Pipeline visual de leads do primeiro contato até a contratação
• Agenda — Reuniões, audiências, prazos e tarefas com lembretes automáticos
• Processos — Acompanhamento completo do caso jurídico (kanban)
• DJEN — Monitoramento automático de publicações do Diário de Justiça
• Financeiro — Honorários, parcelas e notas fiscais
• Follow-up — Sequências automáticas de mensagens para leads inativos`,
      },
      {
        id: 'papeis',
        title: 'Papéis de usuário',
        body: `O sistema possui 5 papéis com permissões diferentes:

• Admin — Acesso total. Configura IA, gerencia equipe, vê todas as conversas e métricas.
• Advogado — Vê processos atribuídos, workspace do caso, agenda, documentos e financeiro.
• Operador — Atende leads na aba de chat. Vê apenas conversas atribuídas a ele.
• Estagiário — Acesso limitado a tarefas, agenda e processos (sem financeiro).
• Financeiro — Acesso ao módulo financeiro, honorários e notas fiscais.`,
      },
    ],
  },
  {
    id: 'jornada-lead',
    title: '2. Jornada do Lead',
    icon: ArrowRight,
    content: [
      {
        id: 'fluxo-completo',
        title: 'Fluxo completo do lead',
        body: `O lead passa por 9 estágios desde o primeiro contato até virar cliente:

NOVO → INICIAL → QUALIFICANDO → REUNIÃO_AGENDADA → AGUARDANDO_DOCS → AGUARDANDO_PROC → FINALIZADO

Ao finalizar, o lead vira CLIENTE:
• Sai da aba "Leads" no atendimento
• Aparece na aba "Clientes"
• Um LegalCase (processo) é criado automaticamente
• A IA é desligada (atendimento passa a ser humano)

Leads que não avançam vão para PERDIDO (com motivo obrigatório).`,
      },
      {
        id: 'entrada',
        title: '2.1 Entrada do lead',
        body: `O lead pode entrar de 3 formas:

1. WhatsApp (principal) — Quando alguém manda mensagem para o número do escritório, o sistema cria o lead automaticamente com stage=NOVO e inicia a conversa com a Sophia.

2. Manual — O operador pode cadastrar um lead manualmente pelo menu Contatos, informando nome e telefone.

3. DJEN — Ao criar um processo a partir de uma publicação do Diário de Justiça, o sistema pode criar ou vincular um lead existente.`,
      },
      {
        id: 'sdr',
        title: '2.2 SDR Sophia — Primeiro contato',
        body: `A Sophia SDR é o primeiro agente que atende. Ela:
• Pede o nome do lead
• Entende qual é o problema (de forma geral)
• Identifica a área do direito (Trabalhista, Consumidor, Família, etc.)
• Gera um resumo do caso

Ela NÃO dá orientação jurídica, NÃO analisa viabilidade e NÃO agenda reuniões.

Quando identifica nome + área, o lead avança para QUALIFICANDO e a conversa é transferida silenciosamente para o Especialista daquela área (o lead não percebe a troca).`,
      },
      {
        id: 'especialista',
        title: '2.3 Especialista — Triagem e qualificação',
        body: `O Especialista (Trabalhista, Consumidor, Penal, etc.) assume a conversa e:

1. PRIMEIRO responde as dúvidas do lead — não começa coletando dados
2. Avalia viabilidade — prescrição, provas mínimas, valor da causa
3. Investiga fatos do caso — usando roteiro específico da área (até 12 matérias por área)
4. Coleta dados pessoais — RG/CNH, comprovante de residência

Cada especialista tem 3 documentos de referência:
• Persona e Regras — Como se comunicar
• Funil e Fases — Quando avançar cada etapa
• Investigação por Matéria — Perguntas específicas para cada tipo de caso`,
      },
      {
        id: 'agendamento',
        title: '2.4 Agendamento de reunião',
        body: `Quando o lead quer prosseguir, o Especialista agenda uma reunião:

Etapa 1: Pergunta o dia ("Quer vir amanhã ou prefere outro dia?")
Etapa 2: Mostra horários disponíveis via lista clicável do WhatsApp

Os horários vêm da agenda do advogado (configurada no sistema). A IA nunca inventa horários.

Ao confirmar, o lead vai para REUNIÃO_AGENDADA e um evento é criado na agenda com lembrete automático por WhatsApp.`,
      },
      {
        id: 'documentos',
        title: '2.5 Coleta de documentos',
        body: `Após a reunião, o Especialista solicita documentos:
• Pessoais: RG/CNH + comprovante de residência
• Probatórios: específicos da área (CTPS, contratos, fotos, laudos, etc.)

Os documentos são solicitados um por vez (não em lista). O lead envia pelo WhatsApp e ficam armazenados no sistema.

O lead vai para AGUARDANDO_DOCS enquanto os documentos são coletados.`,
      },
      {
        id: 'honorarios',
        title: '2.6 Honorários e contrato',
        body: `Modelos de cobrança por área:

• Êxito (30%) — Trabalhista, Consumidor, Civil, Previdenciário. O lead não paga nada agora, só se ganhar.
• Fixo — Penal, Empresarial. O advogado define o valor diretamente.
• Misto — Imobiliário, Família. Depende do caso (êxito se tem proveito econômico, fixo se não).

Após definir honorários, o contrato é enviado via ClickSign para assinatura digital. O lead vai para AGUARDANDO_PROC.`,
      },
      {
        id: 'conversao',
        title: '2.7 Conversão: Lead → Cliente',
        body: `Quando o lead assina o contrato, ele é FINALIZADO:

O que acontece automaticamente:
• lead.is_client = true (vira cliente)
• lead.stage = FINALIZADO
• Sai da aba "Leads" no atendimento
• Aparece na aba "Clientes"
• Um LegalCase é criado com stage=VIABILIDADE
• A IA é desligada na conversa
• O advogado mais disponível na área é atribuído

O lead continua podendo mandar mensagem pelo WhatsApp — agora aparece na aba Clientes.`,
      },
      {
        id: 'perdido',
        title: '2.8 Leads perdidos',
        body: `Um lead vai para PERDIDO quando:
• Prescreveu (prazo legal expirado)
• Caso inviável (sem provas, valor irrisório)
• Desistiu por conta própria
• Não respondeu após follow-ups
• Escolheu outro escritório

É obrigatório informar o motivo (loss_reason). O lead sai da aba Leads mas pode ser reativado se voltar a mandar mensagem.`,
      },
    ],
  },
  {
    id: 'atendimento',
    title: '3. Painel de Atendimento',
    icon: MessageSquare,
    content: [
      {
        id: 'leads-clientes',
        title: 'Aba Leads vs Aba Clientes',
        body: `O painel de atendimento tem duas abas:

Leads — Contatos em prospecção (ainda não contrataram). Mostra leads com stage diferente de FINALIZADO e PERDIDO. É onde o operador trabalha no dia a dia.

Clientes — Contatos que já contrataram (is_client=true). Mostra todos os clientes, mesmo com conversa encerrada. Útil para acompanhamento pós-venda.

Para aparecer na aba Leads: is_client=false e stage NOT IN (PERDIDO, FINALIZADO)
Para aparecer na aba Clientes: is_client=true`,
      },
      {
        id: 'ia-mode',
        title: 'Como funciona a IA',
        body: `Cada conversa tem um toggle de IA:

IA Ligada (ai_mode=true) — A Sophia responde automaticamente. O operador pode acompanhar mas não precisa intervir.

IA Desligada (ai_mode=false) — O operador responde manualmente. A Sophia para de responder.

A IA é desligada automaticamente quando:
• O operador assume a conversa
• O lead pede atendente humano
• O lead vira cliente (FINALIZADO)

O operador pode religar a IA a qualquer momento pelo toggle no chat.`,
      },
      {
        id: 'transferencia',
        title: 'Como transferir conversa',
        body: `Para transferir uma conversa para outro operador ou advogado:

1. Abrir a conversa
2. Clicar no botão de transferência (no header do chat)
3. Selecionar o destinatário
4. Opcionalmente: gravar áudio explicando o contexto
5. Enviar

A transferência fica PENDENTE até o destinatário aceitar. Enquanto isso, a conversa continua com o operador original.`,
      },
      {
        id: 'perguntas-aberto',
        title: 'Perguntas em aberto',
        body: `No topo do chat aparece um banner com "Perguntas em aberto" — são questões que a IA identificou que ainda precisam ser respondidas.

Exemplos: "Qual o horário de trabalho?", "Tem carteira assinada?", "Desde quando?"

Essas perguntas são atualizadas a cada mensagem e ajudam o operador a saber o que ainda falta coletar do lead.`,
      },
    ],
  },
  {
    id: 'crm',
    title: '4. CRM (Pipeline)',
    icon: Filter,
    content: [
      {
        id: 'estagios',
        title: 'Estágios do funil',
        body: `O CRM mostra todos os leads em formato de pipeline (kanban):

INICIAL — Primeiro contato, ainda sendo identificado
QUALIFICANDO — IA ou operador investigando o caso
AGUARDANDO_FORM — Esperando formulário de intake
REUNIÃO_AGENDADA — Reunião marcada com o advogado
AGUARDANDO_DOCS — Esperando documentos do lead
AGUARDANDO_PROC — Esperando contrato/procuração assinados
FINALIZADO — Convertido em cliente (sai do CRM, vai para Clientes)
PERDIDO — Não avançou (com motivo)

Os leads podem ser arrastados entre estágios manualmente.`,
      },
      {
        id: 'score',
        title: 'Score do lead',
        body: `Cada lead tem um score de 0 a 100 que indica a probabilidade de conversão:

Base por estágio: INICIAL=10, QUALIFICANDO=25, REUNIÃO_AGENDADA=50, etc.
Bônus: +8 se área jurídica definida, +5 se advogado atribuído, +5 se próximo passo definido
Penalidade: -3 por dia parado no mesmo estágio (máx -25)

Cores: Verde (70+), Amarelo (45-69), Laranja (20-44), Vermelho (<20)`,
      },
    ],
  },
  {
    id: 'agenda',
    title: '5. Agenda e Tarefas',
    icon: Calendar,
    content: [
      {
        id: 'tipos-evento',
        title: 'Tipos de evento',
        body: `A agenda suporta 6 tipos de evento:

• CONSULTA — Reunião com lead/cliente (presencial, vídeo ou telefone)
• AUDIÊNCIA — Audiência judicial (criada automaticamente pelo DJEN)
• PERÍCIA — Exame pericial agendado
• PRAZO — Prazo processual (contestação, recurso, manifestação)
• TAREFA — Atividade interna (preparar petição, revisar documento)
• OUTRO — Qualquer outro compromisso

Cada evento pode ter lembretes automáticos por WhatsApp (ex: 1 dia antes, 1 hora antes).`,
      },
      {
        id: 'lembretes',
        title: 'Lembretes automáticos',
        body: `O sistema envia lembretes por WhatsApp automaticamente:

• Para o cliente: lembrete da reunião/audiência com data, hora e local
• Para o advogado: lembrete com detalhes do caso e número do processo

Os lembretes são configuráveis por evento:
- minutes_before: 1440 (1 dia), 60 (1 hora), 120 (2 horas)
- channel: WHATSAPP

Audiências criadas pelo DJEN já vêm com lembretes pré-configurados.`,
      },
    ],
  },
  {
    id: 'processos',
    title: '6. Processos',
    icon: Scale,
    content: [
      {
        id: 'preparacao',
        title: 'Preparação do caso (Menu Advogado)',
        body: `Quando o lead vira cliente, um LegalCase é criado com stage=VIABILIDADE. O advogado trabalha nas seguintes etapas:

VIABILIDADE — Análise inicial: o caso tem mérito? Vale ajuizar?
DOCUMENTAÇÃO — Reunir todos os documentos necessários
PETIÇÃO — Redigir a petição inicial
REVISÃO — Revisar antes de protocolar
PROTOCOLO — Pronto para protocolar no tribunal

Cada etapa tem seu card no menu "Advogado". Ao protocolar, o caso vai para o menu "Processos".`,
      },
      {
        id: 'acompanhamento',
        title: 'Acompanhamento (Menu Processos)',
        body: `Após protocolar, o caso entra no kanban de acompanhamento com 13 estágios:

DISTRIBUÍDO → CITAÇÃO → CONTESTAÇÃO → RÉPLICA → PERÍCIA_AGENDADA → INSTRUÇÃO → ALEGAÇÕES_FINAIS → AGUARDANDO_SENTENÇA → JULGAMENTO → RECURSO → TRANSITADO → EXECUÇÃO → ENCERRADO

Os cards podem ser arrastados entre colunas. Cada mudança de estágio é registrada no histórico.

O DJEN atualiza automaticamente o estágio quando detecta publicações relevantes (ex: sentença → JULGAMENTO).`,
      },
      {
        id: 'workspace',
        title: 'Workspace do processo',
        body: `Cada processo tem um workspace completo com abas:

• Resumo — Dados do caso, partes, valores
• Petições — Documentos gerados pela IA ou upload manual
• Documentos — Arquivo de todos os documentos do caso
• Prazos — Prazos processuais com alertas
• Tarefas — Atividades pendentes do caso
• Honorários — Valores, parcelas, pagamentos
• Comunicações — Publicações do DJEN vinculadas
• Timeline — Histórico completo do caso`,
      },
    ],
  },
  {
    id: 'djen',
    title: '7. DJEN (Diário de Justiça)',
    icon: FileText,
    content: [
      {
        id: 'o-que-e-djen',
        title: 'O que é o DJEN',
        body: `O DJEN (Diário da Justiça Eletrônico Nacional) é o sistema que publica movimentações de processos judiciais. O sistema sincroniza automaticamente todas as publicações que mencionam o advogado cadastrado.

O sync roda diariamente às 8h e busca publicações do dia anterior e do dia atual. Também pode ser acionado manualmente pelo botão "Sincronizar".`,
      },
      {
        id: 'analise-ia',
        title: 'Análise por IA',
        body: `Cada publicação pode ser analisada pela IA, que extrai:

• Resumo — O que aconteceu em 3 frases
• Urgência — URGENTE, NORMAL ou BAIXA
• Tipo de ação — O que o advogado precisa fazer
• Prazo — Dias úteis para cumprir
• Estágio sugerido — Para onde mover o processo
• Partes — Parte autora e parte ré
• Juízo — Vara e comarca
• Área jurídica — Trabalhista, Cível, etc.
• Data de audiência — Se houver audiência mencionada

A análise também cria tarefas e eventos de agenda automaticamente.`,
      },
      {
        id: 'criar-processo-djen',
        title: 'Criar processo a partir de publicação',
        body: `Para publicações não vinculadas a nenhum processo, você pode criar um novo:

1. Clicar em "Criar Processo" na publicação
2. O sistema sugere automaticamente leads que correspondem às partes da publicação
3. Selecionar lead existente ou cadastrar novo cliente
4. Escolher estágio do kanban e área jurídica (IA sugere)
5. Confirmar

O que acontece:
• LegalCase criado e vinculado à publicação
• Lead vira cliente (is_client=true, stage=FINALIZADO)
• Lead sai da aba Leads e vai para Clientes
• IA desligada na conversa
• Todas as publicações com mesmo número de processo são vinculadas automaticamente
• Memória da IA atualizada com dados do processo`,
      },
      {
        id: 'notificacao-djen',
        title: 'Notificação automática ao cliente',
        body: `Quando uma nova publicação é vinculada a um processo existente, o cliente recebe uma notificação por WhatsApp automaticamente:

"Olá [nome]! Houve uma nova movimentação no seu processo nº [número]. Nosso advogado já foi notificado e vai analisar."

Controles:
• Só envia 1x por publicação (não repete)
• Só em horário comercial (8h-20h, seg-sex)
• Pode ser desabilitado na configuração (DJEN_NOTIFY_CLIENT)`,
      },
    ],
  },
  {
    id: 'followup',
    title: '8. Follow-up Automático',
    icon: Send,
    content: [
      {
        id: 'sequencias',
        title: 'O que são sequências',
        body: `Sequências são séries de mensagens automáticas enviadas a leads que pararam de responder ou que chegaram a um determinado estágio.

Exemplo: Lead ficou 3 dias sem responder após a triagem → sequência de reengajamento envia mensagem personalizada.

Cada sequência tem:
• Nome e descrição
• Estágios de auto-enrollment (quando ativar automaticamente)
• Passos com delay, tom, objetivo e prompt customizado
• Opção de envio automático ou com aprovação manual`,
      },
      {
        id: 'como-funciona-followup',
        title: 'Como funciona',
        body: `1. Lead entra no estágio configurado (ex: QUALIFICANDO)
2. Sistema verifica se há sequência com auto_enroll para esse estágio
3. Se sim, lead é inscrito automaticamente
4. Após o delay configurado (ex: 72 horas), a IA gera uma mensagem personalizada
5. Se auto_send=true, envia direto. Se false, vai para fila de aprovação
6. Se o lead responder, a sequência para automaticamente

As mensagens são geradas pela IA com contexto do lead (nome, histórico, caso).`,
      },
    ],
  },
  {
    id: 'financeiro',
    title: '9. Financeiro',
    icon: DollarSign,
    content: [
      {
        id: 'honorarios',
        title: 'Honorários',
        body: `Cada processo tem seus honorários configurados:

• Tipo: Êxito (%), Fixo (R$) ou Misto
• Valor: percentual ou valor absoluto
• Parcelas: divisão em pagamentos mensais
• Status: Pendente, Pago, Atrasado

O sistema rastreia parcelas, pagamentos recebidos e gera relatórios financeiros.`,
      },
      {
        id: 'notas-fiscais',
        title: 'Notas fiscais',
        body: `O módulo de notas fiscais permite:
• Emissão de NF-e vinculada ao processo
• Controle de notas emitidas vs pendentes
• Integração com gateway de pagamento (Stripe)`,
      },
    ],
  },
  {
    id: 'configuracoes',
    title: '10. Configurações (Admin)',
    icon: Settings,
    content: [
      {
        id: 'config-ia',
        title: 'Inteligência Artificial',
        body: `Em Configurações > IA você gerencia:

• Modelo — Qual LLM usar (Claude, GPT-4, etc.)
• Skills — Os "especialistas" da Sophia (SDR, Trabalhista, Consumidor, etc.)
• Referências — Documentos que a IA consulta para responder (persona, funil, investigação)
• Temperatura — Criatividade das respostas (0.0 = preciso, 1.0 = criativo)
• Voz TTS — Se ativado, Sophia responde por áudio quando o lead envia áudio

Cada skill tem um prompt editável e até 3 referências. Alterar o prompt muda o comportamento da Sophia naquela área.`,
      },
      {
        id: 'config-whatsapp',
        title: 'WhatsApp e Inboxes',
        body: `O sistema suporta múltiplos números de WhatsApp:

• Instâncias — Cada número do WhatsApp é uma instância da Evolution API
• Inboxes — Agrupam instâncias e atribuem operadores
• Round-robin — Distribui automaticamente conversas novas entre operadores do inbox

Em Configurações > WhatsApp: URL da API, chave de autenticação
Em Configurações > Inboxes: criar/editar inboxes, atribuir operadores`,
      },
      {
        id: 'config-equipe',
        title: 'Equipe e permissões',
        body: `Em Configurações > Usuários:
• Criar/editar usuários
• Atribuir papel (Admin, Advogado, Operador, Estagiário, Financeiro)
• Definir áreas de especialidade (para auto-atribuição)
• Vincular a inboxes

Em Configurações > Permissões:
• Controle granular por papel
• Quem pode ver/editar cada módulo`,
      },
      {
        id: 'config-automacoes',
        title: 'Automações',
        body: `Em Configurações > Automações:
• Regras que disparam ações automáticas
• Exemplos: "Quando lead ficar 3 dias parado → enviar follow-up", "Quando lead for FINALIZADO → criar tarefa para advogado"
• Configuração de sequências de follow-up por estágio`,
      },
    ],
  },
];

// ─── Componente ──────────────────────────────────────────────────────────────

function ManualContent() {
  const [search, setSearch] = useState('');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['visao-geral', 'jornada-lead']));
  const [activeSection, setActiveSection] = useState('visao-geral');
  const contentRef = useRef<HTMLDivElement>(null);

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const scrollToSection = (sectionId: string, subId?: string) => {
    setExpandedSections(prev => new Set([...prev, sectionId]));
    setActiveSection(sectionId);
    setTimeout(() => {
      const el = document.getElementById(subId || sectionId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  // Filtrar seções por busca
  const filteredSections = search.trim()
    ? MANUAL_SECTIONS.map(s => ({
        ...s,
        content: s.content.filter(sub =>
          sub.title.toLowerCase().includes(search.toLowerCase()) ||
          sub.body.toLowerCase().includes(search.toLowerCase())
        ),
      })).filter(s => s.content.length > 0)
    : MANUAL_SECTIONS;

  // Expandir tudo ao buscar
  useEffect(() => {
    if (search.trim()) {
      setExpandedSections(new Set(filteredSections.map(s => s.id)));
    }
  }, [search]);

  return (
    <div className="flex h-[calc(100vh-64px)]">
      {/* Sidebar de navegação */}
      <aside className="w-64 shrink-0 border-r border-border bg-card overflow-y-auto custom-scrollbar hidden lg:block">
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen size={18} className="text-primary" />
            <h2 className="text-sm font-bold text-foreground">Manual do Sistema</h2>
          </div>
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border bg-background">
            <Search size={12} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar no manual..."
              className="flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
        </div>
        <nav className="p-2">
          {MANUAL_SECTIONS.map(section => (
            <button
              key={section.id}
              onClick={() => scrollToSection(section.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[11px] font-medium transition-colors mb-0.5 ${
                activeSection === section.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              }`}
            >
              <section.icon size={13} className="shrink-0" />
              <span className="truncate">{section.title}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Conteúdo */}
      <main ref={contentRef} className="flex-1 overflow-y-auto custom-scrollbar">
        {/* Header mobile com busca */}
        <div className="lg:hidden sticky top-0 z-10 bg-card border-b border-border p-4">
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border bg-background">
            <Search size={12} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar no manual..."
              className="flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
          {/* Título */}
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
              <BookOpen size={24} className="text-primary" />
              Manual do Sistema
            </h1>
            <p className="text-sm text-muted-foreground">
              Guia completo de uso — do primeiro contato do lead até o encerramento do processo.
            </p>
          </div>

          {/* Seções */}
          {filteredSections.map(section => (
            <div key={section.id} id={section.id} className="border border-border rounded-xl overflow-hidden">
              <button
                onClick={() => toggleSection(section.id)}
                className="w-full flex items-center gap-3 px-5 py-4 bg-card hover:bg-accent/30 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <section.icon size={16} className="text-primary" />
                </div>
                <span className="flex-1 text-[14px] font-bold text-foreground">{section.title}</span>
                {expandedSections.has(section.id)
                  ? <ChevronDown size={16} className="text-muted-foreground" />
                  : <ChevronRight size={16} className="text-muted-foreground" />
                }
              </button>
              {expandedSections.has(section.id) && (
                <div className="border-t border-border bg-background">
                  {section.content.map((sub, i) => (
                    <div
                      key={sub.id}
                      id={sub.id}
                      className={`px-5 py-4 ${i > 0 ? 'border-t border-border/50' : ''}`}
                    >
                      <h3 className="text-[13px] font-bold text-foreground mb-2">{sub.title}</h3>
                      <div className="text-[12px] text-muted-foreground leading-relaxed whitespace-pre-line">
                        {search.trim()
                          ? highlightSearch(sub.body, search)
                          : sub.body
                        }
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {filteredSections.length === 0 && (
            <div className="text-center py-12">
              <Search size={32} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">Nenhum resultado para &quot;{search}&quot;</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function highlightSearch(text: string, query: string): React.ReactElement {
  if (!query.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-yellow-500/30 text-foreground rounded px-0.5">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}

export default function ManualPage() {
  return (
    <RouteGuard allowedRoles={['ADMIN', 'ADVOGADO', 'OPERADOR', 'ESTAGIARIO', 'FINANCEIRO', 'COMERCIAL']}>
      <ManualContent />
    </RouteGuard>
  );
}
