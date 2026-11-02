/**
 * Política de privacidade da plataforma (página /privacidade). Vale para
 * clínicas e laboratórios. Ao mudar o texto, atualize também `atualizadoEm`.
 */
import { EMPRESA_DA_PLATAFORMA as EMPRESA, identificacaoDaEmpresa, type DocumentoLegal } from './documento-legal';

export const POLITICA_DE_PRIVACIDADE: DocumentoLegal = Object.freeze({
  titulo: 'Política de privacidade',
  atualizadoEm: '2 de novembro de 2026',
  resumo: [
    'Tratamos os dados de quem contrata e usa o sistema para prestar o serviço, cobrar a assinatura e manter a plataforma segura.',
    'Os dados de pacientes e clientes que a clínica ou o laboratório cadastra são deles: nós só tratamos esses dados para prestar o serviço, conforme as instruções deles.',
    'Não vendemos dados pessoais.',
    'Os dados de cada conta ficam separados e não são compartilhados com outras contas.',
    `Você pode pedir acesso, correção ou exclusão dos seus dados pelo e-mail ${EMPRESA.email}.`,
  ],
  secoes: [
    {
      id: 'quem-somos',
      titulo: 'Sobre esta política',
      blocos: [
        `Esta Política de Privacidade explica como o ${EMPRESA.marca} trata dados pessoais na plataforma de gestão para clínicas odontológicas e laboratórios de prótese, de acordo com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018 — LGPD).`,
        'Ela vale para quem visita as páginas públicas, quem se cadastra ou entra na lista de espera, os Clientes (clínicas e laboratórios) e os seus Usuários e, no que couber, as pessoas cujos dados os Clientes cadastram no sistema, como pacientes, dentistas clientes e outros contatos.',
      ],
    },
    {
      id: 'papeis',
      titulo: 'Nosso papel: controlador e operador',
      blocos: [
        `O ${EMPRESA.marca} é controlador dos dados de cadastro e de uso da conta do Cliente e dos seus Usuários, dos dados de quem entra na lista de espera e dos dados de navegação nas páginas públicas.`,
        `Sobre os dados que o Cliente coloca no sistema (pacientes, dentistas clientes, contatos, conversas, agenda, prontuários, orçamentos, cobranças e documentos), o controlador é o Cliente. O ${EMPRESA.marca} atua como operador: trata esses dados em nome do Cliente, conforme as instruções dele e só para prestar o serviço (art. 39 da LGPD).`,
        'Por isso, quem é paciente ou cliente de uma clínica ou de um laboratório deve falar primeiro com eles para exercer os seus direitos. Se o pedido chegar até nós, vamos encaminhá-lo ao Cliente responsável.',
      ],
    },
    {
      id: 'dados-da-conta',
      titulo: 'Dados que tratamos como controlador',
      blocos: [
        {
          lista: [
            'Cadastro da conta: nome da clínica ou do laboratório, CPF ou CNPJ, telefone e WhatsApp, endereço, nome do responsável e, no caso do laboratório, a inscrição no conselho e os dados do responsável técnico, quando informados.',
            'Usuários: nome, e-mail, telefone, setor, permissões e senha (guardada em formato cifrado, que não permite lê-la).',
            'Lista de espera: nome do laboratório, nome de contato, telefone, e-mail, cidade, estado e porte.',
            `Assinatura: plano, histórico de cobranças e os dados necessários para cobrar. O pagamento com cartão é feito na página do provedor de pagamentos, e o número do cartão não passa pelo ${EMPRESA.marca} nem fica guardado conosco.`,
            'Registros de uso: data e hora de acesso, ações feitas no sistema e, quando disponíveis, endereço IP e navegador, para segurança, suporte e cumprimento do Marco Civil da Internet (Lei nº 12.965/2014).',
            'Atendimento: mensagens trocadas com o nosso suporte.',
          ],
        },
      ],
    },
    {
      id: 'dados-dos-clientes',
      titulo: 'Dados que tratamos em nome do Cliente',
      blocos: [
        'Conforme o uso que o Cliente faz da plataforma, o sistema pode guardar:',
        {
          lista: [
            'dados de cadastro de pacientes e de clientes, como nome, CPF, data de nascimento, telefone, endereço e, para laboratórios, o CRO e os dados da clínica do dentista;',
            'dados de saúde, como prontuário, anamnese, odontograma, planos de tratamento, fotos e exames, que são dados pessoais sensíveis;',
            'dados de trabalhos de prótese, como cor, material, elementos e prazos, ligados ao paciente do dentista cliente;',
            'conversas de WhatsApp, com textos, áudios, fotos, vídeos e documentos;',
            'agenda, orçamentos, contratos, cobranças, recibos e dados financeiros;',
            'dados da equipe do Cliente, inclusive as marcações de ponto com a localização do aparelho no momento da marcação, quando o Cliente usa o relógio de ponto.',
          ],
        },
        'O Cliente deve cadastrar só o necessário. Para os laboratórios, recomendamos identificar o paciente de cada trabalho pelo mínimo possível, como as iniciais ou um código.',
        'Dados de saúde são tratados pelas clínicas e pelos profissionais de saúde para a tutela da saúde e para os demais fins permitidos pelo art. 11 da LGPD. Dados de crianças e adolescentes devem ser tratados pelo Cliente no melhor interesse deles, conforme o art. 14 da LGPD.',
      ],
    },
    {
      id: 'finalidades',
      titulo: 'Para que usamos os dados e com qual base legal',
      blocos: [
        {
          lista: [
            'Prestar o serviço contratado: criar e manter a conta, guardar e mostrar os dados e enviar as mensagens e os avisos configurados pelo Cliente — execução de contrato (art. 7º, V).',
            'Cobrar a assinatura e emitir documentos fiscais — execução de contrato e cumprimento de obrigação legal (art. 7º, II e V).',
            'Dar suporte e avisar sobre mudanças, manutenções e segurança — execução de contrato e legítimo interesse (art. 7º, V e IX).',
            'Proteger a plataforma, prevenir fraudes e apurar acessos indevidos — legítimo interesse e cumprimento de obrigação legal (art. 7º, II e IX).',
            'Guardar registros de acesso pelo prazo do Marco Civil da Internet — cumprimento de obrigação legal (art. 7º, II).',
            'Melhorar a plataforma com estatísticas de uso, sempre que possível de forma agregada ou anonimizada — legítimo interesse (art. 7º, IX).',
            'Defender direitos em processos judiciais, administrativos ou arbitrais — exercício regular de direitos (art. 7º, VI).',
          ],
        },
        'Não vendemos dados pessoais e não usamos os dados de pacientes e clientes do Cliente para fins próprios, como publicidade.',
      ],
    },
    {
      id: 'ia',
      titulo: 'Inteligência artificial',
      blocos: [
        'Quando o Cliente liga recursos de inteligência artificial, o conteúdo necessário para a tarefa (por exemplo, as últimas mensagens de uma conversa ou a foto usada numa simulação) é enviado a um fornecedor de inteligência artificial, como OpenAI ou Anthropic, para gerar a resposta.',
        'Esses fornecedores tratam os dados conforme os termos deles para uso por API, que, na data desta política, preveem que o conteúdo enviado não é usado para treinar os seus modelos. Eles podem estar fora do Brasil (veja a seção sobre transferência internacional).',
        'A equipe do Cliente pode revisar as respostas automáticas. O titular pode pedir a revisão de decisões tomadas só com base em tratamento automatizado (art. 20 da LGPD), falando com o Cliente.',
      ],
    },
    {
      id: 'compartilhamento',
      titulo: 'Com quem compartilhamos',
      blocos: [
        'Compartilhamos dados só quando é necessário para prestar o serviço, cumprir a lei ou proteger direitos:',
        {
          lista: [
            'infraestrutura: servidores, rede de proteção e entrega de conteúdo e envio de e-mails;',
            'WhatsApp (Meta), pelo número conectado pelo Cliente, para enviar e receber mensagens;',
            'provedor de pagamentos (Asaas), para a cobrança da assinatura e para as cobranças que o Cliente emite;',
            'fornecedores de inteligência artificial, como OpenAI e Anthropic, quando o Cliente usa esses recursos;',
            'serviços que o próprio Cliente conecta, como emissor de nota fiscal, assinatura eletrônica de contratos (ClickSign) e Google Drive;',
            'autoridades públicas, quando houver obrigação legal ou ordem judicial.',
          ],
        },
        'Esses fornecedores só podem usar os dados para a finalidade contratada e devem protegê-los. Os dados de uma conta nunca são compartilhados com outra conta da plataforma.',
      ],
    },
    {
      id: 'internacional',
      titulo: 'Transferência internacional',
      blocos: [
        'Alguns fornecedores, como os de inteligência artificial, de e-mail e de rede, podem tratar dados fora do Brasil. Nesses casos, a transferência segue o art. 33 da LGPD, com fornecedores que adotam garantias de proteção compatíveis com a lei brasileira.',
      ],
    },
    {
      id: 'seguranca',
      titulo: 'Segurança',
      blocos: [
        'Adotamos medidas técnicas e administrativas para proteger os dados (art. 46 da LGPD), entre elas: conexão criptografada (HTTPS), senhas guardadas em formato cifrado, separação dos dados de cada conta, controle de acesso por perfil e por setor, registro das ações sensíveis e cópias de segurança do banco de dados.',
        'Nenhum sistema está totalmente livre de incidentes. Se ocorrer um incidente de segurança que possa trazer risco ou dano relevante aos titulares, avisaremos os Clientes afetados e a Autoridade Nacional de Proteção de Dados (ANPD), como determina o art. 48 da LGPD.',
        'O Cliente também tem papel na segurança: escolher quem tem acesso, dar a cada pessoa só as permissões necessárias, remover quem sai da equipe e não compartilhar senhas.',
      ],
    },
    {
      id: 'retencao',
      titulo: 'Por quanto tempo guardamos',
      blocos: [
        {
          lista: [
            'Dados da conta e dados inseridos pelo Cliente: enquanto o contrato estiver ativo.',
            'Depois do encerramento: o Cliente tem 90 dias para pedir uma cópia dos seus dados. Passado esse prazo, os dados podem ser eliminados ou anonimizados, exceto os que a lei mandar guardar.',
            'Registros de acesso: pelo prazo exigido pelo Marco Civil da Internet (no mínimo 6 meses).',
            'Dados fiscais e de cobrança da assinatura: pelo prazo da legislação fiscal.',
            'Lista de espera: até o fim do contato comercial ou até o titular pedir a exclusão.',
          ],
        },
        'A guarda dos prontuários pelo prazo legal (Lei nº 13.787/2018 e normas do conselho profissional) é dever do Cliente, que deve manter uma cópia antes de encerrar a conta.',
      ],
    },
    {
      id: 'direitos',
      titulo: 'Direitos dos titulares',
      blocos: [
        'Pelo art. 18 da LGPD, o titular pode pedir:',
        {
          lista: [
            'a confirmação de que tratamos os seus dados e o acesso a eles;',
            'a correção de dados incompletos, inexatos ou desatualizados;',
            'a anonimização, o bloqueio ou a eliminação de dados desnecessários, excessivos ou tratados em desconformidade com a lei;',
            'a portabilidade dos dados a outro fornecedor;',
            'a informação sobre com quem compartilhamos os dados;',
            'a informação sobre a possibilidade de não dar consentimento e as consequências disso;',
            'a revogação do consentimento e a eliminação dos dados tratados com base nele, salvo as exceções da lei.',
          ],
        },
        `Para dados da sua conta, peça pelo e-mail ${EMPRESA.email}. Podemos pedir informações para confirmar a sua identidade antes de atender. Respondemos em até 15 dias.`,
        'Para dados cadastrados por uma clínica ou um laboratório (por exemplo, como paciente), fale com eles, que são os responsáveis; ajudaremos o Cliente a atender o pedido.',
        'O titular também pode apresentar reclamação à ANPD.',
      ],
    },
    {
      id: 'cookies',
      titulo: 'Cookies e armazenamento no navegador',
      blocos: [
        'O sistema guarda no navegador as informações necessárias para manter o acesso conectado e lembrar preferências, como o tema das telas. Sem elas, o sistema não funciona.',
        'Nas páginas públicas, podemos usar ferramentas de medição de audiência, como o Google Tag Manager, para entender o uso do site. Você pode bloquear ou apagar cookies nas configurações do navegador.',
      ],
    },
    {
      id: 'contato',
      titulo: 'Encarregado e contato',
      blocos: [
        `Canal do encarregado pelo tratamento de dados pessoais (art. 41 da LGPD) e para dúvidas sobre esta política: ${EMPRESA.email}.`,
        identificacaoDaEmpresa(),
      ].filter(Boolean),
    },
    {
      id: 'mudancas',
      titulo: 'Mudanças nesta política',
      blocos: [
        'Podemos atualizar esta política para acompanhar a plataforma ou a lei. A data da versão em vigor fica no topo desta página, e mudanças importantes serão avisadas por e-mail ou dentro do sistema.',
      ],
    },
  ],
});
