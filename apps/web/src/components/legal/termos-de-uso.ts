/**
 * Termos de uso da plataforma (página /termos). Vale para clínicas e
 * laboratórios. Ao mudar o texto, atualize também a versão dele em
 * packages/shared/src/documentos-legais.ts.
 */
import { VERSAO_TERMOS_DE_USO, versaoPorExtenso } from '@crm/shared';
import { EMPRESA_DA_PLATAFORMA as EMPRESA, identificacaoDaEmpresa, type DocumentoLegal } from './documento-legal';

export const TERMOS_DE_USO: DocumentoLegal = Object.freeze({
  titulo: 'Termos de uso',
  atualizadoEm: versaoPorExtenso(VERSAO_TERMOS_DE_USO),
  resumo: [
    `O ${EMPRESA.marca} é um sistema online de gestão para clínicas odontológicas e laboratórios de prótese.`,
    'Cada conta é de um tipo só (clínica ou laboratório), e os dados de uma conta não se misturam com os de outra.',
    'Os dados de pacientes e clientes que você cadastra são seus: você decide sobre eles e responde pelo uso que faz deles.',
    'WhatsApp, pagamentos e inteligência artificial dependem de serviços de outras empresas, que têm regras próprias.',
    'Você pode cancelar quando quiser, sem multa. Antes de cancelar, guarde uma cópia dos seus dados, principalmente dos prontuários.',
  ],
  secoes: [
    {
      id: 'aceite',
      titulo: 'Sobre estes termos',
      blocos: [
        `Estes Termos de Uso regulam o uso da plataforma ${EMPRESA.marca} por clínicas odontológicas, laboratórios de prótese e pelas pessoas que eles cadastram para usar o sistema.`,
        'Ao marcar a opção de aceite no cadastro, ou ao usar a plataforma, você concorda com estes termos e com a Política de Privacidade. Quem faz o cadastro declara ter poderes para contratar em nome da clínica ou do laboratório.',
        `Neste documento, "Cliente" é a clínica ou o laboratório que contrata a plataforma; "Usuário" é cada pessoa com acesso à conta do Cliente (sócios, equipe, dentistas, protéticos); e "${EMPRESA.marca}" ou "nós" é quem mantém a plataforma.`,
      ],
    },
    {
      id: 'servico',
      titulo: 'O que a plataforma oferece',
      blocos: [
        'A plataforma reúne recursos de gestão como atendimento por WhatsApp, agenda, cadastro de pacientes ou de clientes, orçamentos, cobranças, financeiro, caixa, documentos, relatórios e, para laboratórios, o acompanhamento dos trabalhos.',
        'Os recursos disponíveis dependem do tipo de conta e do plano contratado e podem mudar com a evolução da plataforma. Se uma mudança retirar um recurso importante do plano contratado, avisaremos com antecedência.',
      ],
    },
    {
      id: 'conta',
      titulo: 'Conta, tipo de conta e acessos',
      blocos: [
        'Cada conta é de um tipo só: clínica odontológica ou laboratório de prótese. O mesmo cadastro (e-mail) não pode ter uma conta de clínica e outra de laboratório. Os dados de cada conta ficam separados e não são compartilhados com nenhuma outra conta.',
        'O Cliente deve informar dados verdadeiros e mantê-los atualizados.',
        'O Cliente escolhe quem terá acesso e com quais permissões, e responde pelo que os seus Usuários fazem no sistema. Cada Usuário tem login próprio e não deve compartilhar a senha.',
        'Se perceber uso indevido da conta ou acesso de alguém que não deveria tê-lo, o Cliente deve trocar as senhas, remover o acesso e nos avisar pelo canal de contato.',
      ],
    },
    {
      id: 'pagamento',
      titulo: 'Planos, período de teste e pagamento',
      blocos: [
        'Os planos, os preços e o período de teste (quando houver) são os informados na contratação ou na tela de assinatura dentro do sistema.',
        'A assinatura é cobrada conforme o plano e o meio de pagamento escolhidos. Se o pagamento atrasar, podemos limitar ou suspender o acesso depois de avisar o Cliente; o acesso volta assim que o pagamento for confirmado.',
        'Mudanças de preço são avisadas com pelo menos 30 dias de antecedência, por e-mail ou dentro do sistema.',
        'Não há fidelidade: o Cliente pode cancelar a qualquer momento, sem multa. O período já pago continua liberado até o fim e não é devolvido de forma proporcional.',
        'Serviços de outras empresas que o Cliente contrata para usar com a plataforma, como a conta no provedor de pagamentos, são cobrados por essas empresas, conforme as regras delas.',
      ],
    },
    {
      id: 'uso',
      titulo: 'Uso permitido',
      blocos: [
        'O Cliente e os Usuários devem usar a plataforma de acordo com a lei, com estes termos e com as normas da sua profissão. Não é permitido:',
        {
          lista: [
            'usar a plataforma para atividade ilegal ou para enganar pessoas;',
            'enviar mensagens em massa, sem pedido ou autorização de quem recebe, ou em desacordo com as regras do WhatsApp;',
            'cadastrar dados de pessoas sem base legal para isso;',
            'tentar acessar dados de outras contas, contornar os controles de acesso ou testar a segurança da plataforma sem autorização por escrito;',
            'copiar, revender, sublicenciar ou fazer engenharia reversa da plataforma;',
            'usar robôs, programas ou volumes de acesso que prejudiquem o funcionamento do sistema para os demais Clientes.',
          ],
        },
        'Se houver uso em desacordo com estes termos, podemos suspender o acesso envolvido, de forma proporcional, para proteger o Cliente, as pessoas cujos dados estão no sistema e os demais Clientes.',
      ],
    },
    {
      id: 'whatsapp',
      titulo: 'WhatsApp',
      blocos: [
        'O Cliente conecta à plataforma o seu próprio número de WhatsApp lendo um QR Code, do mesmo jeito que se conecta um aparelho ao WhatsApp Web. Essa conexão depende do WhatsApp, serviço da Meta, que tem regras próprias e pode mudar, limitar ou interromper o funcionamento a qualquer momento.',
        `O WhatsApp pode restringir ou bloquear números que enviem muitas mensagens, recebam denúncias ou contrariem as regras dele. O ${EMPRESA.marca} não controla essas decisões e não responde por elas.`,
        'Os envios automáticos (lembretes, confirmações, cobranças, campanhas e outros) podem ser ligados, desligados e ajustados pelo Cliente na plataforma. O Cliente responde pelo conteúdo e pela frequência das mensagens enviadas em seu nome e por ter base legal para enviá-las.',
      ],
    },
    {
      id: 'terceiros',
      titulo: 'Pagamentos e outros serviços de terceiros',
      blocos: [
        'Algumas funções dependem de serviços de outras empresas, como o provedor de pagamentos (Asaas) para boletos, Pix e cartão, emissores de nota fiscal, assinatura eletrônica de contratos (ClickSign) e armazenamento no Google Drive. Para usá-las, o Cliente pode precisar ter conta própria nesses serviços e aceitar as regras deles.',
        'Quando o Cliente cobra pela plataforma, as cobranças são emitidas na conta do próprio Cliente no provedor de pagamentos, que recebe e repassa os valores conforme as regras dele.',
        `O ${EMPRESA.marca} não responde por falhas, mudanças de preço ou interrupções desses serviços, mas trabalha para reduzir o impacto delas no uso da plataforma.`,
      ],
    },
    {
      id: 'ia',
      titulo: 'Inteligência artificial',
      blocos: [
        'Alguns recursos usam inteligência artificial de fornecedores especializados, por exemplo para responder mensagens, organizar conversas, sugerir textos ou gerar simulações de imagem. O Cliente pode ligar e desligar esses recursos.',
        'Respostas e conteúdos gerados por inteligência artificial podem conter erros. O Cliente deve acompanhar o atendimento, revisar o que for importante e corrigir o que for preciso. A inteligência artificial não faz diagnóstico, não indica tratamento e não substitui o profissional.',
        'Simulações de imagem, como a do sorriso, são apenas ilustrativas e não garantem o resultado de nenhum tratamento.',
      ],
    },
    {
      id: 'profissional',
      titulo: 'Responsabilidade profissional',
      blocos: [
        'A plataforma é uma ferramenta de gestão. São responsabilidade do Cliente e dos seus profissionais: decisões clínicas e técnicas, diagnósticos, planos de tratamento, prescrições, a execução dos trabalhos de prótese, os prazos e materiais combinados com os clientes, a emissão de documentos fiscais e o cumprimento das normas do conselho profissional, da vigilância sanitária e das demais leis aplicáveis.',
        'O Cliente responde pelo conteúdo que cadastra e envia pela plataforma, incluindo textos, imagens, documentos, contratos e mensagens.',
      ],
    },
    {
      id: 'dados',
      titulo: 'Dados pessoais',
      blocos: [
        'O tratamento de dados pessoais segue a Lei Geral de Proteção de Dados (Lei nº 13.709/2018) e está descrito na Política de Privacidade, que faz parte destes termos.',
        `Sobre os dados de pacientes, dentistas clientes e demais pessoas que o Cliente cadastra, o Cliente é o controlador: decide o que é tratado e para quê, deve ter base legal para isso e deve informar essas pessoas. O ${EMPRESA.marca} é o operador: trata esses dados em nome do Cliente, só para prestar o serviço e conforme as instruções dele.`,
        'O Cliente deve guardar os prontuários e os demais documentos pelos prazos exigidos pela lei e pelo conselho profissional. Por isso, antes de encerrar a conta, deve exportar ou pedir uma cópia dos dados.',
      ],
    },
    {
      id: 'disponibilidade',
      titulo: 'Disponibilidade, cópias de segurança e suporte',
      blocos: [
        'Trabalhamos para manter a plataforma disponível todos os dias, a qualquer hora, e fazemos cópias de segurança do banco de dados. Ainda assim, podem ocorrer interrupções por manutenção, atualização ou falhas de internet, de energia ou de fornecedores. Sempre que possível, as manutenções programadas são feitas fora do horário comercial.',
        'O suporte é prestado pelos canais informados na plataforma.',
      ],
    },
    {
      id: 'propriedade',
      titulo: 'Propriedade intelectual',
      blocos: [
        `A plataforma, a marca ${EMPRESA.marca}, o software, o desenho das telas e os conteúdos criados por nós pertencem ao ${EMPRESA.marca} ou a quem nos licenciou. Enquanto o contrato estiver ativo, o Cliente tem uma licença de uso da plataforma, não exclusiva e intransferível.`,
        'Os dados e conteúdos que o Cliente cadastra continuam sendo do Cliente.',
        'Sugestões de melhoria enviadas pelo Cliente podem ser usadas para aprimorar a plataforma, sem que isso gere pagamento ou outra obrigação.',
      ],
    },
    {
      id: 'responsabilidade',
      titulo: 'Limites de responsabilidade',
      blocos: [
        `O ${EMPRESA.marca} responde pelos danos diretos que causar ao descumprir estes termos. Não responde por lucros cessantes, perda de oportunidade ou outros danos indiretos, nem por danos causados por serviços de terceiros, pelo uso da plataforma em desacordo com estes termos, por atos dos Usuários do Cliente ou por caso fortuito e força maior.`,
        `Na medida permitida pela lei, a responsabilidade total do ${EMPRESA.marca} fica limitada ao valor pago pelo Cliente nos 12 meses anteriores ao fato.`,
      ],
    },
    {
      id: 'encerramento',
      titulo: 'Suspensão e encerramento',
      blocos: [
        'O Cliente pode cancelar a assinatura a qualquer momento, pelo sistema ou pelo canal de contato.',
        'Podemos suspender ou encerrar a conta por falta de pagamento depois de aviso, por violação destes termos, por risco à segurança da plataforma ou de terceiros, ou por ordem de autoridade.',
        'Depois do encerramento, o Cliente tem 90 dias para pedir uma cópia dos seus dados. Passado esse prazo, os dados podem ser eliminados, exceto os que a lei mandar guardar.',
      ],
    },
    {
      id: 'mudancas',
      titulo: 'Mudanças nestes termos',
      blocos: [
        'Podemos atualizar estes termos para acompanhar mudanças na plataforma ou na lei. Mudanças importantes serão avisadas com pelo menos 30 dias de antecedência, por e-mail ou dentro do sistema. Quem não concordar pode cancelar antes de a mudança valer; continuar usando a plataforma depois disso significa concordar com a nova versão.',
        'A data da versão em vigor fica no topo desta página.',
      ],
    },
    {
      id: 'gerais',
      titulo: 'Disposições gerais',
      blocos: [
        'Estes termos seguem as leis do Brasil.',
        'Se alguma parte destes termos for considerada inválida, o restante continua valendo. Deixar de exigir um direito em algum momento não significa abrir mão dele.',
        'As comunicações serão feitas pelo e-mail cadastrado na conta ou dentro do sistema.',
        `Fica eleito o foro da comarca da sede do ${EMPRESA.marca} para resolver qualquer questão sobre estes termos, salvo quando a lei determinar outro.`,
      ],
    },
    {
      id: 'contato',
      titulo: 'Contato',
      blocos: [`Dúvidas sobre estes termos: ${EMPRESA.email}.`, identificacaoDaEmpresa()].filter(Boolean),
    },
  ],
});
