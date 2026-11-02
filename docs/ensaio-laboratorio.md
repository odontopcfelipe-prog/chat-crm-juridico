# Ensaio do laboratório (F9) — 7 dias com uma conta de teste

Objetivo: operar um **Laboratório Teste** em produção como se fosse um laboratório de
verdade, por 7 dias seguidos, para achar a tela ou o aviso esquecido antes do primeiro
cliente. As clínicas não são afetadas: o laboratório é uma conta separada e os dados não
se cruzam.

## 1. Preparar (uma vez)

1. **Deploy** da versão com a F9 (comando único de backup + deploy passado no chat).
2. **Ligar a criação de laboratório**: entrar como dono da plataforma em
   `/admin/tenants` → bloco *Criação de laboratório* → **Ligar**.
3. **Criar a conta** em `/admin/tenants` → nova conta → tipo **Laboratório** → nome
   *Laboratório Teste*. Ela nasce ativa, no plano Custom, sem período de teste.
4. **Entrar como administrador do laboratório** (o usuário criado junto com a conta).
5. **WhatsApp**: Configurações → WhatsApp → conectar um **número reserva** com a função
   **Comercial**. Com um número só, ele faz tudo: conversa com os dentistas, avisos de
   coleta/prova/entrega e cobrança.
6. **Equipe de teste**: Configurações → Usuários → um usuário em cada setor
   (Atendimento, Protético, Expedição, Comercial, Financeiro e Administrador). Use
   telefones da própria equipe para ver as mensagens chegando.
7. **Tabela de serviços**: cadastrar 5 a 10 serviços com a ficha técnica (prazo,
   garantia, unidade, material, cor, prova). Se já houver a tabela real do laboratório
   piloto, use ela.
8. **Central de Disparos**: conferir que aviso na hora, confirmação, lembretes de 48 h e
   24 h e remarcação estão ligados; ligar o resumo do dia do protético e o aviso de
   venda feita para um número da equipe.

## 2. Roteiro de cada dia

Fazer tudo como o laboratório faria, com dados de teste:

1. **Dentista novo pelo WhatsApp**: um número da equipe escreve para o chip do
   laboratório → a conversa aparece no chat (sem robô) → *Tornar cliente* e completar o
   cadastro (Dentista com CRO, ou Clínica com CNPJ e os dentistas que pedem trabalhos).
2. **Orçamento de trabalho**: ficha do cliente → aba Orçamento → serviços e elementos →
   ficha do caso (cor, material, entrega prometida) → aba Propostas → enviar por
   WhatsApp (sai com o PDF) → aprovar e cobrar (balcão ou maquineta).
3. **Venda rápida** com ficha do caso.
4. **Agenda**: marcar uma coleta, uma prova e uma entrega para dias diferentes →
   conferir o aviso na hora, os lembretes de 48 h e 24 h, a confirmação da véspera e o
   aviso de remarcação (mudar a data de uma delas). A equipe marca *Confirmado* na
   agenda quando o dentista responder.
5. **Trabalhos**: o protético conclui o serviço dele; o Financeiro valida.
6. **Caixa**: abrir, lançar e fechar; o administrador valida o fechamento.
7. **Boleto local** (sem conta Asaas própria): gerar e enviar o carnê.

Anotar qualquer tela com palavra de clínica (paciente, consulta, procedimento, dentista
no lugar de protético), botão que dá "sem acesso" ou aviso que não chegou.

## 3. Conferência diária (no servidor, só leitura)

Uma vez, baixar o script do sha publicado (o repositório é público) e conferir:

```
set +H
curl -fsSL -o ~/ensaio-laboratorio.sh https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/<sha40>/scripts/ensaio-laboratorio.sh && bash -n ~/ensaio-laboratorio.sh && echo ok
```

Todo dia:

```
set +H
bash ~/ensaio-laboratorio.sh 24
```

Mostra: contas de laboratório, mensagens e envios automáticos do laboratório, uso de IA
(tem de ser 0), mensagens em chip de outra conta (tem de ser 0), agenda com tipo de
clínica (0), fichas do laboratório em conta de clínica (0) e, dos logs da API, as
recusas por rota e as mensagens sem tradução. Mande a saída no chat.

Além disso, a vigia do laboratório manda um e-mail por dia às 07:30 para o dono da
plataforma se achar alguma coisa de clínica dentro de um laboratório.

## 4. Critério para terminar

- 7 dias seguidos com a vigia zerada, IA do laboratório zerada, nenhuma mensagem em chip
  de outra conta e nenhuma palavra de clínica nas telas e mensagens do laboratório.
- Nenhuma recusa vinda de tela que o laboratório abre.
- As clínicas normais no período (confirmações, lembretes e cobranças como antes).

## 5. Se algo der errado

- **Parar o laboratório na hora**: `/admin/tenants` → conta do laboratório → suspender.
  A conta para de responder em até 60 s; as clínicas seguem normais.
- Mandar no chat o que aconteceu e a saída do script. Depois da correção, a contagem dos
  7 dias recomeça.
